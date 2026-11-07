import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, workspaceDir } from '../src/config.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { sha256OfText } from '../src/domain/delivery.js'
import type { AdmissionDecision } from '../src/domain/admission.js'
import type { PlannedTask, TaskPlan } from '../src/domain/task-plan.js'
import type { TaskArtifact } from '../src/domain/work.js'
import type { OperationResult } from '../src/runtime/operation-result.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { structuredSpecOf } from './spec-fixture.js'

/**
 * service.ts 的公共入口行为：只通过 ForgeLoopRuntime 的公开方法观察结果，
 * 用真实临时目录 + SQLite 记录搭夹具，不修改源码与既有测试。
 */

const PROJECT = 'demo'
const NOW = '2026-11-06T00:00:00.000Z'

let dir = ''
let runtime: ForgeLoopRuntime
let replies: Array<{ status: 'completed' | 'error'; text: string; reason: string }> = []

const runner: AgentLike = {
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const reply = replies.shift()
    if (!reply) throw new Error('测试没有排队的 Agent 响应')
    return {
      status: reply.status,
      text: reply.text,
      sessionId: 'session-test',
      reason: reply.reason,
      transcriptPath: request.transcriptPath,
      durationMs: 1,
      toolCalls: [],
    }
  },
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-service-deep-'))
  mkdirSync(join(dir, 'packages', 'forgeloop'), { recursive: true })
  replies = []
  const config = resolveConfig(
    {
      project: PROJECT,
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      failureRoundsPerGrant: 1,
      agent: { provider: 'demo', model: 'demo' },
    },
    dir,
  )
  runtime = new ForgeLoopRuntime({ ctx: {}, config, runner, now: () => new Date(NOW) })
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

function submit(reqId: string, text = `需求 ${reqId}`, source = 'test:owner'): string {
  runtime.repo.submit({ reqId, project: PROJECT, text, submittedBy: 'owner', source, now: NOW })
  return reqId
}

function seedAnalysis(reqId: string, requirementVersion = 1, clarifications: string[] = []): void {
  runtime.repo.recordAnalysis(
    {
      reqId,
      analysisVersion: runtime.repo.nextAnalysisVersion(reqId),
      requirementVersion,
      goal: '目标',
      scenarios: ['场景一'],
      businessRules: ['规则一'],
      exceptions: ['异常一'],
      nonGoals: ['非目标一'],
      acceptanceCriteria: ['验收一'],
      clarifications,
      createdAt: NOW,
    },
    { questions: clarifications, updates: [] },
  )
}

function plannedTask(taskId: string, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    taskId,
    goal: `目标 ${taskId}`,
    files: ['docs/a.md'],
    acceptance: `验收 ${taskId}`,
    testCommand: ['true'],
    dependsOn: [],
    limits: { limitSeconds: 60, maxFailureRounds: 1 },
    authorizationSource: '',
    ...overrides,
  }
}

