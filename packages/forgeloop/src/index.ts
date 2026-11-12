/**
 * forgeloop-dsh 插件入口：装载 TypeScript 业务运行时、持久工作协调器、
 * 业务会话输入接管、模型工具与只读 Web 看板通道。
 * 运行期不依赖 Python 解释器或独立 HTTP 服务。
 *
 * 多工作区绑定：宿主存在 DSH 工作区服务时，每个工作区一个租户（配置、记录库、
 * 协调器、工具作用域），业务会话与看板都按会话所属工作区选择租户；没有工作区
 * 服务的宿主（headless）保持单项目模式。未绑定工作区的会话不落入任何默认项目。
 */

import { createPluginLogger } from './runtime/log.js'
import { errorMessage } from './domain/errors.js'
import { asRecord } from './domain/json.js'
import { loadConfigOrThrow, resolveConfig, type ForgeLoopConfig, type RawConfig } from './config.js'
import { buildScopedTools, registerTools } from './tools.js'
import { Coordinator } from './runtime/coordinator.js'
import { ForgeLoopRuntime } from './runtime/service.js'
import {
  createBoardFetch,
  createScopedBoardFetch,
  type BoardScopeSource,
} from './runtime/board-route.js'
import { installSessionSurface, type SessionTenantSource } from './session/index.js'
import {
  WorkspaceTenants,
  type LegacyProject,
  type WorkspaceIdentity,
} from './runtime/workspace-tenants.js'
import { setBuildSourcePath, writeRuntimeIdentity } from './runtime/identity.js'

type AnyRecord = Record<string, unknown>

interface HostSurface {
  inject?: (dependencies: readonly string[], callback: (scope: AnyRecord) => void) => unknown
  tools?: { register(definition: unknown): () => void }
  effect?: (callback: () => unknown) => unknown
}

/** 宿主运行时模式：工作区租户注册表，或没有工作区服务的单项目兼容运行时。 */
type RuntimeMode =
  | {
      readonly kind: 'workspace'
      readonly tenants: WorkspaceTenants
      readonly sessionTenants: SessionTenantSource
      readonly boardScope: BoardScopeSource
    }
  | {
      readonly kind: 'single'
      readonly runtime: ForgeLoopRuntime
      readonly coordinator: Coordinator
    }

function hostSurface(ctx: AnyRecord): HostSurface {
  return ctx
}

function serviceOf(ctx: AnyRecord, name: string): AnyRecord | undefined {
  const getter = ctx.get
  if (typeof getter === 'function') return asRecord(Reflect.apply(getter, ctx, [name]))
  return asRecord(ctx[name])
}

/** 模式等待参数：测试可缩短；生产默认值只在宿主真的缺少工作区服务时承担一次等待成本。 */
export interface HostModeWaitOptions {
  readonly pollMs?: number
  /** Web 宿主等待工作区服务出现的上限；超时按“不可用”失败关闭。 */
  readonly webTimeoutMs?: number
  /** 非 Web 宿主等待工作区服务出现的宽限；超时按单项目兼容模式。 */
  readonly plainTimeoutMs?: number
}

/**
 * 等待 DSH 工作区服务就绪后判定宿主模式。
 *
 * 工作区服务与插件可能在同一装载批次里异步注册，apply 时读不到不等于宿主没有工作区；
 * 因此这里轮询到它就绪。Web 宿主（有 webServer/webApp/connection）在超时后返回
 * `unavailable`，由调用方失败关闭，绝不以单项目模式继续读写；没有 Web 能力的宿主
 * （headless）在宽限期后按单项目兼容。
 */
