import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import { PLUGIN_VERSION } from '../src/runtime/version.js'
import { sha256OfText } from '../src/domain/delivery.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'

/**
 * 可发布候选与上线核对：
 * - 候选包只能从已通过独立验证的那份工作区构建，包版本、摘要与验证绑定；
 * - 安装由外部机制完成，程序核对安装文件、运行版本、需求模块与业务记录；
 * - 任一不一致都保留失败记录，不把安装回执当交付完成。
 */

let dir = ''
let profilesRoot = ''
let runtime: ForgeLoopRuntime

const SCENARIO = '任务按依赖完成'
const CRITERION = '两个任务交付且测试通过'
const SMOKE_OUTPUT = 'smoke ok: verified'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'forgeloop-release-'))
  git(project, ['init', '-q'])
  git(project, ['config', 'user.email', 'test@example.com'])
  git(project, ['config', 'user.name', 'Test'])
  writeFileSync(join(project, '.gitignore'), '.forgeloop/\npackages/forgeloop/lib/\npackages/forgeloop/dist/\n')
  writeFileSync(join(project, 'README.md'), 'fixture\n')
  mkdirSync(join(project, 'packages/forgeloop'), { recursive: true })
  writeFileSync(
    join(project, 'packages/forgeloop/package.json'),
    JSON.stringify({ name: 'forgeloop-dsh', version: PLUGIN_VERSION, type: 'module' }, null, 2),
  )
  writeFileSync(join(project, 'packages/forgeloop/src.ts'), 'export const version = 1\n')
  writeFileSync(
    join(project, 'pack.mjs'),
    [
      "import { createHash } from 'node:crypto'",
      "import { execFileSync } from 'node:child_process'",
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { resolve } from 'node:path'",
      "const mode = process.argv[2]",
      "if (mode === 'build') {",
      "  mkdirSync('packages/forgeloop/lib', { recursive: true })",
      "  writeFileSync('packages/forgeloop/lib/index.js', 'export const ok = 1\\n')",
      "} else if (mode === 'package-min') {",
      "  mkdirSync('packages/forgeloop/dist', { recursive: true })",
      "  const tarball = resolve('packages/forgeloop/dist/artifact-min.tar.gz')",
      "  execFileSync('tar', ['-czf', tarball, '-C', 'packages/forgeloop', 'lib'])",
      "  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')",
      "  const pkg = JSON.parse(readFileSync('packages/forgeloop/package.json', 'utf8'))",
      "  writeFileSync('packages/forgeloop/dist/artifact.json', JSON.stringify({ name: 'forgeloop-dsh', version: pkg.version, sha256, tarball }))",
      "} else {",
      "  mkdirSync('packages/forgeloop/dist', { recursive: true })",
      "  const tarball = resolve('packages/forgeloop/dist/artifact.tar.gz')",
      "  execFileSync('tar', ['-czf', tarball, '-C', 'packages/forgeloop', 'lib'])",
      "  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')",
      "  const pkg = JSON.parse(readFileSync('packages/forgeloop/package.json', 'utf8'))",
      "  writeFileSync('packages/forgeloop/dist/artifact.json', JSON.stringify({",
      "    name: 'forgeloop-dsh', version: pkg.version, sha256, tarball,",
      "    files: ['lib/index.js'], gitHead: '', builtAt: new Date().toISOString(),",
      "  }))",
      "}",
      '',
    ].join('\n'),
  )
  git(project, ['add', '-A'])
  git(project, ['commit', '-qm', 'base'])
  return project
}

function result(
  request: AgentRunRequest,
  text: string,
  status: AgentRunResult['status'] = 'completed',
): AgentRunResult {
  mkdirSync(dirname(request.transcriptPath), { recursive: true })
  writeFileSync(request.transcriptPath, '{}\n', 'utf8')
  return {
    status,
    text,
    sessionId: `session-fake-${request.role}`,
    reason: status === 'completed' ? '' : 'fake failure',
    transcriptPath: request.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  }
}

const ANALYSIS = JSON.stringify({
  goal: '实现两个小改动',
  scenarios: [SCENARIO],
  acceptance_criteria: [CRITERION],
  clarifications: [],
})

