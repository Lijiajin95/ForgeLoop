/**
 * forgeloop-dsh 插件入口：装载 TypeScript 业务运行时、持久工作协调器、
 * 业务会话输入接管、模型工具与只读 Web 看板通道。
 * 运行期不依赖 Python 解释器或独立 HTTP 服务。
 * 当前没有人类 slash 命令表面；新方案的客户决定入口尚未实现。
 */

import { resolveConfig, type RawConfig } from './config.js'
import { buildTools, registerTools } from './tools.js'
import { Coordinator } from './runtime/coordinator.js'
import { ForgeLoopRuntime } from './runtime/service.js'
import { BOARD_MAX_LIMIT } from './runtime/board.js'
import { installSessionSurface } from './session/index.js'

type AnyRecord = Record<string, unknown>

export const name = 'forgeloop'

/** Web 客户端读取看板事实的认证 HTTP 路径；只在有浏览器连接服务的 profile 中注册。 */
export const BOARD_HTTP_PATH = '/api/forgeloop/board'
const BOARD_ENDPOINTS = ['board', 'detail', 'session', 'task', 'execution', 'plan', 'approve', 'advance', 'verify', 'rework', 'recover', 'build', 'deploy', 'retry', 'replan', 'accept', 'stop', 'cancel', 'ops', 'ops-detail', 'ops-decide', 'ops-close', 'ops-confirm-unknown', 'ops-request-fix']

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
 * 把看板与客户决定注册为 Connection 的认证 Fetch 路由：请求先经过宿主连接的
 * Host/Origin 检查与浏览器凭据准入。`board/detail/session` 只读；`approve/advance`
 * 是真实浏览器动作写入的唯一入口，模型工具不能调用。
 *
 * 不用 `connection.rpc.handle()`：它的注册 owner 取自 Connection 插件自身的上下文，
 * 该上下文没有注入 `webServer`，注册时会抛错（DSH 0.2.1-rc.2 实测）。Fetch 路由是
 * Connection 为宿主功能提供的等价认证入口，且不依赖消费方的 webServer 注入。
 */
