import { asRecord } from '../domain/json.js'
import type { ForgeLoopConfig } from '../config.js'
import { errorMessage } from '../domain/errors.js'
import { BOARD_MAX_LIMIT } from './board.js'
import type { Coordinator } from './coordinator.js'
import type { ForgeLoopRuntime } from './service.js'

const BOARD_ENDPOINTS = [
  'board',
  'detail',
  'session',
  'task',
  'execution',
  'plan',
  'approve',
  'advance',
  'verify',
  'requeue',
  'build',
  'deploy',
  'retry',
  'accept',
  'stop',
  'cancel',
  'ops',
  'ops-detail',
  'ops-decide',
  'ops-close',
  'ops-request-fix',
]

interface BoardBody {
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
  confirmPlanChange?: unknown
  files?: unknown
  query?: unknown
  limit?: unknown
  offset?: unknown
}

interface BoardContext {
  readonly runtime: ForgeLoopRuntime
  readonly config: ForgeLoopConfig
  readonly coordinator: Coordinator
}

interface BoardFailure {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

type BoardOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: BoardFailure }

function boardFailure(code: string, message: string): { ok: false; error: BoardFailure } {
  return { ok: false, error: { code, message, details: {} } }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function textOrUndefined(value: unknown): string | undefined {
  const parsed = text(value)
  return parsed === '' ? undefined : parsed
}

function integerAtLeast(value: number, min: number): boolean {
  return Number.isInteger(value) && value >= min
}

function validPageSize(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 200
}

function boardResponse(body: BoardOutcome, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function handleDetail(body: BoardBody | null, context: BoardContext): Response {
  const { runtime } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '缺少需求身份 reqId'), 400)
  const result = runtime.requirementDetail(reqId)
  if (!result.ok) return boardResponse(boardFailure(result.code, result.message), 404)
  return boardResponse({ ok: true, value: result.data })
}
function handleTask(body: BoardBody | null, context: BoardContext): Response {
  const { runtime } = context
  const reqId = text(body?.reqId)
  const taskId = text(body?.taskId)
  const planVersion = typeof body?.planVersion === 'number' ? body.planVersion : undefined
  if (!reqId || !taskId) {
    return boardResponse(boardFailure('bad_request', '任务详情需要 reqId 与 taskId'), 400)
  }
  const result = runtime.taskDetail(reqId, taskId, planVersion)
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 404,
  )
}
function readExecutionInput(body: BoardBody | null): {
  reqId: string
  taskId: string
  planVersion: number | undefined
  offset: number
  limit: number
} | null {
  const reqId = text(body?.reqId)
  const taskId = text(body?.taskId)
  const planVersion = typeof body?.planVersion === 'number' ? body.planVersion : undefined
  const offset = typeof body?.offset === 'number' ? body.offset : 0
  const limit = typeof body?.limit === 'number' ? body.limit : 100
  if (!reqId || !taskId) return null
  if (!integerAtLeast(offset, 0)) return null
  if (!validPageSize(limit)) return null
  if (planVersion !== undefined && !integerAtLeast(planVersion, 1)) return null
  return { reqId, taskId, planVersion, offset, limit }
}

