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
import { asRecord } from './domain/json.js'
import { loadConfigOrThrow, resolveConfig, type ForgeLoopConfig, type RawConfig } from './config.js'
import { buildScopedTools, buildTools, registerTools, type ToolScopeResolver } from './tools.js'
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

function hostSurface(ctx: AnyRecord): HostSurface {
  return ctx
}

function serviceOf(ctx: AnyRecord, name: string): AnyRecord | undefined {
  const getter = ctx.get
  if (typeof getter === 'function') return asRecord(Reflect.apply(getter, ctx, [name]))
  return asRecord(ctx[name])
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
  build: () => (request: Request) => Promise<Response>,
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
        fetch: build(),
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

/** 模型工具作用域：只按调用者会话的原始目录解析租户，解析不到就拒绝。 */
function toolScopeResolver(active: WorkspaceTenants): ToolScopeResolver {
  return async (exec) => {
    const agent = asRecord(exec.agent)
    const cwd = asRecord(asRecord(agent?.session)?.header)?.cwd
    if (typeof cwd !== 'string' || !cwd) {
      return {
        ok: false,
        text: '当前工具调用没有会话目录：ForgeLoop 只在已绑定 DSH 工作区的会话中工作',
      }
    }
    const tenant = await active.forCwd(cwd)
    if (!tenant) {
      return { ok: false, text: '当前会话没有绑定 DSH 工作区；ForgeLoop 不跨工作区读写' }
    }
    return { ok: true, scope: { runtime: tenant.runtime, config: tenant.config } }
  }
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

export function apply(ctx: AnyRecord, rawConfig: RawConfig = {}): void {
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

  // 工作区服务决定单项目还是多工作区模式；判定在装载期一次完成，之后不再切换。
  const workspaceRegistry = serviceOf(ctx, 'workspaceRegistry')
  const workspaceMode = workspaceRegistry !== undefined
  const workspaceSource = workspaceRegistry
    ? {
        list: async (): Promise<readonly WorkspaceIdentity[]> => {
          const list = workspaceRegistry.list
          const items: unknown =
            typeof list === 'function' ? Reflect.apply(list, workspaceRegistry, []) : []
          if (!Array.isArray(items)) return []
          return items
            .map((item) => workspaceIdentityOf(asRecord(item)))
            .filter((item): item is WorkspaceIdentity => item !== undefined)
        },
        byPath: async (path: string): Promise<WorkspaceIdentity | undefined> => {
          const byPath = workspaceRegistry.resolveByPath
          if (typeof byPath !== 'function') return undefined
          try {
            return workspaceIdentityOf(
              asRecord(await Reflect.apply(byPath, workspaceRegistry, [path])),
            )
          } catch {
            // 目录不存在、路径不规范或尚未注册：都视为未绑定工作区。
            return undefined
          }
        },
      }
    : undefined

  /** 一个工作区一份运行时与其协调器；协调器必须持有同一个运行时实例。 */
  const createTenant = (runtimeConfig: ForgeLoopConfig) => {
    const runtime = new ForgeLoopRuntime({ ctx, config: runtimeConfig })
    const coordinator = new Coordinator({
      runtime,
      pollSeconds: runtimeConfig.pollSeconds,
      autoAdvance: runtimeConfig.autoAdvance,
    })
    return { runtime, coordinator }
  }

  const tenants =
    workspaceMode && workspaceSource
      ? new WorkspaceTenants({
          raw: loaded,
          cwd: process.cwd(),
          base: config,
          ...(legacyProjectOf(loaded, config) ? { legacy: legacyProjectOf(loaded, config) } : {}),
          workspaces: workspaceSource,
          sessionCwd: (sessionId) => sessionCwdOf(ctx, sessionId),
          create: createTenant,
          log: (message) => {
            logger.info(message)
          },
        })
      : undefined
  // 判别联合：工作区模式创建租户注册表，单项目模式只创建一个兼容运行时。
  // 没有工作区服务的宿主（headless）走单项目；不会在两种模式之间回退。
  const mode = tenants
    ? ({
        kind: 'workspace',
        tenants,
        sessionTenants: workspaceSessionSource(tenants),
        boardScope: workspaceBoardSource(tenants),
      } as const)
    : ({ kind: 'single', tenant: createTenant(config) } as const)

  const definitions =
    mode.kind === 'workspace'
      ? buildScopedTools(toolScopeResolver(mode.tenants))
      : buildTools(mode.tenant.runtime, config)
  const disposers = registerTools(tools, definitions)

  effect(() => {
    if (mode.kind === 'workspace') {
      void mode.tenants.preload()
    } else {
      mode.tenant.coordinator.start()
    }
    // ForgeLoop 业务会话：注册 preset 并按会话所属工作区接管人类输入。
    const sessionSurface =
      mode.kind === 'workspace'
        ? installSessionSurface(ctx, { tenants: mode.sessionTenants })
        : installSessionSurface(ctx, { runtime: mode.tenant.runtime, config })
    void sessionSurface.ready.then((result) => {
      if (result.ok)
        logger.info('[forgeloop] 已注册业务会话 preset forgeloop', { event: 'session.preset' })
      else logger.warn(`[forgeloop] ${result.reason}`, { event: 'session.preset' })
    })
    // Web 看板路由可选：无浏览器连接的 profile（headless）保持只有工具。
    registerBoardRoute(ctx, () =>
      mode.kind === 'workspace'
        ? createScopedBoardFetch(mode.boardScope)
        : createBoardFetch(mode.tenant.runtime, config, mode.tenant.coordinator),
    )
    logger.info(
      `[forgeloop] 已加载 records=${config.recordsRoot} project=${config.project} owner=${config.owner} mode=${mode.kind}`,
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
      if (mode.kind === 'workspace') {
        await mode.tenants.dispose()
        return
      }
      await mode.tenant.coordinator.stop()
      mode.tenant.runtime.close()
    }
  })
}
