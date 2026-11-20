import { asRecord } from '../domain/json.js'
import type { ForgeLoopConfig } from '../config.js'
import { errorMessage } from '../domain/errors.js'
import { parseReliabilityWindow } from '../domain/reliability.js'
import { attentionView, BOARD_MAX_LIMIT } from './board.js'
import type { Coordinator } from './coordinator.js'
import type { ForgeLoopRuntime } from './service.js'
import { extendWorkBudget } from './budget.js'
import { grantFailureRounds } from './grants.js'
import { resolveCommitment } from './commitment-decisions.js'
import { buildIdentity } from './identity.js'
import { loadLibrary } from './library-docs.js'
import { libraryRebuildOf } from './library-rebuild-registry.js'
import { deliveryMetricsSnapshot, recordHumanIntervention } from './delivery-metrics.js'

const BOARD_ENDPOINTS = [
  'board',
  'attention',
  'detail',
  'session',
  'task',
  'execution',
  'plan',
  'approve',
  'advance',
  'verify',
  'requeue',
  'extend-budget',
  'grant-rounds',
  'retry-analysis',
  'resolve-commitment',
  'build',
  'deploy',
  'deployments',
  'deployment',
  'deployment-intent',
  'deployment-approve',
  'deployment-reject',
  'deployment-verify',
  'deployment-rollback',
  'retry',
  'accept',
  'stop',
  'cancel',
  'reliability',
  'delivery-metrics',
  'library',
  'library-entry',
  'library-rebuild-run',
  'library-rebuild-status',
  'library-rebuild-cancel',
  'library-rebuild-confirm',
  'ops',
  'ops-detail',
  'ops-decide',
  'ops-close',
  'ops-request-fix',
  'intervention',
]

type BoardBody = Record<string, unknown>

export interface BoardWorkspace {
  readonly id: string
  readonly title: string
  readonly path: string
}

export interface BoardContext {
  readonly runtime: ForgeLoopRuntime
  readonly config: ForgeLoopConfig
  readonly coordinator: Coordinator
  readonly workspace?: BoardWorkspace | undefined
}

export type BoardScopeSource = (sessionId: string) => Promise<BoardContext | undefined>

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
  if (endpoint === 'attention') return handleAttention(body, context)

  if (endpoint === 'detail') return handleDetail(body, context)

  if (endpoint === 'task') return handleTask(body, context)

  if (endpoint === 'execution') return handleExecution(body, context)

  if (endpoint === 'session') return handleSession(body, context)

  if (endpoint === 'reliability') return handleReliability(body, context)

  if (endpoint === 'library') return handleLibrary(context)

  if (endpoint === 'library-entry') return handleLibraryEntry(body, context)

  if (endpoint === 'library-rebuild-status') return handleLibraryRebuildStatus(body, context)

  if (endpoint === 'deployments') return handleDeployments(body, context)

  if (endpoint === 'deployment') return handleDeployment(body, context)

  if (endpoint === 'delivery-metrics') return handleDeliveryMetrics(body, context)

  return null
}

function handleDeliveryMetrics(body: BoardBody | null, context: BoardContext): Response {
  const cutoff = text(body?.cutoff)
  const result = deliveryMetricsSnapshot(context.runtime, cutoff ? { cutoff } : {})
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 400,
  )
}

function deploymentStatus(code: string): number {
  if (code === 'forbidden') return 403
  if (code === 'not_found') return 404
  if (code === 'bad_request') return 400
  if (code === 'requirement_required') return 400
  return 409
}

function handleDeployments(body: BoardBody | null, context: BoardContext): Response {
  let limit = 20
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
  return boardResponse({ ok: true, value: context.runtime.deploymentService.rollouts(limit) })
}

function handleDeployment(body: BoardBody | null, context: BoardContext): Response {
  const intentId = text(body?.intentId)
  if (!intentId) return boardResponse(boardFailure('bad_request', '部署详情需要 intentId'), 400)
  const value = context.runtime.deploymentService.rollout(intentId)
  if (!value) return boardResponse(boardFailure('not_found', `未找到部署 ${intentId}`), 404)
  return boardResponse({ ok: true, value })
}

