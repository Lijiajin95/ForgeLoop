import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { candidateDeploymentGate } from '../src/runtime/deployment-gate.js'
import { expectedAcceptanceFingerprints } from '../src/runtime/acceptance-binding.js'
import { candidateIdentityOf } from '../src/domain/delivery.js'
import type { DeploymentArtifact } from '../src/domain/deployment.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

let dir = ''
let database: Database
let repo: Repository

const REQ = 'req-deploy-1'
const TASK_CANDIDATE = 't1-candidate'
const CANDIDATE = candidateIdentityOf({
  planVersion: 1,
  requirementVersion: 1,
  baselineCommit: '',
  candidateHashes: [TASK_CANDIDATE],
})
const ARTIFACT = 'a'.repeat(64)
const TARBALL = '/tmp/candidate.tgz'

function artifact(overrides: Partial<DeploymentArtifact> = {}): DeploymentArtifact {
  return { sha256: ARTIFACT, path: TARBALL, version: '1.0.0', ...overrides }
}

function target(approval: 'owner' | 'auto' = 'owner') {
  return {
    id: 'web',
    toolId: 't',
    requirementId: REQ,
    params: {},
    data: { volumes: [], migrations: [] },
    approval,
    rollback: { keep: 1 },
  }
}

function seedPlan(): void {
  const plan: TaskPlan = {
    taskPlanId: `plan-${REQ}-1`,
    requirementId: REQ,
    project: 'testproj',
    planVersion: 1,
    requirementVersion: 1,
    tasks: [
      {
        taskId: 't1',
        goal: '写文档',
        files: ['docs/x.md'],
        acceptance: '存在',
        testCommand: ['true'],
        dependsOn: [],
        limits: { limitSeconds: -1, maxFailureRounds: -1 },
        authorizationSource: 'system-admission:test',
      },
    ],
    createdAt: '2026-11-03T09:30:00.000Z',
  }
  repo.recordTaskPlan(plan)
  repo.recordTaskArtifact({
    requirementId: REQ,
    planVersion: 1,
    taskId: 't1',
    candidateSha256: TASK_CANDIDATE,
    testEvidenceSha256: 'e'.repeat(64),
    reviewSha256: 'r'.repeat(64),
    acceptance: '存在',
    authorizationSource: 'test',
    recordedAt: '2026-11-03T09:40:00.000Z',
  })
}

function seedCommit(): void {
  repo.recordCommit({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    commitSha: 'd'.repeat(40),
    commitMessage: '部署门禁测试',
    checkCommand: [],
    checkLogPath: '/tmp/check.log',
    checkSha256: 'e'.repeat(64),
    files: ['docs/x.md'],
    committedAt: '2026-11-03T10:03:00.000Z',
  })
}

function seedBuild(): void {
  repo.recordCandidateBuild({
    reqId: REQ,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    verificationSha256: 'v'.repeat(64),
    packageVersion: '1.0.0',
    artifactSha256: ARTIFACT,
    tarball: TARBALL,
    files: ['lib/index.js'],
    gitHead: 'head',
    builtAt: '2026-11-03T10:00:00.000Z',
    evidenceDir: '/tmp/evidence',
  })
}

function seedVerification(verdict: 'pass' | 'block' = 'pass'): void {
  repo.recordVerification({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    requirementVersion: 1,
    workspaceSha256: 'w'.repeat(64),
    verdict,
    reportJson: '{}',
    reportPath: '/tmp/verification.json',
    reportSha256: 'r'.repeat(64),
    evidenceDir: '/tmp/verification',
    sessionId: 'session-1',
    verifiedAt: '2026-11-03T10:01:00.000Z',
  })
}

function seedReview(verdict: 'pass' | 'block' = 'pass'): void {
  repo.recordBusinessReview({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    requirementVersion: 1,
    verificationSha256: 'r'.repeat(64),
    verdict,
    reportJson: '{}',
    reportPath: '/tmp/review.json',
    reportSha256: 's'.repeat(64),
    sessionId: 'session-1',
    reviewedAt: '2026-11-03T10:02:00.000Z',
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-deploy-gate-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repo = new Repository(database)
  repo.submit({
    reqId: REQ,
    project: 'testproj',
    text: '部署门禁测试',
    submittedBy: 'owner',
    source: 'test',
    now: '2026-11-03T09:00:00.000Z',
  })
  repo.setStatus(REQ, 'committed', '已提交')
  seedPlan()
  seedCommit()
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('candidate deployment gate', () => {
  it('requires a build, verification, business review and acceptance in order', () => {
    const gate = candidateDeploymentGate(repo)
    expect(gate(target(), artifact())).toEqual({ ok: false, reason: '没有候选构建' })

    seedBuild()
    expect(gate(target(), artifact({ sha256: 'b'.repeat(64) })).ok).toBe(false)
    expect(gate(target(), artifact({ path: '/tmp/other.tgz' })).reason).toContain('路径')

    expect(gate(target(), artifact()).reason).toContain('独立测试')
    seedVerification('block')
    expect(gate(target(), artifact()).reason).toContain('独立测试')
    seedVerification('pass')
    expect(gate(target(), artifact()).reason).toContain('业务终审')
    seedReview('block')
    expect(gate(target(), artifact()).reason).toContain('业务终审')
    seedReview('pass')
    expect(gate(target(), artifact()).reason).toBe('需求尚未验收')
    expect(gate(target('auto'), artifact())).toEqual({ ok: true, reason: '' })

    const fingerprints = expectedAcceptanceFingerprints(repo, REQ, ARTIFACT)
    repo.recordAcceptance({
      reqId: REQ,
      acceptedBy: 'owner',
      source: 'test',
      fingerprint: fingerprints[0] ?? '',
      now: '2026-11-03T10:03:00.000Z',
    })
    expect(gate(target(), artifact())).toEqual({ ok: true, reason: '' })
  })

  it('rejects an unknown requirement', () => {
    const gate = candidateDeploymentGate(repo)
    expect(gate({ ...target(), requirementId: 'req-missing' }, artifact()).reason).toContain(
      '需求不存在',
    )
  })

  it('resolves the requirement from the intent when the target has no default', () => {
    seedBuild()
    seedVerification()
    seedReview()
    repo.recordAcceptance({
      reqId: REQ,
      acceptedBy: 'owner',
      source: 'test',
      fingerprint: expectedAcceptanceFingerprints(repo, REQ, ARTIFACT)[0] ?? '',
      now: '2026-11-03T10:03:00.000Z',
    })
    const gate = candidateDeploymentGate(repo)
    const unbound = { ...target(), requirementId: '' }
    expect(gate(unbound, artifact(), REQ)).toEqual({ ok: true, reason: '' })
    expect(gate(unbound, artifact(), 'req-missing').reason).toContain('需求不存在')
    expect(gate(unbound, artifact()).reason).toContain('需求不存在')
  })
})
