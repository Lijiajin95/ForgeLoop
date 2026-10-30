import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { Coordinator } from '../src/runtime/coordinator.js'
import { resolveConfig } from '../src/config.js'
import { sha256OfText } from '../src/domain/delivery.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'

let dir = ''
let runtime: ForgeLoopRuntime

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'forgeloop-project-'))
  git(project, ['init', '-q'])
  git(project, ['config', 'user.email', 'test@example.com'])
  git(project, ['config', 'user.name', 'Test'])
  writeFileSync(join(project, '.gitignore'), '.forgeloop/\n')
  writeFileSync(join(project, 'README.md'), 'fixture\n')
  git(project, ['add', '-A'])
  git(project, ['commit', '-qm', 'base'])
  return project
}

function result(request: AgentRunRequest, text: string, status: AgentRunResult['status'] = 'completed'): AgentRunResult {
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
  scenarios: ['任务按依赖完成'],
  acceptance_criteria: ['两个任务交付且测试通过'],
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
  summary: '任务包与验收标准一致，可以进入实现',
  verification_plan: [
    {
      scenario: '任务按依赖完成',
      acceptance_criterion: '两个任务交付且测试通过',
      method: '在独立候选上执行正式测试，并核对两个任务的交付证据',
      required: true,
    },
  ],
})

const VERIFY_OUTPUT = 'smoke ok: verified'

const VERIFICATION_REPORT = JSON.stringify({
  verdict: 'pass',
  summary: '候选通过独立验证',
  findings: [],
  blocking: [],
  scenarios: [
    {
      scenario: '任务按依赖完成',
      status: 'pass',
      evidence: VERIFY_OUTPUT,
      commands: ['smoke'],
    },
  ],
})

const VERIFICATION_PLAN = JSON.stringify({
  tasks: [
    {
      task_id: 'a',
      goal: '写 a',
      files: ['docs/a.md'],
      acceptance: 'a 存在',
      test_command: ['node', '-e', 'process.exit(0)'],
    },
    {
      task_id: 'verify',
      goal: '运行验证',
      files: [],
      verification: true,
      acceptance: '正式测试通过',
      test_command: ['node', '-e', 'process.exit(0)'],
      depends_on: ['a'],
    },
  ],
})

function fakeRunner(
  overrides: {
    onDev?: (request: AgentRunRequest, content: string) => void
    onAnalyze?: (request: AgentRunRequest, content: string) => void
    onPlan?: (request: AgentRunRequest, content: string) => void
  } = {},
): AgentLike {
  return {
    async run(request) {
      if (request.role === 'analyze') {
        overrides.onAnalyze?.(request, request.prompt)
        return result(request, ANALYSIS)
      }
      if (request.role === 'plan') {
        overrides.onPlan?.(request, request.prompt)
        return result(request, PLAN)
      }
      if (request.role === 'verify-plan') return result(request, PLAN_REVIEW)
      if (request.role === 'verify') {
        const verification = join(request.cwd, 'verification')
        mkdirSync(verification, { recursive: true })
        writeFileSync(
          join(verification, 'commands.json'),
          JSON.stringify({ commands: [{ label: 'smoke', argv: ['node', '-e', "console.log('smoke ok: verified')"] }] }),
        )
        writeFileSync(join(verification, 'report.json'), VERIFICATION_REPORT)
        return result(request, VERIFICATION_REPORT)
      }
      if (request.role === 'business-review') {
        return result(
          request,
          JSON.stringify({
            verdict: 'pass',
            summary: '业务终审通过',
            findings: [],
            blocking: [],
            scenarios: [
              { scenario: '任务按依赖完成', status: 'pass', evidence: VERIFY_OUTPUT, commands: ['smoke'] },
            ],
            acceptance: [
              { criterion: '两个任务交付且测试通过', status: 'pass', evidence: VERIFY_OUTPUT, commands: ['smoke'] },
            ],
          }),
        )
      }
      if (request.role === 'review') {
        return result(request, JSON.stringify({ verdict: 'pass', blocking: [], findings: [], summary: 'ok' }))
      }
      const allowed = /计划中列出的预期文件（仅供参考，不是禁止修改其他文件）：(.+)/.exec(request.prompt)?.[1]?.split('、')[0] ?? 'docs/out.md'
      const taskId = /当前任务：(.+)/.exec(request.prompt)?.[1]?.trim() ?? ''
      if (taskId === 'b' && !existsSync(join(request.cwd, 'docs/a.md'))) {
        throw new Error('依赖任务 a 的产物没有进入任务 b 的工作副本')
      }
      if (overrides.onDev) overrides.onDev(request, allowed)
      else {
        mkdirSync(join(request.cwd, allowed, '..'), { recursive: true })
        writeFileSync(join(request.cwd, allowed), `content ${Date.now()}\n`)
      }
      return result(request, 'done')
    },
  }
}

function makeRuntime(
  runner: AgentLike = fakeRunner(),
  formalTest?: typeof import('../src/runtime/formal-test.js').runFormalTest,
): ForgeLoopRuntime {
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
  return new ForgeLoopRuntime({ ctx: {}, config, runner, ...(formalTest ? { formalTest } : {}) })
}