const PLAN = JSON.stringify({
  tasks: [
    {
      task_id: 'a',
      goal: '写 a',
      files: ['docs/a.md'],
      acceptance: 'a 存在',
      test_command: ['node', '-e', 'process.exit(0)'],
    },
    {
      task_id: 'b',
      goal: '写 b',
      files: ['docs/b.md'],
      acceptance: 'b 存在',
      test_command: ['node', '-e', 'process.exit(0)'],
      depends_on: ['a'],
    },
  ],
})

const PLAN_REVIEW = JSON.stringify({
  verdict: 'pass',
  blocking: [],
  findings: [],
  summary: '任务包可进入实现',
  verification_plan: [
    { scenario: SCENARIO, acceptance_criterion: CRITERION, method: '在独立候选上执行验证命令', required: true },
  ],
})

const VERIFICATION_REPORT = JSON.stringify({
  verdict: 'pass',
  summary: '候选通过独立验证',
  findings: [],
  blocking: [],
  scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: SMOKE_OUTPUT, commands: ['smoke'] }],
})

const BUSINESS_REVIEW = JSON.stringify({
  verdict: 'pass',
  summary: '业务终审通过',
  findings: [],
  blocking: [],
  scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: SMOKE_OUTPUT, commands: ['smoke'] }],
  acceptance: [{ criterion: CRITERION, status: 'pass', evidence: SMOKE_OUTPUT, commands: ['smoke'] }],
})

function fakeRunner(): AgentLike {
  return {
    async run(request) {
      if (request.role === 'product') return result(request, ANALYSIS)
      if (request.role === 'dev' && request.prompt.includes('技术方案与研发任务拆解')) return result(request, PLAN)
      if (request.role === 'verify' && request.prompt.includes('正在做实现前评审')) return result(request, PLAN_REVIEW)
      if (request.role === 'verify' && request.prompt.includes('独立验证 Agent')) {
        const verification = join(request.cwd, 'verification')
        mkdirSync(verification, { recursive: true })
        writeFileSync(
          join(verification, 'commands.json'),
          JSON.stringify({ commands: [{ label: 'smoke', argv: ['node', '-e', `console.log('${SMOKE_OUTPUT}')`] }] }),
        )
        writeFileSync(join(verification, 'report.json'), VERIFICATION_REPORT)
        return result(request, VERIFICATION_REPORT)
      }
      if (request.role === 'verify' && request.prompt.includes('业务验收')) return result(request, BUSINESS_REVIEW)
      if (request.role === 'verify' && request.prompt.includes('独立审查')) {
        return result(request, JSON.stringify({ verdict: 'pass', blocking: [], findings: [], summary: 'ok' }))
      }
      const allowed = /计划中列出的预期文件（仅供参考，不是禁止修改其他文件）：(.+)/.exec(request.prompt)?.[1]?.split('、')[0] ?? 'docs/out.md'
      mkdirSync(join(request.cwd, allowed, '..'), { recursive: true })
      writeFileSync(join(request.cwd, allowed), `content ${Date.now()}\n`)
      return result(request, 'done')
    },
  }
}

function makeRuntime(): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      owner: 'owner',
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
      candidateBuildCommand: ['node', 'pack.mjs', 'build'],
      candidatePackageCommand: ['node', 'pack.mjs', 'package'],
      candidateArtifactPath: 'packages/forgeloop/dist/artifact.json',
      dshProfilesRoot: profilesRoot,
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config, runner: fakeRunner() })
}

async function runQueued(action: 'analyze' | 'plan' | 'advance' | 'verify', reqId: string) {
  const request = runtime.requestOperation({ reqId, action, by: 'tester', source: 'test' })
  expect(request.ok, request.message).toBe(true)
  const requestId = (request.data as { requestId: string }).requestId
  const claimed = runtime.repo.claimNextRequest('test-owner', new Date().toISOString())!
  const outcome = await runtime.executeRequest(claimed, new AbortController().signal)
  runtime.repo.resolveRequest(requestId, outcome.state, outcome.detail, new Date().toISOString())
  return outcome
}

