import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CandidatePipeline } from '../src/runtime/candidate-pipeline.js'
import { candidatesDir, resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import { sha256OfBytes, sha256OfText } from '../src/domain/delivery.js'
import { PLUGIN_VERSION } from '../src/runtime/version.js'
import type { PlannedTask, TaskPlan } from '../src/domain/task-plan.js'
import type { Requirement } from '../src/domain/requirement.js'
import type {
  BusinessReviewRecord,
  CodeCandidateRecord,
  RequirementCommitRecord,
  VerificationRecord,
} from '../src/records/repository.js'

/**
 * 候选流水线的行为测试：只通过公开构建/验收/上线核对入口与可观察的产物
 * （返回结果、磁盘记录、日志）断言，覆盖准入交付扫描、受保护文件核验、
 * 构建就绪判断、构建失败分支、产物清单读取与部署守卫。
 */

const NOW = '2026-11-03T10:00:00.000Z'
const CANDIDATE_SHA = 'c'.repeat(64)
const VERIFICATION_SHA = 'r'.repeat(64)
const ARTIFACT_SHA = 'a'.repeat(64)
const AGGREGATE_SHA = 'g'.repeat(64)

let root = ''
let config: ForgeLoopConfig

function buildConfig(overrides: Parameters<typeof resolveConfig>[0] = {}): ForgeLoopConfig {
  return resolveConfig(
    {
      project: 'demo',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      formalTestTimeoutSeconds: 10,
      candidateBuildCommand: ['node', '-e', 'process.exit(0)'],
      candidatePackageCommand: ['node', '-e', 'process.exit(0)'],
      candidateArtifactPath: 'artifact.json',
      dshProfilesRoot: join(root, 'profiles'),
      ...overrides,
    },
    root,
  )
}

function makePlan(
  planVersion = 1,
  tasks: readonly PlannedTask[] = [],
  requirementId = 'req-1',
): TaskPlan {
  return {
    taskPlanId: 'plan-' + planVersion,
    requirementId,
    project: 'demo',
    planVersion,
    requirementVersion: 1,
    tasks: [...tasks],
    createdAt: NOW,
  }
}

function makeTask(taskId: string): PlannedTask {
  return {
    taskId,
    goal: '目标',
    files: ['docs/a.md'],
    acceptance: '验收',
    testCommand: ['node', '-e', 'process.exit(0)'],
    dependsOn: [],
    limits: { limitSeconds: -1, maxFailureRounds: -1 },
    authorizationSource: 'test',
  }
}

function makeCandidate(
  diffPath: string,
  overrides: Partial<CodeCandidateRecord> = {},
): CodeCandidateRecord {
  return {
    requirementId: 'req-1',
    planVersion: 1,
    candidateVersion: 1,
    candidateSha256: CANDIDATE_SHA,
    requirementVersion: 1,
    baselineCommit: 'b'.repeat(40),
    snapshotCommit: 's'.repeat(40),
    diffPath,
    diffSha256: 'd'.repeat(64),
    createdAt: NOW,
    ...overrides,
  }
}

function makeVerification(
  evidenceDir: string,
  overrides: Partial<VerificationRecord> = {},
): VerificationRecord {
  return {
    requirementId: 'req-1',
    planVersion: 1,
    candidateSha256: CANDIDATE_SHA,
    requirementVersion: 1,
    workspaceSha256: 'w'.repeat(64),
    verdict: 'pass',
    reportJson: '{}',
    reportPath: join(evidenceDir, 'verification.json'),
    reportSha256: VERIFICATION_SHA,
    evidenceDir,
    sessionId: 'session-1',
    verifiedAt: NOW,
    ...overrides,
  }
}

function makeReview(
  evidenceDir: string,
  overrides: Partial<BusinessReviewRecord> = {},
): BusinessReviewRecord {
  return {
    requirementId: 'req-1',
    planVersion: 1,
    candidateSha256: CANDIDATE_SHA,
    requirementVersion: 1,
    verificationSha256: VERIFICATION_SHA,
    verdict: 'pass',
    reportJson: '{}',
    reportPath: join(evidenceDir, 'review.json'),
    reportSha256: 'v'.repeat(64),
    sessionId: 'session-review',
    reviewedAt: NOW,
    ...overrides,
  }
}

function makeCommit(): RequirementCommitRecord {
  return {
    requirementId: 'req-1',
    planVersion: 1,
    candidateSha256: CANDIDATE_SHA,
    commitSha: 'e'.repeat(40),
    commitMessage: 'feat: demo',
    checkCommand: ['make', 'check'],
    checkLogPath: join(root, 'check.log'),
    checkSha256: 'f'.repeat(64),
    files: [],
    committedAt: NOW,
  }
}

function makeRequirement(reqId = 'req-1', versionCount = 1): Requirement {
  return {
    reqId,
    project: 'demo',
    status: 'committed',
    blockedReason: '',
    versions: Array.from({ length: versionCount }, (_, index) => ({
      version: index + 1,
      text: '需求版本 ' + (index + 1),
      createdAt: NOW,
      revisedBy: 'owner',
      source: 'test',
    })),
    submittedBy: 'owner',
    source: 'test',
  }
}

function makeAdmission(reqId = 'req-1') {
  return {
    admissionId: 'admission-1',
    requirementId: reqId,
    requirementVersion: 1,
    decision: 'admit' as const,
    code: 'admit',
    reason: '系统准入',
    basis: {} as never,
    policyVersion: 'policy-1',
    decidedBy: 'system',
    createdAt: NOW,
  }
}

function makeBuild(overrides: Record<string, unknown> = {}) {
  return {
    reqId: 'req-1',
    planVersion: 1,
    candidateSha256: CANDIDATE_SHA,
    verificationSha256: VERIFICATION_SHA,
    packageVersion: PLUGIN_VERSION,
    artifactSha256: ARTIFACT_SHA,
    tarball: join(root, 'artifact.tgz'),
    files: [] as string[],
    gitHead: '',
    builtAt: NOW,
    evidenceDir: join(root, 'build-evidence'),
    ...overrides,
  }
}

function makeDeps(overrides: Record<string, any> = {}): any {
  const repo = {
    getRequirement: () => null,
    taskPlans: () => [],
    latestCodeCandidate: () => null,
    verificationForCandidate: () => null,
    businessReviewForCandidate: () => null,
    commitForCandidate: () => null,
    latestTaskPlan: () => null,
    planApproval: () => null,
    taskArtifacts: () => [],
    verification: () => null,
    candidate: () => null,
    acceptance: () => ({ accepted_at: '' }),
    candidateBuild: () => null,
    recordAcceptance: () => {},
    recordCandidateBuild: () => {},
    recordCandidate: () => {},
    recordDeployment: () => {},
    ...(overrides.repo ?? {}),
  }
  return {
    config,
    now: () => NOW,
    validateBuildMaterials: () => ({
      ok: true,
      diffPath: '',
      protectedFiles: [] as string[],
      workspaceSha256: 'w'.repeat(64),
    }),
    requireAuthorizedPlan: () => ({
      ok: false,
      result: {
        ok: false,
        code: 'plan_not_approved',
        message: '未找到该需求的任务包批准；未批准不执行',
      },
    }),
    currentAdmission: () => null,
    candidateIdentity: () => AGGREGATE_SHA,
    statusBoard: () => ({ requirements: [] }),
    ...overrides,
    repo,
  }
}

function pipelineWith(overrides: Record<string, any> = {}): CandidatePipeline {
  return new CandidatePipeline(makeDeps(overrides) as never)
}

function pipelineFrom(
  deps: any,
  repoOverrides: Record<string, any> = {},
  depsOverrides: Record<string, any> = {},
): CandidatePipeline {
  return new CandidatePipeline({
    ...deps,
    ...depsOverrides,
    repo: { ...deps.repo, ...repoOverrides },
  } as never)
}

const PACKAGE_SCRIPT = [
  "const fs = require('node:fs')",
  "const crypto = require('node:crypto')",
  "const path = require('node:path')",
  "fs.mkdirSync('dist', { recursive: true })",
  "const tarball = path.resolve('dist/artifact.tar.gz')",
  "fs.writeFileSync(tarball, 'artifact-bytes')",
  "const sha256 = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex')",
  "const pkg = JSON.parse(fs.readFileSync('packages/forgeloop/package.json', 'utf8'))",
  "fs.writeFileSync('artifact.json', JSON.stringify({ name: 'forgeloop-dsh', version: pkg.version, sha256, tarball, files: ['lib/index.js'], gitHead: 'head-sha', builtAt: '2026-01-01T00:00:00.000Z' }))",
].join(';')

function admittedBuildFixture(
  reqId: string,
  options: {
    packageJson?: Record<string, unknown> | null
    buildCommand?: string[]
    packageCommand?: string[]
    validateBuildMaterials?: () => unknown
  } = {},
) {
  const evidenceDir = join(root, 'evidence-' + reqId)
  const workspace = join(evidenceDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  if (options.packageJson !== null) {
    mkdirSync(join(workspace, 'packages/forgeloop'), { recursive: true })
    writeFileSync(
      join(workspace, 'packages/forgeloop/package.json'),
      JSON.stringify(options.packageJson ?? { name: 'forgeloop-dsh', version: '1.0.0' }),
      'utf8',
    )
  }
  const diffPath = join(root, 'candidate-' + reqId + '.diff')
  writeFileSync(diffPath, 'diff --git a/README.md b/README.md\n', 'utf8')
  const plan = makePlan(1, [], reqId)
  const candidate = makeCandidate(diffPath, { requirementId: reqId })
  const verification = makeVerification(evidenceDir, { requirementId: reqId })
  const review = makeReview(evidenceDir, { requirementId: reqId })
  const commit = makeCommit()
  const localConfig = buildConfig({
    candidateBuildCommand: options.buildCommand ?? ['node', '-e', 'process.exit(0)'],
    candidatePackageCommand: options.packageCommand ?? ['node', '-e', 'process.exit(0)'],
  })
  const deps = makeDeps({
    config: localConfig,
    currentAdmission: () => makeAdmission(reqId),
    validateBuildMaterials:
      options.validateBuildMaterials ??
      (() => ({
        ok: true,
        diffPath,
        protectedFiles: [] as string[],
        workspaceSha256: 'w'.repeat(64),
      })),
    repo: {
      getRequirement: () => makeRequirement(reqId),
      taskPlans: () => [plan],
      latestCodeCandidate: () => candidate,
      verificationForCandidate: () => verification,
      businessReviewForCandidate: () => review,
      commitForCandidate: () => commit,
    },
  })
  return {
    pipeline: new CandidatePipeline(deps as never),
    deps,
    config: localConfig,
    plan,
    candidate,
    verification,
    review,
    commit,
    evidenceDir,
    workspace,
    diffPath,
  }
}

function prepareFixture(
  reqId: string,
  options: {
    packageJson?: Record<string, unknown>
    protectedFiles?: string[]
    buildCommand?: string[]
    packageCommand?: string[]
    version?: string
  } = {},
) {
  const evidenceDir = join(root, 'prepare-' + reqId)
  const workspace = join(evidenceDir, 'workspace')
  mkdirSync(join(workspace, 'packages/forgeloop'), { recursive: true })
  writeFileSync(
    join(workspace, 'packages/forgeloop/package.json'),
    JSON.stringify(options.packageJson ?? { name: 'forgeloop-dsh', version: '1.0.0' }),
    'utf8',
  )
  writeFileSync(join(workspace, 'README.md'), 'fixture\n', 'utf8')
  const diffPath = join(root, 'prepare-' + reqId + '.diff')
  writeFileSync(diffPath, 'diff\n', 'utf8')
  const localConfig = buildConfig({
    candidateBuildCommand: options.buildCommand ?? ['node', '-e', 'process.exit(0)'],
    candidatePackageCommand: options.packageCommand ?? ['node', '-e', 'process.exit(0)'],
  })
  const pipeline = new CandidatePipeline({ config: localConfig } as never)
  const result = (pipeline as any).prepareCandidateBuild(
    { reqId, ...(options.version === undefined ? {} : { version: options.version }) },
    {
      plan: makePlan(1, [], reqId),
      candidate: makeCandidate(diffPath, { requirementId: reqId }),
      verification: makeVerification(evidenceDir, { requirementId: reqId }),
      materials: { diffPath, protectedFiles: options.protectedFiles ?? [] },
    },
  )
  return { result, pipeline, config: localConfig, evidenceDir, workspace, diffPath }
}

function acceptedGuardDeps() {
  const evidenceDir = join(root, 'accept-evidence')
  mkdirSync(evidenceDir, { recursive: true })
  const verificationText = JSON.stringify({
    verdict: 'pass',
    summary: '通过',
    findings: [],
    blocking: [],
  })
  const verificationPath = join(evidenceDir, 'verification.json')
  writeFileSync(verificationPath, verificationText, 'utf8')
  const verification = makeVerification(evidenceDir, {
    reportPath: verificationPath,
    reportSha256: sha256OfText(verificationText),
    reportJson: verificationText,
  })
  const reviewText = JSON.stringify({
    verdict: 'pass',
    summary: '通过',
    findings: [],
    blocking: [],
    scenarios: [],
    acceptance: [],
  })
  const reviewPath = join(evidenceDir, 'review.json')
  writeFileSync(reviewPath, reviewText, 'utf8')
  const review = makeReview(evidenceDir, {
    reportPath: reviewPath,
    reportSha256: sha256OfText(reviewText),
    reportJson: reviewText,
    verificationSha256: verification.reportSha256,
  })
  const plan = makePlan()
  const candidate = makeCandidate(join(evidenceDir, 'candidate.diff'))
  const recordAcceptance = vi.fn()
  const deps = makeDeps({
    currentAdmission: () => makeAdmission(),
    candidateIdentity: () => CANDIDATE_SHA,
    repo: {
      getRequirement: () => makeRequirement(),
      taskPlans: () => [plan],
      latestTaskPlan: () => plan,
      latestCodeCandidate: () => candidate,
      taskArtifacts: () => [],
      planApproval: () => null,
      verification: () => verification,
      businessReviewForCandidate: () => review,
      candidate: () => null,
      acceptance: () => ({ accepted_at: '' }),
      recordAcceptance,
    },
  })
  return {
    deps,
    plan,
    candidate,
    verification,
    review,
    recordAcceptance,
    evidenceDir,
  }
}

function deploymentFixture(
  options: {
    admitted?: boolean
    withProfile?: boolean
    withInstall?: boolean
    installedVersion?: string
  } = {},
) {
  const evidenceDir = join(root, 'deployment-evidence')
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(join(evidenceDir, 'candidate.diff'), '', 'utf8')
  const candidate = makeCandidate(join(evidenceDir, 'absent.diff'))
  const plan = makePlan()
  const verification = makeVerification(evidenceDir)
  const review = makeReview(evidenceDir, { verificationSha256: VERIFICATION_SHA })
  const build = makeBuild()
  const profileDir = join(root, 'profiles', 'prod')
  const installedRoot = join(profileDir, 'node_modules', 'forgeloop-dsh')
  if (options.withProfile !== false) mkdirSync(profileDir, { recursive: true })
  if (options.withProfile !== false && options.withInstall !== false) {
    mkdirSync(installedRoot, { recursive: true })
    writeFileSync(
      join(installedRoot, 'package.json'),
      JSON.stringify({
        name: 'forgeloop-dsh',
        version: options.installedVersion ?? PLUGIN_VERSION,
      }),
      'utf8',
    )
  }
  const recordDeployment = vi.fn()
  const localConfig = buildConfig({ dshProfilesRoot: join(root, 'profiles') })
  const deps = makeDeps({
    config: localConfig,
    currentAdmission: () => (options.admitted === false ? null : makeAdmission()),
    statusBoard: () => ({ requirements: [] }),
    repo: {
      getRequirement: () => makeRequirement(),
      taskPlans: () => [plan],
      latestTaskPlan: () => plan,
      latestCodeCandidate: () => candidate,
      verificationForCandidate: () => verification,
      businessReviewForCandidate: () => review,
      commitForCandidate: () => makeCommit(),
      taskArtifacts: () => [],
      acceptance: () => ({ accepted_at: '' }),
      candidateBuild: () => build,
      candidateIdentity: () => AGGREGATE_SHA,
      recordDeployment,
    },
  })
  return {
    deps,
    pipeline: new CandidatePipeline(deps as never),
    config: localConfig,
    plan,
    candidate,
    verification,
    review,
    build,
    profileDir,
    installedRoot,
    recordDeployment,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-mutation-candidate-'))
  config = buildConfig()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('admitted delivery scanning', () => {
  it('returns no delivery without current admission or without any candidate', () => {
    const plan = makePlan()
    const withoutAdmission = pipelineWith({ repo: { taskPlans: () => [plan] } })
    expect((withoutAdmission as any).admittedDelivery('req-1')).toBeNull()

    const withoutCandidate = pipelineWith({
      currentAdmission: () => makeAdmission(),
      repo: { taskPlans: () => [plan], latestCodeCandidate: () => null },
    })
    expect((withoutCandidate as any).admittedDelivery('req-1')).toBeNull()
  })

  it('scans plans newest first and binds the candidate records of the first hit', () => {
    const candidate = makeCandidate('/tmp/diff.diff')
    const verification = makeVerification('/tmp/evidence')
    const review = makeReview('/tmp/evidence')
    const commit = makeCommit()
    const scanned: number[] = []
    const pipeline = pipelineWith({
      currentAdmission: () => makeAdmission(),
      repo: {
        taskPlans: () => [makePlan(1), makePlan(2)],
        latestCodeCandidate: (_reqId: string, planVersion: number) => {
          scanned.push(planVersion)
          return planVersion === 1 ? candidate : null
        },
        verificationForCandidate: () => verification,
        businessReviewForCandidate: () => review,
        commitForCandidate: () => commit,
      },
    })
    const delivery = (pipeline as any).admittedDelivery('req-1')
    expect(scanned).toEqual([2, 1])
    expect(delivery.plan.planVersion).toBe(1)
    expect(delivery.candidate).toBe(candidate)
    expect(delivery.verification).toBe(verification)
    expect(delivery.review).toBe(review)
    expect(delivery.commit).toBe(commit)
  })
})

describe('protected candidate content', () => {
  it('hashes present files and records missing files as empty', () => {
    const evidenceDir = join(root, 'hashes')
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, 'a.txt'), 'alpha', 'utf8')
    const hashes = (pipelineWith() as any).protectedFileHashes(evidenceDir, [
      'a.txt',
      'missing.txt',
    ]) as Map<string, string>
    expect(hashes.get('a.txt')).toBe(sha256OfText('alpha'))
    expect(hashes.get('missing.txt')).toBe('')
    expect(hashes.size).toBe(2)
  })

  it('reports modified and deleted files but ignores allowed paths', () => {
    const evidenceDir = join(root, 'changes')
    mkdirSync(evidenceDir, { recursive: true })
    for (const [name, content] of [
      ['a.txt', 'alpha'],
      ['b.txt', 'beta'],
      ['c.txt', 'gamma'],
      ['ignored.txt', 'original'],
    ] as const) {
      writeFileSync(join(evidenceDir, name), content, 'utf8')
    }
    const pipeline = pipelineWith()
    const before = (pipeline as any).protectedFileHashes(evidenceDir, [
      'a.txt',
      'b.txt',
      'c.txt',
      'ignored.txt',
    ]) as Map<string, string>
    writeFileSync(join(evidenceDir, 'a.txt'), 'changed', 'utf8')
    rmSync(join(evidenceDir, 'c.txt'))
    writeFileSync(join(evidenceDir, 'ignored.txt'), 'changed too', 'utf8')
    expect((pipeline as any).protectedFilesChanged(evidenceDir, before, ['ignored.txt'])).toEqual([
      'a.txt',
      'c.txt',
    ])
  })
})

describe('build readiness', () => {
  const delivery = (overrides: Record<string, unknown> = {}) => {
    const evidenceDir = join(root, 'readiness')
    return {
      plan: makePlan(),
      candidate: makeCandidate(join(root, 'readiness.diff')),
      verification: makeVerification(evidenceDir),
      review: makeReview(evidenceDir),
      commit: makeCommit(),
      ...overrides,
    }
  }

  it('requires a candidate with a passing independent verification', () => {
    const pipeline = pipelineWith()
    expect(
      (pipeline as any).buildReadiness(delivery({ candidate: null }), undefined),
    ).toMatchObject({
      ok: false,
      code: 'verification_required',
      message: '候选没有通过的独立测试；不能构建',
    })
    expect(
      (pipeline as any).buildReadiness(delivery({ verification: null }), undefined),
    ).toMatchObject({ ok: false, code: 'verification_required' })
    expect(
      (pipeline as any).buildReadiness(
        delivery({ verification: makeVerification(root, { verdict: 'block' }) }),
        undefined,
      ),
    ).toMatchObject({ ok: false, code: 'verification_required' })
  })

  it('requires a passing business review and complete build configuration', () => {
    const pipeline = pipelineWith()
    expect((pipeline as any).buildReadiness(delivery({ review: null }), undefined)).toMatchObject({
      ok: false,
      code: 'business_review_required',
      message: '候选没有通过的业务验收；不能构建',
    })
    expect(
      (pipeline as any).buildReadiness(
        delivery({ review: makeReview(root, { verdict: 'block' }) }),
        undefined,
      ),
    ).toMatchObject({ ok: false, code: 'business_review_required' })

    const unconfigured = pipelineWith({ config: buildConfig({ candidateBuildCommand: [] }) })
    expect((unconfigured as any).buildReadiness(delivery(), undefined)).toMatchObject({
      ok: false,
      code: 'candidate_not_configured',
      message: '未配置 candidateBuildCommand / candidatePackageCommand / candidateArtifactPath',
    })
    const noArtifact = pipelineWith({ config: buildConfig({ candidateArtifactPath: '' }) })
    expect((noArtifact as any).buildReadiness(delivery(), undefined)).toMatchObject({
      ok: false,
      code: 'candidate_not_configured',
    })
  })

  it('validates an optional candidate version', () => {
    const pipeline = pipelineWith()
    expect((pipeline as any).buildReadiness(delivery(), '1.2')).toMatchObject({
      ok: false,
      code: 'version_invalid',
      message: '候选版本必须是 x.y.z，实际 "1.2"',
    })
    expect((pipeline as any).buildReadiness(delivery(), '')).toMatchObject({
      ok: false,
      code: 'version_invalid',
    })
    expect((pipeline as any).buildReadiness(delivery(), '1.2.3')).toBeNull()
    expect((pipeline as any).buildReadiness(delivery(), undefined)).toBeNull()
  })
})

describe('admitted candidate build', () => {
  it('reports an unknown requirement and a missing admitted delivery', () => {
    const unknown = pipelineWith()
    expect(unknown.buildCandidate({ reqId: 'req-x', by: 'owner' })).toMatchObject({
      ok: false,
      code: 'not_found',
      message: '未找到需求 req-x',
    })
    const noDelivery = pipelineWith({
      currentAdmission: () => makeAdmission(),
      repo: { getRequirement: () => makeRequirement(), taskPlans: () => [] },
    })
    expect(noDelivery.buildCandidate({ reqId: 'req-1', by: 'owner' })).toMatchObject({
      ok: false,
      code: 'candidate_missing',
      message: '需求 req-1 没有可构建的新链路候选',
    })
  })

  it('propagates build material validation failures unchanged', () => {
    const fixture = admittedBuildFixture('req-material', {
      validateBuildMaterials: () => ({
        ok: false,
        code: 'verification_invalid',
        message: '独立测试报告的候选、需求、方案或工作区身份不一致；不能构建',
      }),
    })
    expect(fixture.pipeline.buildCandidate({ reqId: 'req-material', by: 'owner' })).toMatchObject({
      ok: false,
      code: 'verification_invalid',
      message: '独立测试报告的候选、需求、方案或工作区身份不一致；不能构建',
    })
  })

  it('reports a missing candidate package manifest and a missing artifact manifest', () => {
    const missingPackage = admittedBuildFixture('req-no-package', { packageJson: null })
    expect(
      missingPackage.pipeline.buildCandidate({ reqId: 'req-no-package', by: 'owner' }),
    ).toMatchObject({
      ok: false,
      code: 'package_missing',
    })

    const missingArtifact = admittedBuildFixture('req-no-artifact')
    const result = missingArtifact.pipeline.buildCandidate({
      reqId: 'req-no-artifact',
      by: 'owner',
    })
    expect(result).toMatchObject({ ok: false, code: 'artifact_missing' })
    expect(result.message).toContain('打包完成但没有找到产物清单')
  })

  it('builds an admitted candidate and records the build binding', () => {
    const fixture = admittedBuildFixture('req-ok', {
      packageCommand: ['node', '-e', PACKAGE_SCRIPT],
    })
    const result = fixture.pipeline.buildCandidate({ reqId: 'req-ok', by: 'owner' })
    expect(result.ok, result.message).toBe(true)
    expect(result.message).toContain('已从准入候选构建安装包 1.0.0')
    const data = result.data as {
      sha256: string
      tarball: string
      files: string[]
      evidenceDir: string
      packageVersion: string
      candidateSha256: string
      verificationSha256: string
      commitSha: string
      recordPath: string
    }
    expect(data.sha256).toHaveLength(64)
    expect(data.packageVersion).toBe('1.0.0')
    expect(data.candidateSha256).toBe(CANDIDATE_SHA)
    expect(data.verificationSha256).toBe(VERIFICATION_SHA)
    expect(data.commitSha).toBe(fixture.commit.commitSha)
    expect(data.evidenceDir).toBe(candidatesDir(fixture.config, 'req-ok', 1))
    expect(data.files).toEqual(['lib/index.js'])
    expect(existsSync(data.recordPath)).toBe(true)

    const record = JSON.parse(readFileSync(data.recordPath, 'utf8')) as Record<string, unknown>
    expect(record).toMatchObject({
      kind: 'candidate-build',
      reqId: 'req-ok',
      planVersion: 1,
      candidateSha256: CANDIDATE_SHA,
      verificationSha256: VERIFICATION_SHA,
      packageVersion: '1.0.0',
      artifactSha256: data.sha256,
      tarball: data.tarball,
      files: ['lib/index.js'],
      gitHead: 'head-sha',
      builtAt: '2026-01-01T00:00:00.000Z',
      commitSha: fixture.commit.commitSha,
      sourceWorkspace: fixture.workspace,
      at: NOW,
    })
  })
})

describe('candidate artifact manifest', () => {
  it('rejects a missing or malformed artifact file', () => {
    const pipeline = pipelineWith()
    const emptyDir = join(root, 'empty-artifact')
    mkdirSync(emptyDir, { recursive: true })
    expect((pipeline as any).readCandidateArtifact(emptyDir, '1.0.0')).toMatchObject({
      ok: false,
      result: { code: 'artifact_missing' },
    })

    const malformedDir = join(root, 'malformed-artifact')
    mkdirSync(malformedDir, { recursive: true })
    writeFileSync(
      join(malformedDir, 'artifact.json'),
      JSON.stringify({ sha256: '', tarball: '', version: '1.0.0' }),
      'utf8',
    )
    expect((pipeline as any).readCandidateArtifact(malformedDir, '1.0.0')).toMatchObject({
      ok: false,
      result: { code: 'artifact_malformed' },
    })
  })

  it('accepts a valid manifest and filters non-string file entries', () => {
    const dir = join(root, 'valid-artifact')
    mkdirSync(dir, { recursive: true })
    const tarball = join(dir, 'artifact.tgz')
    writeFileSync(tarball, 'artifact-bytes', 'utf8')
    writeFileSync(
      join(dir, 'artifact.json'),
      JSON.stringify({
        sha256: sha256OfBytes(readFileSync(tarball)),
        tarball,
        files: ['lib/a.js', 42, 'lib/b.js'],
      }),
      'utf8',
    )
    expect((pipelineWith() as any).readCandidateArtifact(dir, '1.0.0')).toMatchObject({
      ok: true,
      value: {
        tarball,
        files: ['lib/a.js', 'lib/b.js'],
        gitHead: '',
        builtAt: '',
      },
    })
  })
})

describe('candidate build copy preparation', () => {
  it('rejects a build command that mutates protected content', () => {
    const fixture = prepareFixture('req-protected', {
      protectedFiles: ['README.md'],
      buildCommand: ['node', '-e', "require('node:fs').writeFileSync('README.md', 'mutated')"],
    })
    expect(fixture.result).toMatchObject({
      ok: false,
      result: { code: 'candidate_content_changed' },
    })
    expect(fixture.result.result.message).toContain('候选构建过程修改了受保护内容：README.md')
    expect(fixture.result.result.message).toContain('必须重新验证')
    const log = readFileSync(
      join(candidatesDir(fixture.config, 'req-protected', 1), 'candidate-build.log'),
      'utf8',
    )
    expect(log).toContain('=== build')
  })

  it('applies the requested version before hashing protected files', () => {
    const fixture = prepareFixture('req-version', {
      protectedFiles: ['packages/forgeloop/package.json'],
      version: '1.9.9',
    })
    expect(fixture.result).toMatchObject({ ok: true, packageVersion: '1.9.9' })
    const packageJson = JSON.parse(
      readFileSync(join(fixture.result.dir, 'packages/forgeloop/package.json'), 'utf8'),
    ) as { version: string }
    expect(packageJson.version).toBe('1.9.9')
  })

  it('reports a failing package command and an empty package version', () => {
    const failing = prepareFixture('req-package-fail', {
      packageCommand: ['node', '-e', 'process.exit(9)'],
    })
    expect(failing.result).toMatchObject({
      ok: false,
      result: { code: 'candidate_build_failed' },
    })
    expect(failing.result.result.message).toContain('候选包 package 失败（退出码 9）')
    const log = readFileSync(
      join(candidatesDir(failing.config, 'req-package-fail', 1), 'candidate-build.log'),
      'utf8',
    )
    expect(log).toContain('=== build (exit 0)')
    expect(log).toContain('=== package (exit 9)')

    const emptyVersion = prepareFixture('req-empty-version', {
      packageJson: { name: 'forgeloop-dsh', version: '' },
    })
    expect(emptyVersion.result).toMatchObject({
      ok: false,
      result: { code: 'package_missing' },
    })
    expect(emptyVersion.result.result.message).toContain('候选包清单缺少版本号')
  })
})

describe('acceptance guards', () => {
  it('rejects missing requirements, missing plans, unapproved plans, stale requirements and undelivered tasks', () => {
    const fixture = acceptedGuardDeps()
    expect(
      pipelineFrom(fixture.deps, { getRequirement: () => null }).accept({
        reqId: 'req-1',
        by: 'owner',
        source: 'test',
      }),
    ).toMatchObject({ ok: false, code: 'not_found' })

    expect(
      pipelineFrom(fixture.deps, { latestTaskPlan: () => null }).accept({
        reqId: 'req-1',
        by: 'owner',
        source: 'test',
      }),
    ).toMatchObject({ ok: false, code: 'plan_missing' })

    const unapproved = pipelineFrom(
      fixture.deps,
      { planApproval: () => null },
      { currentAdmission: () => null },
    ).accept({ reqId: 'req-1', by: 'owner', source: 'test' })
    expect(unapproved).toMatchObject({ ok: false, code: 'plan_not_approved' })
    expect(unapproved.message).toContain('未找到该需求的任务包批准')

    expect(
      pipelineFrom(fixture.deps, {
        latestTaskPlan: () => ({ ...fixture.plan, requirementVersion: 2 }),
      }).accept({ reqId: 'req-1', by: 'owner', source: 'test' }),
    ).toMatchObject({ ok: false, code: 'stale_requirement' })

    const undelivered = pipelineFrom(fixture.deps, {
      latestTaskPlan: () => ({ ...fixture.plan, tasks: [makeTask('task-a')] }),
    }).accept({ reqId: 'req-1', by: 'owner', source: 'test' })
    expect(undelivered).toMatchObject({ ok: false, code: 'not_delivered' })
    expect(undelivered.message).toContain('task-a')
  })

  it('requires the admitted candidate identity and an explicit matching artifact digest', () => {
    const fixture = acceptedGuardDeps()
    expect(
      pipelineFrom(fixture.deps, { latestCodeCandidate: () => null }).accept({
        reqId: 'req-1',
        by: 'owner',
        source: 'test',
      }),
    ).toMatchObject({ ok: false, code: 'candidate_missing' })

    const builtCandidate = {
      reqId: 'req-1',
      planVersion: 1,
      sha256: 'd'.repeat(64),
      tarball: join(root, 'artifact.tgz'),
      files: [],
      gitHead: '',
      builtAt: NOW,
      evidenceDir: join(root, 'built'),
    }
    const required = pipelineFrom(fixture.deps, { candidate: () => builtCandidate }).accept({
      reqId: 'req-1',
      by: 'owner',
      source: 'test',
    })
    expect(required).toMatchObject({ ok: false, code: 'artifact_required' })
    expect(required.message).toContain('已构建候选包 dddddddddddddddd…')

    expect(
      pipelineFrom(fixture.deps, { candidate: () => builtCandidate }).accept({
        reqId: 'req-1',
        by: 'owner',
        source: 'test',
        artifactSha256: 'e'.repeat(64),
      }),
    ).toMatchObject({ ok: false, code: 'artifact_mismatch' })
  })

  it('rejects stale, invalid and blocking verification materials', () => {
    const fixture = acceptedGuardDeps()
    const evidenceDir = fixture.evidenceDir

    expect(
      pipelineFrom(fixture.deps, {
        verification: () => ({
          ...fixture.verification,
          candidateSha256: 'x'.repeat(64),
        }),
      }).accept({ reqId: 'req-1', by: 'owner', source: 'test' }),
    ).toMatchObject({ ok: false, code: 'verification_stale' })

    expect(
      pipelineFrom(fixture.deps, {
        verification: () => ({
          ...fixture.verification,
          reportPath: join(evidenceDir, 'absent-verification.json'),
        }),
      }).accept({ reqId: 'req-1', by: 'owner', source: 'test' }),
    ).toMatchObject({ ok: false, code: 'verification_invalid' })

    const blockedText = JSON.stringify({
      verdict: 'block',
      summary: '未通过',
      findings: [],
      blocking: ['missing tests'],
    })
    const blockedPath = join(evidenceDir, 'verification-blocked.json')
    writeFileSync(blockedPath, blockedText, 'utf8')
    const blocked = pipelineFrom(fixture.deps, {
      verification: () => ({
        ...fixture.verification,
        verdict: 'block',
        reportPath: blockedPath,
        reportSha256: sha256OfText(blockedText),
        reportJson: blockedText,
      }),
    }).accept({ reqId: 'req-1', by: 'owner', source: 'test' })
    expect(blocked).toMatchObject({ ok: false, code: 'verification_blocked' })
    expect(blocked.message).toContain('missing tests')
  })

  it('rejects missing, stale, invalid and blocking business reviews', () => {
    const fixture = acceptedGuardDeps()
    const evidenceDir = fixture.evidenceDir

    expect(
      pipelineFrom(fixture.deps, { businessReviewForCandidate: () => null }).accept({
        reqId: 'req-1',
        by: 'owner',
        source: 'test',
      }),
    ).toMatchObject({ ok: false, code: 'business_review_required' })

    expect(
      pipelineFrom(fixture.deps, {
        businessReviewForCandidate: () => ({
          ...fixture.review,
          verificationSha256: 'z'.repeat(64),
        }),
      }).accept({ reqId: 'req-1', by: 'owner', source: 'test' }),
    ).toMatchObject({ ok: false, code: 'business_review_stale' })

    expect(
      pipelineFrom(fixture.deps, {
        businessReviewForCandidate: () => ({
          ...fixture.review,
          reportPath: join(evidenceDir, 'absent-review.json'),
        }),
      }).accept({ reqId: 'req-1', by: 'owner', source: 'test' }),
    ).toMatchObject({ ok: false, code: 'business_review_invalid' })

    const blockedText = JSON.stringify({
      verdict: 'block',
      summary: '未通过',
      findings: [],
      blocking: ['review blocked'],
      scenarios: [],
      acceptance: [],
    })
    const blockedPath = join(evidenceDir, 'review-blocked.json')
    writeFileSync(blockedPath, blockedText, 'utf8')
    const blocked = pipelineFrom(fixture.deps, {
      businessReviewForCandidate: () => ({
        ...fixture.review,
        verdict: 'block',
        reportPath: blockedPath,
        reportSha256: sha256OfText(blockedText),
        reportJson: blockedText,
      }),
    }).accept({ reqId: 'req-1', by: 'owner', source: 'test' })
    expect(blocked).toMatchObject({ ok: false, code: 'business_review_blocked' })
    expect(blocked.message).toContain('review blocked')
  })

  it('records the acceptance fingerprint bound to the current materials', () => {
    const fixture = acceptedGuardDeps()
    const builtCandidate = {
      reqId: 'req-1',
      planVersion: 1,
      sha256: 'd'.repeat(64),
      tarball: join(root, 'artifact.tgz'),
      files: [],
      gitHead: '',
      builtAt: NOW,
      evidenceDir: join(root, 'built'),
    }
    const result = pipelineFrom(fixture.deps, { candidate: () => builtCandidate }).accept({
      reqId: 'req-1',
      by: 'owner',
      source: 'test',
      artifactSha256: 'd'.repeat(64),
    })
    expect(result.ok, result.message).toBe(true)
    const data = result.data as { fingerprint: string; binding: Record<string, unknown> }
    expect(data.binding.artifactSha256).toBe('d'.repeat(64))
    expect(data.binding.verificationSha256).toBe(fixture.verification.reportSha256)
    expect(data.binding.businessReviewSha256).toBe(fixture.review.reportSha256)
    expect(data.binding.candidateSha256).toBe(CANDIDATE_SHA)
    const fingerprint = sha256OfText(JSON.stringify(data.binding))
    expect(data.fingerprint).toBe(fingerprint)
    expect(fixture.recordAcceptance).toHaveBeenCalledWith({
      reqId: 'req-1',
      acceptedBy: 'owner',
      source: 'test',
      fingerprint,
      now: NOW,
    })
  })
})

describe('deployment checks', () => {
  it('rejects an unknown requirement, an unsafe profile and missing delivery materials', () => {
    const fixture = deploymentFixture()
    const request = {
      reqId: 'req-1',
      targetProfile: 'prod',
      by: 'owner',
      source: 'test',
    }
    expect(
      pipelineFrom(fixture.deps, { getRequirement: () => null }).verifyDeployment(request),
    ).toMatchObject({ ok: false, code: 'not_found' })
    expect(
      fixture.pipeline.verifyDeployment({ ...request, targetProfile: 'Bad/Profile' }),
    ).toMatchObject({ ok: false, code: 'profile_invalid' })
    expect(
      pipelineFrom(fixture.deps, { taskPlans: () => [] }).verifyDeployment(request),
    ).toMatchObject({ ok: false, code: 'candidate_missing' })
    expect(
      pipelineFrom(
        fixture.deps,
        { latestTaskPlan: () => null },
        { currentAdmission: () => null },
      ).verifyDeployment(request),
    ).toMatchObject({ ok: false, code: 'plan_missing' })
    expect(
      pipelineFrom(fixture.deps, { candidateBuild: () => null }).verifyDeployment(request),
    ).toMatchObject({ ok: false, code: 'candidate_missing' })
    expect(
      pipelineFrom(fixture.deps, {
        candidateBuild: () => makeBuild({ candidateSha256: 'f'.repeat(64) }),
      }).verifyDeployment(request),
    ).toMatchObject({ ok: false, code: 'candidate_stale' })
    expect(
      pipelineFrom(
        fixture.deps,
        {
          acceptance: () => ({ accepted_at: '' }),
          candidateBuild: () => makeBuild({ candidateSha256: AGGREGATE_SHA }),
          candidateIdentity: () => AGGREGATE_SHA,
        },
        { currentAdmission: () => null },
      ).verifyDeployment(request),
    ).toMatchObject({ ok: false, code: 'acceptance_required' })
  })

  it('rejects a missing profile and a profile without an installed plugin', () => {
    const request = {
      reqId: 'req-1',
      targetProfile: 'prod',
      by: 'owner',
      source: 'test',
    }
    const withoutProfile = deploymentFixture({ withProfile: false })
    expect(withoutProfile.pipeline.verifyDeployment(request)).toMatchObject({
      ok: false,
      code: 'profile_missing',
    })
    const withoutInstall = deploymentFixture({ withInstall: false })
    expect(withoutInstall.pipeline.verifyDeployment(request)).toMatchObject({
      ok: false,
      code: 'not_installed',
    })
  })

  it('records a failed deployment when the installed version differs, then verifies after the fix', () => {
    const fixture = deploymentFixture({ installedVersion: '0.0.1' })
    const request = {
      reqId: 'req-1',
      targetProfile: 'prod',
      by: 'owner',
      source: 'test',
    }
    const failed = fixture.pipeline.verifyDeployment(request)
    expect(failed).toMatchObject({ ok: false, code: 'deployment_check_failed' })
    expect(failed.message).toContain(
      'installed_version：安装版本 0.0.1，候选包版本 ' + PLUGIN_VERSION,
    )
    const reportPath = join(
      candidatesDir(fixture.config, 'req-1', 1),
      'deployment',
      'prod',
      'deployment.json',
    )
    const failedReport = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      state: string
      checks: Array<{ id: string; ok: boolean }>
    }
    expect(failedReport.state).toBe('failed')
    expect(failedReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'installed_version', ok: false }),
        expect.objectContaining({ id: 'business_records', ok: true }),
      ]),
    )
    expect(fixture.recordDeployment).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'failed', targetProfile: 'prod' }),
    )

    writeFileSync(
      join(fixture.installedRoot, 'package.json'),
      JSON.stringify({ name: 'forgeloop-dsh', version: PLUGIN_VERSION }),
      'utf8',
    )
    const verified = fixture.pipeline.verifyDeployment(request)
    expect(verified.ok, verified.message).toBe(true)
    const data = verified.data as {
      state: string
      runtimeVersion: string
      checks: Array<{ id: string; ok: boolean }>
    }
    expect(data.state).toBe('verified')
    expect(data.runtimeVersion).toBe(PLUGIN_VERSION)
    expect(data.checks.map((entry) => entry.id)).toEqual([
      'installed_version',
      'installed_files',
      'running_version',
      'requirement_modules',
      'key_entry',
      'business_records',
    ])
    expect(data.checks.every((entry) => entry.ok)).toBe(true)
    expect(fixture.recordDeployment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reqId: 'req-1',
        targetProfile: 'prod',
        state: 'verified',
        recordedBy: 'owner',
        source: 'test',
      }),
    )
  })
})
