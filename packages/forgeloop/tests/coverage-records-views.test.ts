import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { VerificationStore } from '../src/records/verification-store.js'
import {
  buildAcceptanceBinding,
  expectedAcceptanceFingerprints,
} from '../src/runtime/acceptance-binding.js'
import { pendingClarificationsOf } from '../src/runtime/clarification-view.js'
import { requirementDetailExtras } from '../src/runtime/requirement-detail.js'
import { RuleViolationError } from '../src/domain/errors.js'
import { candidateIdentityOf } from '../src/domain/delivery.js'
import { AWAITING_CLARIFICATION } from '../src/domain/status.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import type { RequirementAnalysis } from '../src/domain/requirement.js'
import type { VerificationRecord } from '../src/records/rows.js'
import type { Requirement } from '../src/domain/requirement.js'

/**
 * 记录层验证尝试与运行时视图的补充行为测试。
 *
 * 验证尝试部分走真实临时 sqlite：断言追加历史、序号/前驱、投影与重开恢复。
 * 运行时视图部分用真实仓储构造业务记录；只有持久层无法表达的历史缺口
 * （空版本、缺失的前一条分析）才用结构化仓储桩验证回退展示。
 */

let dir = ''
let database: Database
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-coverage-views-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repository = new Repository(database)
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function submitRequirement(
  reqId: string,
  options: { text?: string; source?: string; now?: string } = {},
): Requirement {
  repository.submit({
    reqId,
    project: 'testproj',
    text: options.text ?? '需求正文',
    submittedBy: 'owner',
    source: options.source ?? 'test',
    now: options.now ?? '2026-11-01T00:00:00.000Z',
  })
  const requirement = repository.getRequirement(reqId)
  if (!requirement) throw new Error(`需求 ${reqId} 未写入`)
  return requirement
}

const VERIFY_CANDIDATE = 'a'.repeat(64)

function verificationRecord(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    requirementId: 'req-verify',
    planVersion: 1,
    candidateSha256: VERIFY_CANDIDATE,
    requirementVersion: 1,
    workspaceSha256: 'w'.repeat(64),
    verdict: 'block',
    reportJson: '{"verdict":"block"}',
    reportPath: '/tmp/verification.json',
    reportSha256: 'r'.repeat(64),
    evidenceDir: '/tmp/evidence',
    sessionId: 'session-verification',
    verifiedAt: '2026-11-01T00:10:00.000Z',
    ...overrides,
  }
}