async function runQueued(run: 'analyze' | 'plan' | 'advance', reqId: string) {
  const request = runtime.requestOperation({ reqId, action: run, by: 'tester', source: 'test' })
  expect(request.ok, request.message).toBe(true)
  const requestId = (request.data as { requestId: string }).requestId
  const claimed = runtime.repo.claimNextRequest('test-owner', new Date().toISOString())!
  expect(claimed.requestId).toBe(requestId)
  const outcome = await runtime.executeRequest(claimed, new AbortController().signal)
  runtime.repo.resolveRequest(requestId, outcome.state, outcome.detail, new Date().toISOString())
  return outcome
}

beforeEach(() => {
  dir = makeProject()
  runtime = makeRuntime()
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('requirement pipeline end to end with a deterministic agent', () => {
  it('submits, analyzes, plans, approves, delivers both tasks and accepts', async () => {
    const submitted = runtime.submit({ text: '增加两个文档改动', by: 'owner', source: 'test' })
    expect(submitted.ok).toBe(true)
    const reqId = (submitted.data as { reqId: string }).reqId

    const analyzed = await runQueued('analyze', reqId)
    expect(analyzed.state).toBe('done')
    expect(runtime.repo.latestAnalysis(reqId)?.goal).toContain('两个小改动')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('draft')

    const planned = await runQueued('plan', reqId)
    expect(planned.state).toBe('done')
    const plan = runtime.repo.latestTaskPlan(reqId)!
    expect(plan.planVersion).toBe(1)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('plan_proposed')

    const approval = runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' })
    expect(approval.ok, approval.message).toBe(true)
    expect(runtime.repo.planApproval(reqId, 1)?.approvedBy).toBe('owner')

    const advanced = await runQueued('advance', reqId)
    expect(advanced.state, advanced.detail).toBe('done')
    const artifacts = runtime.repo.taskArtifacts(reqId, 1)
    expect(artifacts.map((artifact) => artifact.taskId)).toEqual(['a', 'b'])
    for (const artifact of artifacts) {
      expect(artifact.candidateSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(artifact.testEvidenceSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(artifact.reviewSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(artifact.authorizationSource).toContain('plan-approval:')
    }
    const evidence = runtime.repo.evidence(reqId, 1, 'a')!
    expect(existsSync(evidence.candidatePath)).toBe(true)
    const dependentDiff = readFileSync(runtime.repo.evidence(reqId, 1, 'b')!.candidatePath, 'utf8')
    expect(dependentDiff).toContain('docs/b.md')
    expect(dependentDiff).not.toContain('docs/a.md')
    expect(existsSync(evidence.testLogPath)).toBe(true)
    expect(existsSync(evidence.reviewPath)).toBe(true)
    expect(readFileSync(evidence.testLogPath, 'utf8')).toContain('exit_code: 0')

    const accepted = runtime.accept({ reqId, by: 'owner', source: 'dsh-command' })
    expect(accepted.ok, accepted.message).toBe(true)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('accepted')
    expect(runtime.repo.acceptance(reqId).acceptance_fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('passes current requirements and tasks to the requirement Agent as facts', async () => {
    const prompts: string[] = []
    const planPrompts: string[] = []
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({
        onAnalyze: (request) => prompts.push(request.prompt),
        onPlan: (request) => planPrompts.push(request.prompt),
      }),
    )
    const first = runtime.submit({ text: '第一个需求：增加过滤', by: 'owner', source: 'test' })
    const firstId = (first.data as { reqId: string }).reqId
    await runQueued('analyze', firstId)
    await runQueued('plan', firstId)
    const second = runtime.submit({ text: '第二个需求：调整过滤文案', by: 'owner', source: 'test' })
    const secondId = (second.data as { reqId: string }).reqId
    await runQueued('analyze', secondId)

    const prompt = prompts[prompts.length - 1]!
    expect(prompt).toContain('当前项目需求与任务')
    expect(prompt).toContain(`- ${secondId}（当前需求）｜状态 draft`)
    expect(prompt).toContain(`- ${firstId}｜状态 plan_proposed`)
    expect(prompt).toContain('任务包 v1（未批准）')
    expect(prompt).toContain('任务（列出 2/2）')
    expect(prompt).toContain('｜pending｜')

    const planPrompt = planPrompts[0]!
    expect(planPrompt).toContain('你是 ForgeLoop 的研发 Agent')
    expect(planPrompt).toContain('业务场景：')
    expect(planPrompt).toContain('任务按依赖完成')
    expect(planPrompt).toContain('两个任务交付且测试通过')
  })

  it('delivers a verification-only task without a candidate diff', async () => {
    const submitted = runtime.submit({ text: '实现并验证', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)

    runtime.close()
    const baseRunner = fakeRunner()
    const verificationRunner: AgentLike = {
      async run(request) {
        if (request.role === 'plan') return result(request, VERIFICATION_PLAN)
        return baseRunner.run(request)
      },
    }
    runtime = makeRuntime(verificationRunner, async (request) => {
      writeFileSync(request.logPath, `${VERIFY_OUTPUT}\nexit_code: 0\n`)
      return {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        logPath: request.logPath,
        logSha256: sha256OfText(readFileSync(request.logPath, 'utf8')),
        durationMs: 1,
        output: VERIFY_OUTPUT,
      }
    })
    await runQueued('plan', reqId)
    runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' })
    const advanced = await runQueued('advance', reqId)
    expect(advanced.state, advanced.detail).toBe('done')
    const artifacts = runtime.repo.taskArtifacts(reqId, 1)
    expect(artifacts.map((artifact) => artifact.taskId)).toEqual(['a', 'verify'])
    const verifyArtifact = artifacts.find((artifact) => artifact.taskId === 'verify')!
    expect(verifyArtifact.candidateSha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    const evidence = runtime.repo.evidence(reqId, 1, 'verify')!
    expect(readFileSync(evidence.candidatePath, 'utf8')).toBe('')
    expect(readFileSync(evidence.reviewPath, 'utf8')).toContain('verification')
    expect(evidence.devSession).toBe('')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('executing')
    const accepted = runtime.accept({ reqId, by: 'owner', source: 'dsh-command' })
    expect(accepted.ok, accepted.message).toBe(true)
  })

  it('exposes task heartbeat and execution activity', async () => {
    const submitted = runtime.submit({ text: '任务详情', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    await runQueued('plan', reqId)
    runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' })
    await runQueued('advance', reqId)

    const detail = runtime.taskDetail(reqId, 'a', 1)
    expect(detail.ok).toBe(true)
    const value = detail.data as {
      task: { taskId: string }
      run: { state: string; updatedAt: string } | null
      activity: unknown[]
    }
    expect(value.task.taskId).toBe('a')
    expect(value.run?.state).toBe('delivered')
    expect(value.run?.updatedAt).toBeTruthy()
    expect(Array.isArray(value.activity)).toBe(true)

    // 任务详情读取真实 Agent 轨迹摘要，而不是只返回任务元数据。
    const activityPath = join(
      runtime.config.recordsRoot,
      'projects',
      'testproj',
      'evidence',
      reqId,
      'v1',
      'a',
      'dev.jsonl',
    )
    writeFileSync(
      activityPath,
      `${JSON.stringify({ type: 'tool/call', time: 1, data: { name: 'bash', arguments: 'npm test' } })}\n` +
        `${JSON.stringify({ type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: '完成实现' }] } } })}\n`,
    )
    const withActivity = runtime.taskDetail(reqId, 'a', 1)
    const activity = (withActivity.data as { activity: Array<{ summary: string }> }).activity
    expect(activity[0]?.summary).toContain('bash')
    expect(activity[1]?.summary).toContain('完成实现')

    expect(runtime.taskDetail('missing', 'a').code).toBe('not_found')
    expect(runtime.taskDetail(reqId, 'missing').code).toBe('task_missing')
    expect(runtime.taskDetail(reqId, 'a', 99).code).toBe('plan_missing')

    runtime.repo.recordTaskRun({
      requirementId: reqId,
      planVersion: 1,
      taskId: 'b',
      state: 'running',
      reason: '启动开发 Agent',
      executedSeconds: 0,
      updatedAt: '2026-10-29T00:00:00.000Z',
    })
    runtime.repo.heartbeatTaskRun({
      requirementId: reqId,
      planVersion: 1,
      taskId: 'b',
      reason: '正在调用工具 bash',
      updatedAt: '2026-10-29T00:00:02.000Z',
    })
    const run = runtime.repo.taskRuns(reqId, 1).find((candidate) => candidate.taskId === 'b')!
    expect(run.state).toBe('running')
    expect(run.reason).toContain('bash')
    expect(run.updatedAt).toBe('2026-10-29T00:00:02.000Z')
  })

  it('rejects advance before approval and after the requirement is revised', async () => {
    const submitted = runtime.submit({ text: '第一版', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    await runQueued('plan', reqId)

    const beforeApproval = runtime.requestOperation({ reqId, action: 'advance', by: 'owner', source: 'test' })
    expect(beforeApproval.ok).toBe(false)
    expect(beforeApproval.code).toBe('plan_not_approved')

    runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' })
    runtime.revise({ reqId, text: '第二版', by: 'owner', source: 'test' })
    const afterRevise = runtime.requestOperation({ reqId, action: 'advance', by: 'owner', source: 'test' })
    expect(afterRevise.ok).toBe(false)
    expect(afterRevise.code).toBe('stale_requirement')

    const staleApproval = runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' })
    expect(staleApproval.ok).toBe(false)
    expect(staleApproval.code).toBe('stale_requirement')
  })

  it('records a failed formal test as a failure round and stops at the quota', async () => {
    const submitted = runtime.submit({ text: '测试失败', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    await runQueued('plan', reqId)
    runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' })

    runtime.close()
    runtime = makeRuntime(fakeRunner(), async (request) => {
      writeFileSync(request.logPath, 'forced failure\nexit_code: 1\n')
      return {
        exitCode: 1,
        timedOut: false,
        aborted: false,
        logPath: request.logPath,
        logSha256: sha256OfText(readFileSync(request.logPath, 'utf8')),
        durationMs: 1,
        output: 'forced failure',
      }
    })
    const outcome = await runQueued('advance', reqId)
    expect(outcome.state).toBe('done')
    expect(runtime.repo.failureRounds(reqId).length).toBe(2)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
    expect(runtime.repo.taskArtifacts(reqId, 1)).toHaveLength(0)
  })
})

describe('durable coordinator behaviour', () => {
  it('marks claimed requests unknown on restart instead of replaying them', async () => {
    const submitted = runtime.submit({ text: '重启核对', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    const queued = runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 'test' })
    const requestId = (queued.data as { requestId: string }).requestId
    runtime.repo.claimNextRequest('previous-host', new Date().toISOString())

    const coordinator = new Coordinator({ runtime, pollSeconds: 60, autoAdvance: false })
    coordinator.start()
    const recovered = runtime.repo.request(requestId)
    expect(recovered?.state).toBe('unknown')
    expect(recovered?.detail).toContain('无法确认外部副作用')
    await coordinator.stop()
  })

  it('does not claim the same request twice under repeated kicks', async () => {
    const submitted = runtime.submit({ text: '去重', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 'test' })
    const first = runtime.repo.claimNextRequest('host-a', new Date().toISOString())
    expect(first).not.toBeNull()
    expect(runtime.repo.claimNextRequest('host-b', new Date().toISOString())).toBeNull()
  })

  it('marks an in-flight request unknown when the host stops instead of claiming success', async () => {
    let seen = ''
    const hanging: AgentLike = {
      run(request) {
        seen = request.role
        return new Promise((resolve) => {
          request.signal?.addEventListener(
            'abort',
            () => resolve(result(request, '', 'aborted')),
            { once: true },
          )
        })
      },
    }
    runtime.close()
    runtime = makeRuntime(hanging)
    const submitted = runtime.submit({ text: '停止在途', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    const queued = runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 'test' })
    const requestId = (queued.data as { requestId: string }).requestId
    const coordinator = new Coordinator({ runtime, pollSeconds: 60, autoAdvance: false })
    coordinator.start()
    const running = coordinator.kick()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(seen).toBe('analyze')
    await coordinator.stop()
    await running
    const request = runtime.repo.request(requestId)!
    expect(request.state).toBe('unknown')
    expect(runtime.repo.action(`act-${requestId}`)?.state).toBe('unknown')
  })

  it('refuses a second concurrent consumer and leaves pending work untouched', async () => {
    const submitted = runtime.submit({ text: '锁', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 'test' })
    const first = new Coordinator({ runtime, pollSeconds: 60, autoAdvance: false })
    first.start()
    expect(first.snapshot().lock.acquired).toBe(true)

    const secondRuntime = makeRuntime()
    const second = new Coordinator({ runtime: secondRuntime, pollSeconds: 60, autoAdvance: false })
    second.start()
    expect(second.snapshot().lock.acquired).toBe(false)
    expect(second.snapshot().running).toBe(false)
    // 第二个宿主不得把第一个宿主的 pending 标为 unknown 或领取它。
    expect(secondRuntime.repo.pendingRequests()).toHaveLength(1)
    expect(secondRuntime.repo.request((runtime.repo.pendingRequests()[0]!).requestId)?.state).toBe(
      'pending',
    )

    await first.stop()
    const third = new Coordinator({ runtime: secondRuntime, pollSeconds: 60, autoAdvance: false })
    third.start()
    expect(third.snapshot().lock.acquired).toBe(true)
    await third.stop()
    secondRuntime.close()
  })

  it('clears a stale lock left by a dead process', () => {
    const submitted = runtime.submit({ text: '残留锁', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 'test' })
    const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const lockDir = join(dir, '.forgeloop/projects/testproj/host.lock')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ owner: 'dead', pid: 999999, acquiredAt: 'x' }))
    const coordinator = new Coordinator({ runtime, pollSeconds: 60, autoAdvance: false })
    coordinator.start()
    expect(coordinator.snapshot().lock.acquired).toBe(true)
    void coordinator.stop()
  })

  it('dismisses pending work when a stop is issued and records the reason', () => {
    const submitted = runtime.submit({ text: '停止', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 'test' })
    const stopped = runtime.stop({ reqId, by: 'owner', reason: '不再需要' })
    expect(stopped.ok).toBe(true)
    const requirement = runtime.repo.getRequirement(reqId)!
    expect(requirement.status).toBe('blocked')
    expect(requirement.blockedReason).toContain('不再需要')
    expect(runtime.repo.pendingRequests()).toHaveLength(0)
  })
})

describe('task retry', () => {
  const RETRY_PLAN = {
    taskPlanId: 'plan-retry-1',
    requirementId: '',
    project: 'testproj',
    planVersion: 1,
    requirementVersion: 1,
    createdAt: '2026-10-29T00:00:00.000Z',
    tasks: [
      {
        taskId: 'a',
        goal: '先改文档',
        files: ['docs/a.md'],
        acceptance: 'a 完成',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 3 },
        authorizationSource: '',
      },
      {
        taskId: 'b',
        goal: '再补测试',
        files: ['docs/b.md'],
        acceptance: 'b 完成',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: ['a'],
        limits: { limitSeconds: 60, maxFailureRounds: 3 },
        authorizationSource: '',
      },
    ],
  }

  function seedRequirement(reqId: string): void {
    runtime.repo.submit({
      reqId,
      project: 'testproj',
      text: `重试 ${reqId}`,
      submittedBy: 'owner',
      source: 'test',
      now: '2026-10-29T00:00:00.000Z',
    })
    runtime.repo.recordAnalysis({
      reqId,
      analysisVersion: 1,
      requirementVersion: 1,
      goal: '实现两个小改动',
      scenarios: ['任务按依赖完成'],
      acceptanceCriteria: ['两个任务交付且测试通过'],
      clarifications: [],
      createdAt: '2026-10-29T00:00:00.500Z',
    })
  }

  function recordPlan(reqId: string): void {
    runtime.repo.recordTaskPlan({ ...RETRY_PLAN, requirementId: reqId })
  }

  function recordApproval(reqId: string): void {
    runtime.repo.recordPlanApproval({
      requirementId: reqId,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-29T00:00:01.000Z',
      source: 'test',
    })
    runtime.repo.setStatus(reqId, 'approved')
  }

  function seedPlanAndApproval(reqId: string): void {
    recordPlan(reqId)
    recordApproval(reqId)
  }

  function seedApprovedPlan(reqId: string): void {
    seedRequirement(reqId)
    seedPlanAndApproval(reqId)
  }

  function seedFailedRun(reqId: string, taskId: string, reason = '正式测试失败（退出码 1）'): void {
    runtime.repo.recordTaskRun({
      requirementId: reqId,
      planVersion: 1,
      taskId,
      state: 'failed',
      reason,
      executedSeconds: 1,
      updatedAt: '2026-10-29T00:00:02.000Z',
    })
  }

  it('requeues a failed advance, preserves failure rounds and feeds the previous failure into the next attempt', async () => {
    const submitted = runtime.submit({ text: '重试任务', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    await runQueued('plan', reqId)
    runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' })
    runtime.close()

    let failing = true
    const prompts: string[] = []
    const runner = fakeRunner({
      onDev: (request) => {
        prompts.push(request.prompt)
        const allowed = /计划中列出的预期文件（仅供参考，不是禁止修改其他文件）：(.+)/.exec(request.prompt)?.[1]?.split('、')[0] ?? 'docs/out.md'
        mkdirSync(join(request.cwd, allowed, '..'), { recursive: true })
        writeFileSync(join(request.cwd, allowed), `content ${Date.now()}\n`)
      },
    })
    runtime = makeRuntime(runner, async (request) => {
      if (failing) {
        writeFileSync(
          request.logPath,
          ' ❯ tests/architecture-contract.test.ts (1 test | 1 failed)\n' +
            '   → [contracts] FAIL 活动源码未登记在契约 modules：packages/forgeloop/src/domain/retry.ts\n',
        )
        return {
          exitCode: 1,
          timedOut: false,
          aborted: false,
          logPath: request.logPath,
          logSha256: sha256OfText(readFileSync(request.logPath, 'utf8')),
          durationMs: 1,
          output: 'contract failure',
        }
      }
      writeFileSync(request.logPath, `${VERIFY_OUTPUT}\nexit_code: 0\n`)
      return {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        logPath: request.logPath,
        logSha256: sha256OfText(readFileSync(request.logPath, 'utf8')),
        durationMs: 1,
        output: VERIFY_OUTPUT,
      }
    })

    const failed = await runQueued('advance', reqId)
    expect(failed.state).toBe('done')
    expect(runtime.repo.failureRounds(reqId)).toHaveLength(2)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
    expect(runtime.repo.taskArtifacts(reqId, 1)).toHaveLength(0)
    expect(prompts).toHaveLength(2)

    const failedDetail = runtime.taskDetail(reqId, 'a', 1)
    const failedValue = failedDetail.data as {
      run: { state: string; reason: string }
      failureRounds: unknown[]
      advice: { cause: string; actions: string[] }
      retry: { allowed: boolean }
    }
    expect(failedValue.run.state).toBe('failed')
    expect(failedValue.run.reason).toContain('正式测试失败')
    expect(failedValue.failureRounds).toHaveLength(2)
    expect(failedValue.advice.actions.join('\n')).toContain('contracts/architecture.json')
    expect(failedValue.retry.allowed).toBe(true)

    failing = false
    const retry = runtime.retryTask({ reqId, planVersion: 1, taskId: 'a', by: 'owner', source: 'test-retry' })
    expect(retry.ok, retry.message).toBe(true)
    const pending = runtime.repo.requestsFor(reqId).find((request) => request.state === 'pending')
    if (!pending) console.log('DEBUG first=', first, 'requests=', runtime.repo.requestsFor(reqId), 'runs=', runtime.repo.taskRuns(reqId, 1))
    expect(pending?.action).toBe('advance')
    expect(pending?.source).toContain('retry:a')

    const claimed = runtime.repo.claimNextRequest('tester', new Date().toISOString())!
    const outcome = await runtime.executeRequest(claimed, new AbortController().signal)
    runtime.repo.resolveRequest(claimed.requestId, outcome.state, outcome.detail, new Date().toISOString())
    expect(outcome.state).toBe('done')
    expect(runtime.repo.taskArtifacts(reqId, 1).map((artifact) => artifact.taskId)).toEqual(['a', 'b'])
    // 重试不清零既有失败轮次与证据。
    expect(runtime.repo.failureRounds(reqId)).toHaveLength(2)
    // 新一次实现拿到上一次失败原因与正式测试日志尾部，而不是从零开始。
    expect(prompts[2]).toContain('上一次任务运行')
    expect(prompts[2]).toContain('正式测试失败（退出码 1）')
    expect(prompts[2]).toContain('上一次正式测试日志尾部')
    expect(prompts[2]).toContain('retry.ts')

    const requirementDetail = runtime.requirementDetail(reqId)
    expect(requirementDetail.ok, requirementDetail.message).toBe(true)
    const requirementValue = requirementDetail.data as {
      latestPlan: { tasks: unknown[]; technicalSolution?: unknown }
      artifacts: unknown[]
      progress: { total: number; delivered: number }
      acceptanceRecord: Record<string, string>
    }
    expect(requirementValue.latestPlan.tasks).toHaveLength(2)
    expect(requirementValue.artifacts).toHaveLength(2)
    expect(requirementValue.progress).toMatchObject({ total: 2, delivered: 2 })
    expect(requirementValue.acceptanceRecord.accepted_by).toBe('')
    const withRounds = requirementDetail.data as { failureRoundDetails: Array<{ taskId?: string }> }
    expect(withRounds.failureRoundDetails[0]?.taskId).toBe('a')

    // 任务详情的调试证据：活动/日志截断、审查结论与证据身份都要如实返回。
    const taskDir = join(runtime.config.recordsRoot, 'projects', 'testproj', 'evidence', reqId, 'v1', 'a')
    writeFileSync(
      join(taskDir, 'dev.jsonl'),
      Array.from({ length: 130 }, (_, index) =>
        JSON.stringify({ type: 'step/start', time: 1_700_000_000_000 + index, data: { step: index } }),
      ).join('\n') + '\n',
    )
    writeFileSync(join(taskDir, 'formal-test.log'), 'x'.repeat(5_000))
    writeFileSync(
      join(taskDir, 'review.json'),
      `${JSON.stringify({ verdict: 'pass', blocking: [], findings: ['实现了队列'], summary: '通过' })}\n`,
    )
    const evidenceDetail = runtime.taskDetail(reqId, 'a', 1)
    const evidenceValue = evidenceDetail.data as {
      activity: unknown[]
      activityTotal: number
      activityTruncated: boolean
      testLogBytes: number
      testLogTail: string
      testLogTruncated: boolean
      review: { verdict: string; findings: string[] }
      artifact: { candidateSha256: string } | null
      waitingForInput: boolean
      resultUnknown: boolean
    }
    expect(evidenceValue.activity).toHaveLength(120)
    expect(evidenceValue.activityTotal).toBe(130)
    expect(evidenceValue.activityTruncated).toBe(true)
    expect(evidenceValue.testLogBytes).toBe(5_000)
    expect(evidenceValue.testLogTail).toHaveLength(4_000)
    expect(evidenceValue.testLogTruncated).toBe(true)
    expect(evidenceValue.review).toMatchObject({ verdict: 'pass', findings: ['实现了队列'] })
    expect(evidenceValue.artifact?.candidateSha256).toBeTruthy()
    expect(evidenceValue.waitingForInput).toBe(false)
    expect(evidenceValue.resultUnknown).toBe(false)
  })

  it('requires explicit recovery before retrying over an unknown request', () => {
    const reqId = 'req-retry-unknown'
    seedApprovedPlan(reqId)
    seedFailedRun(reqId, 'a')
    runtime.repo.recordFailureRound(reqId, {
      roundId: 'a-a1',
      stage: 'formal_test',
      summary: '正式测试退出码 1',
      occurredAt: '2026-10-29T00:00:03.000Z',
    })
    runtime.repo.recordRequest({
      requestId: 'rq-old',
      reqId,
      project: 'testproj',
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-29T00:00:04.000Z',
    })
    runtime.repo.resolveRequest('rq-old', 'unknown', '宿主停止', '2026-10-29T00:00:05.000Z')
    runtime.repo.setStatus(reqId, 'blocked', '停止请求')

    const first = runtime.retryTask({ reqId, planVersion: 1, taskId: 'a', by: 'owner', source: 'test-retry' })
    expect(first.ok).toBe(false)
    expect(first.code).toBe('recovery_required')
    // 第一次调用只提示核对，不关闭 unknown，也不排队新的推进。
    expect(runtime.repo.request('rq-old')?.state).toBe('unknown')
    expect(runtime.repo.pendingRequests()).toHaveLength(0)

    const confirmed = runtime.retryTask({
      reqId,
      planVersion: 1,
      taskId: 'a',
      by: 'owner',
      source: 'test-retry',
      confirmRecovery: true,
    })
    expect(confirmed.ok, confirmed.message).toBe(true)
    expect(runtime.repo.request('rq-old')?.state).toBe('dismissed')
    expect(runtime.repo.pendingRequests()).toHaveLength(1)
  })

  it('counts retry failures as new rounds instead of colliding with the previous request', async () => {
    const reqId = 'req-retry-counting'
    seedApprovedPlan(reqId)
    seedFailedRun(reqId, 'a')
    runtime.repo.recordFailureRound(reqId, {
      roundId: 'a-a1',
      stage: 'formal_test',
      summary: '上一请求的第一轮失败',
      occurredAt: '2026-10-29T00:00:03.000Z',
    })
    runtime.repo.setStatus(reqId, 'blocked', '等待重试')
    runtime.close()

    runtime = makeRuntime(fakeRunner(), async (request) => {
      writeFileSync(request.logPath, 'forced failure\nexit_code: 1\n')
      return {
        exitCode: 1,
        timedOut: false,
        aborted: false,
        logPath: request.logPath,
        logSha256: sha256OfText(readFileSync(request.logPath, 'utf8')),
        durationMs: 1,
        output: 'forced failure',
      }
    })
    const outcome = await runQueued('advance', reqId)
    expect(outcome.state).toBe('done')
    // 1 条旧请求的失败 + 新请求的 2 次尝试；attempt 序号相同也不能被当成重复轮次。
    expect(runtime.repo.failureRounds(reqId)).toHaveLength(3)
    expect(runtime.repo.failureRounds(reqId).filter((round) => round.roundId === 'a-a1')).toHaveLength(1)
  })

  it('refuses retries that would bypass approval, budget, terminals, delivered tasks or task order', () => {
    const reqId = 'req-retry-guards'
    runtime.repo.submit({
      reqId,
      project: 'testproj',
      text: '重试边界',
      submittedBy: 'owner',
      source: 'test',
      now: '2026-10-29T00:00:00.000Z',
    })
    runtime.repo.recordTaskPlan({ ...RETRY_PLAN, requirementId: reqId })
    seedFailedRun(reqId, 'a')

    const unapproved = runtime.retryTask({ reqId, planVersion: 1, taskId: 'a', by: 'owner', source: 'test-retry' })
    expect(unapproved.code).toBe('plan_not_approved')

    recordApproval(reqId)
    runtime.repo.setStatus(reqId, 'accepted')
    const terminal = runtime.retryTask({ reqId, planVersion: 1, taskId: 'a', by: 'owner', source: 'test-retry' })
    expect(terminal.code).toBe('terminal')

    const exhaustedId = 'req-retry-exhausted'
    seedApprovedPlan(exhaustedId)
    seedFailedRun(exhaustedId, 'a')
    for (let index = 0; index < 3; index += 1) {
      runtime.repo.recordFailureRound(exhaustedId, {
        roundId: `a-a${index + 1}`,
        stage: 'formal_test',
        summary: `第 ${index + 1} 轮失败`,
        occurredAt: `2026-10-29T00:0${index}:00.000Z`,
      })
    }
    const exhausted = runtime.retryTask({
      reqId: exhaustedId,
      planVersion: 1,
      taskId: 'a',
      by: 'owner',
      source: 'test-retry',
    })
    expect(exhausted.code).toBe('grant_required')
    // 普通“推进”也不能绕过同一额度。
    const advanceAfterExhaustion = runtime.requestOperation({
      reqId: exhaustedId,
      action: 'advance',
      by: 'owner',
      source: 'test-advance',
    })
    expect(advanceAfterExhaustion.code).toBe('grant_required')

    const deliveredId = 'req-retry-delivered'
    seedApprovedPlan(deliveredId)
    runtime.repo.recordTaskArtifact({
      requirementId: deliveredId,
      planVersion: 1,
      taskId: 'a',
      candidateSha256: 'candidate',
      testEvidenceSha256: 'test',
      reviewSha256: 'review',
      acceptance: '完成',
      authorizationSource: 'plan-approval:test',
      recordedAt: '2026-10-29T00:00:06.000Z',
      baselineCommit: 'abc123',
    })
    seedFailedRun(deliveredId, 'a')
    const delivered = runtime.retryTask({
      reqId: deliveredId,
      planVersion: 1,
      taskId: 'a',
      by: 'owner',
      source: 'test-retry',
    })
    expect(delivered.code).toBe('already_delivered')

    const orderId = 'req-retry-order'
    seedApprovedPlan(orderId)
    seedFailedRun(orderId, 'a')
    seedFailedRun(orderId, 'b')
    const outOfOrder = runtime.retryTask({
      reqId: orderId,
      planVersion: 1,
      taskId: 'b',
      by: 'owner',
      source: 'test-retry',
    })
    expect(outOfOrder.code).toBe('predecessor_pending')

    const pendingId = 'req-retry-pending'
    seedApprovedPlan(pendingId)
    runtime.repo.recordTaskRun({
      requirementId: pendingId,
      planVersion: 1,
      taskId: 'a',
      state: 'running',
      reason: '启动开发 Agent',
      executedSeconds: 0,
      updatedAt: '2026-10-29T00:00:07.000Z',
    })
    const notFailed = runtime.retryTask({
      reqId: pendingId,
      planVersion: 1,
      taskId: 'a',
      by: 'owner',
      source: 'test-retry',
    })
    expect(notFailed.code).toBe('not_failed')

    const missingTask = runtime.retryTask({
      reqId: pendingId,
      planVersion: 1,
      taskId: 'z',
      by: 'owner',
      source: 'test-retry',
    })
    expect(missingTask.code).toBe('task_missing')

    expect(
      runtime.retryTask({ reqId: 'req-retry-nope', planVersion: 1, taskId: 'a', by: 'owner', source: 'test-retry' })
        .code,
    ).toBe('not_found')

    const noRunId = 'req-retry-no-run'
    seedApprovedPlan(noRunId)
    expect(
      runtime.retryTask({ reqId: noRunId, planVersion: 1, taskId: 'a', by: 'owner', source: 'test-retry' }).code,
    ).toBe('not_failed')

    const stalePlanId = 'req-retry-stale-plan'
    seedApprovedPlan(stalePlanId)
    seedFailedRun(stalePlanId, 'a')
    expect(
      runtime.retryTask({ reqId: stalePlanId, planVersion: 2, taskId: 'a', by: 'owner', source: 'test-retry' }).code,
    ).toBe('stale_plan')

    const staleRequirementId = 'req-retry-stale-requirement'
    seedApprovedPlan(staleRequirementId)
    seedFailedRun(staleRequirementId, 'a')
    runtime.revise({ reqId: staleRequirementId, text: '需求已修订', by: 'owner', source: 'test' })
    expect(
      runtime.retryTask({
        reqId: staleRequirementId,
        planVersion: 1,
        taskId: 'a',
        by: 'owner',
        source: 'test-retry',
      }).code,
    ).toBe('stale_requirement')

    const busyId = 'req-retry-busy'
    seedApprovedPlan(busyId)
    seedFailedRun(busyId, 'a')
    runtime.repo.recordRequest({
      requestId: 'rq-active',
      reqId: busyId,
      project: 'testproj',
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-29T00:00:08.000Z',
    })
    expect(
      runtime.retryTask({ reqId: busyId, planVersion: 1, taskId: 'a', by: 'owner', source: 'test-retry' }).code,
    ).toBe('busy')
  })
})


describe('execution scope, plan freeze and repair loop', () => {
  async function prepared(reqText: string): Promise<string> {
    const submitted = runtime.submit({ text: reqText, by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    expect((await runQueued('analyze', reqId)).state).toBe('done')
    expect((await runQueued('plan', reqId)).state).toBe('done')
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' }).ok).toBe(true)
    return reqId
  }

  it('lets the execution role modify any file in the workspace, not only the planned list', async () => {
    const base = fakeRunner()
    const runner: AgentLike = {
      async run(request) {
        if (request.role === 'dev') {
          mkdirSync(join(request.cwd, 'docs'), { recursive: true })
          writeFileSync(join(request.cwd, 'docs/shared.md'), `shared ${Date.now()}\n`)
        }
        return base.run(request)
      },
    }
    runtime.close()
    runtime = makeRuntime(runner)
    const reqId = await prepared('允许改共享文件')
    const advance = await runQueued('advance', reqId)
    expect(advance.state, advance.detail).toBe('done')
    const evidence = runtime.repo.evidence(reqId, 1, 'a')!
    expect(readFileSync(evidence.candidatePath, 'utf8')).toContain('docs/shared.md')
  })

  it('refuses a plan request queued before approval once the package is frozen', async () => {
    const submitted = runtime.submit({ text: '排队后冻结', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    await runQueued('plan', reqId)
    const queued = runtime.requestOperation({ reqId, action: 'plan', by: 'owner', source: 'test:preapproval' })
    expect(queued.ok).toBe(true)
    const requestId = (queued.data as { requestId: string }).requestId
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' }).ok).toBe(true)

    const claimed = runtime.repo.claimNextRequest('tester', new Date().toISOString())!
    expect(claimed.requestId).toBe(requestId)
    const outcome = await runtime.executeRequest(claimed, new AbortController().signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('已批准并冻结')
    expect(runtime.repo.taskPlans(reqId)).toHaveLength(1)
  })

  it('runs the execution role with workspace-write permission', async () => {
    const permissions: string[] = []
    const base = fakeRunner()
    const runner: AgentLike = {
      async run(request) {
        if (request.role === 'dev') permissions.push(request.permission)
        return base.run(request)
      },
    }
    runtime.close()
    runtime = makeRuntime(runner)
    const reqId = await prepared('执行权限')
    expect((await runQueued('advance', reqId)).state).toBe('done')
    expect(permissions.length).toBeGreaterThan(0)
    expect(permissions.every((permission) => permission === 'workspace-write')).toBe(true)
  })

  it('freezes the approved task package unless the owner explicitly permits a change', async () => {
    const reqId = await prepared('任务包冻结')
    expect(
      runtime.requestOperation({ reqId, action: 'plan', by: 'owner', source: 'test' }),
    ).toMatchObject({ ok: false, code: 'plan_frozen' })
    expect(runtime.repo.taskPlans(reqId)).toHaveLength(1)

    const permitted = runtime.requestOperation({
      reqId,
      action: 'plan',
      by: 'owner',
      source: 'test:permitted',
      confirmPlanChange: true,
      reason: '任务包遗漏关键文件',
    })
    expect(permitted.ok, permitted.message).toBe(true)
  })

  it('returns a blocked verification to the execution role without changing the plan version', async () => {
    let verifyCalls = 0
    const base = fakeRunner()
    const runner: AgentLike = {
      async run(request) {
        if (request.role === 'verify') {
          verifyCalls += 1
          const verification = join(request.cwd, 'verification')
          mkdirSync(verification, { recursive: true })
          writeFileSync(
            join(verification, 'commands.json'),
            JSON.stringify({
              commands: [
                {
                  label: 'smoke',
                  argv: ['node', '-e', verifyCalls === 1 ? 'process.exit(1)' : "console.log('smoke ok: verified')"],
                },
              ],
            }),
          )
          writeFileSync(join(verification, 'report.json'), VERIFICATION_REPORT)
          return result(request, VERIFICATION_REPORT)
        }
        return base.run(request)
      },
    }
    runtime.close()
    runtime = makeRuntime(runner)
    const reqId = await prepared('验证失败自动回研发')

    // 第一轮验证失败后，同一请求内把问题交回执行角色修复，再重新验证。
    const advance = await runQueued('advance', reqId)
    expect(advance.state, advance.detail).toBe('done')
    expect(verifyCalls).toBe(2)
    expect(runtime.repo.taskPlans(reqId)).toHaveLength(1)
    expect(runtime.repo.failureRounds(reqId)).toHaveLength(1)
    expect(runtime.repo.verification(reqId, 1)?.verdict).toBe('pass')
    for (const taskId of ['a', 'b']) {
      expect(runtime.repo.archivedArtifacts(reqId, 1, taskId)).toHaveLength(1)
    }
    expect(runtime.repo.taskRuns(reqId, 1).every((run) => run.state === 'delivered')).toBe(true)
  })
})