async function acceptedRequirement(): Promise<string> {
  const submitted = runtime.submit({ text: '实现两个文档改动', by: 'owner', source: 'test' })
  const reqId = (submitted.data as { reqId: string }).reqId
  expect((await runQueued('analyze', reqId)).state).toBe('done')
  expect((await runQueued('plan', reqId)).state).toBe('done')
  expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' }).ok).toBe(true)
  const advance = await runQueued('advance', reqId)
  expect(advance.state, advance.detail).toBe('done')
  const accepted = runtime.accept({ reqId, by: 'owner', source: 'test' })
  expect(accepted.ok, accepted.message).toBe(true)
  return reqId
}


  it('builds an admitted candidate without any plan approval or overall acceptance', async () => {
    const submitted = runtime.submit({
      text: '实现两个文档改动',
      by: 'owner',
      source: 'dsh-session:test-session:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    expect((await runQueued('analyze', reqId)).state).toBe('done')
    expect(runtime.repo.latestAdmission(reqId)?.decision).toBe('admit')
    expect(runtime.repo.planApproval(reqId, 1)).toBeNull()
    const advance = await runQueued('advance', reqId)
    expect(advance.state, advance.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('committed')
    expect(runtime.repo.acceptance(reqId).accepted_at).toBe('')
    const build = runtime.buildCandidate({ reqId, by: 'owner' })
    expect(build.ok, build.message).toBe(true)
    expect((build.data as { candidateSha256: string }).candidateSha256).toHaveLength(64)
    const installed = installProfile('admitted')
    execFileSync('tar', ['-xzf', (build.data as { tarball: string }).tarball, '-C', installed])
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'forgeloop-dsh', version: PLUGIN_VERSION }), 'utf8')
    const deploy = runtime.verifyDeployment({
      reqId,
      targetProfile: 'admitted',
      by: 'owner',
      source: 'test',
    })
    expect(deploy.ok, deploy.message).toBe(true)
  })

function installProfile(name: string): string {
  const profile = join(profilesRoot, name)
  const installed = join(profile, 'node_modules', 'forgeloop-dsh')
  rmSync(installed, { recursive: true, force: true })
  mkdirSync(installed, { recursive: true })
  return installed
}

beforeEach(() => {
  dir = makeProject()
  profilesRoot = mkdtempSync(join(tmpdir(), 'forgeloop-profiles-'))
  runtime = makeRuntime()
})

afterEach(async () => {
  runtime.close()
  for (const target of [dir, profilesRoot]) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(target, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 4) throw error
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
})