describe('verification attempt history', () => {
  beforeEach(() => {
    submitRequirement('req-verify')
  })

  it('starts a candidate at attempt 1 and exposes recorded failure details', () => {
    const store = new VerificationStore(database)
    expect(store.nextAttempt('req-verify', 1, VERIFY_CANDIDATE)).toEqual({
      attemptNumber: 1,
      previousAttemptId: '',
    })
    expect(store.attempt('ver-missing')).toBeNull()

    const record = verificationRecord({
      failureKind: 'formal_test_failed',
      blocking: ['正式测试用例失败', '报告缺少命令记录'],
      verifiedAt: '2026-11-01T00:10:00.000Z',
    })
    repository.recordVerification(record)

    const expectedAttemptId = `ver-req-verify-v1-${VERIFY_CANDIDATE}-a1`
    const attempt = repository.verificationAttempt(expectedAttemptId)
    expect(attempt).toEqual({
      ...record,
      attemptId: expectedAttemptId,
      attemptNumber: 1,
      previousAttemptId: '',
      failureKind: 'formal_test_failed',
      blocking: ['正式测试用例失败', '报告缺少命令记录'],
      reason: '',
    })
    expect(repository.nextVerificationAttempt('req-verify', 1, VERIFY_CANDIDATE)).toEqual({
      attemptNumber: 2,
      previousAttemptId: expectedAttemptId,
    })
    expect(repository.verification('req-verify', 1)).toMatchObject({
      candidateSha256: VERIFY_CANDIDATE,
      verdict: 'block',
      reportSha256: 'r'.repeat(64),
    })
  })

  it('numbers automatic attempts in order and links the immediate predecessor', () => {
    repository.recordVerification(verificationRecord({ reportSha256: '1'.repeat(64) }))
    repository.recordVerification(
      verificationRecord({
        verdict: 'pass',
        reportSha256: '2'.repeat(64),
        reportJson: '{"verdict":"pass"}',
        verifiedAt: '2026-11-01T00:11:00.000Z',
      }),
    )

    const attempts = repository.verificationAttemptsForCandidate('req-verify', 1, VERIFY_CANDIDATE)
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2])
    expect(attempts.map((attempt) => attempt.verdict)).toEqual(['block', 'pass'])
    expect(attempts[1]?.previousAttemptId).toBe(attempts[0]?.attemptId)
    expect(repository.verification('req-verify', 1)).toMatchObject({
      verdict: 'pass',
      reportSha256: '2'.repeat(64),
      verifiedAt: '2026-11-01T00:11:00.000Z',
    })
  })

  it('links an explicitly numbered attempt to the nearest earlier attempt', () => {
    repository.recordVerification(verificationRecord({ attemptNumber: 1 }))
    repository.recordVerification(
      verificationRecord({
        attemptNumber: 3,
        verdict: 'pass',
        reportSha256: '3'.repeat(64),
        verifiedAt: '2026-11-01T00:12:00.000Z',
      }),
    )

    const skipped = repository.verificationAttempt(`ver-req-verify-v1-${VERIFY_CANDIDATE}-a3`)
    expect(skipped).toMatchObject({
      attemptNumber: 3,
      previousAttemptId: `ver-req-verify-v1-${VERIFY_CANDIDATE}-a1`,
    })
    expect(repository.nextVerificationAttempt('req-verify', 1, VERIFY_CANDIDATE)).toEqual({
      attemptNumber: 4,
      previousAttemptId: `ver-req-verify-v1-${VERIFY_CANDIDATE}-a3`,
    })
  })

  it('leaves the predecessor empty when a manually numbered attempt is first', () => {
    repository.recordVerification(verificationRecord({ attemptNumber: 5 }))
    const first = repository.verificationAttempt(`ver-req-verify-v1-${VERIFY_CANDIDATE}-a5`)
    expect(first).toMatchObject({ attemptNumber: 5, previousAttemptId: '' })
    expect(
      repository.verificationAttemptsForCandidate('req-verify', 1, VERIFY_CANDIDATE),
    ).toHaveLength(1)
    expect(repository.nextVerificationAttempt('req-verify', 1, VERIFY_CANDIDATE)).toEqual({
      attemptNumber: 6,
      previousAttemptId: `ver-req-verify-v1-${VERIFY_CANDIDATE}-a5`,
    })
  })

  it('rewrites the latest projection while keeping each historical attempt', () => {
    repository.recordVerification(
      verificationRecord({
        verdict: 'block',
        reportPath: '/tmp/block.json',
        verifiedAt: '2026-11-01T00:10:00.000Z',
      }),
    )
    repository.recordVerification(
      verificationRecord({
        verdict: 'pass',
        reportPath: '/tmp/pass.json',
        reportJson: '{"verdict":"pass"}',
        reportSha256: 'p'.repeat(64),
        verifiedAt: '2026-11-01T00:20:00.000Z',
      }),
    )

    expect(repository.verification('req-verify', 1)).toMatchObject({
      verdict: 'pass',
      reportPath: '/tmp/pass.json',
      reportSha256: 'p'.repeat(64),
    })
    expect(repository.verificationForCandidate('req-verify', 1, VERIFY_CANDIDATE)).toMatchObject({
      verdict: 'pass',
      reportPath: '/tmp/pass.json',
    })
    const history = repository.verificationAttempts('req-verify')
    expect(history.map((attempt) => [attempt.attemptNumber, attempt.reportPath])).toEqual([
      [1, '/tmp/block.json'],
      [2, '/tmp/pass.json'],
    ])
    // requirement_verifications 是“每个候选的最新投影”，历史保留在 attempts 表里。
    expect(repository.verificationsFor('req-verify')).toHaveLength(1)
  })

  it('treats malformed blocking JSON as an empty list without losing the attempt', () => {
    repository.recordVerification(
      verificationRecord({ failureKind: 'report_missing', blocking: ['缺少报告'] }),
    )
    database.handle
      .prepare(
        'UPDATE requirement_verification_attempts SET blocking_json = ? WHERE attempt_id = ?',
      )
      .run('{not-json', `ver-req-verify-v1-${VERIFY_CANDIDATE}-a1`)

    const attempt = repository.verificationAttempt(`ver-req-verify-v1-${VERIFY_CANDIDATE}-a1`)
    expect(attempt?.blocking).toEqual([])
    expect(attempt?.failureKind).toBe('report_missing')
    expect(
      repository.verificationAttemptsForCandidate('req-verify', 1, VERIFY_CANDIDATE),
    ).toHaveLength(1)
  })

  it('resumes attempt numbering after the database is reopened', () => {
    repository.recordVerification(verificationRecord({ reportSha256: '1'.repeat(64) }))
    repository.close()
    database = Database.open(join(dir, 'records.sqlite'))
    repository = new Repository(database)

    expect(repository.nextVerificationAttempt('req-verify', 1, VERIFY_CANDIDATE)).toEqual({
      attemptNumber: 2,
      previousAttemptId: `ver-req-verify-v1-${VERIFY_CANDIDATE}-a1`,
    })
    expect(
      repository.verificationAttempt(`ver-req-verify-v1-${VERIFY_CANDIDATE}-a1`),
    ).toMatchObject({
      reportSha256: '1'.repeat(64),
    })
    repository.recordVerification(
      verificationRecord({ reportSha256: '2'.repeat(64), verifiedAt: '2026-11-01T00:30:00.000Z' }),
    )
    const attempts = repository.verificationAttemptsForCandidate('req-verify', 1, VERIFY_CANDIDATE)
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2])
    expect(attempts[1]?.previousAttemptId).toBe(attempts[0]?.attemptId)
  })

  it('scopes latest, candidate and history queries by plan version and candidate', () => {
    const otherCandidate = 'b'.repeat(64)
    repository.recordVerification(
      verificationRecord({
        candidateSha256: VERIFY_CANDIDATE,
        reportSha256: '1'.repeat(64),
        verifiedAt: '2026-11-01T00:10:00.000Z',
      }),
    )
    repository.recordVerification(
      verificationRecord({
        candidateSha256: otherCandidate,
        reportSha256: '2'.repeat(64),
        verifiedAt: '2026-11-01T00:20:00.000Z',
      }),
    )
    repository.recordVerification(
      verificationRecord({
        planVersion: 2,
        candidateSha256: VERIFY_CANDIDATE,
        reportSha256: '3'.repeat(64),
        verifiedAt: '2026-11-01T00:30:00.000Z',
      }),
    )

    expect(repository.verification('req-verify', 1)).toMatchObject({
      candidateSha256: otherCandidate,
      reportSha256: '2'.repeat(64),
    })
    expect(repository.verification('req-verify', 2)).toMatchObject({
      reportSha256: '3'.repeat(64),
    })
    expect(repository.verificationForCandidate('req-verify', 1, otherCandidate)).toMatchObject({
      reportSha256: '2'.repeat(64),
    })
    expect(repository.verificationForCandidate('req-verify', 1, 'c'.repeat(64))).toBeNull()
    expect(
      repository.verificationAttemptsForCandidate('req-verify', 1, VERIFY_CANDIDATE),
    ).toHaveLength(1)
    expect(repository.verificationAttemptsForCandidate('req-verify', 1, 'c'.repeat(64))).toEqual([])
    expect(repository.verificationAttempts('req-verify')).toHaveLength(3)
    expect(repository.verificationsFor('req-verify').map((item) => item.reportSha256)).toEqual([
      '1'.repeat(64),
      '2'.repeat(64),
      '3'.repeat(64),
    ])
    expect(repository.verification('req-missing', 1)).toBeNull()
    expect(repository.verificationsFor('req-missing')).toEqual([])
  })
})

