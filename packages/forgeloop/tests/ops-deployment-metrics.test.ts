import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { buildAutonomyStats } from '../src/runtime/autonomy-stats.js'
import { ReliabilityDashboard } from '../src/runtime/reliability.js'
import type { DeploymentAttemptState } from '../src/domain/deployment.js'

const PROJECT = 'forgeloop'
const NOW = new Date('2026-11-03T10:00:00.000Z')
const RECENT = '2026-10-20T00:00:00.000Z'
const OLD = '2026-08-01T00:00:00.000Z'

let dir = ''
let database: Database
let repository: Repository

function submit(reqId: string): void {
  repository.submit({
    reqId,
    project: PROJECT,
    text: `指标复算 ${reqId}`,
    submittedBy: 'owner',
    source: 'test',
    now: RECENT,
  })
}

function commit(reqId: string, sha: string): void {
  repository.recordTaskPlan({
    taskPlanId: `plan-${reqId}`,
    requirementId: reqId,
    project: PROJECT,
    planVersion: 1,
    requirementVersion: 1,
    tasks: [
      {
        taskId: 't1',
        goal: '写文档',
        files: ['docs/a.md'],
        acceptance: '存在',
        testCommand: ['true'],
        dependsOn: [],
        limits: { limitSeconds: -1, maxFailureRounds: -1 },
        authorizationSource: 'test',
      },
    ],
    createdAt: RECENT,
  })
  repository.recordCommit({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: sha,
    commitSha: 'c'.repeat(40),
    commitMessage: 'test',
    checkCommand: ['true'],
    checkLogPath: join(dir, 'check.log'),
    checkSha256: 'e'.repeat(64),
    files: ['docs/a.md'],
    committedAt: RECENT,
  })
  repository.recordVerification({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: sha,
    requirementVersion: 1,
    workspaceSha256: 'w'.repeat(64),
    verdict: 'pass',
    reportJson: '{}',
    reportPath: join(dir, 'verification.json'),
    reportSha256: 'v'.repeat(64),
    evidenceDir: dir,
    sessionId: 'session',
    verifiedAt: RECENT,
  })
  repository.recordCandidateBuild({
    reqId,
    planVersion: 1,
    candidateSha256: sha,
    verificationSha256: 'v'.repeat(64),
    packageVersion: '1.0.0',
    artifactSha256: `artifact-${sha}`,
    tarball: join(dir, 'candidate.tgz'),
    files: [],
    gitHead: 'head',
    builtAt: RECENT,
    evidenceDir: dir,
  })
  repository.setStatus(reqId, 'committed')
}