export async function waitForWorkspaceMode(
  registryOf: () => AnyRecord | undefined,
  webCapable: () => boolean,
  options: HostModeWaitOptions = {},
): Promise<'workspace' | 'single' | 'unavailable'> {
  const pollMs = options.pollMs ?? 100
  const web = webCapable()
  const budget = web ? (options.webTimeoutMs ?? 60_000) : (options.plainTimeoutMs ?? 2_000)
  const deadline = Date.now() + budget
  for (;;) {
    if (registryOf()) return 'workspace'
    if (Date.now() >= deadline) return web ? 'unavailable' : 'single'
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/** 工作区注册表的只读适配：身份只取 id、路径与标题，不信任其他字段。 */
function workspaceSourceOf(registry: AnyRecord) {
  return {
    list: async (): Promise<readonly WorkspaceIdentity[]> => {
      const list = registry.list
      const items: unknown = typeof list === 'function' ? Reflect.apply(list, registry, []) : []
      if (!Array.isArray(items)) return []
      return items
        .map((item) => workspaceIdentityOf(asRecord(item)))
        .filter((item): item is WorkspaceIdentity => item !== undefined)
    },
    byPath: async (path: string): Promise<WorkspaceIdentity | undefined> => {
      const byPath = registry.resolveByPath
      if (typeof byPath !== 'function') return undefined
      try {
        return workspaceIdentityOf(asRecord(await Reflect.apply(byPath, registry, [path])))
      } catch {
        // 目录不存在、路径不规范或尚未注册：都视为未绑定工作区。
        return undefined
      }
    },
  }
}

export const name = 'forgeloop'

/** Web 客户端读取看板事实的认证 HTTP 路径；只在有浏览器连接服务的 profile 中注册。 */
export const BOARD_HTTP_PATH = '/api/forgeloop/board'

/**
 * 把看板与客户决定注册为 Connection 的认证 Fetch 路由：请求先经过宿主连接的
 * Host/Origin 检查与浏览器凭据准入。看板按请求携带的会话身份解析工作区，
 * 只读写该工作区的记录库；没有会话或会话未绑定工作区时拒绝。
 *
 * 不用 `connection.rpc.handle()`：它的注册 owner 取自 Connection 插件自身的上下文，
 * 该上下文没有注入 `webServer`，注册时会抛错（DSH 0.2.1-rc.2 实测）。Fetch 路由是
 * Connection 为宿主功能提供的等价认证入口，且不依赖消费方的 webServer 注入。
 */
function registerBoardRoute(
  ctx: AnyRecord,
  build: () => Promise<(request: Request) => Promise<Response>>,
): void {
  const injectServices = hostSurface(ctx).inject
  if (typeof injectServices !== 'function') return
  injectServices(['connection'], (connectionScope) => {
    const services = connectionScope as {
      effect?: (callback: () => () => void) => unknown
      connection?: {
        fetch?: { register?: (route: unknown) => () => Promise<void> }
      }
    }
    const registry = services.connection?.fetch
    const register = registry?.register
    if (typeof register !== 'function') return
    const effect = services.effect
    if (typeof effect !== 'function') return
    effect(() => {
      const dispose = register.call(registry, {
        path: BOARD_HTTP_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        // 模式在首个请求到达时已判定；等待期间请求保持挂起，不返回错误页面。
        fetch: async (request: Request) => (await build())(request),
      })
      return () => {
        void dispose()
      }
    })
  })
}

/** 工作区注册表的只读适配：身份只取 id、路径与标题，不信任其他字段。 */
function workspaceIdentityOf(value: AnyRecord | undefined): WorkspaceIdentity | undefined {
  if (!value) return undefined
  const id = typeof value.id === 'string' ? value.id : ''
  const path = typeof value.path === 'string' ? value.path : ''
  if (!id || !path) return undefined
  return { id, path, title: typeof value.title === 'string' ? value.title : path }
}

/** 会话 header 的原始目录：优先活动会话，其次持久化记录；找不到时返回 undefined。 */
async function sessionCwdOf(ctx: AnyRecord, sessionId: string): Promise<string | undefined> {
  const sessions = serviceOf(ctx, 'sessions')
  const get = sessions?.get
  if (typeof get === 'function') {
    const session = asRecord(Reflect.apply(get, sessions, [sessionId]))
    const cwd = asRecord(session?.header)?.cwd
    if (typeof cwd === 'string' && cwd) return cwd
  }
  const query = serviceOf(ctx, 'sessionQuery')
  const readSession = query?.readSession
  if (typeof readSession === 'function') {
    try {
      const snapshot = asRecord(await Reflect.apply(readSession, query, [sessionId]))
      const cwd = asRecord(snapshot?.header)?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 显式配置的旧项目：只有宿主真的写了 projectPath 时才按路径复用旧目录。 */
function legacyProjectOf(raw: RawConfig, config: ForgeLoopConfig): LegacyProject | undefined {
  if (!raw.projectPath) return undefined
  return { project: config.project, projectPath: config.projectPath }
}

/** 业务会话输入接管的作用域：按会话目录找租户，找不到返回 undefined 由调用方拒绝。 */
function workspaceSessionSource(active: WorkspaceTenants): SessionTenantSource {
  return {
    forCwd: async (cwd) => {
      const tenant = await active.forCwd(cwd)
      return tenant
        ? { id: tenant.workspace.id, runtime: tenant.runtime, config: tenant.config }
        : undefined
    },
  }
}

/** 看板作用域：按浏览器会话身份找租户，找不到返回 undefined 由路由拒绝。 */
function workspaceBoardSource(active: WorkspaceTenants): BoardScopeSource {
  return async (sessionId) => {
    const tenant = await active.forSession(sessionId)
    return tenant
      ? { runtime: tenant.runtime, config: tenant.config, coordinator: tenant.coordinator }
      : undefined
  }
}

/**
 * 必需的宿主服务：Agent 工厂（agent-loop）与工具注册表。
 * 默认模型/权限预设/子进程按可选方式读取，缺失时仍能加载并明确报错。
 */
export const inject = ['agents', 'agentLoop', 'tools']

export function apply(
  ctx: AnyRecord,
  rawConfig: RawConfig = {},
  options: { readonly modeWait?: HostModeWaitOptions } = {},
): void {
  // 业务配置放在 ForgeLoop 自己的文件里；宿主配置只负责装载，不再保存一份。
  const loaded = loadConfigOrThrow(rawConfig)
  const config = resolveConfig(loaded)
  setBuildSourcePath(config.projectPath)
  const logger = createPluginLogger(config)
  // 运行身份写入失败也必须落到项目日志，而不是只出现在宿主 console。
  writeRuntimeIdentity(import.meta.url, (message) => {
    logger.warn(message)
  })
  // 先校验宿主服务再打开记录库：缺服务时直接失败，不留下未关闭的 SQLite 句柄。
  const tools = hostSurface(ctx).tools
  if (!tools) throw new Error('宿主缺少 tools 服务，无法注册 ForgeLoop 工具')
  const effect = hostSurface(ctx).effect
  if (typeof effect !== 'function') throw new Error('宿主缺少 effect 服务，无法启动协调器')

  // 工作区服务可能与本插件在同一装载批次中异步注册：模式判定放到首次使用前完成，
  // 判定前不创建任何记录库或协调器；Web 宿主等服务缺失时失败关闭，不回退单项目。
  const createTenant = (runtimeConfig: ForgeLoopConfig) => {
    const runtime = new ForgeLoopRuntime({ ctx, config: runtimeConfig })
    const coordinator = new Coordinator({
      runtime,
      pollSeconds: runtimeConfig.pollSeconds,
      autoAdvance: runtimeConfig.autoAdvance,
    })
    return { runtime, coordinator }
  }

  const modePromise: Promise<RuntimeMode> = (async () => {
    const status = await waitForWorkspaceMode(
      () => serviceOf(ctx, 'workspaceRegistry'),
      () =>
        serviceOf(ctx, 'webServer') !== undefined ||
        serviceOf(ctx, 'webApp') !== undefined ||
        serviceOf(ctx, 'connection') !== undefined,
      options.modeWait ?? {},
    )
    if (status === 'unavailable') {
      throw new Error(
        '检测到 Web 宿主但 DSH 工作区服务未就绪：ForgeLoop 拒绝以单项目模式启动，避免跨工作区读写',
      )
    }
    if (status === 'single') {
      const tenant = createTenant(config)
      logger.info('[forgeloop] 宿主没有 DSH 工作区服务：单项目模式')
      return { kind: 'single', runtime: tenant.runtime, coordinator: tenant.coordinator }
    }
    const registry = serviceOf(ctx, 'workspaceRegistry')
    if (!registry) throw new Error('DSH 工作区服务在判定后消失')
    const tenants = new WorkspaceTenants({
      raw: loaded,
      cwd: process.cwd(),
      base: config,
      ...(legacyProjectOf(loaded, config) ? { legacy: legacyProjectOf(loaded, config) } : {}),
      workspaces: workspaceSourceOf(registry),
      sessionCwd: (sessionId) => sessionCwdOf(ctx, sessionId),
      create: createTenant,
      log: (message) => {
        logger.info(message)
      },
    })
    return {
      kind: 'workspace',
      tenants,
      sessionTenants: workspaceSessionSource(tenants),
      boardScope: workspaceBoardSource(tenants),
    }
  })()
  modePromise.catch((error: unknown) => {
    logger.error(`[forgeloop] 宿主模式判定失败：${errorMessage(error)}`)
  })

  /** 工具作用域：等待模式判定；单项目固定使用兼容运行时，工作区按会话解析。 */
  const definitions = buildScopedTools(async (exec) => {
    const mode = await modePromise
    if (mode.kind === 'single') return { ok: true, scope: { runtime: mode.runtime, config } }
    const agent = asRecord(exec.agent)
    const cwd = asRecord(asRecord(agent?.session)?.header)?.cwd
    if (typeof cwd !== 'string' || !cwd) {
      return {
        ok: false,
        text: '当前工具调用没有会话目录：ForgeLoop 只在已绑定 DSH 工作区的会话中工作',
      }
    }
    const tenant = await mode.tenants.forCwd(cwd)
    if (!tenant) {
      return { ok: false, text: '当前会话没有绑定 DSH 工作区；ForgeLoop 不跨工作区读写' }
    }
    return { ok: true, scope: { runtime: tenant.runtime, config: tenant.config } }
  })
  const disposers = registerTools(tools, definitions)

  const sessionTenants: SessionTenantSource = {
    forCwd: async (cwd) => {
      const mode = await modePromise
      if (mode.kind === 'single') return { id: 'single', runtime: mode.runtime, config }
      return mode.sessionTenants.forCwd(cwd)
    },
  }

  effect(() => {
    void modePromise
      .then(async (mode) => {
        if (mode.kind === 'workspace') {
          await mode.tenants.preload()
        } else {
          mode.coordinator.start()
        }
      })
      .catch(() => undefined)
    // ForgeLoop 业务会话：注册 preset 并按会话所属工作区接管人类输入。
    const sessionSurface = installSessionSurface(ctx, { tenants: sessionTenants })
    void sessionSurface.ready.then((result) => {
      if (result.ok)
        logger.info('[forgeloop] 已注册业务会话 preset forgeloop', { event: 'session.preset' })
      else logger.warn(`[forgeloop] ${result.reason}`, { event: 'session.preset' })
    })
    // Web 看板路由可选：无浏览器连接的 profile（headless）保持只有工具。
    registerBoardRoute(ctx, async () => {
      const mode = await modePromise
      return mode.kind === 'workspace'
        ? createScopedBoardFetch(mode.boardScope)
        : createBoardFetch(mode.runtime, config, mode.coordinator)
    })
    logger.info(
      `[forgeloop] 已加载 records=${config.recordsRoot} project=${config.project} owner=${config.owner}；等待宿主模式判定`,
      { event: 'plugin.start' },
    )
    return async () => {
      await sessionSurface.dispose()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 单个工具注销失败不阻止其余清理。
        }
      }
      const mode = await modePromise.catch(() => undefined)
      if (!mode) return
      if (mode.kind === 'workspace') {
        await mode.tenants.dispose()
        return
      }
      await mode.coordinator.stop()
      mode.runtime.close()
    }
  })
}