function handleExecution(body: BoardBody | null, context: BoardContext): Response {
  const { runtime } = context
  const input = readExecutionInput(body)
  if (!input) {
    return boardResponse(
      boardFailure('bad_request', '执行过程需要 reqId、taskId 与合法分页参数'),
      400,
    )
  }
  const result = runtime.taskExecution({
    reqId: input.reqId,
    taskId: input.taskId,
    ...(input.planVersion ? { planVersion: input.planVersion } : {}),
    offset: input.offset,
    limit: input.limit,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 404,
  )
}

function handleSession(body: BoardBody | null, context: BoardContext): Response {
  const { runtime } = context
  const sessionId = text(body?.sessionId)
  if (!sessionId) return boardResponse(boardFailure('bad_request', '缺少会话身份 sessionId'), 400)
  return boardResponse({ ok: true, value: runtime.sessionSummary(sessionId) })
}

function handleRead(
  body: BoardBody | null,
  endpoint: unknown,
  context: BoardContext,
): Response | null {
  if (endpoint === 'detail') return handleDetail(body, context)

  if (endpoint === 'task') return handleTask(body, context)

  if (endpoint === 'execution') return handleExecution(body, context)

  if (endpoint === 'session') return handleSession(body, context)

  return null
}

function handlePlan(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '重新生成任务包需要 reqId'), 400)
  const sessionId = text(body?.sessionId)
  const reason = text(body?.reason)
  const result = runtime.requestOperation({
    reqId,
    action: 'plan',
    by: config.owner,
    source: `web-decision:${sessionId || 'unknown-session'}:plan`,
    ...(body?.confirmPlanChange === true ? { confirmPlanChange: true } : {}),
    ...(reason ? { reason } : {}),
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}
function handleApprove(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  const planVersion = typeof body?.planVersion === 'number' ? body.planVersion : Number.NaN
  if (!reqId || !Number.isInteger(planVersion) || planVersion < 1) {
    return boardResponse(boardFailure('bad_request', '批准需要 reqId 与正整数 planVersion'), 400)
  }
  const sessionId = text(body?.sessionId)
  const result = runtime.approvePlan({
    reqId,
    planVersion,
    by: config.owner,
    source: `web-decision:${sessionId || 'unknown-session'}:plan-v${planVersion}`,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}
function handleAdvance(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '推进需要 reqId'), 400)
  const sessionId = text(body?.sessionId)
  const result = runtime.requestOperation({
    reqId,
    action: 'advance',
    by: config.owner,
    source: `web-decision:${sessionId || 'unknown-session'}:advance`,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}
function handleVerify(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '独立验证需要 reqId'), 400)
  const sessionId = text(body?.sessionId)
  const result = runtime.requestOperation({
    reqId,
    action: 'verify',
    by: config.owner,
    source: `web-decision:${sessionId || 'unknown-session'}:verify`,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}
function handleRequeue(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '重新执行需要 reqId'), 400)
  const sessionId = text(body?.sessionId)
  const result = runtime.requeue({
    reqId,
    by: config.owner,
    source: `web-decision:${sessionId || 'unknown-session'}`,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}
function handleBuild(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '构建候选需要 reqId'), 400)
  const version = textOrUndefined(body?.version)
  const result = runtime.buildCandidate({
    reqId,
    by: config.owner,
    ...(version ? { version } : {}),
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}
function handleDeploy(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  const targetProfile = text(body?.targetProfile)
  if (!reqId || !targetProfile) {
    return boardResponse(boardFailure('bad_request', '上线核对需要 reqId 与 targetProfile'), 400)
  }
  const sessionId = text(body?.sessionId)
  const result = runtime.verifyDeployment({
    reqId,
    targetProfile,
    by: config.owner,
    source: `web-decision:${sessionId || 'unknown-session'}:deploy`,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}
function readRetryInput(body: BoardBody | null): {
  reqId: string
  taskId: string
  planVersion: number
} | null {
  const reqId = text(body?.reqId)
  const taskId = text(body?.taskId)
  const planVersion = typeof body?.planVersion === 'number' ? body.planVersion : Number.NaN
  if (!reqId || !taskId || !Number.isInteger(planVersion) || planVersion < 1) return null
  return { reqId, taskId, planVersion }
}

function handleRetry(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const input = readRetryInput(body)
  if (!input) {
    return boardResponse(
      boardFailure('bad_request', '重试需要 reqId、taskId 与正整数 planVersion'),
      400,
    )
  }
  const sessionId = text(body?.sessionId)
  const result = runtime.retryTask({
    reqId: input.reqId,
    planVersion: input.planVersion,
    taskId: input.taskId,
    by: config.owner,
    source: `web-decision:${sessionId || 'unknown-session'}`,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}

function handleAccept(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '验收需要 reqId'), 400)
  const sessionId = text(body?.sessionId)
  const artifactSha256 = textOrUndefined(body?.artifactSha256)
  const result = runtime.accept({
    reqId,
    by: config.owner,
    source: `web-decision:${sessionId || 'unknown-session'}:accept`,
    ...(artifactSha256 ? { artifactSha256 } : {}),
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}
function handleCancel(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config, coordinator } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '取消需要 reqId'), 400)
  const sessionId = text(body?.sessionId)
  const reason = text(body?.reason)
  coordinator.abortRequirement(reqId)
  const result = runtime.cancel({
    reqId,
    by: config.owner,
    reason: reason || `Web 取消请求（${sessionId || 'unknown-session'}）`,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}
function handleStop(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config, coordinator } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '停止需要 reqId'), 400)
  const reason = text(body?.reason)
  const aborted = coordinator.abortRequirement(reqId)
  const result = runtime.stop({
    reqId,
    by: config.owner,
    reason: reason || 'Web 停止请求',
  })
  return boardResponse(
    result.ok
      ? { ok: true, value: { ...(asRecord(result.data) ?? {}), aborted } }
      : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}

function handleWrite(
  body: BoardBody | null,
  endpoint: unknown,
  context: BoardContext,
): Response | null {
  if (endpoint === 'plan') return handlePlan(body, context)

  if (endpoint === 'approve') return handleApprove(body, context)

  if (endpoint === 'advance') return handleAdvance(body, context)

  if (endpoint === 'verify') return handleVerify(body, context)

  if (endpoint === 'requeue') return handleRequeue(body, context)

  if (endpoint === 'build') return handleBuild(body, context)

  if (endpoint === 'deploy') return handleDeploy(body, context)

  if (endpoint === 'retry') return handleRetry(body, context)

  if (endpoint === 'accept') return handleAccept(body, context)

  if (endpoint === 'cancel') return handleCancel(body, context)

  if (endpoint === 'stop') return handleStop(body, context)

  return null
}

function handleOpsOverview(_body: BoardBody | null, context: BoardContext): Response {
  const { runtime } = context
  const result = runtime.opsStatus()
  return boardResponse({ ok: true, value: result.data })
}
function handleOpsDetail(body: BoardBody | null, context: BoardContext): Response {
  const { runtime } = context
  const eventId = text(body?.eventId)
  if (!eventId) return boardResponse(boardFailure('bad_request', '缺少运维事件 eventId'), 400)
  const result = runtime.opsStatus(eventId)
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 404,
  )
}
function readOpsDecision(body: BoardBody | null): 'approve' | 'decline' | null {
  return body?.decision === 'approve' || body?.decision === 'decline' ? body.decision : null
}

function handleOpsDecide(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const eventId = text(body?.eventId)
  const decision = readOpsDecision(body)
  if (!eventId || !decision) {
    return boardResponse(
      boardFailure('bad_request', '处置决定需要 eventId 与 approve/decline'),
      400,
    )
  }
  const sessionId = text(body?.sessionId)
  const reason = text(body?.reason)
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
function handleOpsClose(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const eventId = text(body?.eventId)
  if (!eventId) return boardResponse(boardFailure('bad_request', '关闭事件需要 eventId'), 400)
  const sessionId = text(body?.sessionId)
  const reason = text(body?.reason)
  const result = runtime.opsClose({
    eventId,
    by: config.owner,
    reason: reason || `Web 关闭（${sessionId || 'unknown-session'}）`,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}
function handleOpsRequestFix(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const eventId = text(body?.eventId)
  if (!eventId) return boardResponse(boardFailure('bad_request', '生成修复需求需要 eventId'), 400)
  const sessionId = text(body?.sessionId)
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

function handleOps(
  body: BoardBody | null,
  endpoint: unknown,
  context: BoardContext,
): Response | null {
  if (endpoint === 'ops') return handleOpsOverview(body, context)

  if (endpoint === 'ops-detail') return handleOpsDetail(body, context)

  if (endpoint === 'ops-decide') return handleOpsDecide(body, context)

  if (endpoint === 'ops-close') return handleOpsClose(body, context)

  if (endpoint === 'ops-request-fix') return handleOpsRequestFix(body, context)

  return null
}

function handleBoardQuery(body: BoardBody | null, runtime: ForgeLoopRuntime): Response {
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
}

/** 看板与客户决定的唯一认证入口；模型工具不能调用。 */
export function createBoardFetch(
  runtime: ForgeLoopRuntime,
  config: ForgeLoopConfig,
  coordinator: Coordinator,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return boardResponse(boardFailure('bad_request', '请求体不是 JSON'), 400)
    }
    const body = payload as BoardBody | null
    const endpoint = body?.endpoint
    if (!BOARD_ENDPOINTS.includes(String(endpoint))) {
      return boardResponse(boardFailure('not_found', `未知的看板端点 ${String(endpoint)}`), 404)
    }
    const context: BoardContext = { runtime, config, coordinator }
    try {
      return (
        handleRead(body, endpoint, context) ??
        handleWrite(body, endpoint, context) ??
        handleOps(body, endpoint, context) ??
        handleBoardQuery(body, runtime)
      )
    } catch (error) {
      return boardResponse(boardFailure('internal', `看板读取失败：${errorMessage(error)}`), 500)
    }
  }
}