function intent(input: {
  intentId: string
  reqId: string
  sha: string
  state: DeploymentAttemptState
  createdAt: string
}): void {
  repository.deploymentStore.recordDeploymentIntent({
    intentId: input.intentId,
    project: PROJECT,
    targetId: 'auto',
    requirementId: input.reqId,
    artifactSha256: `artifact-${input.sha}`,
    artifactPath: join(dir, 'candidate.tgz'),
    artifactVersion: '1.0.0',
    source: `test:${input.intentId}`,
    approval: 'auto',
    state: input.state,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-ops-metrics-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repository = new Repository(database)
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('deployment and ops metrics recomputation', () => {
  it('separates research completion, deployment, autonomous delivery and rollback', () => {
    // req-a：自主交付（提交 + 验证 + 当前候选 verified 部署）。
    submit('req-a')
    commit('req-a', 'a')
    intent({ intentId: 'dep-a1', reqId: 'req-a', sha: 'a', state: 'verified', createdAt: RECENT })
    // req-b：同一需求有重复 verified 记录，只算一次部署完成。
    submit('req-b')
    commit('req-b', 'b')
    intent({ intentId: 'dep-b1', reqId: 'req-b', sha: 'b', state: 'verified', createdAt: RECENT })
    intent({ intentId: 'dep-b2', reqId: 'req-b', sha: 'b', state: 'verified', createdAt: RECENT })
    // req-c：部署失败并回退；仍是研发完成，但不是上线完成或自主交付。
    submit('req-c')
    commit('req-c', 'c')
    intent({ intentId: 'dep-c1', reqId: 'req-c', sha: 'c', state: 'failed', createdAt: RECENT })
    intent({
      intentId: 'dep-c2',
      reqId: 'req-c',
      sha: 'c',
      state: 'rolled_back',
      createdAt: RECENT,
    })
    // req-d：只有需求，没有提交/部署。
    submit('req-d')

    repository.createOpsEvent({
      eventId: 'ops-ok',
      project: PROJECT,
      resourceId: 'web',
      checkId: 'health',
      signature: 'web/health',
      severity: 'major',
      state: 'open',
      title: '页面不可用',
      openedAt: RECENT,
      updatedAt: RECENT,
    })
    repository.updateOpsEvent('ops-ok', {
      state: 'recovered',
      recoveredAt: RECENT,
      updatedAt: RECENT,
    })
    repository.createOpsEvent({
      eventId: 'ops-open',
      project: PROJECT,
      resourceId: 'web',
      checkId: 'disk',
      signature: 'web/disk',
      severity: 'major',
      state: 'unresolved',
      title: '磁盘告警',
      openedAt: RECENT,
      updatedAt: RECENT,
    })

    const stats = buildAutonomyStats(repository, PROJECT, 'owner')
    expect(stats.requirements.total).toBe(4)
    expect(stats.requirements.researchCompleted).toBe(3)
    expect(stats.requirements.deploymentCompleted).toBe(2)
    expect(stats.requirements.deploymentFailed).toBe(1)
    expect(stats.requirements.rolledBack).toBe(1)
    expect(stats.requirements.autonomousSuccess).toBe(2)
    expect(stats.requirements.notAutonomous).toBe(2)
    expect(stats.requirements.autonomousSuccessRate).toEqual({
      numerator: 2,
      denominator: 4,
      rate: 0.5,
    })
    expect(stats.ops.recovered).toBe(1)
    expect(stats.ops.unresolved).toBe(1)
  })

  it('keeps deployment intents separate from legacy deployment checks and windows them', () => {
    for (const state of ['verified', 'failed', 'rolled_back', 'awaiting_approval'] as const) {
      intent({
        intentId: `dep-${state}`,
        reqId: 'req-window',
        sha: state,
        state,
        createdAt: RECENT,
      })
    }
    intent({
      intentId: 'dep-old',
      reqId: 'req-window',
      sha: 'old',
      state: 'verified',
      createdAt: OLD,
    })
    repository.recordDeployment({
      reqId: 'req-window',
      planVersion: 1,
      candidateSha256: 'legacy-ok',
      packageVersion: '1.0.0',
      targetProfile: 'web',
      artifactSha256: 'artifact-legacy-ok',
      runtimeVersion: '1.0.0',
      state: 'verified',
      checks: [],
      evidenceDir: dir,
      recordedBy: 'owner',
      source: 'test',
      recordedAt: RECENT,
    })
    repository.recordDeployment({
      reqId: 'req-window',
      planVersion: 1,
      candidateSha256: 'legacy-bad',
      packageVersion: '1.0.0',
      targetProfile: 'web',
      artifactSha256: 'artifact-legacy-bad',
      runtimeVersion: '1.0.0',
      state: 'failed',
      checks: [],
      evidenceDir: dir,
      recordedBy: 'owner',
      source: 'test',
      recordedAt: RECENT,
    })

    const dashboard = new ReliabilityDashboard({
      repository,
      project: PROJECT,
      projectPath: dir,
      now: () => NOW,
      currentHead: () => null,
    })
    const recent = dashboard.report('30d').runtime
    expect(recent.deploymentIntents).toMatchObject({
      verified: 1,
      failed: 1,
      rolledBack: 1,
      pending: 1,
      total: 3,
    })
    expect(recent.deploymentIntents.rate).toEqual({ pass: 1, total: 3, rate: 33.3 })
    // 旧的 requirement_deployments 仍按自己的分母统计，不与新通道合并或重复。
    expect(recent.deployment).toEqual({ pass: 1, total: 2, rate: 50 })

    const all = dashboard.report('all').runtime
    expect(all.deploymentIntents).toMatchObject({ verified: 2, failed: 1, rolledBack: 1, total: 4 })
    expect(all.deployment).toEqual({ pass: 1, total: 2, rate: 50 })
  })
})
