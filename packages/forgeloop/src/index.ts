/**
 * forgeloop-dsh 插件入口：装载 TypeScript 业务运行时、持久工作协调器、
 * 模型工具与只读 Web 看板通道。运行期不依赖 Python 解释器或独立 HTTP 服务。
 * 当前没有人类 slash 命令表面；新方案的客户决定入口尚未实现。
 */

import { resolveConfig, type RawConfig } from './config.js'
import { buildTools, registerTools } from './tools.js'
import { Coordinator } from './runtime/coordinator.js'
import { ForgeLoopRuntime } from './runtime/service.js'

type AnyRecord = Record<string, unknown>

export const name = 'forgeloop'

/** Web 客户端读取看板事实的认证 HTTP 路径；只在有浏览器连接服务的 profile 中注册。 */
export const BOARD_HTTP_PATH = '/api/forgeloop/board'
const BOARD_ENDPOINTS = ['board', 'detail']

interface BoardFailure {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

type BoardOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: BoardFailure }

function boardFailure(code: string, message: string): { ok: false; error: BoardFailure } {
  return { ok: false, error: { code, message, details: {} } }
}

function boardResponse(body: BoardOutcome, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 把看板注册为 Connection 的认证 Fetch 路由：请求先经过宿主连接的 Host/Origin 检查与
 * 浏览器凭据准入，只有 owner 能读到本插件自己的项目记录。只读，没有写入端点。
 *
 * 不用 `connection.rpc.handle()`：它的注册 owner 取自 Connection 插件自身的上下文，
 * 该上下文没有注入 `webServer`，注册时会抛错（DSH 0.2.1-rc.2 实测）。Fetch 路由是
 * Connection 为宿主功能提供的等价认证入口，且不依赖消费方的 webServer 注入。
 */
function registerBoardRoute(ctx: AnyRecord, runtime: ForgeLoopRuntime): void {
  const injectServices = ctx.inject as ((dependencies: string[], callback: (scope: AnyRecord) => void) => unknown) | undefined
  if (typeof injectServices !== 'function') return
  injectServices(['connection'], (scope) => {
    const services = scope as {
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
        fetch: async (request: Request): Promise<Response> => {
          let payload: unknown
          try {
            payload = await request.json()
          } catch {
            return boardResponse(boardFailure('bad_request', '请求体不是 JSON'), 400)
          }
          const body = payload as { endpoint?: unknown; reqId?: unknown } | null
          const endpoint = body?.endpoint
          if (!BOARD_ENDPOINTS.includes(String(endpoint))) {
            return boardResponse(boardFailure('not_found', `未知的看板端点 ${String(endpoint)}`), 404)
          }
          try {
            if (endpoint === 'detail') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              if (!reqId) return boardResponse(boardFailure('bad_request', '缺少需求身份 reqId'), 400)
              const result = runtime.status(reqId)
              if (!result.ok) return boardResponse(boardFailure(result.code, result.message), 404)
              return boardResponse({ ok: true, value: result.data })
            }
            return boardResponse({ ok: true, value: runtime.statusBoard() })
          } catch (error) {
            return boardResponse(boardFailure('internal', `看板读取失败：${(error as Error).message}`), 500)
          }
        },
      })
      return () => {
        void dispose()
      }
    })
  })
}

/**
 * 必需的宿主服务：Agent 工厂（agent-loop）与工具注册表。
 * 默认模型/权限预设/子进程按可选方式读取，缺失时仍能加载并明确报错。
 */
export const inject = ['agents', 'agentLoop', 'tools']

export function apply(ctx: AnyRecord, rawConfig: RawConfig = {}): void {
  const config = resolveConfig(rawConfig)
  const runtime = new ForgeLoopRuntime({ ctx, config })
  const coordinator = new Coordinator({
    runtime,
    pollSeconds: config.pollSeconds,
    autoAdvance: config.autoAdvance,
  })
  const tools = ctx.tools as { register(definition: unknown): () => void }
  const disposers = registerTools(tools, buildTools(runtime, config))

  const effect = ctx.effect as (callback: () => unknown) => unknown
  effect(() => {
    coordinator.start()
    // Web 看板路由可选：无浏览器连接的 profile（headless）保持只有工具。
    registerBoardRoute(ctx, runtime)
    const summary = runtime.directorySummary() as AnyRecord
    // 启动信息只写宿主日志，不作为业务状态或验收证据。
    console.log(
      `[forgeloop] 已加载 records=${String(summary.database)} project=${config.project} path=${config.projectPath} owner=${coordinator.owner}`,
    )
    return async () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 单个注册清理失败不阻止其余清理。
        }
      }
      await coordinator.stop()
      runtime.close()
    }
  })
}