describe('candidate build and deployment checks', () => {
  it('builds only from the verified workspace and records the verification binding', async () => {
    const reqId = await acceptedRequirement()
    const built = runtime.buildCandidate({ reqId, by: 'owner' })
    expect(built.ok, built.message).toBe(true)
    const build = runtime.repo.candidateBuild(reqId, 1)!
    const verification = runtime.repo.verification(reqId, 1)!
    expect(build.verificationSha256).toBe(verification.reportSha256)
    expect(build.candidateSha256).toBe(verification.candidateSha256)
    expect(build.packageVersion).toBe(PLUGIN_VERSION)
    expect(build.files).toEqual(['lib/index.js'])
    expect(readFileSync(build.tarball).length).toBeGreaterThan(0)
    const record = JSON.parse(readFileSync(join(build.evidenceDir, 'build', 'candidate-build.json'), 'utf8'))
    expect(record.verificationSha256).toBe(verification.reportSha256)
  })

  it('refuses to build before acceptance or without a passing verification', async () => {
    const submitted = runtime.submit({ text: '实现两个文档改动', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    await runQueued('plan', reqId)
    runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' })
    await runQueued('advance', reqId)
    expect(runtime.buildCandidate({ reqId, by: 'owner' })).toMatchObject({
      ok: false,
      code: 'acceptance_required',
    })
  })

  it('verifies installed files, runtime version and business records, then completes delivery', async () => {
    const reqId = await acceptedRequirement()
    expect(runtime.buildCandidate({ reqId, by: 'owner' }).ok).toBe(true)
    const build = runtime.repo.candidateBuild(reqId, 1)!
    const installed = installProfile('web')
    execFileSync('tar', ['-xzf', build.tarball, '-C', installed])
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'forgeloop-dsh', version: PLUGIN_VERSION }), 'utf8')

    const deployed = runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })
    expect(deployed.ok, deployed.message).toBe(true)
    const deployment = runtime.repo.deployment(reqId, 1)!
    expect(deployment.state).toBe('verified')
    expect(deployment.runtimeVersion).toBe(PLUGIN_VERSION)
    expect(deployment.candidateSha256).toBe(build.candidateSha256)
    expect(deployment.checks.every((check) => (check as { ok: boolean }).ok)).toBe(true)
  })

  it('fails deployment checks when the installed package differs from the verified candidate', async () => {
    const reqId = await acceptedRequirement()
    expect(runtime.buildCandidate({ reqId, by: 'owner' }).ok).toBe(true)
    const build = runtime.repo.candidateBuild(reqId, 1)!
    const installed = installProfile('web')
    execFileSync('tar', ['-xzf', build.tarball, '-C', installed])
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'forgeloop-dsh', version: PLUGIN_VERSION }), 'utf8')
    writeFileSync(join(installed, 'lib/index.js'), 'export const ok = 999\n', 'utf8')

    const deployed = runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })
    expect(deployed.ok).toBe(false)
    expect(deployed.message).toContain('installed_files')
    const deployment = runtime.repo.deployment(reqId, 1)!
    expect(deployment.state).toBe('failed')
  })

  it('refuses deployment when nothing was installed into the target profile', async () => {
    const reqId = await acceptedRequirement()
    expect(runtime.buildCandidate({ reqId, by: 'owner' }).ok).toBe(true)
    mkdirSync(join(profilesRoot, 'web'), { recursive: true })
    expect(runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'not_installed',
    })
  })
