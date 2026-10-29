import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import { candidateIdentityOf } from '../src/domain/delivery.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'

/**
 * 验证阻断 → 研发修复 → 重新送验：旧候选、旧材料与失败轮次必须保留，
 * 新尝试产生新的候选身份，而不是覆盖成“从未失败”。
 */

let dir = ''
let runtime: ForgeLoopRuntime

const SCENARIO = '任务按依赖完成'
const CRITERION = '两个任务交付且测试通过'
const SMOKE_OUTPUT = 'smoke ok: verified'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'forgeloop-rework-'))
  git(project, ['init', '-q'])
  git(project, ['config', 'user.email', 'test@example.com'])
  git(project, ['config', 'user.name', 'Test'])
  writeFileSync(join(project, '.gitignore'), '.forgeloop/\n')
  writeFileSync(join(project, 'README.md'), 'fixture\n')
  git(project, ['add', '-A'])
  git(project, ['commit', '-qm', 'base'])
  return project
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

function verificationReport(): string {
  return JSON.stringify({
    verdict: 'pass',
    summary: '候选通过独立验证',
    findings: [],
    blocking: [],
    scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: SMOKE_OUTPUT, commands: ['smoke'] }],
  })
}

function commandsOf(exitCode: number): string {
  const body =
    exitCode === 0 ? `console.log('${SMOKE_OUTPUT}')` : 'process.exit(1)'
  return JSON.stringify({ commands: [{ label: 'smoke', argv: ['node', '-e', body] }] })
}

