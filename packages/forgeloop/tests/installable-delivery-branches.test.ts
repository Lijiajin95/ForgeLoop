import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import {
  DELIVERY_MATERIALS,
  evaluateInstallableDelivery,
  installInstructionsOf,
  latestAvailableAt,
  type InstallableDeliveryMaterials,
} from '../src/domain/installable-delivery.js'
import {
  recordInstallableDelivery,
  safeInstallableDelivery,
} from '../src/runtime/installable-delivery.js'
import { sha256OfText } from '../src/domain/delivery.js'
import { asRecord } from '../src/domain/json.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const CANDIDATE = sha256OfText('candidate')
const VERIFICATION = sha256OfText('verification')
const REVIEW = sha256OfText('review')
const PACKAGE = sha256OfText('package')
const COMMIT = 'c0ffee1'.padEnd(40, '0')

const runner: AgentLike = {
  async run(request) {
    return {
      status: 'completed',
      text: '',
      sessionId: 'installable-coverage',
      reason: '',
      transcriptPath: request.transcriptPath,
      durationMs: 1,
      toolCalls: [],
    }
  },
}

function runtimeWith(root: string) {
  return new ForgeLoopRuntime({
    ctx: {},
    config: resolveConfig(
      {
        project: 'testproj',
        projectPath: root,
        recordsRoot: join(root, '.forgeloop'),
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      },
      root,
    ),
    runner,
    now: () => new Date('2026-11-16T10:10:00.000Z'),
  })
}

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-installable-extra-'))
  roots.push(root)
  return root
}

function submitRequirement(runtime: ForgeLoopRuntime, text = '需求'): string {
  const submitted = runtime.submit({ text, by: 'owner', source: 'test', analyze: false })
  const reqId = asRecord(submitted.data)?.reqId
  if (typeof reqId !== 'string') throw new Error('测试需求没有身份')
  return reqId
}

function seed(
  runtime: ForgeLoopRuntime,
  reqId: string,
  options: {
    bindings?: {
      buildCandidate?: string
      verificationCandidate?: string
      reviewCandidate?: string
      reviewVerification?: string
    }
  } = {},
): void {
  const repo = runtime.repo
  const bindings = options.bindings ?? {}
  repo.recordCommit({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    commitSha: COMMIT,
    commitMessage: '',
    checkCommand: [],
    checkLogPath: '/gate.log',
    checkSha256: sha256OfText('gate'),
    files: [],
    committedAt: '2026-11-16T10:05:00.000Z',
  })
  repo.recordVerification({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: bindings.verificationCandidate ?? CANDIDATE,
    requirementVersion: 1,
    workspaceSha256: sha256OfText('workspace'),
    verdict: 'pass',
    reportJson: '{}',
    reportPath: '/verification/report.json',
    reportSha256: VERIFICATION,
    evidenceDir: '/verification',
    sessionId: 'verification-session',
    verifiedAt: '2026-11-16T10:06:00.000Z',
  })
  repo.recordBusinessReview({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: bindings.reviewCandidate ?? CANDIDATE,
    requirementVersion: 1,
    verificationSha256: bindings.reviewVerification ?? VERIFICATION,
    verdict: 'pass',
    reportJson: '{}',
    reportPath: '/review/report.json',
    reportSha256: REVIEW,
    sessionId: 'verification-session',
    reviewedAt: '2026-11-16T10:07:00.000Z',
  })
  repo.recordCandidateBuild({
    reqId,
    planVersion: 1,
    candidateSha256: bindings.buildCandidate ?? CANDIDATE,
    verificationSha256: VERIFICATION,
    packageVersion: '0.0.3',
    artifactSha256: PACKAGE,
    tarball: '/artifacts/demo.tgz',
    files: [],
    gitHead: COMMIT,
    builtAt: '2026-11-16T10:08:00.000Z',
    evidenceDir: '/build',
  })
  repo.recordDeployment({
    reqId,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    packageVersion: '0.0.3',
    targetProfile: 'trial',
    artifactSha256: PACKAGE,
    runtimeVersion: '0.0.3',
    state: 'verified',
    checks: [],
    evidenceDir: '/deployment',
    recordedBy: 'system:coordinator',
    source: 'test',
    recordedAt: '2026-11-16T10:09:00.000Z',
  })
}

const deps = (runtime: ForgeLoopRuntime) => ({
  config: runtime.config,
  repo: runtime.repo,
  now: () => '2026-11-16T10:10:00.000Z',
})