// ---------------------------------------------------------------- 验收绑定

const ACCEPT_REQ = 'req-accept'

function taskPlanOf(taskIds: readonly string[]): TaskPlan {
  return {
    taskPlanId: `plan-${ACCEPT_REQ}-1`,
    requirementId: ACCEPT_REQ,
    project: 'testproj',
    planVersion: 1,
    requirementVersion: 1,
    tasks: taskIds.map((taskId) => ({
      taskId,
      goal: `完成 ${taskId}`,
      files: [`docs/${taskId}.md`],
      acceptance: `${taskId} 可观察`,
      testCommand: ['true'],
      dependsOn: [],
      limits: { limitSeconds: -1, maxFailureRounds: -1 },
      authorizationSource: 'system-admission:test',
    })),
    createdAt: '2026-11-01T01:00:00.000Z',
  }
}

const ARTIFACT_SHA = 'f'.repeat(64)

function seedDeliverable(
  options: {
    taskIds?: readonly string[]
    artifactTaskIds?: readonly string[]
    baselineCommit?: string
    buildCandidate?: string
    planVersionForBuild?: number
    withVerification?: boolean
    withReview?: boolean
  } = {},
): string {
  const taskIds = options.taskIds ?? ['t1']
  const artifactTaskIds = options.artifactTaskIds ?? taskIds
  const baselineCommit = options.baselineCommit ?? ''
  seedAcceptRequirement()
  repository.recordTaskPlan(taskPlanOf(taskIds))
  for (const [index, taskId] of artifactTaskIds.entries()) {
    repository.recordTaskArtifact({
      requirementId: ACCEPT_REQ,
      planVersion: 1,
      taskId,
      candidateSha256: `cand-${taskId}`,
      testEvidenceSha256: `e${index}`.repeat(32),
      reviewSha256: `r${index}`.repeat(32),
      acceptance: `${taskId} 可观察`,
      authorizationSource: 'test',
      recordedAt: '2026-11-01T01:10:00.000Z',
    })
    if (baselineCommit) {
      repository.recordEvidence({
        requirementId: ACCEPT_REQ,
        planVersion: 1,
        taskId,
        baselineCommit,
        workspacePath: `/tmp/${taskId}`,
        candidatePath: `/tmp/${taskId}/candidate`,
        testLogPath: `/tmp/${taskId}/test.log`,
        reviewPath: `/tmp/${taskId}/review.md`,
        devSession: 'dev-session',
        reviewSession: 'review-session',
        recordedAt: '2026-11-01T01:10:00.000Z',
      })
    }
  }
  const identity = candidateIdentityOf({
    planVersion: 1,
    requirementVersion: 1,
    baselineCommit,
    candidateHashes: artifactTaskIds.map((taskId) => `cand-${taskId}`),
  })
  repository.recordCandidateBuild({
    reqId: ACCEPT_REQ,
    planVersion: options.planVersionForBuild ?? 1,
    candidateSha256: options.buildCandidate ?? identity,
    verificationSha256: 'v'.repeat(64),
    packageVersion: '1.0.0',
    artifactSha256: ARTIFACT_SHA,
    tarball: '/tmp/candidate.tgz',
    files: ['lib/index.js'],
    gitHead: 'head',
    builtAt: '2026-11-01T01:20:00.000Z',
    evidenceDir: '/tmp/build-evidence',
  })
  if (options.withVerification) {
    repository.recordVerification(
      verificationRecord({ requirementId: ACCEPT_REQ, candidateSha256: identity }),
    )
  }
  if (options.withReview) {
    repository.recordBusinessReview({
      requirementId: ACCEPT_REQ,
      planVersion: 1,
      candidateSha256: identity,
      requirementVersion: 1,
      verificationSha256: 'r'.repeat(64),
      verdict: 'pass',
      reportJson: '{}',
      reportPath: '/tmp/review.json',
      reportSha256: 's'.repeat(64),
      sessionId: 'review-session',
      reviewedAt: '2026-11-01T01:30:00.000Z',
    })
  }
  return identity
}