function planFor(reqId: string, overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}`,
    requirementId: reqId,
    project: PROJECT,
    planVersion: 1,
    requirementVersion: 1,
    technicalSolution: { summary: '方案摘要', approach: ['步骤一'], risks: ['风险一'] },
    tasks: [plannedTask('t1'), plannedTask('t2', { files: ['docs/b.md'], dependsOn: ['t1'] })],
    createdAt: NOW,
    ...overrides,
  }
}

function seedPlan(reqId: string, overrides: Partial<TaskPlan> = {}): TaskPlan {
  const plan = planFor(reqId, overrides)
  runtime.repo.recordTaskPlan(plan)
  return plan
}

function approvePlan(reqId: string, planVersion = 1): void {
  runtime.repo.recordPlanApproval({
    requirementId: reqId,
    planVersion,
    approvedBy: 'owner',
    approvedAt: NOW,
    source: 'test:approve',
  })
}

function admissionDecision(
  admit: boolean,
  code: string,
  reason: string,
  requirementVersion = 1,
): AdmissionDecision {
  return {
    admit,
    code,
    reason,
    basis: {
      policyVersion: 'test-policy',
      source: 'test:owner',
      submittedBy: 'owner',
      owner: 'local-owner',
      project: PROJECT,
      projectPath: dir,
      requirementVersion,
      analysisVersion: 1,
      trustedSource: true,
      allowAnySource: true,
      requireOwner: false,
      codeCommitAllowed: admit,
    },
  }
}

function admit(reqId: string, requirementVersion = 1): void {
  runtime.repo.recordAdmission({
    requirementId: reqId,
    requirementVersion,
    decision: admissionDecision(true, 'admitted', '可信来源与需求说明齐备', requirementVersion),
    decidedBy: 'system:admission',
    createdAt: NOW,
  })
}

function artifactFor(
  reqId: string,
  taskId: string,
  overrides: Partial<TaskArtifact> = {},
): TaskArtifact {
  return {
    requirementId: reqId,
    planVersion: 1,
    taskId,
    candidateSha256: `sha-${taskId}`,
    testEvidenceSha256: `test-${taskId}`,
    reviewSha256: `review-${taskId}`,
    acceptance: '通过',
    authorizationSource: 'plan-approval:test',
    recordedAt: NOW,
    baselineCommit: '',
    ...overrides,
  }
}

function recordRun(
  reqId: string,
  taskId: string,
  state: 'running' | 'delivered' | 'failed' | 'blocked' | 'awaiting_user',
  reason = '',
): void {
  runtime.repo.recordTaskRun({
    requirementId: reqId,
    planVersion: 1,
    taskId,
    state,
    reason,
    executedSeconds: 1,
    updatedAt: NOW,
  })
}

function recordReview(
  reqId: string,
  plan: TaskPlan,
  overrides: Partial<{
    planSha256: string
    requirementVersion: number
    verdict: 'pass' | 'block'
    reportJson: string
    reportPath: string
    reportSha256: string
  }> = {},
): { reportPath: string; reportJson: string } {
  const reportJson = overrides.reportJson ?? JSON.stringify({ verdict: 'pass', summary: '通过' })
  const reportPath = overrides.reportPath ?? join(dir, 'plan-review.json')
  if (overrides.reportPath === undefined) writeFileSync(reportPath, reportJson, 'utf8')
  runtime.repo.recordPlanReview({
    requirementId: reqId,
    planVersion: plan.planVersion,
    requirementVersion: overrides.requirementVersion ?? plan.requirementVersion,
    planSha256:
      overrides.planSha256 ??
      sha256OfText(JSON.stringify(runtime.repo.taskPlan(reqId, plan.planVersion))),
    verdict: overrides.verdict ?? 'pass',
    reportJson,
    reportPath,
    reportSha256: overrides.reportSha256 ?? sha256OfText(reportJson),
    sessionId: 'session-review',
    reviewedAt: NOW,
  })
  return { reportPath, reportJson }
}

function expectOk(result: OperationResult): Record<string, unknown> {
  expect(result.ok, result.message).toBe(true)
  return result.data as Record<string, unknown>
}

describe('需求只读视图', () => {
  it('evidence 区分未找到、缺任务包，并汇总产物、证据、验收与候选', () => {
    expect(runtime.evidence('missing')).toEqual({
      ok: false,
      code: 'not_found',
      message: '未找到需求 missing',
    })

    const reqId = submit('req-evidence')
    expect(runtime.evidence(reqId)).toEqual({
      ok: false,
      code: 'plan_missing',
      message: `需求 ${reqId} 没有任务包`,
    })

    const plan = seedPlan(reqId)
    runtime.repo.recordTaskArtifact(artifactFor(reqId, 't1'))
    runtime.repo.recordEvidence({
      requirementId: reqId,
      planVersion: 1,
      taskId: 't1',
      baselineCommit: 'base-commit-1',
      workspacePath: join(dir, 'workspace/t1'),
      candidatePath: join(dir, 'evidence/t1/candidate'),
      testLogPath: join(dir, 'evidence/t1/formal-test.log'),
      reviewPath: join(dir, 'evidence/t1/review.json'),
      devSession: 'session-dev',
      reviewSession: 'session-review',
      recordedAt: NOW,
    })
    runtime.repo.recordCandidate({
      reqId,
      planVersion: 1,
      sha256: 'candidate-sha',
      tarball: join(dir, 'candidate.tgz'),
      files: ['docs/a.md'],
      gitHead: 'head-1',
      builtAt: NOW,
      evidenceDir: join(dir, 'candidate-evidence'),
    })
    runtime.repo.recordAcceptance({
      reqId,
      acceptedBy: 'owner',
      source: 'test:accept',
      fingerprint: 'fp-1',
      now: NOW,
    })

    const result = runtime.evidence(reqId)
    expect(result.message).toBe(`需求 ${reqId} 交付证据（任务包 v${plan.planVersion}）`)
    const data = expectOk(result)
    expect(data.planVersion).toBe(1)
    const evidence = data.evidence as Array<Record<string, unknown>>
    expect(evidence.map((entry) => entry.taskId)).toEqual(['t1', 't2'])
    expect(evidence[0]?.artifact).toMatchObject({
      taskId: 't1',
      candidateSha256: 'sha-t1',
      baselineCommit: 'base-commit-1',
    })
    expect(evidence[0]?.files).toMatchObject({
      candidatePath: join(dir, 'evidence/t1/candidate'),
      devSession: 'session-dev',
      reviewSession: 'session-review',
    })
    expect(evidence[1]).toEqual({ taskId: 't2', artifact: null, files: null })
    expect(data.acceptance).toEqual({
      accepted_at: NOW,
      accepted_by: 'owner',
      acceptance_source: 'test:accept',
      acceptance_fingerprint: 'fp-1',
    })
    expect(data.candidate).toEqual({
      reqId,
      planVersion: 1,
      sha256: 'candidate-sha',
      tarball: join(dir, 'candidate.tgz'),
      files: ['docs/a.md'],
      gitHead: 'head-1',
      builtAt: NOW,
      evidenceDir: join(dir, 'candidate-evidence'),
    })
  })

  it('showPlan 支持指定版本并报告授权状态', () => {
    expect(runtime.showPlan('missing')).toEqual({
      ok: false,
      code: 'not_found',
      message: '未找到需求 missing',
    })

    const reqId = submit('req-plan')
    expect(runtime.showPlan(reqId)).toEqual({
      ok: false,
      code: 'plan_missing',
      message: `需求 ${reqId} 没有对应任务包`,
    })

    seedPlan(reqId)
    seedPlan(reqId, { planVersion: 2, taskPlanId: 'plan-v2' })
    seedAnalysis(reqId)
    approvePlan(reqId, 1)

    const latest = expectOk(runtime.showPlan(reqId))
    expect((latest.plan as Record<string, unknown>).planVersion).toBe(2)
    expect(latest.authorization).toMatchObject({ status: 'missing', approval: null })
    expect(latest.analysis).toMatchObject({ analysisVersion: 1, goal: '目标' })

    const first = runtime.showPlan(reqId, 1)
    expect(first.message).toBe(`需求 ${reqId} 任务包 v1`)
    const firstData = expectOk(first)
    expect((firstData.plan as Record<string, unknown>).planVersion).toBe(1)
    expect(firstData.authorization).toMatchObject({
      status: 'approved',
      approval: { approvedBy: 'owner' },
    })
  })

  it('listRequests 默认只列在途请求，指定需求时返回全部历史', () => {
    submit('req-a')
    submit('req-b')
    const pending = runtime.repo.recordRequest({
      requestId: 'rq-pending',
      reqId: 'req-a',
      project: PROJECT,
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    const resolved = runtime.repo.recordRequest({
      requestId: 'rq-resolved',
      reqId: 'req-b',
      project: PROJECT,
      planVersion: 0,
      action: 'verify',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    runtime.repo.resolveRequest(resolved.request.requestId, 'done', '已完成', NOW)

    const all = expectOk(runtime.listRequests())
    expect(all.requests).toHaveLength(1)
    expect(all.requests).toEqual([
      expect.objectContaining({
        requestId: pending.request.requestId,
        action: 'analyze',
        state: 'pending',
      }),
    ])

    const forB = runtime.listRequests('req-b')
    expect(forB.message).toBe('共 1 条操作请求')
    const dataB = expectOk(forB)
    expect(dataB.requests).toEqual([
      expect.objectContaining({ requestId: 'rq-resolved', state: 'done', detail: '已完成' }),
    ])
  })

  it('requirementView 暴露失败轮次额度、在途请求与过期验证标记', () => {
    const reqId = submit('req-view')
    seedAnalysis(reqId)
    seedPlan(reqId)
    runtime.repo.recordTaskArtifact(artifactFor(reqId, 't1'))
    runtime.repo.recordVerification({
      requirementId: reqId,
      planVersion: 1,
      candidateSha256: 'cand-verified',
      requirementVersion: 1,
      workspaceSha256: 'workspace-sha',
      verdict: 'block',
      reportJson: '{}',
      reportPath: join(dir, 'verification.json'),
      reportSha256: 'verification-sha',
      evidenceDir: join(dir, 'verification'),
      sessionId: 'session-verify',
      verifiedAt: NOW,
    })
    runtime.repo.appendGrant(reqId, 'owner', NOW)
    runtime.repo.appendGrant(reqId, 'owner', NOW)
    runtime.repo.recordFailureRound(reqId, {
      roundId: 't1-1',
      stage: 'formal_test',
      summary: '第一次失败',
      occurredAt: NOW,
    })
    runtime.repo.recordRequest({
      requestId: 'rq-waiting',
      reqId,
      project: PROJECT,
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })

    const data = expectOk(runtime.status(reqId))
    expect(data).toMatchObject({
      reqId,
      status: 'draft',
      delivered: ['t1'],
      grants: 3,
      failureRounds: 1,
      grantQuota: { grants: 3, used: 1, remaining: 2 },
      approval: null,
    })
    expect(data.failureRoundDetails).toEqual([
      {
        roundId: 't1-1',
        stage: 'formal_test',
        summary: '第一次失败',
        occurredAt: NOW,
        taskId: 't1',
      },
    ])
    expect(data.pendingRequests).toEqual([
      expect.objectContaining({ requestId: 'rq-waiting', action: 'analyze', state: 'pending' }),
    ])
    // 两份任务只有一份交付：候选身份无法完整组装，验证不得标成新鲜。
    expect(data.verification).toMatchObject({
      verdict: 'block',
      candidateSha256: 'cand-verified',
      fresh: false,
    })
  })

  it('requirementDetail 汇总任务包、交付、归档、提交、准入与部署证据', () => {
    const reqId = submit('req-detail')
    seedAnalysis(reqId)
    seedPlan(reqId)
    runtime.repo.recordTaskArtifact(artifactFor(reqId, 't1'))
    runtime.repo.recordTaskArtifact(artifactFor(reqId, 't2'))
    recordRun(reqId, 't1', 'delivered')
    recordRun(reqId, 't2', 'delivered')
    runtime.repo.recordArchivedArtifact({
      artifact: artifactFor(reqId, 't2'),
      attempt: 1,
      archivedAt: NOW,
      archivedPath: join(dir, 'archive/t2-1'),
      reason: '验证阻断',
    })
    runtime.repo.recordCommit({
      requirementId: reqId,
      planVersion: 1,
      candidateSha256: 'cand-commit',
      commitSha: 'commit-1',
      commitMessage: 'feat: 完成需求',
      checkCommand: ['true'],
      checkLogPath: join(dir, 'check.log'),
      checkSha256: 'check-sha',
      files: ['docs/a.md'],
      committedAt: NOW,
    })
    runtime.repo.recordAdmission({
      requirementId: reqId,
      requirementVersion: 1,
      decision: admissionDecision(true, 'admitted', '可信来源与需求说明齐备'),
      decidedBy: 'system:admission',
      createdAt: NOW,
    })
    runtime.repo.recordBusinessReview({
      requirementId: reqId,
      planVersion: 1,
      candidateSha256: 'cand-commit',
      requirementVersion: 1,
      verificationSha256: 'verification-sha',
      verdict: 'pass',
      reportJson: '{}',
      reportPath: join(dir, 'business-review.json'),
      reportSha256: 'review-sha',
      sessionId: 'session-review',
      reviewedAt: NOW,
    })
    runtime.repo.recordCandidateBuild({
      reqId,
      planVersion: 1,
      candidateSha256: 'cand-commit',
      verificationSha256: 'verification-sha',
      packageVersion: '1.2.3',
      artifactSha256: 'artifact-sha',
      tarball: join(dir, 'package.tgz'),
      files: ['packages/forgeloop/src/x.ts'],
      gitHead: 'head-1',
      builtAt: NOW,
      evidenceDir: join(dir, 'build-evidence'),
    })
    runtime.repo.recordDeployment({
      reqId,
      planVersion: 1,
      candidateSha256: 'cand-commit',
      packageVersion: '1.2.3',
      targetProfile: 'local',
      artifactSha256: 'artifact-sha',
      runtimeVersion: '1.0.0',
      state: 'applied',
      checks: [{ name: '安装检查' }],
      evidenceDir: join(dir, 'deploy-evidence'),
      recordedBy: 'owner',
      source: 'test:deploy',
      recordedAt: NOW,
    })
    runtime.stop({ reqId, by: 'owner', reason: '排查中' })
    runtime.repo.recordRequest({
      requestId: 'rq-detail',
      reqId,
      project: PROJECT,
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })

    const data = expectOk(runtime.requirementDetail(reqId))
    expect(data.latestPlan).toMatchObject({ planVersion: 1 })
    expect((data.artifacts as unknown[]).length).toBe(2)
    expect(data.progress).toMatchObject({
      total: 2,
      delivered: 2,
      failed: 0,
      pending: 0,
      running: 0,
    })
    expect(data.admission).toEqual({
      decision: 'admit',
      code: 'admitted',
      reason: '可信来源与需求说明齐备',
      createdAt: NOW,
    })
    expect(data.commit).toEqual({
      commitSha: 'commit-1',
      commitMessage: 'feat: 完成需求',
      files: ['docs/a.md'],
      committedAt: NOW,
    })
    expect(data.businessReview).toMatchObject({ verdict: 'pass', candidateSha256: 'cand-commit' })
    expect(data.candidateBuild).toMatchObject({ packageVersion: '1.2.3' })
    expect(data.deployment).toMatchObject({ state: 'applied', targetProfile: 'local' })
    expect(data.archivedDeliveries).toEqual([
      {
        taskId: 't2',
        attempt: 1,
        candidateSha256: 'sha-t2',
        archivedAt: NOW,
        archivedPath: join(dir, 'archive/t2-1'),
        reason: '验证阻断',
      },
    ])
    expect(data.activeRequests).toBe(1)
    expect(data.stopRequested).toBe(true)
  })

  it('requirementDetail 在未全量交付或未提交时保持空的证据字段', () => {
    const partial = submit('req-partial')
    seedPlan(partial)
    runtime.repo.recordTaskArtifact(artifactFor(partial, 't1'))
    const partialData = expectOk(runtime.requirementDetail(partial))
    expect(partialData.businessReview).toBeNull()
    expect(partialData.candidateBuild).toBeNull()
    expect(partialData.deployment).toBeNull()
    expect(partialData.archivedDeliveries).toEqual([])
    expect(partialData.admission).toBeNull()
    expect(partialData.commit).toBeNull()
    expect(partialData.progress).toMatchObject({ total: 2, delivered: 1, pending: 1 })

    const delivered = submit('req-delivered')
    seedPlan(delivered)
    runtime.repo.recordTaskArtifact(artifactFor(delivered, 't1'))
    runtime.repo.recordTaskArtifact(artifactFor(delivered, 't2'))
    const deliveredData = expectOk(runtime.requirementDetail(delivered))
    // 全部交付但没有提交/评审记录：详情仍返回空业务评审，而不是抛错。
    expect(deliveredData.businessReview).toBeNull()
    expect(deliveredData.progress).toMatchObject({ total: 2, delivered: 2 })
  })
})

describe('answerClarifications', () => {
  it('拒绝空回答、缺失需求和非待澄清状态，并给出原文', async () => {
    await expect(
      runtime.answerClarifications({
        reqId: 'missing',
        answer: '   ',
        by: 'owner',
        source: 'test',
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'empty_answer',
      message: '澄清回答不能为空',
      reqId: 'missing',
    })

    await expect(
      runtime.answerClarifications({
        reqId: 'missing',
        answer: '回答',
        by: 'owner',
        source: 'test',
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'not_found',
      message: '未找到需求 missing',
      reqId: 'missing',
    })

    const draft = submit('req-draft')
    await expect(
      runtime.answerClarifications({ reqId: draft, answer: '回答', by: 'owner', source: 'test' }),
    ).resolves.toEqual({
      ok: false,
      code: 'no_clarification',
      message: `需求 ${draft} 当前不在待澄清状态`,
      reqId: draft,
    })

    const noAnalysis = submit('req-no-analysis')
    runtime.repo.setStatus(noAnalysis, 'awaiting_clarification')
    await expect(
      runtime.answerClarifications({
        reqId: noAnalysis,
        answer: '回答',
        by: 'owner',
        source: 'test',
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'no_clarification',
      message: `需求 ${noAnalysis} 没有与当前版本对应的待澄清项`,
      reqId: noAnalysis,
    })

    const stale = submit('req-stale-analysis')
    seedAnalysis(stale, 1, ['问题一'])
    runtime.repo.setStatus(stale, 'awaiting_clarification')
    runtime.repo.appendVersion({
      reqId: stale,
      text: '修订后的需求',
      revisedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    runtime.repo.setStatus(stale, 'awaiting_clarification')
    await expect(
      runtime.answerClarifications({ reqId: stale, answer: '回答', by: 'owner', source: 'test' }),
    ).resolves.toEqual({
      ok: false,
      code: 'no_clarification',
      message: `需求 ${stale} 没有与当前版本对应的待澄清项`,
      reqId: stale,
    })
  })

  it('回答后追加需求版本、落回答记录并重新分析', async () => {
    const reqId = submit('req-answer', '订单列表支持取消订单')
    seedAnalysis(reqId, 1, ['是否包含已取消订单？'])
    runtime.repo.setStatus(reqId, 'awaiting_clarification')
    replies.push({
      status: 'completed',
      text: structuredSpecOf({
        goal: '订单列表支持取消订单',
        scenarios: ['店长查看订单列表'],
        acceptance_criteria: ['包含已取消订单'],
        clarifications: [],
        clarification_updates: [
          { question_id: 'Q1-1', status: 'resolved', resolution: '包含已取消订单' },
        ],
      }),
      reason: '',
    })

    const result = await runtime.answerClarifications({
      reqId,
      answer: '  包含已取消订单  ',
      by: 'owner',
      source: 'test:answer',
    })
    expect(result.ok, result.message).toBe(true)
    expect(result).toMatchObject({
      ok: true,
      code: 'ok',
      reqId,
      requirementVersion: 2,
    })
    expect(result.analysis).toMatchObject({ analysisVersion: 2, requirementVersion: 2 })
    const requirement = runtime.repo.getRequirement(reqId)
    expect(requirement?.versions.map((version) => version.version)).toEqual([1, 2])
    expect(requirement?.versions[1]?.text).toContain('澄清回答（问题 Q1-1（分析 v1））：')
    expect(requirement?.versions[1]?.text).toContain('包含已取消订单')
    expect(runtime.repo.clarificationAnswers(reqId)[0]).toMatchObject({
      analysisVersion: 1,
      requirementVersion: 1,
      answeredVersion: 2,
      questionId: 'Q1-1',
      answerSeq: 1,
      answer: '包含已取消订单',
      source: 'test:answer',
    })
    expect(runtime.repo.openClarifications(reqId)).toEqual([])
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('specified')
  })

  it('重新分析失败时保留回答并报告已追加的需求版本', async () => {
    const reqId = submit('req-answer-fail', '订单列表支持取消订单')
    seedAnalysis(reqId, 1, ['是否包含已取消订单？'])
    runtime.repo.setStatus(reqId, 'awaiting_clarification')
    replies.push({ status: 'error', text: '', reason: '模型不可用' })

    const result = await runtime.answerClarifications({
      reqId,
      answer: '需要包含',
      by: 'owner',
      source: 'test:answer',
    })
    expect(result).toEqual({
      ok: false,
      code: 'analysis_failed',
      message: '模型不可用',
      reqId,
      requirementVersion: 2,
    })
    expect(runtime.repo.clarificationAnswers(reqId)[0]).toMatchObject({
      answer: '需要包含',
      answeredVersion: 2,
    })
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('analysis_failed')
  })
})

describe('requestOperation 守卫', () => {
  it('拒绝未找到与终态需求', () => {
    expect(
      runtime.requestOperation({
        reqId: 'missing',
        action: 'analyze',
        by: 'owner',
        source: 'test',
      }),
    ).toEqual({ ok: false, code: 'not_found', message: '未找到需求 missing' })

    const reqId = submit('req-cancelled')
    runtime.cancel({ reqId, by: 'owner', reason: '不需要' })
    expect(
      runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'terminal',
      message: `需求 ${reqId} 已处于终态 cancelled，不能再排队`,
    })
  })

  it('没有准入或批准时拒绝推进，需求版本变化时判定任务包过期', () => {
    const reqId = submit('req-gate')
    seedPlan(reqId)
    expect(
      runtime.requestOperation({ reqId, action: 'advance', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'admission_required',
      message: `需求 ${reqId} 尚未获得系统准入或人类批准；不能自动进入研发`,
    })

    runtime.repo.appendVersion({
      reqId,
      text: '新版本',
      revisedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    approvePlan(reqId)
    expect(
      runtime.requestOperation({ reqId, action: 'advance', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'stale_requirement',
      message: `任务包 v1 依据需求 v1，当前是 2；需要重新生成任务包`,
    })
  })

  it('验证入口要求任务包与失败轮次额度，并列出未交付任务', () => {
    const reqId = submit('req-verify')
    seedAnalysis(reqId)
    seedPlan(reqId)
    approvePlan(reqId)
    runtime.repo.recordFailureRound(reqId, {
      roundId: 't1-1',
      stage: 'formal_test',
      summary: '失败一',
      occurredAt: NOW,
    })

    expect(
      runtime.requestOperation({ reqId, action: 'verify', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'grant_required',
      message: `需求 ${reqId} 的失败轮次额度已用尽；需要追加授权后才能继续验证`,
    })

    runtime.repo.appendGrant(reqId, 'owner', NOW)
    expect(
      runtime.requestOperation({ reqId, action: 'verify', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'not_delivered',
      message: '仍有任务未交付，不能开始独立验证：t1、t2',
    })

    runtime.repo.recordTaskArtifact(artifactFor(reqId, 't1'))
    expect(
      runtime.requestOperation({ reqId, action: 'verify', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'not_delivered',
      message: '仍有任务未交付，不能开始独立验证：t2',
    })

    runtime.repo.recordTaskArtifact(artifactFor(reqId, 't2'))
    const queued = runtime.requestOperation({
      reqId,
      action: 'verify',
      by: 'owner',
      source: 'test',
    })
    expect(queued.ok, queued.message).toBe(true)
    expect(queued.message).toMatch(/^已受理verify请求 rq-/)
    expect(expectOk(queued)).toMatchObject({ action: 'verify', planVersion: 1, state: 'pending' })

    const noPlan = submit('req-verify-no-plan')
    admit(noPlan)
    expect(
      runtime.requestOperation({ reqId: noPlan, action: 'verify', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'plan_missing',
      message: `需求 ${noPlan} 尚无任务包，不能开始验证`,
    })
  })

  it('已批准任务包冻结：无显式许可或无原因都拒绝修改', () => {
    const reqId = submit('req-frozen')
    seedAnalysis(reqId)
    seedPlan(reqId)
    approvePlan(reqId)

    expect(
      runtime.requestOperation({ reqId, action: 'plan', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'plan_frozen',
      message: `需求 ${reqId} 的任务包 v1 已批准并冻结；修改任务包需要所有者显式许可并说明原因`,
    })

    expect(
      runtime.requestOperation({
        reqId,
        action: 'plan',
        by: 'owner',
        source: 'test',
        confirmPlanChange: true,
        reason: '   ',
      }),
    ).toEqual({
      ok: false,
      code: 'reason_required',
      message: '修改已批准任务包必须说明原因，便于审计',
    })

    const confirmed = runtime.requestOperation({
      reqId,
      action: 'plan',
      by: 'owner',
      source: 'test',
      confirmPlanChange: true,
      reason: '需要调整范围',
    })
    expect(confirmed.ok, confirmed.message).toBe(true)
    expect(expectOk(confirmed)).toMatchObject({
      action: 'plan',
      source: 'test:plan-change:需要调整范围',
      requestedBy: 'owner',
    })
  })

  it('规划要求分析结论；同一需求不能同时排队不同动作', () => {
    const reqId = submit('req-plan-pre')
    expect(
      runtime.requestOperation({ reqId, action: 'plan', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'analysis_missing',
      message: `需求 ${reqId} 尚无分析结论`,
    })

    seedAnalysis(reqId)
    const first = runtime.requestOperation({
      reqId,
      action: 'analyze',
      by: 'owner',
      source: 'test',
    })
    expect(first.ok, first.message).toBe(true)
    const duplicate = runtime.requestOperation({
      reqId,
      action: 'analyze',
      by: 'owner',
      source: 'test',
    })
    expect(duplicate.ok).toBe(true)
    expect(duplicate.message).toMatch(
      new RegExp(`^需求 ${reqId} 已有待执行的 analyze 请求 rq-[0-9a-f-]+，未重复排队$`),
    )

    expect(
      runtime.requestOperation({ reqId, action: 'plan', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'rule_violation',
      message: `需求 ${reqId} 已有待执行的 analyze 请求；不能同时排队 plan`,
    })
  })

  it('只有 advance 会解除主动停止，且允许默认恢复原因', () => {
    const analyzeReq = submit('req-stop-analyze')
    runtime.stop({ reqId: analyzeReq, by: 'owner', reason: '暂停' })
    expect(
      runtime.requestOperation({
        reqId: analyzeReq,
        action: 'analyze',
        by: 'owner',
        source: 'test',
      }).ok,
    ).toBe(true)
    expect(runtime.repo.activeStop(analyzeReq)).not.toBeNull()
    expect(runtime.repo.stop(analyzeReq)?.resumeReason).toBe('')

    const advanceReq = submit('req-stop-advance')
    seedAnalysis(advanceReq)
    seedPlan(advanceReq)
    approvePlan(advanceReq)
    runtime.repo.appendGrant(advanceReq, 'owner', NOW)
    runtime.stop({ reqId: advanceReq, by: 'owner', reason: '暂停' })
    const resumed = runtime.requestOperation({
      reqId: advanceReq,
      action: 'advance',
      by: 'owner',
      source: 'test',
      reason: '继续执行',
    })
    expect(resumed.ok, resumed.message).toBe(true)
    expect(runtime.repo.activeStop(advanceReq)).toBeNull()
    expect(runtime.repo.stop(advanceReq)).toMatchObject({
      resumedBy: 'owner',
      resumeReason: '继续执行',
      resumedAt: NOW,
    })

    const defaultReq = submit('req-stop-default')
    seedAnalysis(defaultReq)
    seedPlan(defaultReq)
    approvePlan(defaultReq)
    runtime.repo.appendGrant(defaultReq, 'owner', NOW)
    runtime.stop({ reqId: defaultReq, by: 'owner', reason: '暂停' })
    expect(
      runtime.requestOperation({
        reqId: defaultReq,
        action: 'advance',
        by: 'owner',
        source: 'test',
      }).ok,
    ).toBe(true)
    expect(runtime.repo.stop(defaultReq)?.resumeReason).toBe('显式恢复执行')
  })
})

describe('retryTask 资格判定', () => {
  it('拒绝未找到、终态与缺少任务包的需求', () => {
    expect(
      runtime.retryTask({
        reqId: 'missing',
        planVersion: 1,
        taskId: 't1',
        by: 'owner',
        source: 'test',
      }),
    ).toEqual({ ok: false, code: 'not_found', message: '未找到需求 missing' })

    const cancelled = submit('req-retry-cancelled')
    runtime.cancel({ reqId: cancelled, by: 'owner', reason: '不需要' })
    expect(
      runtime.retryTask({
        reqId: cancelled,
        planVersion: 1,
        taskId: 't1',
        by: 'owner',
        source: 'test',
      }),
    ).toEqual({
      ok: false,
      code: 'terminal',
      message: `需求 ${cancelled} 已处于终态 cancelled`,
    })

    const noPlan = submit('req-retry-noplan')
    expect(
      runtime.retryTask({
        reqId: noPlan,
        planVersion: 1,
        taskId: 't1',
        by: 'owner',
        source: 'test',
      }),
    ).toEqual({
      ok: false,
      code: 'plan_missing',
      message: `需求 ${noPlan} 尚无任务包`,
    })

    const stalePlan = submit('req-retry-stale-plan')
    seedPlan(stalePlan)
    expect(
      runtime.retryTask({
        reqId: stalePlan,
        planVersion: 2,
        taskId: 't1',
        by: 'owner',
        source: 'test',
      }),
    ).toEqual({
      ok: false,
      code: 'stale_plan',
      message: '任务包 v2 不是最新版本（最新 v1）；刷新后再重试',
    })

    const staleRequirement = submit('req-retry-stale-req')
    seedPlan(staleRequirement)
    runtime.repo.appendVersion({
      reqId: staleRequirement,
      text: '新版本',
      revisedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    expect(
      runtime.retryTask({
        reqId: staleRequirement,
        planVersion: 1,
        taskId: 't1',
        by: 'owner',
        source: 'test',
      }),
    ).toEqual({
      ok: false,
      code: 'stale_requirement',
      message: '任务包 v1 依据需求 v1，当前是 v2；需重新规划与批准',
    })

    const unapproved = submit('req-retry-unapproved')
    seedPlan(unapproved)
    expect(
      runtime.retryTask({
        reqId: unapproved,
        planVersion: 1,
        taskId: 't1',
        by: 'owner',
        source: 'test',
      }),
    ).toEqual({
      ok: false,
      code: 'plan_not_approved',
      message: '未找到该需求的任务包批准；未批准不执行；任务包尚未获得批准',
    })
  })

  it('拒绝不存在的任务、已交付任务与未失败任务', () => {
    const reqId = submit('req-retry-task')
    seedPlan(reqId)
    approvePlan(reqId)

    expect(
      runtime.retryTask({ reqId, planVersion: 1, taskId: 't9', by: 'owner', source: 'test' }),
    ).toEqual({ ok: false, code: 'task_missing', message: '任务包内没有任务 t9' })

    runtime.repo.recordTaskArtifact(artifactFor(reqId, 't1'))
    expect(
      runtime.retryTask({ reqId, planVersion: 1, taskId: 't1', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'already_delivered',
      message: '任务 t1 已有交付产物，不能重试',
    })

    const noRun = submit('req-retry-norun')
    seedPlan(noRun)
    approvePlan(noRun)
    expect(
      runtime.retryTask({
        reqId: noRun,
        planVersion: 1,
        taskId: 't1',
        by: 'owner',
        source: 'test',
      }),
    ).toEqual({ ok: false, code: 'not_failed', message: '任务 t1 尚未运行，不能重试' })

    const running = submit('req-retry-running')
    seedPlan(running)
    approvePlan(running)
    recordRun(running, 't1', 'running')
    expect(
      runtime.retryTask({
        reqId: running,
        planVersion: 1,
        taskId: 't1',
        by: 'owner',
        source: 'test',
      }),
    ).toEqual({
      ok: false,
      code: 'not_failed',
      message: '任务 t1 当前状态是 running，不是失败状态',
    })
  })

  it('拒绝有在途请求、额度用尽与前置任务未交付的重试', () => {
    const busy = submit('req-retry-busy')
    seedPlan(busy)
    approvePlan(busy)
    recordRun(busy, 't1', 'failed', '测试失败')
    runtime.repo.recordRequest({
      requestId: 'rq-busy',
      reqId: busy,
      project: PROJECT,
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    expect(
      runtime.retryTask({ reqId: busy, planVersion: 1, taskId: 't1', by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'busy',
      message: `需求 ${busy} 已有待执行或执行中的 analyze 请求 rq-busy；等待结束后再重试`,
    })

    const exhausted = submit('req-retry-exhausted')
    seedPlan(exhausted)
    approvePlan(exhausted)
    recordRun(exhausted, 't1', 'failed', '测试失败')
    runtime.repo.recordFailureRound(exhausted, {
      roundId: 't1-1',
      stage: 'formal_test',
      summary: '失败一',
      occurredAt: NOW,
    })
    expect(
      runtime.retryTask({
        reqId: exhausted,
        planVersion: 1,
        taskId: 't1',
        by: 'owner',
        source: 'test',
      }),
    ).toEqual({
      ok: false,
      code: 'grant_required',
      message: `需求 ${exhausted} 的失败轮次额度已用尽；需要追加授权或重新规划后再重试`,
    })

    const predecessor = submit('req-retry-predecessor')
    seedPlan(predecessor)
    approvePlan(predecessor)
    runtime.repo.appendGrant(predecessor, 'owner', NOW)
    recordRun(predecessor, 't2', 'failed', '测试失败')
    expect(
      runtime.retryTask({
        reqId: predecessor,
        planVersion: 1,
        taskId: 't2',
        by: 'owner',
        source: 'test',
      }),
    ).toEqual({
      ok: false,
      code: 'predecessor_pending',
      message: '任务 t1 尚未交付，不能重试后续任务 t2',
    })
  })

  it('可重试的失败任务只排队一次 advance 并带上任务身份', () => {
    const reqId = submit('req-retry-ok')
    seedPlan(reqId)
    approvePlan(reqId)
    runtime.repo.appendGrant(reqId, 'owner', NOW)
    recordRun(reqId, 't1', 'failed', '正式测试失败')

    const result = runtime.retryTask({
      reqId,
      planVersion: 1,
      taskId: 't1',
      by: 'owner',
      source: 'test',
    })
    expect(result.ok, result.message).toBe(true)
    expect(result.message).toMatch(/^已受理任务 t1 的重试：已受理advance请求 rq-/)
    expect(expectOk(result)).toMatchObject({ taskId: 't1', action: 'advance' })
    const requests = runtime.repo.requestsFor(reqId)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      action: 'advance',
      state: 'pending',
      source: 'test:retry:t1',
    })
  })
})

describe('approvePlan 守卫', () => {
  it('拒绝未找到、终态与缺少任务包', () => {
    expect(
      runtime.approvePlan({ reqId: 'missing', planVersion: 1, by: 'owner', source: 'test' }),
    ).toEqual({ ok: false, code: 'not_found', message: '未找到需求 missing' })

    const cancelled = submit('req-approve-cancelled')
    runtime.cancel({ reqId: cancelled, by: 'owner', reason: '不需要' })
    expect(
      runtime.approvePlan({ reqId: cancelled, planVersion: 1, by: 'owner', source: 'test' }),
    ).toEqual({ ok: false, code: 'terminal', message: '需求已处于终态 cancelled' })

    const reqId = submit('req-approve-noplan')
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' })).toEqual({
      ok: false,
      code: 'plan_missing',
      message: `需求 ${reqId} 没有任务包 v1`,
    })
  })

  it('批准前按现行规则复核任务包，并拒绝越界文件', () => {
    const invalid = submit('req-approve-invalid')
    seedPlan(invalid)
    const row = runtime.repo.db
      .prepare('SELECT plan FROM requirement_task_plans WHERE req_id = ? AND plan_version = 1')
      .get(invalid)
    const payload = JSON.parse(String(row?.plan)) as {
      tasks: Array<{ limits: { limit_seconds: number } }>
    }
    payload.tasks[0]!.limits.limit_seconds = 0
    runtime.repo.db
      .prepare('UPDATE requirement_task_plans SET plan = ? WHERE req_id = ? AND plan_version = 1')
      .run(JSON.stringify(payload), invalid)
    expect(
      runtime.approvePlan({ reqId: invalid, planVersion: 1, by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'plan_invalid',
      message: '任务包 v1 不满足当前硬性规则：任务执行限额必须为 -1 或正数（-1 表示不限）',
    })

    const language = submit('req-approve-language')
    seedPlan(language, { tasks: [plannedTask('t1', { files: ['src/legacy.py'] })] })
    expect(
      runtime.approvePlan({ reqId: language, planVersion: 1, by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'plan_out_of_boundary',
      message:
        '任务包越过 TypeScript 语言/工程边界，不能批准：t1.files=src/legacy.py；t1.files=src/legacy.py',
    })

    const unknownPackage = submit('req-approve-package')
    seedPlan(unknownPackage, {
      tasks: [plannedTask('t1', { files: ['packages/ghost/src/x.ts'] })],
    })
    expect(
      runtime.approvePlan({ reqId: unknownPackage, planVersion: 1, by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'plan_out_of_boundary',
      message: '任务包越过 TypeScript 语言/工程边界，不能批准：t1.files=packages/ghost/src/x.ts',
    })
  })

  it('拒绝依据旧需求版本的任务包', () => {
    const reqId = submit('req-approve-stale')
    seedPlan(reqId)
    runtime.repo.appendVersion({
      reqId,
      text: '新版本',
      revisedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' })).toEqual({
      ok: false,
      code: 'stale_requirement',
      message: `任务包 v1 依据需求 v1，当前需求是 v2；请重新规划后再批准`,
    })
  })

  it('要求实现前评审通过且证据文件有效', () => {
    const reqId = submit('req-approve-review')
    const plan = seedPlan(reqId)
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' })).toEqual({
      ok: false,
      code: 'plan_review_required',
      message: '任务包 v1 尚未通过验证 Agent 的实现前评审；不能批准进入实现',
    })

    recordReview(reqId, plan, { planSha256: 'stale-sha' })
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' })).toEqual({
      ok: false,
      code: 'plan_review_stale',
      message: '任务包 v1 的实现前评审已过期（任务包或需求版本发生变化）；请重新生成任务包并评审',
    })

    const missingFile = submit('req-approve-missing-evidence')
    const missingPlan = seedPlan(missingFile)
    recordReview(missingFile, missingPlan, {
      reportPath: join(dir, 'does-not-exist.json'),
    })
    expect(
      runtime.approvePlan({ reqId: missingFile, planVersion: 1, by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'plan_review_invalid',
      message: '实现前评审证据文件缺失或摘要不一致；不能批准',
    })

    const tampered = submit('req-approve-tampered')
    const tamperedPlan = seedPlan(tampered)
    const reportPath = join(dir, 'tampered-review.json')
    writeFileSync(reportPath, '被篡改', 'utf8')
    recordReview(tampered, tamperedPlan, {
      reportPath,
      reportJson: '原始内容',
      reportSha256: sha256OfText('原始内容'),
    })
    expect(
      runtime.approvePlan({ reqId: tampered, planVersion: 1, by: 'owner', source: 'test' }),
    ).toEqual({
      ok: false,
      code: 'plan_review_invalid',
      message: '实现前评审证据文件缺失或摘要不一致；不能批准',
    })
  })

  it('阻断评审不能放行', () => {
    const reqId = submit('req-approve-blocked')
    const plan = seedPlan(reqId)
    recordReview(reqId, plan, {
      verdict: 'block',
      reportJson: '坏掉的评审 JSON',
    })
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' })).toEqual({
      ok: false,
      code: 'plan_review_blocked',
      message: '实现前评审阻断：坏掉的评审 JSON',
    })
  })

  it('评审有效时记录批准、绑定授权来源并进入 approved', () => {
    const reqId = submit('req-approve-ok')
    const plan = seedPlan(reqId)
    recordReview(reqId, plan)

    const result = runtime.approvePlan({
      reqId,
      planVersion: 1,
      by: 'owner',
      source: 'test:approve',
    })
    expect(result.ok, result.message).toBe(true)
    expect(result.message).toBe(`已记录需求 ${reqId} 的任务包 v1 批准（依据需求 v1）`)
    expect(expectOk(result)).toEqual({
      authorizationSource: `plan-approval:${reqId}:v1:owner`,
      tasks: ['t1', 't2'],
    })
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('approved')
    expect(runtime.repo.planApproval(reqId, 1)).toMatchObject({
      approvedBy: 'owner',
      approvedAt: NOW,
      source: 'test:approve',
    })
  })
})

describe('recoverInterrupted', () => {
  it('空场返回空结果，并丢弃中断请求的一次性工作副本', () => {
    expect(runtime.recoverInterrupted(NOW)).toEqual({
      interruptedRequests: [],
      migratedUnknown: 0,
      discardedWorkspaces: [],
    })

    const planned = submit('req-interrupted')
    seedPlan(planned)
    const dirs = [
      workspaceDir(runtime.config, planned, 1, 't1'),
      workspaceDir(runtime.config, planned, 1, 't2'),
    ]
    for (const workspace of dirs) mkdirSync(workspace, { recursive: true })
    const first = runtime.repo.recordRequest({
      requestId: 'rq-claimed-1',
      reqId: planned,
      project: PROJECT,
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    runtime.repo.claimNextRequest('host-1', NOW, PROJECT)

    const withoutPlan = submit('req-interrupted-noplan')
    runtime.repo.recordRequest({
      requestId: 'rq-claimed-2',
      reqId: withoutPlan,
      project: PROJECT,
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    runtime.repo.claimNextRequest('host-1', NOW, PROJECT)

    const outcome = runtime.recoverInterrupted(NOW)
    expect(outcome.interruptedRequests).toEqual(['rq-claimed-1', 'rq-claimed-2'])
    expect(outcome.migratedUnknown).toBe(0)
    expect(outcome.discardedWorkspaces).toEqual(dirs)
    for (const workspace of dirs) expect(existsSync(workspace)).toBe(false)
    expect(runtime.repo.getRequirement(planned)?.status).toBe('blocked')
    expect(runtime.repo.getRequirement(planned)?.blockedReason).toBe(
      `上一次执行被宿主中断（${NOW}）：一次性工作副本已丢弃，可重新执行`,
    )
    expect(runtime.repo.getRequirement(withoutPlan)?.status).toBe('draft')
    expect(runtime.repo.request('rq-claimed-2')?.state).toBe('failed')
    expect(runtime.repo.request('rq-claimed-1')?.detail).toBe(
      `宿主中断：执行未完成（${NOW}）；一次性工作副本已丢弃，可重新执行`,
    )
    expect(first.request.state).toBe('pending')
  })
})

describe('验证与执行入口', () => {
  it('没有验证上下文时拒绝执行验证命令', async () => {
    await expect(runtime.runVerificationCheck('req-no-context', 'unit')).resolves.toEqual({
      ok: false,
      text: '没有正在进行的验证：req-no-context。只有验证会话在研发产物交付后可以执行验证方案中的命令。',
    })
  })

  it('executeRequest 对缺失、终态与缺少任务包给出明确失败', async () => {
    const signal = new AbortController().signal
    runtime.repo.recordRequest({
      requestId: 'rq-ghost',
      reqId: 'ghost',
      project: PROJECT,
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    await expect(
      runtime.executeRequest(runtime.repo.request('rq-ghost')!, signal),
    ).resolves.toEqual({
      state: 'failed',
      detail: '未找到需求 ghost',
    })

    const cancelled = submit('req-exec-cancelled')
    runtime.cancel({ reqId: cancelled, by: 'owner', reason: '不需要' })
    runtime.repo.recordRequest({
      requestId: 'rq-terminal',
      reqId: cancelled,
      project: PROJECT,
      planVersion: 0,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    await expect(
      runtime.executeRequest(runtime.repo.request('rq-terminal')!, signal),
    ).resolves.toEqual({ state: 'failed', detail: '需求已处于终态 cancelled' })

    const verifyReq = submit('req-exec-verify')
    runtime.repo.recordRequest({
      requestId: 'rq-verify',
      reqId: verifyReq,
      project: PROJECT,
      planVersion: 0,
      action: 'verify',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    await expect(
      runtime.executeRequest(runtime.repo.request('rq-verify')!, signal),
    ).resolves.toEqual({ state: 'failed', detail: `需求 ${verifyReq} 尚无任务包` })

    const advanceReq = submit('req-exec-advance')
    runtime.repo.recordRequest({
      requestId: 'rq-advance',
      reqId: advanceReq,
      project: PROJECT,
      planVersion: 0,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    await expect(
      runtime.executeRequest(runtime.repo.request('rq-advance')!, signal),
    ).resolves.toEqual({ state: 'failed', detail: `需求 ${advanceReq} 尚无任务包` })
  })

  it('executeRequest 走系统准入链路时报告需求说明缺失', async () => {
    const signal = new AbortController().signal
    const reqId = submit('req-exec-admitted')
    admit(reqId)
    runtime.repo.recordRequest({
      requestId: 'rq-admitted',
      reqId,
      project: PROJECT,
      planVersion: 0,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    await expect(
      runtime.executeRequest(runtime.repo.request('rq-admitted')!, signal),
    ).resolves.toEqual({ state: 'failed', detail: '需求说明缺失或已过期' })
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')

    const analyzeReq = submit('req-exec-analyze', '实现登录')
    runtime.repo.recordRequest({
      requestId: 'rq-analyze',
      reqId: analyzeReq,
      project: PROJECT,
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    replies.push({
      status: 'completed',
      text: structuredSpecOf({
        goal: '实现登录',
        scenarios: ['用户登录'],
        acceptance_criteria: ['登录成功'],
        clarifications: [],
      }),
      reason: '',
    })
    const outcome = await runtime.executeRequest(
      runtime.repo.request('rq-analyze')!,
      new AbortController().signal,
    )
    expect(outcome.state).toBe('done')
    expect(runtime.repo.latestAnalysis(analyzeReq)).toMatchObject({
      goal: '实现登录',
      requirementVersion: 1,
    })
  })

  it('taskDetail 与 taskExecution 在需求、任务包、任务三层缺失处拒绝', () => {
    expect(runtime.taskDetail('missing', 't1')).toEqual({
      ok: false,
      code: 'not_found',
      message: '未找到需求 missing',
    })
    expect(runtime.taskExecution({ reqId: 'missing', taskId: 't1' })).toEqual({
      ok: false,
      code: 'not_found',
      message: '未找到需求 missing',
    })

    const noPlan = submit('req-task-noplan')
    expect(runtime.taskDetail(noPlan, 't1')).toEqual({
      ok: false,
      code: 'plan_missing',
      message: `需求 ${noPlan} 没有任务包`,
    })
    expect(runtime.taskExecution({ reqId: noPlan, taskId: 't1' })).toEqual({
      ok: false,
      code: 'plan_missing',
      message: `需求 ${noPlan} 没有任务包`,
    })

    const reqId = submit('req-task')
    seedPlan(reqId)
    expect(runtime.taskDetail(reqId, 't9')).toEqual({
      ok: false,
      code: 'task_missing',
      message: '任务包内没有任务 t9',
    })
    expect(runtime.taskExecution({ reqId, taskId: 't9' })).toEqual({
      ok: false,
      code: 'task_missing',
      message: '任务包内没有任务 t9',
    })
  })
})