function registerBoardRoute(
  ctx: AnyRecord,
  runtime: ForgeLoopRuntime,
  config: ReturnType<typeof resolveConfig>,
  coordinator: Coordinator,
): void {
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
          const body = payload as {
            endpoint?: unknown
            reqId?: unknown
            sessionId?: unknown
            planVersion?: unknown
            taskId?: unknown
            artifactSha256?: unknown
            targetProfile?: unknown
            version?: unknown
            eventId?: unknown
            decision?: unknown
            reason?: unknown
            confirmRecovery?: unknown
            files?: unknown
            query?: unknown
            limit?: unknown
            offset?: unknown
          } | null
          const endpoint = body?.endpoint
          if (!BOARD_ENDPOINTS.includes(String(endpoint))) {
            return boardResponse(boardFailure('not_found', `未知的看板端点 ${String(endpoint)}`), 404)
          }
          try {
            if (endpoint === 'detail') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              if (!reqId) return boardResponse(boardFailure('bad_request', '缺少需求身份 reqId'), 400)
              const result = runtime.requirementDetail(reqId)
              if (!result.ok) return boardResponse(boardFailure(result.code, result.message), 404)
              return boardResponse({ ok: true, value: result.data })
            }
            if (endpoint === 'task') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
              const planVersion = typeof body?.planVersion === 'number' ? body.planVersion : undefined
              if (!reqId || !taskId) {
                return boardResponse(boardFailure('bad_request', '任务详情需要 reqId 与 taskId'), 400)
              }
              const result = runtime.taskDetail(reqId, taskId, planVersion)
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 404)
            }
            if (endpoint === 'execution') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
              const planVersion = typeof body?.planVersion === 'number' ? body.planVersion : undefined
              const offset = typeof body?.offset === 'number' ? body.offset : 0
              const limit = typeof body?.limit === 'number' ? body.limit : 100
              if (
                !reqId ||
                !taskId ||
                !Number.isInteger(offset) ||
                offset < 0 ||
                !Number.isInteger(limit) ||
                limit < 1 ||
                limit > 200 ||
                (planVersion !== undefined && (!Number.isInteger(planVersion) || planVersion < 1))
              ) {
                return boardResponse(boardFailure('bad_request', '执行过程需要 reqId、taskId 与合法分页参数'), 400)
              }
              const result = runtime.taskExecution({ reqId, taskId, ...(planVersion ? { planVersion } : {}), offset, limit })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 404)
            }
            if (endpoint === 'session') {
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              if (!sessionId) return boardResponse(boardFailure('bad_request', '缺少会话身份 sessionId'), 400)
              return boardResponse({ ok: true, value: runtime.sessionSummary(sessionId) })
            }
            if (endpoint === 'plan') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              if (!reqId) return boardResponse(boardFailure('bad_request', '重新生成任务包需要 reqId'), 400)
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const result = runtime.requestOperation({
                reqId,
                action: 'plan',
                by: config.owner,
                source: `web-decision:${sessionId || 'unknown-session'}:plan`,
              })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'approve') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              const planVersion = typeof body?.planVersion === 'number' ? body.planVersion : Number.NaN
              if (!reqId || !Number.isInteger(planVersion) || planVersion < 1) {
                return boardResponse(boardFailure('bad_request', '批准需要 reqId 与正整数 planVersion'), 400)
              }
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const result = runtime.approvePlan({
                reqId,
                planVersion,
                by: config.owner,
                source: `web-decision:${sessionId || 'unknown-session'}:plan-v${planVersion}`,
              })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'advance') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              if (!reqId) return boardResponse(boardFailure('bad_request', '推进需要 reqId'), 400)
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const result = runtime.requestOperation({
                reqId,
                action: 'advance',
                by: config.owner,
                source: `web-decision:${sessionId || 'unknown-session'}:advance`,
              })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'verify') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              if (!reqId) return boardResponse(boardFailure('bad_request', '独立验证需要 reqId'), 400)
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const result = runtime.requestOperation({
                reqId,
                action: 'verify',
                by: config.owner,
                source: `web-decision:${sessionId || 'unknown-session'}:verify`,
              })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'rework') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              const planVersion = typeof body?.planVersion === 'number' ? body.planVersion : Number.NaN
              if (!reqId || !Number.isInteger(planVersion) || planVersion < 1) {
                return boardResponse(boardFailure('bad_request', '重新研发需要 reqId 与正整数 planVersion'), 400)
              }
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const result = runtime.rework({
                reqId,
                planVersion,
                by: config.owner,
                source: `web-decision:${sessionId || 'unknown-session'}:rework`,
                confirmRecovery: body?.confirmRecovery === true,
              })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'recover') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              if (!reqId) return boardResponse(boardFailure('bad_request', '核对未知请求需要 reqId'), 400)
              if (body?.confirmRecovery !== true) {
                return boardResponse(
                  boardFailure('recovery_required', '请先核对工作副本、Git、产物与证据，再确认关闭未知请求'),
                  409,
                )
              }
              const result = runtime.recover({ reqId, by: config.owner, confirm: true })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'build') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              if (!reqId) return boardResponse(boardFailure('bad_request', '构建候选需要 reqId'), 400)
              const version =
                typeof body?.version === 'string' && body.version.trim() ? body.version.trim() : undefined
              const result = runtime.buildCandidate({
                reqId,
                by: config.owner,
                ...(version ? { version } : {}),
              })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'deploy') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              const targetProfile =
                typeof body?.targetProfile === 'string' ? body.targetProfile.trim() : ''
              if (!reqId || !targetProfile) {
                return boardResponse(boardFailure('bad_request', '上线核对需要 reqId 与 targetProfile'), 400)
              }
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const result = runtime.verifyDeployment({
                reqId,
                targetProfile,
                by: config.owner,
                source: `web-decision:${sessionId || 'unknown-session'}:deploy`,
              })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'retry') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
              const planVersion = typeof body?.planVersion === 'number' ? body.planVersion : Number.NaN
              if (!reqId || !taskId || !Number.isInteger(planVersion) || planVersion < 1) {
                return boardResponse(boardFailure('bad_request', '重试需要 reqId、taskId 与正整数 planVersion'), 400)
              }
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const result = runtime.retryTask({
                reqId,
                planVersion,
                taskId,
                by: config.owner,
                source: `web-decision:${sessionId || 'unknown-session'}`,
                confirmRecovery: body?.confirmRecovery === true,
              })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'replan') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              const planVersion = typeof body?.planVersion === 'number' ? body.planVersion : Number.NaN
              const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : undefined
              const files = Array.isArray(body?.files)
                ? body.files.filter((file: unknown): file is string => typeof file === 'string')
                : []
              if (
                !reqId ||
                !Number.isInteger(planVersion) ||
                planVersion < 1 ||
                files.length === 0 ||
                files.length > 20 ||
                files.some((file) => !file.trim() || file.length > 200)
              ) {
                return boardResponse(boardFailure('bad_request', '重新规划需要 reqId、正整数 planVersion 与 1..20 个补充文件'), 400)
              }
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const result = await runtime.replanTask({
                reqId,
                planVersion,
                ...(taskId ? { taskId } : {}),
                files,
                by: config.owner,
                source: `web-decision:${sessionId || 'unknown-session'}:replan`,
                confirmRecovery: body?.confirmRecovery === true,
              })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'accept') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              if (!reqId) return boardResponse(boardFailure('bad_request', '验收需要 reqId'), 400)
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const artifactSha256 =
                typeof body?.artifactSha256 === 'string' && body.artifactSha256.trim()
                  ? body.artifactSha256.trim()
                  : undefined
              const result = runtime.accept({
                reqId,
                by: config.owner,
                source: `web-decision:${sessionId || 'unknown-session'}:accept`,
                ...(artifactSha256 ? { artifactSha256 } : {}),
              })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'cancel') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              if (!reqId) return boardResponse(boardFailure('bad_request', '取消需要 reqId'), 400)
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
              coordinator.abortRequirement(reqId)
              const result = runtime.cancel({
                reqId,
                by: config.owner,
                reason: reason || `Web 取消请求（${sessionId || 'unknown-session'}）`,
              })
              return boardResponse(result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message), result.ok ? 200 : 409)
            }
            if (endpoint === 'stop') {
              const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : ''
              if (!reqId) return boardResponse(boardFailure('bad_request', '停止需要 reqId'), 400)
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
              const aborted = coordinator.abortRequirement(reqId)
              const result = runtime.stop({
                reqId,
                by: config.owner,
                reason: reason || 'Web 停止请求',
              })
              return boardResponse(
                result.ok ? { ok: true, value: { ...(result.data as object | undefined), aborted } } : boardFailure(result.code, result.message),
                result.ok ? 200 : 409,
              )
            }
            if (endpoint === 'ops') {
              const result = runtime.opsStatus()
              return boardResponse({ ok: true, value: result.data })
            }
            if (endpoint === 'ops-detail') {
              const eventId = typeof body?.eventId === 'string' ? body.eventId.trim() : ''
              if (!eventId) return boardResponse(boardFailure('bad_request', '缺少运维事件 eventId'), 400)
              const result = runtime.opsStatus(eventId)
              return boardResponse(
                result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
                result.ok ? 200 : 404,
              )
            }
            if (endpoint === 'ops-decide') {
              const eventId = typeof body?.eventId === 'string' ? body.eventId.trim() : ''
              const decision = body?.decision === 'approve' || body?.decision === 'decline' ? body.decision : ''
              if (!eventId || !decision) {
                return boardResponse(boardFailure('bad_request', '处置决定需要 eventId 与 approve/decline'), 400)
              }
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
              const result = runtime.opsDecide({
                eventId,
                decision,
                by: config.owner,
                source: `web-decision:${sessionId || 'unknown-session'}:ops-${decision}`,
                ...(reason ? { reason } : {}),
              })
              return boardResponse(
                result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
                result.ok ? 200 : 409,
              )
            }
            if (endpoint === 'ops-confirm-unknown') {
              const eventId = typeof body?.eventId === 'string' ? body.eventId.trim() : ''
              if (!eventId) return boardResponse(boardFailure('bad_request', '核对未知结果需要 eventId'), 400)
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
              const result = runtime.opsConfirmUnknown({
                eventId,
                by: config.owner,
                reason: reason || `Web 核对（${sessionId || 'unknown-session'}）`,
              })
              return boardResponse(
                result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
                result.ok ? 200 : 409,
              )
            }
            if (endpoint === 'ops-close') {
              const eventId = typeof body?.eventId === 'string' ? body.eventId.trim() : ''
              if (!eventId) return boardResponse(boardFailure('bad_request', '关闭事件需要 eventId'), 400)
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
              const result = runtime.opsClose({
                eventId,
                by: config.owner,
                reason: reason || `Web 关闭（${sessionId || 'unknown-session'}）`,
                confirmUnknown: body?.confirmRecovery === true,
              })
              return boardResponse(
                result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
                result.ok ? 200 : 409,
              )
            }
            if (endpoint === 'ops-request-fix') {
              const eventId = typeof body?.eventId === 'string' ? body.eventId.trim() : ''
              if (!eventId) return boardResponse(boardFailure('bad_request', '生成修复需求需要 eventId'), 400)
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
              const result = runtime.opsRequestFix({
                eventId,
                by: config.owner,
                source: `web-decision:${sessionId || 'unknown-session'}:ops-fix`,
              })
              return boardResponse(
                result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
                result.ok ? 200 : 409,
              )
            }
            if (body?.query !== undefined && typeof body.query !== 'string') {
              return boardResponse(boardFailure('bad_request', 'query 必须是字符串'), 400)
            }
            const query = typeof body?.query === 'string' ? body.query.trim().slice(0, 200) : ''
            let limit: number | undefined
            if (body?.limit !== undefined) {
              if (
                typeof body.limit !== 'number' ||
                !Number.isInteger(body.limit) ||
                body.limit < 1 ||
                body.limit > BOARD_MAX_LIMIT
              ) {
                return boardResponse(
                  boardFailure('bad_request', `limit 必须是 1..${BOARD_MAX_LIMIT} 的整数`),
                  400,
                )
              }
              limit = body.limit
            }
            return boardResponse({ ok: true, value: runtime.statusBoard(limit, query) })
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
    // ForgeLoop 业务会话：注册 preset 并接管该 preset 会话的人类输入。
    const sessionSurface = installSessionSurface(ctx, { runtime, config })
    void sessionSurface.ready.then((result) => {
      if (result.ok) console.log('[forgeloop] 已注册业务会话 preset forgeloop')
      else console.warn(`[forgeloop] ${result.reason}`)
    })
    // Web 看板路由可选：无浏览器连接的 profile（headless）保持只有工具。
    registerBoardRoute(ctx, runtime, config, coordinator)
    const summary = runtime.directorySummary() as AnyRecord
    // 启动信息只写宿主日志，不作为业务状态或验收证据。
    console.log(
      `[forgeloop] 已加载 records=${String(summary.database)} project=${config.project} path=${config.projectPath} owner=${coordinator.owner}`,
    )
    return async () => {
      await sessionSurface.dispose()
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