describe('release gate error paths', () => {
  it('refuses building when candidate commands are not configured or the version is invalid', async () => {
    const reqId = await acceptedRequirement()
    const plain = resolveConfig(
      {
        project: 'testproj',
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        pollSeconds: 1,
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
        formalTestTimeoutSeconds: 30,
        maxTaskAttempts: 2,
        dshProfilesRoot: profilesRoot,
      },
      dir,
    )
    const bare = new ForgeLoopRuntime({ ctx: {}, config: plain, runner: fakeRunner() })
    try {
      expect(bare.buildCandidate({ reqId, by: 'owner' })).toMatchObject({
        ok: false,
        code: 'candidate_not_configured',
      })
    } finally {
      bare.close()
    }
    expect(runtime.buildCandidate({ reqId, by: 'owner', version: 'v1' })).toMatchObject({
      ok: false,
      code: 'version_invalid',
    })
  })

  it('refuses building when the verification report was tampered with', async () => {
    const reqId = await acceptedRequirement()
    const verification = runtime.repo.verification(reqId, 1)!
    writeFileSync(verification.reportPath, `${verification.reportJson}\n篡改\n`, 'utf8')
    expect(runtime.buildCandidate({ reqId, by: 'owner' })).toMatchObject({
      ok: false,
      code: 'verification_invalid',
    })
  })

  it('refuses deployment before a build, for bad profiles, and when not installed', async () => {
    const reqId = await acceptedRequirement()
    expect(runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'candidate_missing',
    })
    expect(runtime.buildCandidate({ reqId, by: 'owner' }).ok).toBe(true)
    expect(
      runtime.verifyDeployment({ reqId, targetProfile: '../etc', by: 'owner', source: 'test' }),
    ).toMatchObject({ ok: false, code: 'profile_invalid' })
    expect(
      runtime.verifyDeployment({ reqId, targetProfile: 'missing', by: 'owner', source: 'test' }),
    ).toMatchObject({ ok: false, code: 'profile_missing' })
    mkdirSync(join(profilesRoot, 'empty'), { recursive: true })
    expect(
      runtime.verifyDeployment({ reqId, targetProfile: 'empty', by: 'owner', source: 'test' }),
    ).toMatchObject({ ok: false, code: 'not_installed' })
  })

  it('reports installed version and requirement module mismatches separately', async () => {
    const reqId = await acceptedRequirement()
    expect(runtime.buildCandidate({ reqId, by: 'owner' }).ok).toBe(true)
    const build = runtime.repo.candidateBuild(reqId, 1)!
    const installed = installProfile('web')
    execFileSync('tar', ['-xzf', build.tarball, '-C', installed])
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'forgeloop-dsh', version: '9.9.9' }), 'utf8')
    const wrongVersion = runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })
    expect(wrongVersion.ok).toBe(false)
    expect(wrongVersion.message).toContain('installed_version')

    // 安装文件匹配但本次需求的模块缺失：单独判 requirement_modules 失败。
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'forgeloop-dsh', version: PLUGIN_VERSION }), 'utf8')
    const plan = runtime.repo.latestTaskPlan(reqId)!
    const withModule = {
      ...plan,
      planVersion: 1,
      tasks: plan.tasks.map((task) => ({
        ...task,
        files: [...task.files, 'packages/forgeloop/src/missing-module.ts'],
      })),
    }
    runtime.repo.db.handle
      .prepare('UPDATE requirement_task_plans SET plan = ? WHERE req_id = ? AND plan_version = 1')
      .run(
        JSON.stringify({
          task_plan_id: withModule.taskPlanId,
          requirement_id: reqId,
          project: 'testproj',
          plan_version: 1,
          requirement_version: 1,
          created_at: withModule.createdAt,
          tasks: withModule.tasks.map((task) => ({
            task_id: task.taskId,
            goal: task.goal,
            files: task.files,
            acceptance: task.acceptance,
            test_command: task.testCommand,
            depends_on: task.dependsOn,
            limits: { limit_seconds: task.limits.limitSeconds, max_failure_rounds: task.limits.maxFailureRounds },
            authorization_source: task.authorizationSource,
          })),
        }),
        reqId,
      )
    const missingModule = runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })
    expect(missingModule.ok).toBe(false)
    expect(missingModule.message).toContain('requirement_modules')
  })

  it('records a failed check when the candidate artifact no longer matches the current delivery', async () => {
    const reqId = await acceptedRequirement()
    expect(runtime.buildCandidate({ reqId, by: 'owner' }).ok).toBe(true)
    const build = runtime.repo.candidateBuild(reqId, 1)!
    const installed = installProfile('web')
    execFileSync('tar', ['-xzf', build.tarball, '-C', installed])
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'forgeloop-dsh', version: PLUGIN_VERSION }), 'utf8')
    expect(runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' }).ok).toBe(true)

    // 交付材料变化形成新候选身份：旧候选包的部署核对必须拒绝。
    const artifact = runtime.repo.taskArtifact(reqId, 1, 'a')!
    runtime.repo.recordTaskArtifact({ ...artifact, candidateSha256: 'e'.repeat(64) })
    expect(runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'candidate_stale',
    })
  })

  it('refuses building when delivery is incomplete, review evidence is gone, or the verified workspace changed', async () => {
    const reqId = await acceptedRequirement()
    const plan = runtime.repo.latestTaskPlan(reqId)!
    const artifact = runtime.repo.taskArtifact(reqId, 1, plan.tasks[0]!.taskId)!
    runtime.repo.db.handle
      .prepare('DELETE FROM requirement_task_artifacts WHERE req_id = ? AND plan_version = 1 AND task_id = ?')
      .run(reqId, plan.tasks[0]!.taskId)
    expect(runtime.buildCandidate({ reqId, by: 'owner' })).toMatchObject({
      ok: false,
      code: 'not_delivered',
    })
    runtime.repo.recordTaskArtifact(artifact)

    const verification = runtime.repo.verification(reqId, 1)!
    runtime.repo.db.handle
      .prepare('DELETE FROM requirement_business_reviews WHERE req_id = ?')
      .run(reqId)
    expect(runtime.buildCandidate({ reqId, by: 'owner' })).toMatchObject({
      ok: false,
      code: 'business_review_required',
    })

    // 恢复业务终审后，篡改验证工作区使受保护内容与记录不一致。
    const reviewJson = `${JSON.stringify({ kind: 'business-review', verdict: 'pass', summary: '通过', blocking: [], scenarios: [], acceptance: [] })}\n`
    const reviewPath = join(dir, 'review-restore.json')
    writeFileSync(reviewPath, reviewJson, 'utf8')
    runtime.repo.recordBusinessReview({
      requirementId: reqId,
      planVersion: 1,
      candidateSha256: verification.candidateSha256,
      requirementVersion: 1,
      verificationSha256: verification.reportSha256,
      verdict: 'pass',
      reportJson: reviewJson,
      reportPath: reviewPath,
      reportSha256: sha256OfText(reviewJson),
      sessionId: 'session',
      reviewedAt: new Date().toISOString(),
    })
    const workspace = join(verification.evidenceDir, 'workspace')
    writeFileSync(join(workspace, 'docs/a.md'), 'tampered\n', 'utf8')
    expect(runtime.buildCandidate({ reqId, by: 'owner' })).toMatchObject({
      ok: false,
      code: 'candidate_content_mismatch',
    })
  })

  it('requires the exact accepted artifact digest once a candidate exists', async () => {
    const reqId = await acceptedRequirement()
    expect(runtime.buildCandidate({ reqId, by: 'owner' }).ok).toBe(true)
    const build = runtime.repo.candidateBuild(reqId, 1)!
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'artifact_required',
    })
    expect(
      runtime.accept({ reqId, by: 'owner', source: 'test', artifactSha256: 'f'.repeat(64) }),
    ).toMatchObject({ ok: false, code: 'artifact_mismatch' })
    expect(
      runtime.accept({ reqId, by: 'owner', source: 'test', artifactSha256: build.artifactSha256 }).ok,
    ).toBe(true)
  })

  it('surfaces missing or malformed package artifacts instead of recording a candidate', async () => {
    const reqId = await acceptedRequirement()
    const base = {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
      candidateBuildCommand: ['node', 'pack.mjs', 'build'],
      candidatePackageCommand: ['node', 'pack.mjs', 'package'],
      dshProfilesRoot: profilesRoot,
    }
    const missingArtifact = new ForgeLoopRuntime({
      ctx: {},
      config: resolveConfig({ ...base, candidateArtifactPath: 'packages/forgeloop/dist/none.json' }, dir),
      runner: fakeRunner(),
    })
    try {
      expect(missingArtifact.buildCandidate({ reqId, by: 'owner' })).toMatchObject({
        ok: false,
        code: 'artifact_missing',
      })
    } finally {
      missingArtifact.close()
    }

    const malformed = new ForgeLoopRuntime({
      ctx: {},
      config: resolveConfig({ ...base, candidateArtifactPath: 'packages/forgeloop/package.json' }, dir),
      runner: fakeRunner(),
    })
    try {
      expect(malformed.buildCandidate({ reqId, by: 'owner' })).toMatchObject({
        ok: false,
        code: 'artifact_malformed',
      })
    } finally {
      malformed.close()
    }
  })

  it('rejects building when the verified workspace disappeared', async () => {
    const reqId = await acceptedRequirement()
    const verification = runtime.repo.verification(reqId, 1)!
    rmSync(join(verification.evidenceDir, 'workspace'), { recursive: true, force: true })
    expect(runtime.buildCandidate({ reqId, by: 'owner' })).toMatchObject({
      ok: false,
      code: 'verification_workspace_missing',
    })
  })

  it('exposes business review, candidate build and deployment in the requirement detail', async () => {
    const reqId = await acceptedRequirement()
    expect(runtime.buildCandidate({ reqId, by: 'owner' }).ok).toBe(true)
    const build = runtime.repo.candidateBuild(reqId, 1)!
    const installed = installProfile('web')
    execFileSync('tar', ['-xzf', build.tarball, '-C', installed])
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'forgeloop-dsh', version: PLUGIN_VERSION }), 'utf8')
    expect(runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' }).ok).toBe(true)

    const detail = runtime.requirementDetail(reqId).data as {
      businessReview: { verdict: string } | null
      candidateBuild: { packageVersion: string } | null
      deployment: { state: string } | null
      archivedDeliveries: unknown[]
    }
    expect(detail.businessReview).toMatchObject({ verdict: 'pass' })
    expect(detail.candidateBuild).toMatchObject({ packageVersion: PLUGIN_VERSION })
    expect(detail.deployment).toMatchObject({ state: 'verified' })
    expect(detail.archivedDeliveries).toEqual([])
  })

  it('returns empty release detail fields for a requirement without a plan', () => {
    runtime.repo.submit({
      reqId: 'req-no-plan',
      project: 'testproj',
      text: '没有任务包',
      submittedBy: 'owner',
      source: 'test',
      now: new Date().toISOString(),
    })
    const detail = runtime.requirementDetail('req-no-plan').data as {
      businessReview: unknown
      candidateBuild: unknown
      deployment: unknown
      archivedDeliveries: unknown[]
    }
    expect(detail.businessReview).toBeNull()
    expect(detail.candidateBuild).toBeNull()
    expect(detail.deployment).toBeNull()
    expect(detail.archivedDeliveries).toEqual([])
  })

  it('reports deployment preconditions and installed-material failures explicitly', async () => {
    // 没有任务包时直接拒绝，不猜测候选。
    runtime.repo.submit({
      reqId: 'req-deploy-noplan',
      project: 'testproj',
      text: '无任务包',
      submittedBy: 'owner',
      source: 'test',
      now: new Date().toISOString(),
    })
    expect(
      runtime.verifyDeployment({ reqId: 'req-deploy-noplan', targetProfile: 'web', by: 'owner', source: 'test' }),
    ).toMatchObject({ ok: false, code: 'plan_missing' })

    const reqId = await acceptedRequirement()
    expect(runtime.buildCandidate({ reqId, by: 'owner' }).ok).toBe(true)
    const build = runtime.repo.candidateBuild(reqId, 1)!
    const installed = installProfile('web')
    execFileSync('tar', ['-xzf', build.tarball, '-C', installed])
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'forgeloop-dsh', version: PLUGIN_VERSION }), 'utf8')

    // 安装文件缺失。
    rmSync(join(installed, 'lib/index.js'), { force: true })
    const missingFile = runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })
    expect(missingFile.ok).toBe(false)
    expect(missingFile.message).toContain('installed_files')

    // 包文件不可读：安装文件存在但 tarball 被删。
    execFileSync('tar', ['-xzf', build.tarball, '-C', installed])
    rmSync(build.tarball, { force: true })
    const missingTarball = runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })
    expect(missingTarball.ok).toBe(false)
    expect(missingTarball.message).toContain('installed_files')

    // 安装清单损坏：读出空版本，按版本不一致失败。
    writeFileSync(join(installed, 'package.json'), '{not json', 'utf8')
    const brokenManifest = runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })
    expect(brokenManifest.ok).toBe(false)
    expect(brokenManifest.message).toContain('installed_version')

    // 交付材料被清空：不能只靠旧构建做上线核对。
    const artifact = runtime.repo.taskArtifact(reqId, 1, 'a')!
    runtime.repo.db.handle
      .prepare('DELETE FROM requirement_task_artifacts WHERE req_id = ? AND plan_version = 1 AND task_id = ?')
      .run(reqId, 'a')
    expect(runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'not_delivered',
    })
    runtime.repo.recordTaskArtifact(artifact)
  })


  it('accepts a minimal artifact manifest and defaults optional fields', async () => {
    const reqId = await acceptedRequirement()
    const config = resolveConfig(
      {
        project: 'testproj',
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        pollSeconds: 1,
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
        formalTestTimeoutSeconds: 30,
        maxTaskAttempts: 2,
        candidateBuildCommand: ['node', 'pack.mjs', 'build'],
        candidatePackageCommand: ['node', 'pack.mjs', 'package-min'],
        candidateArtifactPath: 'packages/forgeloop/dist/artifact.json',
        dshProfilesRoot: profilesRoot,
      },
      dir,
    )
    const minimal = new ForgeLoopRuntime({ ctx: {}, config, runner: fakeRunner() })
    try {
      const built = minimal.buildCandidate({ reqId, by: 'owner' })
      expect(built.ok, built.message).toBe(true)
      const build = minimal.repo.candidateBuild(reqId, 1)!
      expect(build.files).toEqual([])
      expect(build.gitHead).toBe('')
    } finally {
      minimal.close()
    }
  })

})
})
