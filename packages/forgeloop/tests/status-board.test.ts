import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { MAX_ROUNDS_PER_GRANT } from '../src/domain/counting.js'
import { candidateIdentityOf, sha256OfText } from '../src/domain/delivery.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import {
  BOARD_TASK_AWAITING_INPUT,
  BOARD_TASK_DELIVERED,
  BOARD_TASK_PENDING,
  buildProjectFacts,
  buildStatusBoard,
  requirementTitle,
  taskIdOfFailureRound,
} from '../src/runtime/board.js'

const PROJECT = 'forgeloop'
const NOW = '2026-10-23T10:00:00.000Z'

let dir = ''
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-board-'))
  repository = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function submit(reqId: string, text = '状态看板', createdAt = '2026-10-23T00:00:00.000Z'): string {
  repository.submit({
    reqId,
    project: PROJECT,
    text,
    submittedBy: 'owner',
    source: 'test',
    now: createdAt,
  })
  return reqId
}

function plan(reqId: string, planVersion = 1, requirementVersion = 1): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}-${planVersion}`,
    requirementId: reqId,
    project: PROJECT,
    planVersion,
    requirementVersion,
    createdAt: '2026-10-23T00:00:01.000Z',
    tasks: [
      {
        taskId: 't1',
        goal: '写文档',
        files: ['docs/a.md'],
        acceptance: 'a 存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
      {
        taskId: 't2',
        goal: '补测试',
        files: ['docs/b.md'],
        acceptance: 'b 存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: ['t1'],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
    ],
  }
}

function deliver(reqId: string, taskId: string, planVersion = 1): void {  repository.recordTaskArtifact({
    requirementId: reqId,
    planVersion,
    taskId,
    candidateSha256: `candidate-${taskId}`,
    testEvidenceSha256: `test-${taskId}`,
    reviewSha256: `review-${taskId}`,
    acceptance: '达成',
    authorizationSource: `plan-approval:${reqId}:v${planVersion}:owner`,
    recordedAt: NOW,
    baselineCommit: 'abc123',
  })
}

function analyze(reqId: string, clarifications: string[], analysisVersion = 1): void {
  repository.recordAnalysis({
    reqId,
    analysisVersion,
    requirementVersion: 1,
    goal: '目标',
    scenarios: ['场景'],
    acceptanceCriteria: ['标准'],
    clarifications,
    createdAt: '2026-10-23T00:00:02.000Z',
  })
}

function board(options?: number | { limit?: number; query?: string }) {
  const normalized = typeof options === 'number' ? { limit: options } : (options ?? {})
  return buildStatusBoard({ repository, project: PROJECT, now: NOW, ...normalized })
}

/** 计划评审是批准的硬门禁：看板只在评审通过时提供“批准”。 */
function seedPlanReview(
  reqId: string,
  planVersion = 1,
  verdict: 'pass' | 'block' = 'pass',
): void {
  const stored = repository.taskPlan(reqId, planVersion)!
  const planSha256 = sha256OfText(JSON.stringify(stored))
  const review = {
    kind: 'plan-review',
    reqId,
    planVersion,
    requirementVersion: stored.requirementVersion,
    planSha256,
    verdict,
    blocking: verdict === 'pass' ? [] : ['任务包没有覆盖验收标准'],
    findings: [],
    summary: verdict === 'pass' ? '任务包可进入实现' : '任务包阻断',
    verification_plan: [
      {
        scenario: '场景',
        acceptance_criterion: '标准',
        method: '在独立候选上执行测试',
        required: true,
      },
    ],
    sessionId: 'session-plan-review',
    at: NOW,
  }
  const reportJson = `${JSON.stringify(review, null, 2)}\n`
  const reportPath = join(dir, `plan-review-${reqId}-v${planVersion}.json`)
  writeFileSync(reportPath, reportJson, 'utf8')
  repository.recordPlanReview({
    requirementId: reqId,
    planVersion,
    requirementVersion: stored.requirementVersion,
    planSha256,
    verdict,
    reportJson,
    reportPath,
    reportSha256: sha256OfText(reportJson),
    sessionId: review.sessionId,
    reviewedAt: NOW,
  })
}

/** 独立验证绑定固定候选；新鲜度决定看板是否还提供“独立验证”。 */
function seedVerification(reqId: string, planVersion = 1, verdict: 'pass' | 'block' = 'pass'): string {
  const plan = repository.taskPlan(reqId, planVersion)!
  const artifacts = plan.tasks.map((task) => repository.taskArtifact(reqId, planVersion, task.taskId)!)
  const candidateSha256 = candidateIdentityOf({
    planVersion,
    requirementVersion: plan.requirementVersion,
    baselineCommit: artifacts[0]?.baselineCommit ?? '',
    candidateHashes: artifacts.map((artifact) => artifact.candidateSha256),
  })
  const report = {
    kind: 'verification',
    reqId,
    planVersion,
    requirementVersion: plan.requirementVersion,
    candidateSha256,
    workspaceSha256: 'tree',
    planReviewSha256: 'plan-review',
    verdict,
    summary: verdict === 'pass' ? '候选通过独立验证' : '候选未通过独立验证',
    findings: [],
    blocking: verdict === 'pass' ? [] : ['必过场景未通过'],
    scenarios: [{ scenario: '场景', status: verdict === 'pass' ? 'pass' : 'fail', evidence: '正式测试', commands: ['smoke'] }],
    commands: [],
    sessionId: 'session-verification',
    at: NOW,
  }
  const reportJson = `${JSON.stringify(report, null, 2)}\n`
  const reportPath = join(dir, `verification-${reqId}-v${planVersion}.json`)
  writeFileSync(reportPath, reportJson, 'utf8')
  repository.recordVerification({
    requirementId: reqId,
    planVersion,
    candidateSha256,
    requirementVersion: plan.requirementVersion,
    workspaceSha256: 'tree',
    verdict,
    reportJson,
    reportPath,
    reportSha256: sha256OfText(reportJson),
    evidenceDir: dir,
    sessionId: report.sessionId,
    verifiedAt: NOW,
  })
  return candidateSha256
}

describe('status board', () => {
  it('reports an empty project without inventing entries', () => {
    const view = board()
    expect(view.project).toBe(PROJECT)
    expect(view.generatedAt).toBe(NOW)
    expect(view.summary).toEqual({ requirements: 0, active: 0, tasks: 0, delivered: 0, issues: 0, blocking: 0 })
    expect(view.requirements).toEqual([])
    expect(view.tasks).toEqual([])
    expect(view.issues).toEqual([])
  })

  it('lists a requirement before planning with explicit gaps instead of guessed state', () => {
    submit('req-1', '给会话区加一个需求页')
    const view = board()
    expect(view.requirements).toHaveLength(1)
    const requirement = view.requirements[0]!
    expect(requirement.status).toBe('draft')
    expect(requirement.planVersion).toBeNull()
    expect(requirement.approval).toBe('none')
    expect(requirement.progress.total).toBe(0)
    expect(requirement.title).toBe('给会话区加一个需求页')
    expect(view.tasks).toEqual([])
  })

  it('derives task state from artifacts and task runs, not from requirement status alone', () => {
    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId))
    repository.setStatus(reqId, 'executing')
    deliver(reqId, 't1')

    const view = board()
    expect(view.tasks.map((task) => [task.taskId, task.state])).toEqual([
      ['t1', BOARD_TASK_DELIVERED],
      ['t2', BOARD_TASK_PENDING],
    ])
    expect(view.requirements[0]!.progress).toMatchObject({ total: 2, delivered: 1, pending: 1 })
    expect(view.summary.delivered).toBe(1)
  })

  it('surfaces a failed task run as a failed task and a failure-round issue', () => {
    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId))
    repository.setStatus(reqId, 'executing')
    repository.recordTaskRun({
      requirementId: reqId,
      planVersion: 1,
      taskId: 't1',
      state: 'failed',
      reason: '正式测试退出码 1',
      executedSeconds: 12,
      updatedAt: NOW,
    })
    repository.recordFailureRound(reqId, {
      roundId: 'round-1',
      stage: 'formal_test',
      summary: '正式测试退出码 1',
      occurredAt: NOW,
    })

    const view = board()
    expect(view.tasks[0]!.state).toBe('failed')
    expect(view.tasks[0]!.failureReason).toBe('正式测试退出码 1')
    const actions = view.tasks[0]!.failureAdvice?.actions.join('\n') ?? ''
    expect(actions).toContain('正式测试日志')
    expect(actions).toContain('重试')
    expect(view.requirements[0]!.progress.failed).toBe(1)
    const issue = view.issues.find((candidate) => candidate.kind === 'failure_round')
    expect(issue).toMatchObject({ reqId, severity: 'attention', title: '正式测试退出码 1' })
    expect(issue?.detail).toContain(String(MAX_ROUNDS_PER_GRANT - 1))
  })

  it('blocks once the automatic failure-round budget is exhausted', () => {
    const reqId = submit('req-1')
    for (let index = 0; index < MAX_ROUNDS_PER_GRANT; index += 1) {
      repository.recordFailureRound(reqId, {
        roundId: `round-${index}`,
        stage: 'formal_test',
        summary: `第 ${index + 1} 轮失败`,
        occurredAt: `2026-10-23T0${index}:00:00.000Z`,
      })
    }
    const view = board()
    const requirement = view.requirements[0]!
    expect(requirement.remainingRounds).toBe(0)
    const issue = view.issues.find((candidate) => candidate.kind === 'failure_round')
    expect(issue?.severity).toBe('blocking')
    expect(issue?.title).toBe(`第 ${MAX_ROUNDS_PER_GRANT} 轮失败`)
    expect(view.summary.blocking).toBe(1)
  })

  it('turns analysis clarifications into blocking issues and waits for an answer', () => {
    const reqId = submit('req-1')
    analyze(reqId, ['看板展示哪些项目？', '是否需要手动刷新？'])
    repository.setStatus(reqId, 'awaiting_clarification')

    const view = board()
    const clarifications = view.issues.filter((issue) => issue.kind === 'clarification')
    expect(clarifications).toHaveLength(2)
    expect(new Set(clarifications.map((issue) => issue.issueId)).size).toBe(2)
    expect(clarifications.every((issue) => issue.severity === 'blocking')).toBe(true)
    expect(view.requirements[0]!.clarifications).toBe(2)
  })

  it('shows a proposed plan waiting for approval without treating it as approved', () => {
    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId))
    repository.setStatus(reqId, 'plan_proposed')
    seedPlanReview(reqId)

    const view = board()
    expect(view.requirements[0]!.approval).toBe('missing')
    expect(view.requirements[0]!.planReview?.verdict).toBe('pass')
    const issue = view.issues.find((candidate) => candidate.kind === 'approval')
    expect(issue).toMatchObject({ reqId, severity: 'attention', title: '任务包 v1 待批准' })
  })

  it('marks an approval for an older plan version as stale', () => {
    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId, 1))
    repository.setStatus(reqId, 'executing')
    repository.recordTaskPlan(plan(reqId, 2))
    repository.setStatus(reqId, 'plan_proposed')
    seedPlanReview(reqId, 2)
    repository.recordPlanApproval({
      requirementId: reqId,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-23T00:00:03.000Z',
      source: 'test',
    })

    const view = board()
    expect(view.requirements[0]!.planVersion).toBe(2)
    expect(view.requirements[0]!.approval).toBe('stale')
    const issue = view.issues.find((candidate) => candidate.kind === 'approval')
    expect(issue?.detail).toContain('旧版本批准不能驱动新任务包')
  })

  it('gates approval on the plan review and verification on the fixed candidate', () => {
    const reqId = submit('req-verify')
    repository.recordTaskPlan(plan(reqId))
    repository.setStatus(reqId, 'plan_proposed')

    let item = board().requirements[0]!
    expect(item.actions).toEqual(['plan', 'cancel'])
    expect(item.planReview).toBeNull()
    expect(board().issues.find((issue) => issue.kind === 'approval')).toMatchObject({
      severity: 'attention',
      title: '任务包 v1 待实现前评审',
    })

    // 评审阻断时不能批准：只保留“重新生成任务包”，并给出阻断原因。
    seedPlanReview(reqId, 1, 'block')
    expect(board().issues.find((issue) => issue.kind === 'approval')).toMatchObject({
      severity: 'blocking',
      title: '任务包 v1 实现前评审阻断',
    })
    expect(board().requirements[0]!.actions).toEqual(['plan', 'cancel'])

    seedPlanReview(reqId)
    expect(board().requirements[0]!.actions).toEqual(['approve', 'cancel'])

    repository.recordPlanApproval({
      requirementId: reqId,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-23T00:00:03.000Z',
      source: 'test',
    })
    repository.setStatus(reqId, 'executing')
    deliver(reqId, 't1')
    deliver(reqId, 't2')
    item = board().requirements[0]!
    expect(item.verification).toBeNull()
    expect(item.actions).toContain('verify')

    // 通过且与当前候选一致的验证结论才算 fresh，之后不再重复提供验证。
    seedVerification(reqId)
    item = board().requirements[0]!
    expect(item.verification).toMatchObject({ verdict: 'pass', fresh: true })
    expect(item.actions).not.toContain('verify')
  })

  it('freezes an approved plan and never offers plan or replan for it', () => {
    const reqId = submit('req-frozen')
    repository.recordTaskPlan(plan(reqId))
    repository.recordPlanApproval({
      requirementId: reqId,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-23T00:00:03.000Z',
      source: 'test',
    })
    repository.recordTaskRun({
      requirementId: reqId,
      planVersion: 1,
      taskId: 't1',
      state: 'failed',
      reason: '正式测试失败（退出码 1）',
      executedSeconds: 1,
      updatedAt: NOW,
    })
    repository.setStatus(reqId, 'blocked', '任务失败，等待决定')

    const requirement = board().requirements.find((item) => item.reqId === reqId)!
    expect(requirement.actions).not.toContain('plan')
    expect(requirement.actions).not.toContain('replan')
    expect(requirement.actions).toContain('cancel')

    repository.setStatus(reqId, 'cancelled')
    expect(board().requirements.find((item) => item.reqId === reqId)?.actions).toEqual([])
  })

  it('does not keep a delivered task failure round in first-screen attention', () => {
    const reqId = submit('req-delivered-history')
    repository.recordTaskPlan(plan(reqId))
    repository.recordPlanApproval({
      requirementId: reqId,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-23T00:00:03.000Z',
      source: 'test',
    })
    deliver(reqId, 't1')
    repository.recordFailureRound(reqId, {
      roundId: 't1-a1',
      stage: 'formal_test',
      summary: '交付前的旧失败',
      occurredAt: '2026-10-23T00:00:04.000Z',
    })
    repository.setStatus(reqId, 'executing')
    const view = board()
    expect(view.issues.some((issue) => issue.kind === 'failure_round')).toBe(false)
  })

  it('reports blocked requirements with the recorded reason', () => {
    const reqId = submit('req-1')
    repository.setStatus(reqId, 'blocked', '正式测试连续失败，等待人工核对')

    const view = board()
    const issue = view.issues.find((candidate) => candidate.kind === 'blocked')
    expect(issue).toMatchObject({
      reqId,
      severity: 'blocking',
      title: '正式测试连续失败，等待人工核对',
    })
  })

  it('distinguishes an unknown request from a failed one', () => {
    const reqId = submit('req-1')
    repository.recordRequest({
      requestId: 'request-1',
      reqId,
      project: PROJECT,
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    repository.resolveRequest('request-1', 'unknown', '宿主中断', NOW)

    const unknownView = board()
    const unknownIssue = unknownView.issues.find((issue) => issue.kind === 'request')
    expect(unknownIssue).toMatchObject({ severity: 'blocking', title: '推进请求结果未知' })
    expect(unknownIssue?.detail).toContain('不盲目重放')

    repository.recordRequest({
      requestId: 'request-2',
      reqId,
      project: PROJECT,
      planVersion: 1,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    repository.resolveRequest('request-2', 'failed', '执行器异常', NOW)
    const failedView = board()
    const failedIssue = failedView.issues.find((issue) => issue.title.includes('分析'))
    expect(failedIssue).toMatchObject({ severity: 'attention', title: '分析请求失败' })
  })

  it('keeps accepted requirements visible while dropping their resolved issues', () => {
    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId))
    deliver(reqId, 't1')
    deliver(reqId, 't2')
    repository.setStatus(reqId, 'accepted')
    repository.recordFailureRound(reqId, {
      roundId: 'round-old',
      stage: 'formal_test',
      summary: '历史失败',
      occurredAt: NOW,
    })

    const view = board()
    expect(view.requirements[0]!.status).toBe('accepted')
    expect(view.requirements[0]!.progress.delivered).toBe(2)
    expect(view.issues).toEqual([])
  })

  it('limits listed requirements while summary counts the whole project', () => {
    submit('req-a', '第一条', '2026-10-23T00:00:00.000Z')
    submit('req-b', '第二条', '2026-10-23T00:01:00.000Z')
    submit('req-c', '第三条', '2026-10-23T00:02:00.000Z')

    const view = board(2)
    expect(view.requirements.map((requirement) => requirement.reqId)).toEqual(['req-c', 'req-b'])
    expect(view.summary.requirements).toBe(3)
  })

  it('orders blocking issues before attention ones regardless of time', () => {
    const reqId = submit('req-1')
    analyze(reqId, ['需要澄清'], 1)
    repository.setStatus(reqId, 'blocked', '阻塞原因')
    repository.recordFailureRound(reqId, {
      roundId: 'round-1',
      stage: 'formal_test',
      summary: '较新的失败轮次',
      occurredAt: '2026-10-23T09:00:00.000Z',
    })
    const view = board()
    expect(view.issues.map((issue) => issue.severity)).toEqual(['blocking', 'blocking', 'attention'])
    expect(view.issues[2]!.kind).toBe('failure_round')
  })

  it('truncates long titles without rewriting the stored requirement text', () => {
    const long = `第一行 ${'很长的需求描述'.repeat(20)}\n第二行不参与标题`
    submit('req-1', long)
    const view = board()
    expect(view.requirements[0]!.title.length).toBe(81)
    expect(view.requirements[0]!.title.endsWith('…')).toBe(true)
    const requirement = repository.getRequirement('req-1')!
    expect(requirementTitle({ ...requirement, versions: requirement.versions })).toContain('第一行')
    expect(requirement.versions[0]!.text).toBe(long.trim())
  })

  it('marks a running task waiting for input and keeps the requirement stop/unknown facts separate', () => {
    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId))
    repository.recordPlanApproval({
      requirementId: reqId,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-23T00:00:03.000Z',
      source: 'test',
    })
    repository.setStatus(reqId, 'blocked', '停止请求：等待核对')
    repository.recordTaskRun({
      requirementId: reqId,
      planVersion: 1,
      taskId: 't1',
      state: 'running',
      reason: '正在调用工具 ask_user_question',
      executedSeconds: 3,
      updatedAt: NOW,
    })
    repository.recordRequest({
      requestId: 'request-unknown',
      reqId,
      project: PROJECT,
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    repository.resolveRequest('request-unknown', 'unknown', '宿主停止', NOW)

    const view = board()
    const requirement = view.requirements[0]!
    const task = view.tasks[0]!
    expect(task.state).toBe(BOARD_TASK_AWAITING_INPUT)
    expect(task.resultUnknown).toBe(true)
    expect(requirement.progress.awaitingInput).toBe(1)
    expect(requirement.progress.running).toBe(0)
    expect(requirement.stopRequested).toBe(true)
    expect(requirement.unknownRequests).toBe(1)
    expect(requirement.actions).toEqual(['stop', 'cancel'])
    const blocked = view.issues.find((issue) => issue.kind === 'blocked')
    expect(blocked?.detail).toContain('不能认定已经停稳')
  })

  it('exposes server-judged actions for approval, advance and stop without inventing acceptance', () => {
    const proposed = submit('req-proposed')
    repository.recordTaskPlan(plan(proposed))
    repository.setStatus(proposed, 'plan_proposed')
    seedPlanReview(proposed)
    expect(board().requirements.find((item) => item.reqId === proposed)?.actions).toEqual([
      'approve',
      'cancel',
    ])

    const approved = submit('req-approved')
    repository.recordTaskPlan(plan(approved))
    repository.recordPlanApproval({
      requirementId: approved,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-23T00:00:03.000Z',
      source: 'test',
    })
    repository.setStatus(approved, 'executing')
    repository.recordTaskRun({
      requirementId: approved,
      planVersion: 1,
      taskId: 't1',
      state: 'running',
      reason: '启动开发 Agent',
      executedSeconds: 1,
      updatedAt: NOW,
    })
    const executing = board().requirements.find((item) => item.reqId === approved)!
    // 任务仍在运行/等待输入时不重复提供“推进”；停止与取消仍可用。
    expect(executing.actions).not.toContain('advance')
    expect(executing.actions).toContain('stop')
    expect(executing.actions).toContain('cancel')
    expect(executing.actions).not.toContain('accept')

    // 没有运行中任务时，已批准执行中的需求可以继续推进。
    const idle = submit('req-idle')
    repository.recordTaskPlan(plan(idle))
    repository.recordPlanApproval({
      requirementId: idle,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-23T00:00:03.000Z',
      source: 'test',
    })
    repository.setStatus(idle, 'executing')
    expect(board().requirements.find((item) => item.reqId === idle)?.actions).toContain('advance')
  })

  it('offers recover, build and deploy only when the underlying records allow them', () => {
    // recover：存在 unknown 请求时提供，且不自动重放。
    const recoverReq = submit('req-board-recover')
    repository.recordRequest({
      requestId: 'rq-board-recover',
      reqId: recoverReq,
      project: PROJECT,
      planVersion: 0,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    repository.claimNextRequest('tester', NOW)
    repository.markClaimedUnknown(NOW)
    expect(board().requirements.find((item) => item.reqId === recoverReq)?.actions).toContain('recover')

    // build：已验收、验证与业务终审都新鲜通过，且尚未构建。
    const buildReq = submit('req-board-build')
    repository.recordTaskPlan(plan(buildReq))
    repository.recordPlanApproval({
      requirementId: buildReq,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-23T00:00:03.000Z',
      source: 'test',
    })
    for (const task of plan(buildReq).tasks) {
      repository.recordTaskArtifact({
        requirementId: buildReq,
        planVersion: 1,
        taskId: task.taskId,
        candidateSha256: `candidate-${task.taskId}`,
        testEvidenceSha256: `test-${task.taskId}`,
        reviewSha256: `review-${task.taskId}`,
        acceptance: '完成',
        authorizationSource: `plan-approval:${buildReq}:v1:owner`,
        recordedAt: NOW,
        baselineCommit: 'abc',
      })
    }
    const candidateSha = seedVerification(buildReq, 1, 'pass')
    const verification = repository.verification(buildReq, 1)!
    const reviewJson = `${JSON.stringify({
      kind: 'business-review',
      verdict: 'pass',
      summary: '业务终审通过',
      blocking: [],
      scenarios: [],
      acceptance: [],
    })}\n`
    const reviewPath = join(dir, `business-${buildReq}.json`)
    writeFileSync(reviewPath, reviewJson, 'utf8')
    repository.recordBusinessReview({
      requirementId: buildReq,
      planVersion: 1,
      candidateSha256: candidateSha,
      requirementVersion: 1,
      verificationSha256: verification.reportSha256,
      verdict: 'pass',
      reportJson: reviewJson,
      reportPath: reviewPath,
      reportSha256: sha256OfText(reviewJson),
      sessionId: 'session-business',
      reviewedAt: NOW,
    })
    repository.recordAcceptance({
      reqId: buildReq,
      acceptedBy: 'owner',
      source: 'test',
      fingerprint: 'fingerprint',
      now: NOW,
    })
    expect(board().requirements.find((item) => item.reqId === buildReq)?.actions).toContain('build')

    // deploy：已有候选构建但尚无通过的上线核对。
    repository.recordCandidateBuild({
      reqId: buildReq,
      planVersion: 1,
      candidateSha256: candidateSha,
      verificationSha256: verification.reportSha256,
      packageVersion: '0.1.0',
      artifactSha256: 'artifact',
      tarball: '/tmp/x.tgz',
      files: ['lib/index.js'],
      gitHead: 'abc',
      builtAt: NOW,
      evidenceDir: dir,
    })
    const deployView = board().requirements.find((item) => item.reqId === buildReq)!
    expect(deployView.actions).toContain('deploy')
    expect(deployView.actions).not.toContain('build')
    expect(deployView.candidate).toMatchObject({ packageVersion: '0.1.0', artifactSha256: 'artifact' })

    repository.recordDeployment({
      reqId: buildReq,
      planVersion: 1,
      candidateSha256: candidateSha,
      packageVersion: '0.1.0',
      targetProfile: 'web',
      artifactSha256: 'artifact',
      runtimeVersion: '0.1.0',
      state: 'verified',
      checks: [{ id: 'installed_files', ok: true, detail: 'ok' }],
      evidenceDir: dir,
      recordedBy: 'owner',
      source: 'test',
      recordedAt: NOW,
    })
    const verifiedView = board().requirements.find((item) => item.reqId === buildReq)!
    expect(verifiedView.actions).not.toContain('deploy')
    expect(verifiedView.deployment).toMatchObject({ state: 'verified', targetProfile: 'web' })
    expect(verifiedView.deployment?.failedChecks).toEqual([])

    repository.recordDeployment({
      reqId: buildReq,
      planVersion: 1,
      candidateSha256: candidateSha,
      packageVersion: '0.1.0',
      targetProfile: 'canary',
      artifactSha256: 'artifact',
      runtimeVersion: '0.1.0',
      state: 'failed',
      checks: [
        { id: 'installed_files', ok: false, detail: '内容不一致 lib/index.js' },
        { id: 'running_version', ok: true, detail: 'ok' },
      ],
      evidenceDir: dir,
      recordedBy: 'owner',
      source: 'test',
      recordedAt: '2026-10-23T11:00:00.000Z',
    })
    const failedView = board().requirements.find((item) => item.reqId === buildReq)!
    expect(failedView.deployment?.state).toBe('failed')
    expect(failedView.deployment?.failedChecks).toEqual(['installed_files：内容不一致 lib/index.js'])
    expect(failedView.actions).toContain('deploy')
  })

  it('offers regeneration for a stored plan that violates current rules and stops offering build/deploy once done', () => {
    const legacy = submit('req-board-legacy')
    repository.db.handle
      .prepare(
        'INSERT INTO requirement_task_plans (req_id, plan_version, task_plan_id, plan, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        legacy,
        1,
        `plan-${legacy}-1`,
        JSON.stringify({
          task_plan_id: `plan-${legacy}-1`,
          requirement_id: legacy,
          project: PROJECT,
          plan_version: 1,
          requirement_version: 1,
          created_at: NOW,
          tasks: [
            {
              task_id: 't1',
              goal: '写实现',
              files: ['packages/forgeloop/src/a.ts'],
              acceptance: 'a 完成',
              test_command: ['npx', 'vitest', 'run', 'packages/forgeloop/tests/a.test.ts'],
              depends_on: [],
              limits: { limit_seconds: 60, max_failure_rounds: 2 },
              authorization_source: '',
            },
            {
              task_id: 't2',
              goal: '写实现',
              files: [],
              acceptance: 'b 完成',
              test_command: ['node', '-e', 'process.exit(0)'],
              depends_on: ['t1'],
              limits: { limit_seconds: 60, max_failure_rounds: 2 },
              authorization_source: '',
            },
          ],
        }),
        NOW,
      )
    repository.setStatus(legacy, 'plan_proposed')
    seedPlanReview(legacy)
    const legacyView = board().requirements.find((item) => item.reqId === legacy)!
    expect(legacyView.actions).toContain('plan')
    expect(legacyView.actions).not.toContain('approve')
  })

  it('searches requirement text, task goals and versions within the authoritative records', () => {
    const first = submit('req-search-a', '给工作台增加搜索与筛选')
    repository.recordTaskPlan(plan(first))
    submit('req-search-b', '补测试与文档')

    const byText = board({ query: '搜索' })
    expect(byText.query).toBe('搜索')
    expect(byText.requirements.map((item) => item.reqId)).toEqual(['req-search-a'])
    expect(byText.tasks.every((task) => task.reqId === 'req-search-a')).toBe(true)

    // “写文档”只出现在任务目标里，证明搜索也覆盖任务字段。
    const byTaskGoal = board({ query: '写文档' })
    expect(byTaskGoal.requirements.map((item) => item.reqId)).toEqual(['req-search-a'])

    const none = board({ query: '完全不存在的词' })
    expect(none.requirements).toEqual([])
    expect(none.tasks).toEqual([])
    expect(none.issues).toEqual([])
    expect(none.summary.requirements).toBe(0)
  })

  it('reports truncation for search results beyond the limit', () => {
    submit('req-a', '共同关键词 一')
    submit('req-b', '共同关键词 二')
    submit('req-c', '共同关键词 三')
    const view = buildStatusBoard({ repository, project: PROJECT, now: NOW, limit: 2, query: '共同关键词' })
    expect(view.limit).toBe(2)
    expect(view.truncated).toBe(true)
    expect(view.summary.requirements).toBe(3)
    expect(view.requirements).toHaveLength(2)
  })

  it('links a failure-round issue to its task without guessing when the prefix is unknown', () => {
    expect(taskIdOfFailureRound(plan('req-x'), 't1-rq-123-a1')).toBe('t1')
    expect(taskIdOfFailureRound(plan('req-x'), 'other-task-a1')).toBeUndefined()
    expect(taskIdOfFailureRound(null, 't1-a1')).toBeUndefined()

    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId))
    repository.recordFailureRound(reqId, {
      roundId: 't2-rq-1-a1',
      stage: 'formal_test',
      summary: '正式测试退出码 1',
      occurredAt: NOW,
    })
    const issue = board().issues.find((candidate) => candidate.kind === 'failure_round')
    expect(issue?.taskId).toBe('t2')
  })
})

describe('project facts for the requirement Agent', () => {
  it('puts the current requirement first with times, statuses and task states', () => {
    const older = submit('req-older', '旧需求', '2026-10-22T00:00:00.000Z')
    const newer = submit('req-newer', '新需求\n第二行', '2026-10-23T00:00:00.000Z')
    repository.recordTaskPlan(plan(older))
    repository.setStatus(older, 'executing')
    deliver(older, 't1')
    repository.recordTaskRun({
      requirementId: older,
      planVersion: 1,
      taskId: 't2',
      state: 'failed',
      reason: '正式测试退出码 1',
      executedSeconds: 3,
      updatedAt: NOW,
    })

    const facts = buildProjectFacts({
      repository,
      project: PROJECT,
      currentReqId: older,
      now: NOW,
    })

    expect(facts.generatedAt).toBe(NOW)
    expect(facts.total).toBe(2)
    expect(facts.requirements.map((requirement) => requirement.reqId)).toEqual([older, newer])
    const current = facts.requirements[0]!
    expect(current).toMatchObject({
      current: true,
      status: 'executing',
      version: 1,
      createdAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
      planVersion: 1,
      approval: 'missing',
      taskCount: 2,
    })
    expect(current.tasks.map((task) => [task.taskId, task.state, task.lastActivity])).toEqual([
      ['t1', BOARD_TASK_DELIVERED, ''],
      ['t2', 'failed', NOW],
    ])
    expect(facts.requirements[1]).toMatchObject({ current: false, title: '新需求' })

    const capped = buildProjectFacts({
      repository,
      project: PROJECT,
      currentReqId: older,
      now: NOW,
      taskLimit: 1,
    })
    expect(capped.requirements[0]!.tasks).toHaveLength(1)
    expect(capped.requirements[0]!.taskCount).toBe(2)
  })

  it('excludes ended requirements from the list, counts them, and caps the list', () => {
    const ids: string[] = []
    for (let index = 0; index < 12; index += 1) {
      ids.push(
        submit(
          `req-${index}`,
          `需求 ${index}`,
          `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        ),
      )
    }
    repository.setStatus(ids[0]!, 'accepted')

    const facts = buildProjectFacts({ repository, project: PROJECT, now: NOW, limit: 5 })

    expect(facts.total).toBe(11)
    expect(facts.terminal).toBe(1)
    expect(facts.requirements).toHaveLength(5)
    expect(facts.notListed).toBe(6)
    expect(facts.requirements.some((requirement) => requirement.reqId === ids[0])).toBe(false)
    expect(facts.requirements[0]!.reqId).toBe(ids[11])
  })
})
