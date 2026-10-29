import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
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
    JSON.stringify({ name: 'forgeloop-dsh', version: '0.0.2', type: 'module' }, null, 2),
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
      "} else {",
      "  mkdirSync('packages/forgeloop/dist', { recursive: true })",
      "  const tarball = resolve('packages/forgeloop/dist/artifact.tar.gz')",
      "  execFileSync('tar', ['-czf', tarball, '-C', 'packages/forgeloop', 'lib'])",
      "  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')",
      "  writeFileSync('packages/forgeloop/dist/artifact.json', JSON.stringify({",
      "    name: 'forgeloop-dsh', version: '0.0.2', sha256, tarball,",
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
      if (request.role === 'analyze') return result(request, ANALYSIS)
      if (request.role === 'plan') return result(request, PLAN)
      if (request.role === 'verify-plan') return result(request, PLAN_REVIEW)
      if (request.role === 'verify') {
        const verification = join(request.cwd, 'verification')
        mkdirSync(verification, { recursive: true })
        writeFileSync(
          join(verification, 'commands.json'),
          JSON.stringify({ commands: [{ label: 'smoke', argv: ['node', '-e', `console.log('${SMOKE_OUTPUT}')`] }] }),
        )
        writeFileSync(join(verification, 'report.json'), VERIFICATION_REPORT)
        return result(request, VERIFICATION_REPORT)
      }
      if (request.role === 'business-review') return result(request, BUSINESS_REVIEW)
      if (request.role === 'review') {
        return result(request, JSON.stringify({ verdict: 'pass', blocking: [], findings: [], summary: 'ok' }))
      }
      const allowed = /允许修改的文件（只能改这些）：(.+)/.exec(request.prompt)?.[1]?.split('、')[0] ?? 'docs/out.md'
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
    expect(build.packageVersion).toBe('0.0.2')
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
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'forgeloop-dsh', version: '0.0.2' }), 'utf8')

    const deployed = runtime.verifyDeployment({ reqId, targetProfile: 'web', by: 'owner', source: 'test' })
    expect(deployed.ok, deployed.message).toBe(true)
    const deployment = runtime.repo.deployment(reqId, 1)!
    expect(deployment.state).toBe('verified')
    expect(deployment.runtimeVersion).toBe('0.0.2')
    expect(deployment.candidateSha256).toBe(build.candidateSha256)
    expect(deployment.checks.every((check) => (check as { ok: boolean }).ok)).toBe(true)
  })

  it('fails deployment checks when the installed package differs from the verified candidate', async () => {
    const reqId = await acceptedRequirement()
    expect(runtime.buildCandidate({ reqId, by: 'owner' }).ok).toBe(true)
    const build = runtime.repo.candidateBuild(reqId, 1)!
    const installed = installProfile('web')
    execFileSync('tar', ['-xzf', build.tarball, '-C', installed])
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'forgeloop-dsh', version: '0.0.2' }), 'utf8')
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
})