const completeMaterials: InstallableDeliveryMaterials = {
  requirementVersion: 1,
  currentRequirementVersion: 1,
  commit: { commitSha: COMMIT, commitMessage: '', committedAt: '2026-11-16T10:05:00.000Z' },
  package: {
    packageVersion: '0.0.3',
    tarball: '/artifacts/demo.tgz',
    artifactSha256: PACKAGE,
    builtAt: '2026-11-16T10:08:00.000Z',
  },
  instructions: {
    path: '/evidence/INSTALL.md',
    sha256: sha256OfText('instructions'),
    bytes: 10,
    writtenAt: '2026-11-16T10:09:30.000Z',
  },
  verification: { verdict: 'pass', sha256: VERIFICATION, at: '2026-11-16T10:06:00.000Z' },
  businessReview: { verdict: 'pass', sha256: REVIEW, at: '2026-11-16T10:07:00.000Z' },
  trial: {
    targetId: 'trial',
    artifactSha256: PACKAGE,
    runtimeVersion: '0.0.3',
    state: 'verified',
    verifiedAt: '2026-11-16T10:09:00.000Z',
  },
}

describe('installable delivery material edge cases', () => {
  it('reports each missing material separately and tolerant of invalid timestamps', () => {
    const drops: Array<Partial<InstallableDeliveryMaterials>> = [
      { commit: null },
      { package: null },
      { instructions: null },
      { verification: null },
      { businessReview: null },
      { trial: null },
    ]
    for (const patch of drops) {
      const verdict = evaluateInstallableDelivery({ ...completeMaterials, ...patch })
      expect(verdict.status).toBe('incomplete')
      expect(verdict.missing).toHaveLength(1)
    }
    expect(evaluateInstallableDelivery(completeMaterials).missing).toEqual([])
    expect([...DELIVERY_MATERIALS]).toHaveLength(6)

    const badTime = evaluateInstallableDelivery({
      ...completeMaterials,
      commit: { ...completeMaterials.commit!, committedAt: 'not-a-time' },
    })
    expect(badTime.status).toBe('mismatch')
    expect(badTime.mismatches).toContain('材料时间不可核对')

    const failedTrial = evaluateInstallableDelivery({
      ...completeMaterials,
      trial: { ...completeMaterials.trial!, state: 'applied' },
    })
    expect(failedTrial.mismatches).toContain('试装未核对通过')
  })

  it('returns empty availability for invalid or empty times and writes honest instructions', () => {
    expect(latestAvailableAt([])).toBe('')
    expect(latestAvailableAt(['2026-11-16T10:00:00.000Z', 'x'])).toBe('')
    expect(latestAvailableAt(['2026-11-16T10:00:00.000Z', '2026-11-16T11:00:00.000Z'])).toBe(
      '2026-11-16T11:00:00.000Z',
    )

    const text = installInstructionsOf({
      reqId: 'req-1',
      project: 'demo',
      requirementVersion: 1,
      commit: { ...completeMaterials.commit!, commitMessage: '' },
      package: completeMaterials.package!,
      verification: completeMaterials.verification!,
      businessReview: completeMaterials.businessReview!,
      trial: { ...completeMaterials.trial!, artifactSha256: sha256OfText('other') },
      targetParams: {},
    })
    expect(text).toContain('提交信息：未记录')
    expect(text).toContain('该目标未声明参数')
    expect(text).toContain('交付包与试装包摘要一致：否')
  })
})

