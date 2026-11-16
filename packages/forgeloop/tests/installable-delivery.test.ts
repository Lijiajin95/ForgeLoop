import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { recordInstallableDelivery } from '../src/runtime/installable-delivery.js'
import {
  DELIVERY_MATERIALS,
  evaluateInstallableDelivery,
  installInstructionsOf,
  type InstallableDeliveryMaterials,
} from '../src/domain/installable-delivery.js'
import { sha256OfText } from '../src/domain/delivery.js'
import { asRecord } from '../src/domain/json.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-delivery-'))
  roots.push(root)
  return root
}

const CANDIDATE = sha256OfText('candidate')
const VERIFICATION = sha256OfText('verification')
const REVIEW = sha256OfText('review')
const PACKAGE = sha256OfText('package')
const COMMIT_SHA = 'c0ffee1'.padEnd(40, '0')

const runner: AgentLike = {
  async run(request) {
    return {
      status: 'completed',
      text: '',
      sessionId: 'delivery-test',
      reason: '',
      transcriptPath: request.transcriptPath,
      durationMs: 1,
      toolCalls: [],
    }
  },
}

function runtimeWith(root: string) {
  const runtime = new ForgeLoopRuntime({
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
  return runtime
}

function submitRequirement(runtime: ForgeLoopRuntime): string {
  const submitted = runtime.submit({
    text: '# 交付验证\n\n需要一个可安装交付。',
    by: 'owner',
    source: 'test',
    analyze: false,
  })
  const data = asRecord(submitted.data)
  const reqId = typeof data?.reqId === 'string' ? data.reqId : ''
  if (!reqId) throw new Error('测试需求没有拿到身份')
  return reqId
}

/** 按真实记录形状登记提交、测试、验收、构建与试装；测试只关心判定本身。 */
function seedMaterials(
  runtime: ForgeLoopRuntime,
  reqId: string,
  input: { trialSha?: string; reviewVerificationSha?: string } = {},
): void {
  const repo = runtime.repo
  repo.recordCommit({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    commitSha: COMMIT_SHA,
    commitMessage: 'feat(demo): 可安装交付',
    checkCommand: ['npm', 'run', 'check'],
    checkLogPath: '/evidence/gate.log',
    checkSha256: sha256OfText('gate'),
    files: ['src/demo.ts'],
    committedAt: '2026-11-16T10:05:00.000Z',
  })
  repo.recordVerification({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    requirementVersion: 1,
    workspaceSha256: sha256OfText('workspace'),
    verdict: 'pass',
    reportJson: '{}',
    reportPath: '/evidence/verification/report.json',
    reportSha256: VERIFICATION,
    evidenceDir: '/evidence/verification',
    sessionId: 'verification-session',
    verifiedAt: '2026-11-16T10:06:00.000Z',
  })
  repo.recordBusinessReview({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    requirementVersion: 1,
    verificationSha256: input.reviewVerificationSha ?? VERIFICATION,
    verdict: 'pass',
    reportJson: '{}',
    reportPath: '/evidence/review/report.json',
    reportSha256: REVIEW,
    sessionId: 'verification-session',
    reviewedAt: '2026-11-16T10:07:00.000Z',
  })
  repo.recordCandidateBuild({
    reqId,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    verificationSha256: VERIFICATION,
    packageVersion: '0.0.3',
    artifactSha256: PACKAGE,
    tarball: '/artifacts/forgeloop-dsh-0.0.3.tgz',
    files: ['lib/index.js'],
    gitHead: COMMIT_SHA,
    builtAt: '2026-11-16T10:08:00.000Z',
    evidenceDir: '/evidence/build',
  })
  repo.recordDeployment({
    reqId,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    packageVersion: '0.0.3',
    targetProfile: 'trial-profile',
    artifactSha256: input.trialSha ?? PACKAGE,
    runtimeVersion: '0.0.3',
    state: 'verified',
    checks: [{ id: 'running_version', ok: true, detail: '实际运行版本 0.0.3' }],
    evidenceDir: '/evidence/deployment',
    recordedBy: 'system:coordinator',
    source: 'test',
    recordedAt: '2026-11-16T10:09:00.000Z',
  })
}

function depsOf(runtime: ForgeLoopRuntime) {
  return {
    config: runtime.config,
    repo: runtime.repo,
    now: () => new Date('2026-11-16T10:10:00.000Z').toISOString(),
  }
}

const emptyMaterials: InstallableDeliveryMaterials = {
  requirementVersion: 1,
  currentRequirementVersion: 1,
  commit: null,
  package: null,
  instructions: null,
  verification: null,
  businessReview: null,
  trial: null,
}

describe('installable delivery verdict', () => {
  it('lists every missing material in a stable order', () => {
    const verdict = evaluateInstallableDelivery(emptyMaterials)
    expect(verdict.status).toBe('incomplete')
    expect(verdict.missing).toEqual([...DELIVERY_MATERIALS])
    expect(verdict.availableAt).toBe('')
  })

  it('requires a passing test, a passing review and the same package digest in the trial', () => {
    const complete: InstallableDeliveryMaterials = {
      requirementVersion: 1,
      currentRequirementVersion: 1,
      commit: {
        commitSha: COMMIT_SHA,
        commitMessage: 'feat(demo): 可安装交付',
        committedAt: '2026-11-16T10:05:00.000Z',
      },
      package: {
        packageVersion: '0.0.3',
        tarball: '/artifacts/demo.tgz',
        artifactSha256: PACKAGE,
        builtAt: '2026-11-16T10:08:00.000Z',
      },
      instructions: {
        path: '/evidence/delivery/INSTALL.md',
        sha256: sha256OfText('instructions'),
        bytes: 10,
        writtenAt: '2026-11-16T10:09:30.000Z',
      },
      verification: { verdict: 'pass', sha256: VERIFICATION, at: '2026-11-16T10:06:00.000Z' },
      businessReview: { verdict: 'pass', sha256: REVIEW, at: '2026-11-16T10:07:00.000Z' },
      trial: {
        targetId: 'trial-profile',
        artifactSha256: PACKAGE,
        runtimeVersion: '0.0.3',
        state: 'verified',
        verifiedAt: '2026-11-16T10:09:00.000Z',
      },
    }

    const delivered = evaluateInstallableDelivery(complete)
    expect(delivered).toMatchObject({ status: 'delivered', missing: [], mismatches: [] })
    // 可用时间是六项材料里最晚的一项，不是登记时刻。
    expect(delivered.availableAt).toBe('2026-11-16T10:09:30.000Z')

    expect(
      evaluateInstallableDelivery({
        ...complete,
        verification: { ...complete.verification!, verdict: 'block' },
      }).mismatches,
    ).toContain('独立测试未通过')
    expect(
      evaluateInstallableDelivery({
        ...complete,
        businessReview: { ...complete.businessReview!, verdict: 'block' },
      }).mismatches,
    ).toContain('业务验收未通过')
    expect(
      evaluateInstallableDelivery({
        ...complete,
        trial: { ...complete.trial!, artifactSha256: sha256OfText('other') },
      }).mismatches,
    ).toContain('交付包与试装包摘要不一致')
    expect(
      evaluateInstallableDelivery({ ...complete, currentRequirementVersion: 2 }).mismatches,
    ).toContain('交付材料绑定的是旧需求版本')
  })

  it('writes instructions that name the package, commit, trial target and digest equality', () => {
    const text = installInstructionsOf({
      reqId: 'req-1',
      project: 'testproj',
      requirementVersion: 1,
      commit: {
        commitSha: COMMIT_SHA,
        commitMessage: 'feat(demo): 可安装交付',
        committedAt: '2026-11-16T10:05:00.000Z',
      },
      package: {
        packageVersion: '0.0.3',
        tarball: '/artifacts/demo.tgz',
        artifactSha256: PACKAGE,
        builtAt: '2026-11-16T10:08:00.000Z',
      },
      verification: { verdict: 'pass', sha256: VERIFICATION, at: '2026-11-16T10:06:00.000Z' },
      businessReview: { verdict: 'pass', sha256: REVIEW, at: '2026-11-16T10:07:00.000Z' },
      trial: {
        targetId: 'trial-profile',
        artifactSha256: PACKAGE,
        runtimeVersion: '0.0.3',
        state: 'verified',
        verifiedAt: '2026-11-16T10:09:00.000Z',
      },
      targetParams: { profile: 'trial' },
    })
    expect(text).toContain(COMMIT_SHA)
    expect(text).toContain(PACKAGE)
    expect(text).toContain('试装目标：trial-profile')
    expect(text).toContain('交付包与试装包摘要一致：是')
    expect(text).toContain('profile=trial')
    // 说明文档不是授权：安装与回退仍由外部受控机制执行。
    expect(text).toContain('ForgeLoop 不内置安装器')
  })
})

describe('installable delivery record', () => {
  it('registers a delivery once commit, package, instructions, tests and trial line up', () => {
    const root = projectRoot()
    const runtime = runtimeWith(root)
    const reqId = submitRequirement(runtime)
    seedMaterials(runtime, reqId)

    const result = recordInstallableDelivery(depsOf(runtime), reqId)
    expect(result.ok).toBe(true)
    const record = runtime.repo.installableDeliveryStore.latest(reqId)
    expect(record).not.toBeNull()
    expect(record).toMatchObject({
      reqId,
      requirementVersion: 1,
      planVersion: 1,
      candidateSha256: CANDIDATE,
      commitSha: COMMIT_SHA,
      artifactSha256: PACKAGE,
      trialArtifactSha256: PACKAGE,
      trialTarget: 'trial-profile',
      // 安装说明在登记时写入，因此可用时间是材料与说明都齐备的登记时刻。
      availableAt: '2026-11-16T10:10:00.000Z',
      recordedAt: '2026-11-16T10:10:00.000Z',
    })
    expect(existsSync(record?.instructionsPath ?? '')).toBe(true)
    const instructions = readFileSync(record?.instructionsPath ?? '', 'utf8')
    expect(instructions).toContain(PACKAGE)
    expect(instructions).toContain(COMMIT_SHA)
    runtime.close()
  })

  it('does not create a second record for the same candidate and package', () => {
    const root = projectRoot()
    const runtime = runtimeWith(root)
    const reqId = submitRequirement(runtime)
    seedMaterials(runtime, reqId)

    expect(recordInstallableDelivery(depsOf(runtime), reqId).ok).toBe(true)
    expect(recordInstallableDelivery(depsOf(runtime), reqId).ok).toBe(true)
    expect(runtime.repo.installableDeliveryStore.countFor(reqId)).toBe(1)
    runtime.close()
  })

  it('refuses a trial whose package digest differs from the delivery package', () => {
    const root = projectRoot()
    const runtime = runtimeWith(root)
    const reqId = submitRequirement(runtime)
    seedMaterials(runtime, reqId, { trialSha: sha256OfText('installed-other') })

    const result = recordInstallableDelivery(depsOf(runtime), reqId)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('delivery_mismatch')
    expect(result.message).toContain('交付包与试装包摘要不一致')
    expect(runtime.repo.installableDeliveryStore.countFor(reqId)).toBe(0)
    runtime.close()
  })

  it('refuses material that belongs to an older requirement version', () => {
    const root = projectRoot()
    const runtime = runtimeWith(root)
    const reqId = submitRequirement(runtime)
    seedMaterials(runtime, reqId)
    runtime.repo.appendVersion({
      reqId,
      text: '# 交付验证\n\n需求已修订。',
      revisedBy: 'owner',
      source: 'test',
      now: '2026-11-16T10:09:30.000Z',
    })

    const result = recordInstallableDelivery(depsOf(runtime), reqId)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('delivery_mismatch')
    expect(result.message).toContain('旧需求版本')
    expect(runtime.repo.installableDeliveryStore.countFor(reqId)).toBe(0)
    runtime.close()
  })

  it('refuses when the review is bound to another round of test evidence', () => {
    const root = projectRoot()
    const runtime = runtimeWith(root)
    const reqId = submitRequirement(runtime)
    seedMaterials(runtime, reqId, { reviewVerificationSha: sha256OfText('other-verification') })

    const result = recordInstallableDelivery(depsOf(runtime), reqId)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('delivery_mismatch')
    expect(result.message).toContain('同一轮')
    expect(runtime.repo.installableDeliveryStore.countFor(reqId)).toBe(0)
    runtime.close()
  })
})
