import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { Coordinator } from '../src/runtime/coordinator.js'
import { resolveConfig } from '../src/config.js'
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

function fakeRunner(overrides: { onDev?: (request: AgentRunRequest, content: string) => void } = {}): AgentLike {
  return {
    async run(request) {
      if (request.role === 'analyze') return result(request, ANALYSIS)
      if (request.role === 'plan') return result(request, PLAN)
      if (request.role === 'review') {
        return result(request, JSON.stringify({ verdict: 'pass', blocking: [], findings: [], summary: 'ok' }))
      }
      const allowed = /允许修改的文件（只能改这些）：(.+)/.exec(request.prompt)?.[1]?.split('、')[0] ?? 'docs/out.md'
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

  it('blocks delivery when the implementer edits outside the approved file list', async () => {
    const submitted = runtime.submit({ text: '越界改动', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    await runQueued('plan', reqId)
    runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' })

    runtime.close()
    runtime = makeRuntime(
      fakeRunner({
        onDev: (request) => {
          mkdirSync(join(request.cwd, 'docs'), { recursive: true })
          writeFileSync(join(request.cwd, 'docs/outside.md'), 'not allowed\n')
        },
      }),
    )
    const outcome = await runQueued('advance', reqId)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('越出批准文件清单')
    expect(runtime.repo.taskArtifacts(reqId, 1)).toHaveLength(0)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
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
        logSha256: 'a'.repeat(64),
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