import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import { candidateIdentityOf, sha256OfText } from '../src/domain/delivery.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

let dir = ''
let runtime: ForgeLoopRuntime
let config: ForgeLoopConfig

function makeRuntime(overrides: Partial<ForgeLoopConfig> = {}): ForgeLoopRuntime {
  config = {
    ...resolveConfig(
      {
        project: 'testproj',
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        pollSeconds: 1,
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
        formalTestTimeoutSeconds: 30,
        maxTaskAttempts: 2,
      },
      dir,
    ),
    ...overrides,
  }
  return new ForgeLoopRuntime({ ctx: {}, config })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-lifecycle-'))
  runtime = makeRuntime()
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

function submit(reqId = 'req-1'): string {
  const result = runtime.submit({ text: '生命周期测试', by: 'owner', source: 'test' })
  expect(result.ok, result.message).toBe(true)
  return (result.data as { reqId: string }).reqId
}

function plan(reqId: string, planVersion = 1, testCommand: string[] = ['node', '-e', 'process.exit(0)']): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}-${planVersion}`,
    requirementId: reqId,
    project: 'testproj',
    planVersion,
    requirementVersion: 1,
    createdAt: '2026-10-23T00:00:01.000Z',
    tasks: [
      {
        taskId: 't1',
        goal: '写文档',
        files: ['docs/a.md'],
        acceptance: '文档存在',
        testCommand,
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
      {
        taskId: 't2',
        goal: '补测试',
        files: ['docs/b.md'],
        acceptance: '测试存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: ['t1'],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
    ],
  }
}

function seedPlan(reqId: string, planVersion = 1, testCommand?: string[]): TaskPlan {
  const value = plan(reqId, planVersion, testCommand)
  runtime.repo.recordTaskPlan(value)
  return value
}

function approve(reqId: string, planVersion = 1): void {
  runtime.repo.recordPlanApproval({
    requirementId: reqId,
    planVersion,
    approvedBy: 'owner',
    approvedAt: '2026-10-23T00:00:02.000Z',
    source: 'test',
  })
}

function deliver(reqId: string, taskId: string, planVersion = 1): void {
  runtime.repo.recordTaskArtifact({
    requirementId: reqId,
    planVersion,
    taskId,
    candidateSha256: `candidate-${taskId}`,
    testEvidenceSha256: `test-${taskId}`,
    reviewSha256: `review-${taskId}`,
    acceptance: '达成',
    authorizationSource: `plan-approval:${reqId}:v${planVersion}:owner`,
    recordedAt: '2026-10-23T00:00:03.000Z',
    baselineCommit: 'abc',
  })
}

/** 验收必须绑定当前候选的独立验证结论；这里写入可核对的通过证据。 */
function verify(reqId: string, planVersion = 1): string {
  const plan = runtime.repo.taskPlan(reqId, planVersion)!
  const artifacts = plan.tasks.map((task) => runtime.repo.taskArtifact(reqId, planVersion, task.taskId)!)
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
    verdict: 'pass',
    summary: '候选通过独立验证',
    findings: [],
    blocking: [],
    scenarios: [{ scenario: '场景', status: 'pass', evidence: '正式测试退出码 0', commands: ['smoke'] }],
    commands: [],
    sessionId: 'session-verification',
    at: '2026-10-23T00:00:04.000Z',
  }
  const reportJson = `${JSON.stringify(report, null, 2)}\n`
  const reportPath = join(dir, 'verifications', reqId, `v${planVersion}`, candidateSha256.slice(0, 16), 'verification.json')
  mkdirSync(join(reportPath, '..'), { recursive: true })
  writeFileSync(reportPath, reportJson, 'utf8')
  runtime.repo.recordVerification({
    requirementId: reqId,
    planVersion,
    candidateSha256,
    requirementVersion: plan.requirementVersion,
    workspaceSha256: 'tree',
    verdict: 'pass',
    reportJson,
    reportPath,
    reportSha256: sha256OfText(reportJson),
    evidenceDir: join(reportPath, '..'),
    sessionId: report.sessionId,
    verifiedAt: report.at,
  })
  const review = {
    kind: 'business-review',
    reqId,
    planVersion,
    requirementVersion: plan.requirementVersion,
    candidateSha256,
    verificationSha256: sha256OfText(reportJson),
    verdict: 'pass',
    summary: '业务终审通过',
    findings: [],
    blocking: [],
    scenarios: [{ scenario: '场景', status: 'pass', evidence: '正式测试退出码 0', commands: ['smoke'] }],
    acceptance: [{ criterion: '验收', status: 'pass', evidence: '正式测试退出码 0', commands: ['smoke'] }],
    sessionId: 'session-business-review',
    at: '2026-10-23T00:00:05.000Z',
  }
  const reviewJson = `${JSON.stringify(review, null, 2)}\n`
  const reviewPath = join(dir, 'reviews', reqId, `v${planVersion}`, 'business', 'business-review.json')
  mkdirSync(join(reviewPath, '..'), { recursive: true })
  writeFileSync(reviewPath, reviewJson, 'utf8')
  runtime.repo.recordBusinessReview({
    requirementId: reqId,
    planVersion,
    candidateSha256,
    requirementVersion: plan.requirementVersion,
    verificationSha256: sha256OfText(reportJson),
    verdict: 'pass',
    reportJson: reviewJson,
    reportPath: reviewPath,
    reportSha256: sha256OfText(reviewJson),
    sessionId: review.sessionId,
    reviewedAt: review.at,
  })
  return candidateSha256
}

describe('requirement lifecycle commands', () => {
  it('revises a requirement and rejects unknown or terminal identities', () => {
    const reqId = submit()
    const revised = runtime.revise({ reqId, text: '修订后的需求', by: 'owner', source: 'test' })
    expect(revised.ok).toBe(true)
    expect((revised.data as { versions: unknown[] }).versions).toHaveLength(2)

    expect(runtime.revise({ reqId: 'req-missing', text: 'x', by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })

    runtime.repo.setStatus(reqId, 'accepted')
    expect(runtime.revise({ reqId, text: 'x', by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'terminal',
    })
  })

  it('cancels a requirement, dismisses pending work and refuses terminal ones', () => {
    const reqId = submit()
    runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 'test' })
    const cancelled = runtime.cancel({ reqId, by: 'owner', reason: '方向变了' })
    expect(cancelled.ok).toBe(true)
    expect(runtime.repo.requestsFor(reqId).every((request) => request.state === 'dismissed')).toBe(true)
    expect(runtime.repo.cancellation(reqId)?.reason).toBe('方向变了')
    expect(runtime.cancel({ reqId, by: 'owner', reason: 'again' })).toMatchObject({ ok: false, code: 'terminal' })
    expect(runtime.cancel({ reqId: 'req-missing', by: 'owner', reason: 'x' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })

  it('stops a requirement into blocked state and records the reason', () => {
    const reqId = submit()
    const stopped = runtime.stop({ reqId, by: 'owner', reason: '先暂停' })
    expect(stopped.ok).toBe(true)
    const view = runtime.status(reqId).data as { status: string; blockedReason: string }
    expect(view.status).toBe('blocked')
    expect(view.blockedReason).toContain('先暂停')
    expect(runtime.stop({ reqId, by: 'owner', reason: '' }).ok).toBe(true)
    expect(runtime.stop({ reqId: 'req-missing', by: 'owner', reason: '' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })

  it('adds grants without clearing the failure count', () => {
    const reqId = submit()
    const granted = runtime.grant({ reqId, by: 'owner' })
    expect(granted.ok).toBe(true)
    expect(granted.data).toEqual({ grants: 2 })
    expect(runtime.grant({ reqId: 'req-missing', by: 'owner' })).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('operation requests', () => {
  it('rejects unknown and terminal requirements', () => {
    expect(runtime.requestOperation({ reqId: 'req-missing', action: 'analyze', by: 'owner', source: 't' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    const reqId = submit()
    runtime.repo.setStatus(reqId, 'accepted')
    expect(runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 't' })).toMatchObject({
      ok: false,
      code: 'terminal',
    })
  })

  it('requires an analysis before planning', () => {
    const reqId = submit()
    expect(runtime.requestOperation({ reqId, action: 'plan', by: 'owner', source: 't' })).toMatchObject({
      ok: false,
      code: 'analysis_missing',
    })
  })

  it('reuses a pending request of the same action and refuses a conflicting one', () => {
    const reqId = submit()
    const first = runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 't' })
    expect(first.ok).toBe(true)
    const again = runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 't' })
    expect(again.ok).toBe(true)
    expect(again.message).toContain('未重复排队')

    runtime.repo.recordAnalysis({
      reqId,
      analysisVersion: 1,
      requirementVersion: 1,
      goal: '目标',
      scenarios: ['场景'],
      acceptanceCriteria: ['标准'],
      clarifications: [],
      createdAt: '2026-10-23T00:00:02.000Z',
    })
    const conflicting = runtime.requestOperation({ reqId, action: 'plan', by: 'owner', source: 't' })
    expect(conflicting.ok).toBe(false)
    expect(conflicting.message).toContain('不能同时排队')
  })

  it('requires an approved plan before advancing', () => {
    const reqId = submit()
    expect(runtime.requestOperation({ reqId, action: 'advance', by: 'owner', source: 't' })).toMatchObject({
      ok: false,
      code: 'plan_missing',
    })
    seedPlan(reqId)
    expect(runtime.requestOperation({ reqId, action: 'advance', by: 'owner', source: 't' })).toMatchObject({
      ok: false,
      code: 'plan_not_approved',
    })
  })
})

describe('plan, evidence and request queries', () => {
  it('shows the latest or a specific plan with its authorization', () => {
    const reqId = submit()
    expect(runtime.showPlan(reqId)).toMatchObject({ ok: false, code: 'plan_missing' })
    expect(runtime.showPlan('req-missing')).toMatchObject({ ok: false, code: 'not_found' })

    seedPlan(reqId)
    approve(reqId)
    const view = runtime.showPlan(reqId).data as { plan: { planVersion: number }; authorization: { status: string } }
    expect(view.plan.planVersion).toBe(1)
    expect(view.authorization.status).toBe('approved')
    seedPlan(reqId, 2)
    const specific = runtime.showPlan(reqId, 1).data as { plan: { planVersion: number } }
    expect(specific.plan.planVersion).toBe(1)
    expect(runtime.showPlan(reqId, 9)).toMatchObject({ ok: false, code: 'plan_missing' })
  })

  it('reports delivery evidence per task', () => {
    const reqId = submit()
    expect(runtime.evidence(reqId)).toMatchObject({ ok: false, code: 'plan_missing' })
    expect(runtime.evidence('req-missing')).toMatchObject({ ok: false, code: 'not_found' })
    seedPlan(reqId)
    deliver(reqId, 't1')
    const view = runtime.evidence(reqId).data as {
      evidence: Array<{ taskId: string; artifact: { taskId: string } | null }>
    }
    expect(view.evidence).toHaveLength(2)
    expect(view.evidence[0]!.artifact?.taskId).toBe('t1')
    expect(view.evidence[1]!.artifact).toBeNull()
  })

  it('lists requests for one requirement or the whole project', () => {
    const reqId = submit()
    runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 't' })
    expect((runtime.listRequests(reqId).data as { requests: unknown[] }).requests).toHaveLength(1)
    expect((runtime.listRequests().data as { requests: unknown[] }).requests).toHaveLength(1)
    expect((runtime.listRequests('req-missing').data as { requests: unknown[] }).requests).toHaveLength(0)
  })
})

describe('recovery and candidate preconditions', () => {
  it('closes an interrupted claimed request as failed and discards its workspace', () => {
    const reqId = submit()
    runtime.repo.recordRequest({
      requestId: 'rq-interrupted',
      reqId,
      project: 'testproj',
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-23T00:00:02.000Z',
    })
    runtime.repo.claimNextRequest('tester', '2026-10-23T00:00:03.000Z')
    const recovery = runtime.recoverInterrupted('2026-10-23T00:00:04.000Z')
    expect(recovery.interruptedRequests).toEqual(['rq-interrupted'])
    expect(runtime.repo.request('rq-interrupted')?.state).toBe('failed')
    expect(runtime.repo.request('rq-interrupted')?.detail).toContain('一次性工作副本已丢弃')
  })

  it('refuses to build a candidate before every task is delivered', () => {
    expect(runtime.buildCandidate({ reqId: 'req-missing', by: 'owner' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    const reqId = submit()
    expect(runtime.buildCandidate({ reqId, by: 'owner' })).toMatchObject({ ok: false, code: 'plan_missing' })
    seedPlan(reqId)
    expect(runtime.buildCandidate({ reqId, by: 'owner' })).toMatchObject({ ok: false, code: 'plan_not_approved' })
    approve(reqId)
    expect(runtime.buildCandidate({ reqId, by: 'owner' })).toMatchObject({ ok: false, code: 'not_delivered' })
    deliver(reqId, 't1')
    deliver(reqId, 't2')
    expect(runtime.buildCandidate({ reqId, by: 'owner' })).toMatchObject({
      ok: false,
      code: 'candidate_not_configured',
    })
  })

  it('validates the candidate version before touching any workspace', () => {
    const reqId = submit()
    seedPlan(reqId)
    approve(reqId)
    deliver(reqId, 't1')
    deliver(reqId, 't2')
    const configured = makeRuntime({
      candidateBuildCommand: ['node', '-e', 'process.exit(0)'],
      candidatePackageCommand: ['node', '-e', 'process.exit(0)'],
      candidateArtifactPath: 'dist/artifact.json',
    })
    try {
      expect(configured.buildCandidate({ reqId, by: 'owner', version: 'not-a-version' })).toMatchObject({
        ok: false,
        code: 'version_invalid',
      })
    } finally {
      configured.close()
    }
  })
})

describe('acceptance rules', () => {
  it('requires a plan, an approval and every delivered task', () => {
    expect(runtime.accept({ reqId: 'req-missing', by: 'owner', source: 't' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    const reqId = submit()
    expect(runtime.accept({ reqId, by: 'owner', source: 't' })).toMatchObject({ ok: false, code: 'plan_missing' })
    seedPlan(reqId)
    expect(runtime.accept({ reqId, by: 'owner', source: 't' })).toMatchObject({ ok: false, code: 'plan_not_approved' })
    approve(reqId)
    expect(runtime.accept({ reqId, by: 'owner', source: 't' })).toMatchObject({ ok: false, code: 'not_delivered' })
    deliver(reqId, 't1')
    expect(runtime.accept({ reqId, by: 'owner', source: 't' })).toMatchObject({ ok: false, code: 'not_delivered' })
    deliver(reqId, 't2')
    expect(runtime.accept({ reqId, by: 'owner', source: 't' })).toMatchObject({
      ok: false,
      code: 'verification_required',
    })
    verify(reqId)
    const accepted = runtime.accept({ reqId, by: 'owner', source: 't' })
    expect(accepted.ok).toBe(true)
    expect(accepted.message).toContain('材料指纹')
    expect(runtime.repo.getRequirement(reqId)!.status).toBe('accepted')
  })

  it('rejects acceptance once the requirement has moved past the approved version', () => {
    const reqId = submit()
    seedPlan(reqId)
    approve(reqId)
    deliver(reqId, 't1')
    deliver(reqId, 't2')
    runtime.revise({ reqId, text: '修订后需重新规划', by: 'owner', source: 't' })
    expect(runtime.accept({ reqId, by: 'owner', source: 't' })).toMatchObject({
      ok: false,
      code: 'stale_requirement',
    })
  })

  it('binds acceptance to the exact recorded candidate artifact', () => {
    const reqId = submit()
    seedPlan(reqId)
    approve(reqId)
    deliver(reqId, 't1')
    deliver(reqId, 't2')
    verify(reqId)
    const sha = 'a'.repeat(64)
    runtime.repo.recordCandidate({
      reqId,
      planVersion: 1,
      sha256: sha,
      tarball: 'dist/forgeloop.tgz',
      files: [],
      gitHead: 'abc',
      builtAt: '2026-10-23T00:00:04.000Z',
      evidenceDir: 'evidence',
    })
    expect(runtime.accept({ reqId, by: 'owner', source: 't' })).toMatchObject({
      ok: false,
      code: 'artifact_required',
    })
    expect(runtime.accept({ reqId, by: 'owner', source: 't', artifactSha256: 'b'.repeat(64) })).toMatchObject({
      ok: false,
      code: 'artifact_mismatch',
    })
    const accepted = runtime.accept({ reqId, by: 'owner', source: 't', artifactSha256: sha })
    expect(accepted.ok).toBe(true)
    expect(runtime.repo.acceptance(reqId).acceptance_fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('execution guards and directory summary', () => {
  it('refuses to execute work for unknown or terminal requirements', async () => {
    const missing = runtime.repo.request('nope') ?? {
      requestId: 'rq-x',
      reqId: 'req-missing',
      project: 'testproj',
      planVersion: 0,
      action: 'analyze' as const,
      state: 'pending' as const,
      requestedBy: 'owner',
      source: 'test',
      createdAt: '2026-10-23T00:00:00.000Z',
      detail: '',
      owner: '',
      claimedAt: '',
      attempts: 0,
    }
    expect(await runtime.executeRequest(missing, new AbortController().signal)).toEqual({
      state: 'failed',
      detail: '未找到需求 req-missing',
    })

    const reqId = submit()
    runtime.repo.setStatus(reqId, 'accepted')
    const request = {
      ...missing,
      reqId,
      requestId: 'rq-terminal',
    }
    expect((await runtime.executeRequest(request, new AbortController().signal)).state).toBe('failed')
  })

  it('summarizes the records layout and the resolved agent selection', () => {
    const summary = runtime.directorySummary() as {
      recordsRoot: string
      database: string
      projectPath: string
      autoAdvance: boolean
      agent: { provider: string; model: string }
    }
    expect(summary.recordsRoot).toBe(config.recordsRoot)
    expect(summary.database).toContain('records.sqlite')
    expect(summary.projectPath).toBe(dir)
    expect(summary.autoAdvance).toBe(false)
    expect(summary.agent).toEqual({ provider: 'fake', model: 'fake' })
  })
})

describe('approval boundaries', () => {
  it('refuses a plan that references a retired Python runtime', () => {
    const reqId = submit()
    seedPlan(reqId, 1, ['python', '-m', 'pytest'])
    const result = runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' })
    expect(result).toMatchObject({ ok: false, code: 'plan_out_of_boundary' })
  })

  it('rejects an approval for a missing plan or stale requirement version', () => {
    const reqId = submit()
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'plan_missing',
    })
    seedPlan(reqId)
    runtime.revise({ reqId, text: '修订后重新规划', by: 'owner', source: 'test' })
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'stale_requirement',
    })
  })
})
