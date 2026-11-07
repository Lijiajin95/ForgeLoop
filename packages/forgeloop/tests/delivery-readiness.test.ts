import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { deliveryReadiness } from '../src/runtime/delivery-readiness.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

const REQ = 'req-ready-1'
const CANDIDATE = 'c'.repeat(64)
const ARTIFACT = 'a'.repeat(64)
let dir = ''
let repo: Repository

function plan(requirementVersion = 1, planVersion = 1): TaskPlan {
  return {
    taskPlanId: `plan-${REQ}-${planVersion}`,
    requirementId: REQ,
    project: 'testproj',
    planVersion,
    requirementVersion,
    createdAt: '2026-11-05T09:00:00.000Z',
    tasks: [
      {
        taskId: 'a',
        goal: '写文档',
        files: ['docs/a.md'],
        acceptance: '存在',
        testCommand: ['true'],
        dependsOn: [],
        limits: { limitSeconds: -1, maxFailureRounds: -1 },
        authorizationSource: 'system-admission:test',
      },
    ],
  }
}

function admission(requirementVersion = 1, admit = true, at = '2026-11-05T09:01:00.000Z'): void {
  repo.recordAdmission({
    requirementId: REQ,
    requirementVersion,
    decision: {
      admit,
      code: admit ? 'admitted' : 'blocked',
      reason: admit ? 'ok' : '不可信来源',
      basis: {
        policyVersion: 'test',
        source: 'test',
        submittedBy: 'owner',
        owner: 'owner',
        project: 'testproj',
        projectPath: dir,
        requirementVersion,
        analysisVersion: 1,
        trustedSource: admit,
        allowAnySource: false,
        requireOwner: false,
        codeCommitAllowed: admit,
      },
    },
    decidedBy: 'system:admission',
    createdAt: at,
  })
}

function build(candidateSha = CANDIDATE, artifactSha = ARTIFACT, planVersion = 1): void {
  repo.recordCandidateBuild({
    reqId: REQ,
    planVersion,
    candidateSha256: candidateSha,
    verificationSha256: 'v'.repeat(64),
    packageVersion: '1.0.0',
    artifactSha256: artifactSha,
    tarball: '/tmp/a.tgz',
    files: ['lib/index.js'],
    gitHead: 'head',
    builtAt: '2026-11-05T09:02:00.000Z',
    evidenceDir: '/tmp/build',
  })
}

function verify(verdict: 'pass' | 'block' = 'pass'): void {
  repo.recordVerification({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    requirementVersion: 1,
    workspaceSha256: 'w'.repeat(64),
    verdict,
    reportJson: '{}',
    reportPath: '/tmp/v.json',
    reportSha256: 'r'.repeat(64),
    evidenceDir: '/tmp/v',
    sessionId: 's',
    verifiedAt: '2026-11-05T09:03:00.000Z',
  })
}

function review(verdict: 'pass' | 'block' = 'pass'): void {
  repo.recordBusinessReview({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    requirementVersion: 1,
    verificationSha256: 'r'.repeat(64),
    verdict,
    reportJson: '{}',
    reportPath: '/tmp/r.json',
    reportSha256: 's'.repeat(64),
    sessionId: 's',
    reviewedAt: '2026-11-05T09:04:00.000Z',
  })
}

function commit(candidateSha = CANDIDATE): void {
  repo.recordCommit({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: candidateSha,
    commitSha: 'd'.repeat(40),
    commitMessage: 'test',
    checkCommand: [],
    checkLogPath: '/tmp/c.log',
    checkSha256: 'e'.repeat(64),
    files: ['docs/a.md'],
    committedAt: '2026-11-05T09:05:00.000Z',
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-readiness-'))
  repo = new Repository(Database.open(join(dir, 'records.sqlite')))
  repo.submit({
    reqId: REQ,
    project: 'testproj',
    text: 'ready',
    submittedBy: 'owner',
    source: 'test',
    now: '2026-11-05T08:00:00.000Z',
  })
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('delivery readiness', () => {
  it('reports missing requirement, stop and uncommitted status', () => {
    expect(deliveryReadiness(repo, 'missing').reason).toContain('需求不存在')
    repo.recordStop({
      requirementId: REQ,
      requestedBy: 'owner',
      reason: 'stop',
      requestedAt: '2026-11-05T08:10:00.000Z',
    })
    expect(deliveryReadiness(repo, REQ).reason).toContain('已停止')
    repo.resumeStop({
      requirementId: REQ,
      resumedBy: 'owner',
      reason: 'resume',
      resumedAt: '2026-11-05T08:11:00.000Z',
    })
    expect(deliveryReadiness(repo, REQ).reason).toContain('尚未受控提交')
  })

  it('requires build, artifact match and current evidence', () => {
    repo.setStatus(REQ, 'committed')
    expect(deliveryReadiness(repo, REQ).reason).toBe('没有候选构建')
    build()
    expect(deliveryReadiness(repo, REQ, 'b'.repeat(64)).reason).toContain('制品摘要')
    expect(deliveryReadiness(repo, REQ).reason).toContain('独立测试')
    verify('block')
    expect(deliveryReadiness(repo, REQ).reason).toContain('独立测试')
    verify()
    expect(deliveryReadiness(repo, REQ).reason).toContain('业务终审')
    review('block')
    expect(deliveryReadiness(repo, REQ).reason).toContain('业务终审')
    review()
    expect(deliveryReadiness(repo, REQ).reason).toContain('受控提交')
    commit()
    expect(deliveryReadiness(repo, REQ)).toEqual({ ok: true, reason: '' })
  })

  it('rejects stale or blocked admission and plan version drift', () => {
    repo.setStatus(REQ, 'committed')
    build()
    verify()
    review()
    commit()
    admission(2)
    expect(deliveryReadiness(repo, REQ).reason).toContain('系统准入')
    admission(1, false, '2026-11-05T09:06:00.000Z')
    expect(deliveryReadiness(repo, REQ).reason).toContain('未准入')
    admission(1, true, '2026-11-05T09:07:00.000Z')
    repo.recordTaskPlan(plan(2, 2))
    expect(deliveryReadiness(repo, REQ).reason).toContain('需求版本')
    repo.recordTaskPlan(plan(1, 3))
    expect(deliveryReadiness(repo, REQ).reason).toContain('任务包版本')
  })
})
