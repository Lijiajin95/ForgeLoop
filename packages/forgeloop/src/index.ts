import { createHostLogger } from './runtime/log.js'
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

export interface HostModeWaitOptions {
  readonly pollMs?: number
  /** Web 宿主等待工作区服务出现的上限；超时按“不可用”失败关闭。 */
  readonly webTimeoutMs?: number
  /** 非 Web 宿主的观察窗口：窗口内每轮重新判定 Web 能力，始终没有宿主服务才按单项目兼容。 */
  readonly plainTimeoutMs?: number
}

export async function waitForWorkspaceMode(
  registryOf: () => AnyRecord | undefined,
  webCapable: () => boolean,
  options: HostModeWaitOptions = {},
): Promise<'workspace' | 'single' | 'unavailable'> {
  const pollMs = options.pollMs ?? 100
  const webTimeoutMs = options.webTimeoutMs ?? 60_000
  // 旧的 2 秒窗口会在这个间隙把 Web 宿主误判成单项目。
  const plainTimeoutMs = options.plainTimeoutMs ?? 10_000
  const startedAt = Date.now()
  let webDeadline = 0

  for (;;) {
    if (registryOf()) return 'workspace'

    const now = Date.now()
    if (webCapable()) {
      if (webDeadline === 0) webDeadline = now + webTimeoutMs
      if (now >= webDeadline) return 'unavailable'
    } else if (now - startedAt >= plainTimeoutMs) {
      return 'single'
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

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
        fetch: async (request: Request) => (await build())(request),
      })
      return () => {
        void dispose()
      }
    })
  })
}

function workspaceIdentityOf(value: AnyRecord | undefined): WorkspaceIdentity | undefined {
  if (!value) return undefined
  const id = typeof value.id === 'string' ? value.id : ''
  const path = typeof value.path === 'string' ? value.path : ''
  if (!id || !path) return undefined
  return { id, path, title: typeof value.title === 'string' ? value.title : path }
}

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
      // DSH `readSession` 返回 `{ session: header, events }`：header 字段名是 `session`。
      const cwd = asRecord(snapshot?.session)?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    } catch {
      return undefined
    }
  }
  return undefined
}

function legacyProjectOf(raw: RawConfig, config: ForgeLoopConfig): LegacyProject | undefined {
  if (!raw.projectPath) return undefined
  return { project: config.project, projectPath: config.projectPath }
}

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

function workspaceBoardSource(active: WorkspaceTenants): BoardScopeSource {
  return async (sessionId) => {
    const tenant = await active.forSession(sessionId)
    return tenant
      ? {
          runtime: tenant.runtime,
          config: tenant.config,
          coordinator: tenant.coordinator,
          workspace: {
            id: tenant.workspace.id,
            title: tenant.workspace.title,
            path: tenant.workspace.path,
          },
        }
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
  const loaded = loadConfigOrThrow(rawConfig)
  const config = resolveConfig(loaded)
  setBuildSourcePath(config.projectPath, config.clientEntryFile)
  const logger = createHostLogger(config)
  writeRuntimeIdentity(import.meta.url, (message) => {
    logger.warn(message)
  })
  const tools = hostSurface(ctx).tools
  if (!tools) throw new Error('宿主缺少 tools 服务，无法注册 ForgeLoop 工具')
  const effect = hostSurface(ctx).effect
  if (typeof effect !== 'function') throw new Error('宿主缺少 effect 服务，无法启动协调器')

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
          mode.tenants.startReconcile()
        } else {
          mode.coordinator.start()
        }
      })
      .catch(() => undefined)
    const sessionSurface = installSessionSurface(ctx, { tenants: sessionTenants })
    void sessionSurface.ready.then((result) => {
      if (result.ok)
        logger.info('[forgeloop] 已注册业务会话 preset forgeloop', { event: 'session.preset' })
      else logger.warn(`[forgeloop] ${result.reason}`, { event: 'session.preset' })
    })
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
          continue
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