async function handleDeploymentIntent(
  body: BoardBody | null,
  context: BoardContext,
): Promise<Response> {
  const targetId = text(body?.targetId)
  if (!targetId) return boardResponse(boardFailure('bad_request', '部署提议需要 targetId'), 400)
  const requirementId = text(body?.reqId)
  const sessionId = text(body?.sessionId)
  const result = await context.runtime.deploymentService.request({
    targetId,
    ...(requirementId ? { requirementId } : {}),
    by: context.config.owner,
    source: `web-decision:${sessionId || 'unknown-session'}:deployment-intent`,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : deploymentStatus(result.code),
  )
}

async function handleDeploymentApprove(
  body: BoardBody | null,
  context: BoardContext,
): Promise<Response> {
  const intentId = text(body?.intentId)
  if (!intentId) return boardResponse(boardFailure('bad_request', '批准部署需要 intentId'), 400)
  const result = await context.runtime.deploymentService.approve({
    intentId,
    by: context.config.owner,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : deploymentStatus(result.code),
  )
}

function handleDeploymentReject(body: BoardBody | null, context: BoardContext): Response {
  const intentId = text(body?.intentId)
  if (!intentId) return boardResponse(boardFailure('bad_request', '拒绝部署需要 intentId'), 400)
  const result = context.runtime.deploymentService.reject({
    intentId,
    by: context.config.owner,
    reason: text(body?.reason),
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : deploymentStatus(result.code),
  )
}

async function handleDeploymentVerify(
  body: BoardBody | null,
  context: BoardContext,
): Promise<Response> {
  const intentId = text(body?.intentId)
  if (!intentId) return boardResponse(boardFailure('bad_request', '核对部署需要 intentId'), 400)
  const result = await context.runtime.deploymentService.verify({
    intentId,
    by: context.config.owner,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : deploymentStatus(result.code),
  )
}

async function handleDeploymentRollback(
  body: BoardBody | null,
  context: BoardContext,
): Promise<Response> {
  const intentId = text(body?.intentId)
  if (!intentId) return boardResponse(boardFailure('bad_request', '回退部署需要 intentId'), 400)
  const result = await context.runtime.deploymentService.rollback({
    intentId,
    by: context.config.owner,
    reason: text(body?.reason),
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : deploymentStatus(result.code),
  )
}

function handleReliability(body: BoardBody | null, context: BoardContext): Response {
  const window = parseReliabilityWindow(body?.window)
  if (!window) {
    return boardResponse(boardFailure('bad_request', '可靠性窗口只能是 7d、30d、90d 或 all'), 400)
  }
  return boardResponse({ ok: true, value: context.runtime.reliability(window) })
}

function handleLibrary(context: BoardContext): Response {
  const projectPath = context.config.projectPath
  if (typeof projectPath !== 'string' || !projectPath) {
    return boardResponse(boardFailure('bad_request', '项目路径未配置，无法读取需求库'), 400)
  }
  try {
    const loaded = loadLibrary(projectPath)
    return boardResponse({
      ok: true,
      value: {
        entries: loaded.entries.map((item) => ({
          id: item.entry.id,
          title: item.entry.title,
          status: item.entry.status,
          topics: item.entry.topics,
          summary: item.entry.summary,
          always: item.entry.always,
          path: item.entry.path,
          ref: item.entry.ref,
          source: item.entry.source,
          updatedAt: item.entry.updatedAt,
          bytes: item.bytes,
        })),
        warnings: loaded.warnings,
      },
    })
  } catch (error) {
    return boardResponse(boardFailure('bad_request', `需求库不可用：${errorMessage(error)}`), 400)
  }
}

function handleLibraryEntry(body: BoardBody | null, context: BoardContext): Response {
  const projectPath = context.config.projectPath
  if (typeof projectPath !== 'string' || !projectPath) {
    return boardResponse(boardFailure('bad_request', '项目路径未配置，无法读取需求库'), 400)
  }
  const entryId = text(body?.entryId)
  if (!entryId) {
    return boardResponse(boardFailure('bad_request', '读取需求库正文需要 entryId'), 400)
  }
  let loaded
  try {
    loaded = loadLibrary(projectPath)
  } catch (error) {
    return boardResponse(boardFailure('bad_request', `需求库不可用：${errorMessage(error)}`), 400)
  }
  const found = loaded.entries.find((item) => item.entry.id === entryId)
  if (!found) {
    return boardResponse(boardFailure('not_found', `需求库没有条目 ${entryId}`), 404)
  }
  return boardResponse({
    ok: true,
    value: {
      id: found.entry.id,
      title: found.entry.title,
      status: found.entry.status,
      path: found.entry.path,
      ref: found.entry.ref,
      bytes: found.bytes,
      content: found.content,
    },
  })
}

function handleLibraryRebuildStatus(body: BoardBody | null, context: BoardContext): Response {
  const runId = text(body?.runId)
  const run = libraryRebuildOf(context.runtime).status(runId || undefined)
  return boardResponse(
    run ? { ok: true, value: run } : boardFailure('not_found', '该项目尚未运行过需求库重建'),
    run ? 200 : 404,
  )
}

function handleLibraryRebuildRun(body: BoardBody | null, context: BoardContext): Response {
  const sessionId = text(body?.sessionId)
  try {
    const started = libraryRebuildOf(context.runtime).start({
      by: context.config.owner,
      source: `web-decision:${sessionId || 'unknown-session'}:library-rebuild`,
    })
    return boardResponse({ ok: true, value: started })
  } catch (error) {
    return boardResponse(boardFailure('conflict', errorMessage(error)), 409)
  }
}

function handleLibraryRebuildCancel(body: BoardBody | null, context: BoardContext): Response {
  const runId = text(body?.runId)
  if (!runId) {
    return boardResponse(boardFailure('bad_request', '取消需求库重建需要 runId'), 400)
  }
  const cancelled = libraryRebuildOf(context.runtime).cancel(runId)
  return boardResponse({ ok: true, value: { cancelled, runId } })
}

function handleLibraryRebuildConfirm(body: BoardBody | null, context: BoardContext): Response {
  const runId = text(body?.runId)
  const sessionId = text(body?.sessionId)
  try {
    const result = libraryRebuildOf(context.runtime).confirm(
      runId || undefined,
      `owner-confirm:web-decision:${sessionId || 'unknown-session'}`,
    )
    return boardResponse({ ok: true, value: result })
  } catch (error) {
    return boardResponse(boardFailure('conflict', errorMessage(error)), 409)
  }
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
  if (!reqId) return boardResponse(boardFailure('bad_request', '独立测试需要 reqId'), 400)
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
function handleGrantRounds(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '追加授权需要 reqId'), 400)
  const sessionId = text(body?.sessionId)
  const result = grantFailureRounds(runtime.repo, {
    reqId,
    by: config.owner,
    source: `web-decision:${sessionId || 'unknown-session'}:grant-rounds`,
  })
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}

function readCommitmentDecision(body: BoardBody | null): 'revise' | 'replace' | 'reject' | null {
  return body?.decision === 'revise' || body?.decision === 'replace' || body?.decision === 'reject'
    ? body.decision
    : null
}

function handleResolveCommitment(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  const existingReqId = text(body?.existingReqId)
  const decision = readCommitmentDecision(body)
  if (!reqId || !existingReqId || !decision) {
    return boardResponse(
      boardFailure('bad_request', '承诺决定需要 reqId、existingReqId 与 revise/replace/reject'),
      400,
    )
  }
  const sessionId = text(body?.sessionId)
  const result = resolveCommitment(
    { repo: runtime.repo, owner: config.owner, now: () => new Date().toISOString() },
    {
      reqId,
      existingReqId,
      decision,
      reason: text(body?.reason),
      by: config.owner,
      source: `web-decision:${sessionId || 'unknown-session'}:commitment-${decision}`,
      ...(textOrUndefined(body?.decisionId) ? { decisionId: text(body?.decisionId) } : {}),
    },
  )
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    result.ok ? 200 : 409,
  )
}

function handleExtendBudget(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '延长工时需要 reqId'), 400)
  const seconds = Number(body?.seconds)
  const sessionId = text(body?.sessionId)
  const result = extendWorkBudget(runtime.repo, {
    reqId,
    seconds,
    by: config.owner,
    source: `web-decision:${sessionId || 'unknown-session'}:extend-budget`,
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
function handleRetryAnalysis(body: BoardBody | null, context: BoardContext): Response {
  const { runtime, config } = context
  const reqId = text(body?.reqId)
  if (!reqId) return boardResponse(boardFailure('bad_request', '重新分析需要 reqId'), 400)
  const sessionId = text(body?.sessionId)
  const result = runtime.analysisQueue.retry({
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
): Response | Promise<Response> | null {
  if (endpoint === 'deployment-intent') return handleDeploymentIntent(body, context)

  if (endpoint === 'library-rebuild-run') return handleLibraryRebuildRun(body, context)

  if (endpoint === 'library-rebuild-cancel') return handleLibraryRebuildCancel(body, context)

  if (endpoint === 'library-rebuild-confirm') return handleLibraryRebuildConfirm(body, context)

  if (endpoint === 'deployment-approve') return handleDeploymentApprove(body, context)

  if (endpoint === 'deployment-reject') return handleDeploymentReject(body, context)

  if (endpoint === 'deployment-verify') return handleDeploymentVerify(body, context)

  if (endpoint === 'deployment-rollback') return handleDeploymentRollback(body, context)

  if (endpoint === 'resolve-commitment') return handleResolveCommitment(body, context)

  if (endpoint === 'intervention') return handleIntervention(body, context)

  return handleLegacyWrite(body, endpoint, context)
}

function handleIntervention(body: BoardBody | null, context: BoardContext): Response {
  const reqId = text(body?.reqId)
  const reason = text(body?.reason)
  const startedAt = text(body?.startedAt)
  if (!reqId || !reason || !startedAt) {
    return boardResponse(
      boardFailure('bad_request', '人工处理记录需要 reqId、reason 与 startedAt'),
      400,
    )
  }
  const sessionId = text(body?.sessionId)
  const result = recordHumanIntervention(context.runtime, {
    reqId,
    reason,
    startedAt,
    actor: context.config.owner,
    source: `web-decision:${sessionId || 'owner'}`,
  })
  const status = result.ok ? 200 : result.code === 'not_found' ? 404 : 400
  return boardResponse(
    result.ok ? { ok: true, value: result.data } : boardFailure(result.code, result.message),
    status,
  )
}

function handleLegacyWrite(
  body: BoardBody | null,
  endpoint: unknown,
  context: BoardContext,
): Response | null {
  if (endpoint === 'plan') return handlePlan(body, context)

  if (endpoint === 'approve') return handleApprove(body, context)

  if (endpoint === 'advance') return handleAdvance(body, context)

  if (endpoint === 'verify') return handleVerify(body, context)

  if (endpoint === 'requeue') return handleRequeue(body, context)

  if (endpoint === 'extend-budget') return handleExtendBudget(body, context)

  if (endpoint === 'grant-rounds') return handleGrantRounds(body, context)

  if (endpoint === 'retry-analysis') return handleRetryAnalysis(body, context)

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

/** 可选的分页参数：缺省合法，给出时必须是范围内的整数。 */
function isOptionalCounter(value: unknown, min: number, max: number): value is number | undefined {
  if (value === undefined) return true
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/** 待办筛选只接受三种取值；其他输入一律拒绝，不做默认猜测。 */
function isAttentionPriority(value: unknown): value is 'all' | 'blocked' | 'input' {
  return value === 'all' || value === 'blocked' || value === 'input'
}

/**
 * 全项目待办队列：只读分页；入口计数来自同一聚合的 total。
 * offset 允许超过总数（返回空页），便于翻页后记录减少时继续收敛。
 */
function handleAttention(body: BoardBody | null, context: BoardContext): Response {
  const offset = body?.offset
  if (!isOptionalCounter(offset, 0, Number.MAX_SAFE_INTEGER)) {
    return boardResponse(boardFailure('bad_request', 'offset 必须是不小于 0 的整数'), 400)
  }
  const limit = body?.limit
  if (!isOptionalCounter(limit, 1, BOARD_MAX_LIMIT)) {
    return boardResponse(
      boardFailure('bad_request', `limit 必须是 1..${BOARD_MAX_LIMIT} 的整数`),
      400,
    )
  }
  const priority = body?.priority === undefined ? 'all' : body.priority
  if (!isAttentionPriority(priority)) {
    return boardResponse(boardFailure('bad_request', 'priority 只能是 all、blocked 或 input'), 400)
  }
  const reqId = text(body?.reqId)
  const value = attentionView(context.runtime, {
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
    priority,
    ...(reqId ? { reqId } : {}),
  })
  return boardResponse({ ok: true, value })
}

function handleBoardQuery(body: BoardBody | null, context: BoardContext): Response {
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
  const value = context.runtime.statusBoard(limit, query)
  // 单项目模式保留运行时自己的全局身份，避免改变既有响应。
  const scopedBuild = context.workspace
    ? buildIdentity(context.config.projectPath, context.config.clientEntryFile)
    : undefined
  return boardResponse({
    ok: true,
    value: {
      ...value,
      ...(scopedBuild ? { build: scopedBuild } : {}),
      ...(context.workspace ? { workspace: context.workspace } : {}),
    },
  })
}

export function createBoardFetch(
  runtime: ForgeLoopRuntime,
  config: ForgeLoopConfig,
  coordinator: Coordinator,
): (request: Request) => Promise<Response> {
  return createBoardHandler(async () => ({ runtime, config, coordinator }), false)
}

/**
 * 多工作区看板：每个请求都必须给出会话身份，服务端按该会话的工作区选择记录库与
 * 协调器。请求体里的任何工作区标识都不作数，也不存在“全局看板”——缺少会话或
 * 会话未绑定工作区时直接拒绝。
 */
export function createScopedBoardFetch(
  source: BoardScopeSource,
): (request: Request) => Promise<Response> {
  return createBoardHandler(source, true)
}

function createBoardHandler(
  source: BoardScopeSource,
  scoped: boolean,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return boardResponse(boardFailure('bad_request', '请求体不是 JSON'), 400)
    }
    const body: BoardBody | null = asRecord(payload) ?? null
    const endpoint = body?.endpoint
    if (!BOARD_ENDPOINTS.includes(String(endpoint))) {
      return boardResponse(boardFailure('not_found', `未知的看板端点 ${String(endpoint)}`), 404)
    }
    let context: BoardContext
    if (scoped) {
      const sessionId = text(body?.sessionId)
      if (!sessionId) {
        return boardResponse(
          boardFailure('session_required', '看板请求缺少会话身份 sessionId'),
          400,
        )
      }
      const resolved = await source(sessionId)
      if (!resolved) {
        return boardResponse(
          boardFailure(
            'workspace_unbound',
            '当前会话没有绑定 DSH 工作区；ForgeLoop 不跨工作区读取或写入',
          ),
          403,
        )
      }
      context = resolved
    } else {
      const resolved = await source('')
      if (!resolved) {
        return boardResponse(boardFailure('internal', '看板作用域未就绪'), 500)
      }
      context = resolved
    }
    try {
      const handled =
        handleRead(body, endpoint, context) ??
        handleWrite(body, endpoint, context) ??
        handleOps(body, endpoint, context) ??
        handleBoardQuery(body, context)
      return handled instanceof Promise ? await handled : handled
    } catch (error) {
      return boardResponse(boardFailure('internal', `看板读取失败：${errorMessage(error)}`), 500)
    }
  }
}