describe('installable delivery recorder branches', () => {
  it('rejects every incomplete material with a specific message', () => {
    const root = projectRoot()
    const runtime = runtimeWith(root)
    const noCommit = submitRequirement(runtime, '没有提交')
    const noCommitResult = recordInstallableDelivery(deps(runtime), noCommit)
    expect(noCommitResult).toMatchObject({ ok: false, code: 'delivery_incomplete' })
    expect(noCommitResult.message).toContain('受控提交')

    const noBuild = submitRequirement(runtime, '没有构建')
    runtime.repo.recordCommit({
      requirementId: noBuild,
      planVersion: 1,
      candidateSha256: CANDIDATE,
      commitSha: COMMIT,
      commitMessage: '',
      checkCommand: [],
      checkLogPath: '/gate.log',
      checkSha256: sha256OfText('gate'),
      files: [],
      committedAt: '2026-11-16T10:05:00.000Z',
    })
    expect(recordInstallableDelivery(deps(runtime), noBuild).message).toContain('安装包')

    const noVerification = submitRequirement(runtime, '没有测试')
    runtime.repo.recordCommit({
      requirementId: noVerification,
      planVersion: 1,
      candidateSha256: CANDIDATE,
      commitSha: COMMIT,
      commitMessage: '',
      checkCommand: [],
      checkLogPath: '/gate.log',
      checkSha256: sha256OfText('gate'),
      files: [],
      committedAt: '2026-11-16T10:05:00.000Z',
    })
    runtime.repo.recordCandidateBuild({
      reqId: noVerification,
      planVersion: 1,
      candidateSha256: CANDIDATE,
      verificationSha256: VERIFICATION,
      packageVersion: '0.0.3',
      artifactSha256: PACKAGE,
      tarball: '/artifacts/demo.tgz',
      files: [],
      gitHead: COMMIT,
      builtAt: '2026-11-16T10:08:00.000Z',
      evidenceDir: '/build',
    })
    expect(recordInstallableDelivery(deps(runtime), noVerification).message).toContain('独立测试')
    runtime.close()
  })

  it('rejects material that belongs to another candidate or another review round', () => {
    for (const bindings of [
      { buildCandidate: sha256OfText('other-build') },
      { verificationCandidate: sha256OfText('other-verification') },
      { reviewCandidate: sha256OfText('other-review') },
      { reviewVerification: sha256OfText('other-round') },
    ]) {
      const root = projectRoot()
      const runtime = runtimeWith(root)
      const reqId = submitRequirement(runtime)
      seed(runtime, reqId, { bindings })
      const result = recordInstallableDelivery(deps(runtime), reqId)
      expect(result.ok, JSON.stringify(bindings)).toBe(false)
      // 材料属于其他候选或另一轮验收时，按“不成立”或“缺少该候选材料”阻断，都不得登记。
      expect(['delivery_mismatch', 'delivery_incomplete']).toContain(result.code)
      expect(runtime.repo.installableDeliveryStore.countFor(reqId)).toBe(0)
      runtime.close()
    }
  })

  it('rejects a missing business review and a missing trial record', () => {
    for (const drop of ['review', 'trial'] as const) {
      const root = projectRoot()
      const runtime = runtimeWith(root)
      const reqId = submitRequirement(runtime)
      seed(runtime, reqId)
      runtime.repo.db.handle
        .prepare(
          drop === 'review'
            ? 'DELETE FROM requirement_business_reviews WHERE req_id = ?'
            : 'DELETE FROM requirement_deployments WHERE req_id = ?',
        )
        .run(reqId)
      const result = recordInstallableDelivery(deps(runtime), reqId)
      expect(result.ok, drop).toBe(false)
      expect(result.code).toBe('delivery_incomplete')
      expect(result.message).toContain(drop === 'review' ? '业务验收' : '试装')
      runtime.close()
    }
  })

  it('records a delivery from a verified deployment intent when the deployment row is absent', () => {
    const root = projectRoot()
    const runtime = runtimeWith(root)
    const reqId = submitRequirement(runtime)
    seed(runtime, reqId)
    // 删除上线核对记录，只留部署工具已核对通过的 intent。
    runtime.repo.db.handle
      .prepare('DELETE FROM requirement_deployments WHERE req_id = ?')
      .run(reqId)
    runtime.repo.deploymentStore.recordDeploymentIntent({
      intentId: 'dep-1',
      project: 'testproj',
      targetId: 'trial',
      requirementId: reqId,
      artifactSha256: PACKAGE,
      artifactPath: '/artifacts/demo.tgz',
      artifactVersion: '0.0.3',
      source: 'test',
      approval: 'auto',
      state: 'verified',
      createdAt: '2026-11-16T10:08:30.000Z',
      updatedAt: '2026-11-16T10:09:30.000Z',
    })
    const result = recordInstallableDelivery(deps(runtime), reqId)
    expect(result.ok, result.message).toBe(true)
    expect(runtime.repo.installableDeliveryStore.latest(reqId)).toMatchObject({
      trialTarget: 'trial',
      trialRuntimeVersion: '0.0.3',
    })
    // 历史、计数与项目内列表供指标与幂等判定复用。
    expect(runtime.repo.installableDeliveryStore.allFor(reqId)).toHaveLength(1)
    expect(runtime.repo.installableDeliveryStore.countFor(reqId)).toBe(1)
    expect(runtime.repo.installableDeliveryStore.all('testproj')).toHaveLength(1)
    expect(runtime.repo.installableDeliveryStore.all()).toHaveLength(1)
    runtime.close()
  })

  it('refuses a verified trial that was not the deployment of this candidate', () => {
    const root = projectRoot()
    const runtime = runtimeWith(root)
    const reqId = submitRequirement(runtime)
    seed(runtime, reqId)
    runtime.repo.db.handle
      .prepare('UPDATE requirement_deployments SET candidate_sha256 = ? WHERE req_id = ?')
      .run(sha256OfText('other-candidate'), reqId)
    const result = recordInstallableDelivery(deps(runtime), reqId)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('delivery_mismatch')
    expect(result.message).toContain('试装记录不是该受控提交的部署')
    expect(runtime.repo.installableDeliveryStore.countFor(reqId)).toBe(0)
    runtime.close()
  })

  it('turns a recorder exception into an explicit failure', () => {
    const runtime = {
      config: { project: 'testproj' },
      repo: {
        getRequirement: () => {
          throw new Error('记录库不可读')
        },
      },
    }
    const result = safeInstallableDelivery(runtime as never, 'req-1')
    expect(result).toMatchObject({ ok: false, code: 'delivery_error' })
    expect(result.message).toContain('记录库不可读')
  })
})