interface VerifyOptions {
  commands?: string
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

function fakeRunner(workspace: VerifyOptions): AgentLike {
  return {
    async run(request) {
      if (request.role === 'analyze') return result(request, ANALYSIS)
      if (request.role === 'plan') return result(request, PLAN)
      if (request.role === 'verify-plan') return result(request, PLAN_REVIEW)
      if (request.role === 'verify') {
        const verification = join(request.cwd, 'verification')
        mkdirSync(verification, { recursive: true })
        writeFileSync(join(verification, 'commands.json'), workspace.commands ?? commandsOf(0))
        writeFileSync(join(verification, 'report.json'), verificationReport())
        return result(request, verificationReport())
      }
      if (request.role === 'business-review') {
        return result(
          request,
          JSON.stringify({
            verdict: 'pass',
            summary: '业务终审通过',
            findings: [],
            blocking: [],
            scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: SMOKE_OUTPUT, commands: ['smoke'] }],
            acceptance: [{ criterion: CRITERION, status: 'pass', evidence: SMOKE_OUTPUT, commands: ['smoke'] }],
          }),
        )
      }
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

function makeRuntime(runner: AgentLike): ForgeLoopRuntime {
  const config = resolveConfig(
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
  )
  return new ForgeLoopRuntime({ ctx: {}, config, runner })
}

async function runQueued(action: 'analyze' | 'plan' | 'advance' | 'verify', reqId: string) {
  const request = runtime.requestOperation({ reqId, action, by: 'tester', source: 'test' })
  expect(request.ok, request.message).toBe(true)
  const requestId = (request.data as { requestId: string }).requestId
  const claimed = runtime.repo.claimNextRequest('test-owner', new Date().toISOString())!
  expect(claimed.requestId).toBe(requestId)
  const outcome = await runtime.executeRequest(claimed, new AbortController().signal)
  runtime.repo.resolveRequest(requestId, outcome.state, outcome.detail, new Date().toISOString())
  return outcome
}

async function runPipeline(): Promise<{ reqId: string; advance: Awaited<ReturnType<typeof runQueued>> }> {
  const submitted = runtime.submit({ text: '实现两个文档改动', by: 'owner', source: 'test' })
  const reqId = (submitted.data as { reqId: string }).reqId
  expect((await runQueued('analyze', reqId)).state).toBe('done')
  expect((await runQueued('plan', reqId)).state).toBe('done')
  const approval = runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' })
  expect(approval.ok, approval.message).toBe(true)
  return { reqId, advance: await runQueued('advance', reqId) }
}

function identityOf(reqId: string, planVersion = 1): string {
  const plan = runtime.repo.latestTaskPlan(reqId)!
  const artifacts = runtime.repo.taskArtifacts(reqId, planVersion)
  return candidateIdentityOf({
    planVersion: plan.planVersion,
    requirementVersion: plan.requirementVersion,
    baselineCommit: artifacts[0]!.baselineCommit,
    candidateHashes: artifacts.map((artifact) => artifact.candidateSha256),
  })
}

function claimAndExecute(reqId: string): Promise<{ state: string; detail: string }> {
  const pending = runtime.repo.requestsFor(reqId).find((request) => request.state === 'pending')!
  const claimed = runtime.repo.claimNextRequest('test-owner', new Date().toISOString())!
  expect(claimed.requestId).toBe(pending.requestId)
  return runtime.executeRequest(claimed, new AbortController().signal).then((outcome) => {
    runtime.repo.resolveRequest(claimed.requestId, outcome.state, outcome.detail, new Date().toISOString())
    return outcome
  })
}

beforeEach(() => {
  dir = makeProject()
  runtime = makeRuntime(fakeRunner({}))
})

afterEach(async () => {
  runtime.close()
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
})

describe('verification failure rework', () => {
  it('archives the blocked candidate, re-runs the same plan and binds a new verification', async () => {
    const workspace: VerifyOptions = { commands: commandsOf(1) }
    runtime.close()
    runtime = makeRuntime(fakeRunner(workspace))
    const { reqId, advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    const oldIdentity = identityOf(reqId)
    const oldVerification = runtime.repo.verification(reqId, 1)!
    expect(oldVerification.verdict).toBe('block')
    expect(oldVerification.candidateSha256).toBe(oldIdentity)
    const roundsBefore = runtime.repo.failureRounds(reqId).length
    expect(roundsBefore).toBe(1)

    // 第二次送验前，研发修复已把验证命令换成能通过的版本。
    workspace.commands = commandsOf(0)
    const rework = runtime.rework({ reqId, planVersion: 1, by: 'owner', source: 'test' })
    expect(rework.ok, rework.message).toBe(true)
    expect(runtime.repo.taskArtifacts(reqId, 1)).toHaveLength(0)
    for (const taskId of ['a', 'b']) {
      const archived = runtime.repo.archivedArtifacts(reqId, 1, taskId)
      expect(archived).toHaveLength(1)
      expect(existsSync(archived[0]!.archivedPath)).toBe(true)
      expect(readdirSync(archived[0]!.archivedPath).length).toBeGreaterThan(0)
    }

    const outcome = await claimAndExecute(reqId)
    expect(outcome.state, outcome.detail).toBe('done')
    const newIdentity = identityOf(reqId)
    expect(newIdentity).not.toBe(oldIdentity)
    const verification = runtime.repo.verification(reqId, 1)!
    expect(verification.verdict).toBe('pass')
    expect(verification.candidateSha256).toBe(newIdentity)
    // 旧候选的阻断结论与失败轮次仍然可按旧身份回查。
    expect(runtime.repo.verificationForCandidate(reqId, 1, oldIdentity)?.verdict).toBe('block')
    expect(runtime.repo.failureRounds(reqId).length).toBe(roundsBefore)
    expect(runtime.repo.failureRounds(reqId)[0]!.stage).toBe('verification')
  })

  it('refuses rework when the current candidate did not fail verification', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({}))
    const { reqId } = await runPipeline()
    const rework = runtime.rework({ reqId, planVersion: 1, by: 'owner', source: 'test' })
    expect(rework).toMatchObject({ ok: false, code: 'verification_not_blocked' })
  })

  it('requires an explicit recovery confirmation when the request result is unknown', async () => {
    const workspace: VerifyOptions = { commands: commandsOf(1) }
    runtime.close()
    runtime = makeRuntime(fakeRunner(workspace))
    const { reqId } = await runPipeline()
    runtime.requestOperation({ reqId, action: 'advance', by: 'owner', source: 'test' })
    runtime.repo.claimNextRequest('test-owner', new Date().toISOString())
    runtime.repo.markClaimedUnknown(new Date().toISOString())

    expect(runtime.rework({ reqId, planVersion: 1, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'recovery_required',
    })
    workspace.commands = commandsOf(0)
    expect(
      runtime.rework({ reqId, planVersion: 1, by: 'owner', source: 'test', confirmRecovery: true }).ok,
    ).toBe(true)
    expect(runtime.repo.requestsFor(reqId).every((request) => request.state !== 'unknown')).toBe(true)
  })

  it('records a preflight block when the delivered diff no longer applies, so rework is reachable', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({}))
    const { reqId } = await runPipeline()
    // 模拟基线变化：换掉任务 a 的候选身份并写入无法应用的 diff。
    const artifact = runtime.repo.taskArtifact(reqId, 1, 'a')!
    runtime.repo.recordTaskArtifact({ ...artifact, candidateSha256: 'f'.repeat(64) })
    const evidence = runtime.repo.evidence(reqId, 1, 'a')!
    writeFileSync(evidence.candidatePath, '--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-x\n+y\n', 'utf8')

    const verify = await runQueued('verify', reqId)
    expect(verify.state).toBe('failed')
    expect(verify.detail).toContain('无法应用到验证副本')
    const blocked = runtime.repo.verification(reqId, 1)!
    expect(blocked.verdict).toBe('block')
    expect(blocked.reportJson).toContain('无法应用到验证副本')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')

    const rework = runtime.rework({ reqId, planVersion: 1, by: 'owner', source: 'test' })
    expect(rework.ok, rework.message).toBe(true)
  })

  it('refuses rework while another request is still in flight', async () => {
    const workspace: VerifyOptions = { commands: commandsOf(1) }
    runtime.close()
    runtime = makeRuntime(fakeRunner(workspace))
    const { reqId } = await runPipeline()
    runtime.requestOperation({ reqId, action: 'advance', by: 'owner', source: 'test' })
    expect(runtime.rework({ reqId, planVersion: 1, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'busy',
    })
    // 清掉在途请求，避免影响清理。
    runtime.repo.dismissPendingFor(reqId, 'test cleanup', new Date().toISOString())
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('fixture')
  })
})