function seedAcceptRequirement(): void {
  if (!repository.getRequirement(ACCEPT_REQ)) {
    submitRequirement(ACCEPT_REQ, { text: '验收绑定需求', now: '2026-11-01T00:50:00.000Z' })
  }
}

type StubRepository = Record<string, (...args: never[]) => unknown>

function stubRepository(overrides: StubRepository): Repository {
  return overrides as unknown as Repository
}

describe('acceptance binding evidence', () => {
  it('returns no fingerprints before any candidate build exists', () => {
    seedAcceptRequirement()
    expect(expectedAcceptanceFingerprints(repository, ACCEPT_REQ, ARTIFACT_SHA)).toEqual([])
  })

  it('returns no fingerprints when the built plan cannot be read', () => {
    seedAcceptRequirement()
    repository.recordCandidateBuild({
      reqId: ACCEPT_REQ,
      planVersion: 3,
      candidateSha256: 'c'.repeat(64),
      verificationSha256: 'v'.repeat(64),
      packageVersion: '1.0.0',
      artifactSha256: ARTIFACT_SHA,
      tarball: '/tmp/candidate.tgz',
      files: [],
      gitHead: 'head',
      builtAt: '2026-11-01T01:20:00.000Z',
      evidenceDir: '/tmp/build-evidence',
    })
    expect(expectedAcceptanceFingerprints(repository, ACCEPT_REQ, ARTIFACT_SHA)).toEqual([])
  })

  it('returns no fingerprints and reports the missing task artifact', () => {
    seedDeliverable({ taskIds: ['t1', 't2'], artifactTaskIds: ['t1'] })
    expect(expectedAcceptanceFingerprints(repository, ACCEPT_REQ, ARTIFACT_SHA)).toEqual([])

    const plan = repository.taskPlan(ACCEPT_REQ, 1)
    expect(plan).not.toBeNull()
    expect(() =>
      buildAcceptanceBinding({
        plan: plan!,
        artifacts: repository.taskArtifacts(ACCEPT_REQ, 1),
        verification: verificationRecord({ requirementId: ACCEPT_REQ }),
        businessReview: { reportSha256: 's'.repeat(64) } as never,
        candidateSha256: 'c'.repeat(64),
      }),
    ).toThrow(new RuleViolationError('任务 t2 缺少交付产物'))
  })

  it('returns no fingerprints when the build names another candidate', () => {
    seedDeliverable({ buildCandidate: 'd'.repeat(64) })
    expect(expectedAcceptanceFingerprints(repository, ACCEPT_REQ, ARTIFACT_SHA)).toEqual([])
  })

  it('requires both verification and business review for the built candidate', () => {
    const identity = seedDeliverable()
    expect(expectedAcceptanceFingerprints(repository, ACCEPT_REQ, ARTIFACT_SHA)).toEqual([])

    repository.recordVerification(
      verificationRecord({ requirementId: ACCEPT_REQ, candidateSha256: identity }),
    )
    expect(expectedAcceptanceFingerprints(repository, ACCEPT_REQ, ARTIFACT_SHA)).toEqual([])

    repository.recordBusinessReview({
      requirementId: ACCEPT_REQ,
      planVersion: 1,
      candidateSha256: identity,
      requirementVersion: 1,
      verificationSha256: 'r'.repeat(64),
      verdict: 'pass',
      reportJson: '{}',
      reportPath: '/tmp/review.json',
      reportSha256: 's'.repeat(64),
      sessionId: 'review-session',
      reviewedAt: '2026-11-01T01:30:00.000Z',
    })
    expect(expectedAcceptanceFingerprints(repository, ACCEPT_REQ, ARTIFACT_SHA)).toHaveLength(2)
  })

  it('binds the baseline commit and keeps the artifact digest as a separate fingerprint', () => {
    seedDeliverable({
      baselineCommit: 'base-commit-1',
      withVerification: true,
      withReview: true,
    })

    // 不传制品摘要时两种绑定重合；传入另一个摘要才多出一种，供“验收早于构建”的场景复核。
    expect(expectedAcceptanceFingerprints(repository, ACCEPT_REQ, '')).toHaveLength(1)
    expect(expectedAcceptanceFingerprints(repository, ACCEPT_REQ, 'a'.repeat(64))).toHaveLength(2)

    const binding = buildAcceptanceBinding({
      plan: repository.taskPlan(ACCEPT_REQ, 1)!,
      artifacts: repository.taskArtifacts(ACCEPT_REQ, 1),
      verification: repository.verificationForCandidate(
        ACCEPT_REQ,
        1,
        candidateIdentityOf({
          planVersion: 1,
          requirementVersion: 1,
          baselineCommit: 'base-commit-1',
          candidateHashes: ['cand-t1'],
        }),
      )!,
      businessReview: repository.businessReviewForCandidate(
        ACCEPT_REQ,
        1,
        candidateIdentityOf({
          planVersion: 1,
          requirementVersion: 1,
          baselineCommit: 'base-commit-1',
          candidateHashes: ['cand-t1'],
        }),
      )!,
      artifactSha256: 'artifact-sha',
      candidateSha256: candidateIdentityOf({
        planVersion: 1,
        requirementVersion: 1,
        baselineCommit: 'base-commit-1',
        candidateHashes: ['cand-t1'],
      }),
    })
    expect(binding.baselineCommit).toBe('base-commit-1')
    expect(binding.artifactSha256).toBe('artifact-sha')
    expect(binding.verificationCandidateSha256).toBe(binding.candidateSha256)
    expect(binding.testEvidenceSha256).toMatch(/^[0-9a-f]{64}$/)

    const first = expectedAcceptanceFingerprints(repository, ACCEPT_REQ, 'artifact-sha')
    const second = expectedAcceptanceFingerprints(repository, ACCEPT_REQ, 'other-artifact-sha')
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    expect(new Set(first).size).toBe(2)
    // 不含制品摘要的绑定与制品无关；含制品摘要的绑定随当前制品变化。
    expect(first[0]).toBe(second[0])
    expect(first[0]).not.toBe(first[1])
    expect(first[1]).not.toBe(second[1])
    expect(first[0]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns no fingerprints when material hashes cannot be serialized', () => {
    const candidate = candidateIdentityOf({
      planVersion: 1,
      requirementVersion: 1,
      baselineCommit: '',
      candidateHashes: ['cand-t1'],
    })
    const plan = taskPlanOf(['t1'])
    const artifacts = [
      {
        requirementId: ACCEPT_REQ,
        planVersion: 1,
        taskId: 't1',
        candidateSha256: 'cand-t1',
        testEvidenceSha256: Symbol('broken-evidence'),
        reviewSha256: 'r'.repeat(64),
        acceptance: '可观察',
        authorizationSource: 'test',
        recordedAt: '2026-11-01T01:10:00.000Z',
        baselineCommit: '',
      },
    ]
    const stub = stubRepository({
      latestCandidateBuild: () => ({
        reqId: ACCEPT_REQ,
        planVersion: 1,
        candidateSha256: candidate,
        verificationSha256: 'v'.repeat(64),
        packageVersion: '1.0.0',
        artifactSha256: ARTIFACT_SHA,
        tarball: '/tmp/candidate.tgz',
        files: [],
        gitHead: 'head',
        builtAt: '2026-11-01T01:20:00.000Z',
        evidenceDir: '/tmp/build-evidence',
      }),
      taskPlan: () => plan,
      taskArtifacts: () => artifacts,
      verificationForCandidate: () =>
        verificationRecord({ requirementId: ACCEPT_REQ, candidateSha256: candidate }),
      businessReviewForCandidate: () => ({
        requirementId: ACCEPT_REQ,
        planVersion: 1,
        candidateSha256: candidate,
        requirementVersion: 1,
        verificationSha256: 'r'.repeat(64),
        verdict: 'pass',
        reportJson: '{}',
        reportPath: '/tmp/review.json',
        reportSha256: 's'.repeat(64),
        sessionId: 'review-session',
        reviewedAt: '2026-11-01T01:30:00.000Z',
      }),
    })

    expect(expectedAcceptanceFingerprints(stub, ACCEPT_REQ, ARTIFACT_SHA)).toEqual([])
  })
})

// ---------------------------------------------------------------- 待澄清视图

const CLARITY_SESSION = 'session-clarity'

function seedAnalysis(
  reqId: string,
  overrides: Partial<RequirementAnalysis> = {},
  clarification?: { questions: readonly string[] },
): void {
  // recordAnalysis 的澄清入参要求 updates 可迭代；这里只用问题列表，回答留空。
  repository.recordAnalysis(
    {
      reqId,
      analysisVersion: 1,
      requirementVersion: 1,
      goal: '澄清待办',
      scenarios: [],
      acceptanceCriteria: ['可以看到澄清问题'],
      clarifications: ['为什么需要这个改动？'],
      createdAt: '2026-11-01T02:00:00.000Z',
      ...overrides,
    },
    clarification ? { ...clarification, updates: [] } : undefined,
  )
}

describe('pending clarification view', () => {
  it('returns the bound awaiting requirement with its open questions', () => {
    submitRequirement('req-clarify', {
      text: '首个需求\n补充说明',
      source: `dsh-session:${CLARITY_SESSION}:message-1`,
      now: '2026-11-01T02:00:00.000Z',
    })
    seedAnalysis('req-clarify', { clarifications: ['为什么要做？', '验收标准是什么？'] })
    repository.setStatus('req-clarify', AWAITING_CLARIFICATION)

    expect(
      pendingClarificationsOf({
        repository,
        project: 'testproj',
        sessionId: CLARITY_SESSION,
      }),
    ).toEqual([
      {
        reqId: 'req-clarify',
        title: '首个需求',
        requirementVersion: 1,
        analysisVersion: 1,
        questions: ['为什么要做？', '验收标准是什么？'],
        questionIds: ['Q1-1', 'Q1-2'],
        updatedAt: '2026-11-01T02:00:00.000Z',
      },
    ])
  })

  it('excludes other sessions, non-awaiting states, missing analyses and closed questions', () => {
    submitRequirement('req-other-session', {
      source: 'dsh-session:another-session:message-1',
      now: '2026-11-01T02:00:00.000Z',
    })
    seedAnalysis('req-other-session')
    repository.setStatus('req-other-session', AWAITING_CLARIFICATION)

    submitRequirement('req-draft', {
      source: `dsh-session:${CLARITY_SESSION}:message-2`,
      now: '2026-11-01T02:01:00.000Z',
    })
    seedAnalysis('req-draft')

    submitRequirement('req-no-analysis', {
      source: `dsh-session:${CLARITY_SESSION}:message-3`,
      now: '2026-11-01T02:02:00.000Z',
    })
    repository.setStatus('req-no-analysis', AWAITING_CLARIFICATION)

    submitRequirement('req-no-questions', {
      source: `dsh-session:${CLARITY_SESSION}:message-4`,
      now: '2026-11-01T02:03:00.000Z',
    })
    seedAnalysis('req-no-questions', { clarifications: [] })
    repository.setStatus('req-no-questions', AWAITING_CLARIFICATION)

    expect(
      pendingClarificationsOf({ repository, project: 'testproj', sessionId: CLARITY_SESSION }),
    ).toEqual([])
  })

  it('excludes an analysis that belongs to an older requirement version', () => {
    submitRequirement('req-drift', {
      source: `dsh-session:${CLARITY_SESSION}:message-5`,
      now: '2026-11-01T02:00:00.000Z',
    })
    seedAnalysis('req-drift')
    repository.appendVersion({
      reqId: 'req-drift',
      text: '修订后的需求',
      revisedBy: 'owner',
      source: 'test',
      now: '2026-11-01T02:10:00.000Z',
    })
    repository.setStatus('req-drift', AWAITING_CLARIFICATION)

    expect(
      pendingClarificationsOf({ repository, project: 'testproj', sessionId: CLARITY_SESSION }),
    ).toEqual([])
  })

  it('sorts pending clarifications by the latest requirement version time', () => {
    for (const [reqId, source, now] of [
      ['req-older', `dsh-session:${CLARITY_SESSION}:m-old`, '2026-11-01T02:00:00.000Z'],
      ['req-newer', `dsh-session:${CLARITY_SESSION}:m-new`, '2026-11-01T03:00:00.000Z'],
    ] as const) {
      submitRequirement(reqId, { source, now })
      seedAnalysis(reqId, { createdAt: now })
      repository.setStatus(reqId, AWAITING_CLARIFICATION)
    }

    expect(
      pendingClarificationsOf({ repository, project: 'testproj', sessionId: CLARITY_SESSION }).map(
        (item) => [item.reqId, item.updatedAt],
      ),
    ).toEqual([
      ['req-newer', '2026-11-01T03:00:00.000Z'],
      ['req-older', '2026-11-01T02:00:00.000Z'],
    ])
  })

  it('falls back to an empty timestamp for a legacy requirement without versions', () => {
    const legacy = {
      reqId: 'req-legacy',
      project: 'testproj',
      versions: [],
      status: AWAITING_CLARIFICATION,
      source: `dsh-session:${CLARITY_SESSION}:m-legacy`,
    } as unknown as Requirement
    const stub = stubRepository({
      listRequirements: () => [legacy],
      latestAnalysis: () => ({
        reqId: 'req-legacy',
        analysisVersion: 1,
        requirementVersion: 0,
        goal: '旧需求',
        scenarios: [],
        acceptanceCriteria: [],
        clarifications: ['仍需确认'],
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
      openClarifications: () => [
        {
          reqId: 'req-legacy',
          analysisVersion: 1,
          questionIndex: 1,
          questionId: 'Q1-1',
          text: '仍需确认',
          status: 'open',
          resolution: '',
          resolvedAnalysisVersion: null,
          resolvedRequirementVersion: null,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    })

    expect(
      pendingClarificationsOf({
        repository: stub,
        project: 'testproj',
        sessionId: CLARITY_SESSION,
      }),
    ).toEqual([
      {
        reqId: 'req-legacy',
        title: 'req-legacy',
        requirementVersion: 0,
        analysisVersion: 1,
        questions: ['仍需确认'],
        questionIds: ['Q1-1'],
        updatedAt: '',
      },
    ])
  })
})

// ---------------------------------------------------------------- 需求详情补充

function analysisOf(
  reqId: string,
  analysisVersion: number,
  requirementVersion: number,
  overrides: Partial<RequirementAnalysis> = {},
): RequirementAnalysis & { reqId: string } {
  return {
    reqId,
    analysisVersion,
    requirementVersion,
    goal: '需求目标',
    scenarios: ['场景'],
    acceptanceCriteria: ['可观察结果'],
    clarifications: [],
    createdAt: `2026-11-01T04:0${analysisVersion}:00.000Z`,
    ...overrides,
  }
}

describe('requirement detail extras', () => {
  it('returns neutral differences for an unknown requirement', () => {
    expect(requirementDetailExtras(repository, 'req-missing')).toEqual({
      analysisHistory: [],
      clarificationHistory: { questions: [], answers: [] },
      specChanges: {
        addedPoints: [],
        changedPoints: [],
        removedPoints: [],
        addedAcceptance: [],
        changedAcceptance: [],
        removedAcceptance: [],
        resolvedClarifications: [],
        remainingClarifications: [],
        newClarifications: [],
        addedAssumptions: [],
        changedAssumptions: [],
      },
    })
  })

  it('projects the first analysis as additions and returns its clarification history', () => {
    submitRequirement('req-detail', { text: '详情需求' })
    repository.recordAnalysis(
      analysisOf('req-detail', 1, 1, {
        businessPoints: [
          {
            id: 'BP-1',
            basis: 'user_requirement',
            source: '需求原文',
            actor: '业务用户',
            trigger: '打开页面时',
            behavior: '看到最新状态',
            rules: ['只有本人可以修改'],
            exceptions: { status: 'assessed', items: ['网络中断时保持原状态'], reason: '' },
          },
        ],
        acceptanceItems: [
          {
            id: 'AC-1',
            pointIds: ['BP-1'],
            given: '存在一条记录',
            when: '用户打开页面',
            then: '显示记录的最新状态',
          },
        ],
        clarifications: ['是否覆盖历史记录？'],
      }),
      { questions: ['是否覆盖历史记录？'], updates: [] },
    )
    repository.recordClarificationAnswer({
      reqId: 'req-detail',
      analysisVersion: 1,
      requirementVersion: 1,
      answeredVersion: 1,
      questionIds: ['Q1-1'],
      answer: '只覆盖当前版本',
      source: 'owner',
      answeredAt: '2026-11-01T04:05:00.000Z',
    })

    const extras = requirementDetailExtras(repository, 'req-detail')
    expect(extras.analysisHistory).toHaveLength(1)
    expect(extras.clarificationHistory.questions).toHaveLength(1)
    expect(extras.clarificationHistory.questions[0]).toMatchObject({
      questionId: 'Q1-1',
      text: '是否覆盖历史记录？',
    })
    expect(extras.clarificationHistory.answers).toHaveLength(1)
    expect(extras.clarificationHistory.answers[0]).toMatchObject({
      answer: '只覆盖当前版本',
      questionIds: ['Q1-1'],
    })
    expect(extras.specChanges).toMatchObject({
      addedPoints: ['BP-1'],
      addedAcceptance: ['AC-1'],
      newClarifications: ['是否覆盖历史记录？'],
    })
  })

  it('diffs a later analysis against its previous version', () => {
    submitRequirement('req-diff', { text: '差异需求' })
    const point = (id: string, behavior: string) => ({
      id,
      basis: 'user_requirement' as const,
      source: '需求原文',
      actor: '业务用户',
      trigger: '打开页面时',
      behavior,
      rules: [] as string[],
      exceptions: { status: 'not_applicable' as const, items: [] as string[], reason: '无' },
    })
    repository.recordAnalysis(
      analysisOf('req-diff', 1, 1, {
        businessPoints: [point('BP-1', '原始行为'), point('BP-2', '将被移除')],
        acceptanceItems: [
          {
            id: 'AC-1',
            pointIds: ['BP-1'],
            given: '前置条件',
            when: '执行动作',
            then: '原始结果',
          },
        ],
        assumptions: [
          {
            id: 'AS-1',
            statement: '假设一',
            basis: 'inference',
            source: '分析推断',
            impact: '影响范围一',
            needsConfirmation: false,
          },
        ],
        clarifications: ['保留的问题', '已解决的问题'],
      }),
      { questions: ['保留的问题', '已解决的问题'], updates: [] },
    )
    repository.appendVersion({
      reqId: 'req-diff',
      text: '修订后的需求',
      revisedBy: 'owner',
      source: 'test',
      now: '2026-11-01T04:10:00.000Z',
    })
    repository.recordAnalysis(
      analysisOf('req-diff', 2, 2, {
        businessPoints: [point('BP-1', '修改后的行为'), point('BP-3', '新增行为')],
        acceptanceItems: [
          {
            id: 'AC-1',
            pointIds: ['BP-1'],
            given: '前置条件',
            when: '执行动作',
            then: '修改后的结果',
          },
          {
            id: 'AC-2',
            pointIds: ['BP-3'],
            given: '新前置条件',
            when: '新动作',
            then: '新结果',
          },
        ],
        assumptions: [
          {
            id: 'AS-2',
            statement: '假设二',
            basis: 'inference',
            source: '分析推断',
            impact: '影响范围二',
            needsConfirmation: false,
          },
        ],
        clarifications: ['保留的问题', '新问题'],
      }),
      {
        questions: ['新问题'],
        updates: [
          {
            questionId: 'Q1-2',
            status: 'resolved',
            resolution: '已在修订中说明',
          },
        ],
      },
    )

    const extras = requirementDetailExtras(repository, 'req-diff')
    expect(extras.analysisHistory.map((item) => item.analysisVersion)).toEqual([1, 2])
    expect(extras.specChanges).toMatchObject({
      addedPoints: ['BP-3'],
      changedPoints: ['BP-1'],
      removedPoints: ['BP-2'],
      addedAcceptance: ['AC-2'],
      changedAcceptance: ['AC-1'],
      removedAcceptance: [],
      resolvedClarifications: ['已解决的问题'],
      remainingClarifications: ['保留的问题'],
      newClarifications: ['新问题'],
      addedAssumptions: ['AS-2'],
      changedAssumptions: [],
    })
    expect(extras.clarificationHistory.questions.map((question) => question.text)).toEqual([
      '保留的问题',
      '已解决的问题',
      '新问题',
    ])
  })

  it('treats a missing previous analysis entry as no baseline', () => {
    const latest = analysisOf('req-gap', 2, 2, {
      businessPoints: [
        {
          id: 'BP-9',
          basis: 'user_requirement',
          source: '需求原文',
          actor: '业务用户',
          trigger: '打开页面时',
          behavior: '新行为',
          rules: [],
          exceptions: { status: 'not_applicable', items: [], reason: '无' },
        },
      ],
    })
    const stub = stubRepository({
      analyses: () => [undefined, latest],
      clarificationQuestions: () => [],
      clarificationAnswers: () => [],
    })

    const extras = requirementDetailExtras(stub, 'req-gap')
    expect(extras.analysisHistory).toHaveLength(2)
    expect(extras.specChanges).toMatchObject({
      addedPoints: ['BP-9'],
      changedPoints: [],
      removedPoints: [],
      addedAcceptance: [],
    })
  })
})
