import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { Coordinator } from '../src/runtime/coordinator.js'
import { resolveConfig } from '../src/config.js'
import type { AgentOpenRequest, AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { COMMITTED, SPECIFIED } from '../src/domain/status.js'

const SCENARIO = '需求功能可用'
const CRITERION = '命令输出证明功能可用'
const SMOKE = 'verified ok'

let project = ''
let runtime: ForgeLoopRuntime

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-auto-intake-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, '.gitignore'), '.forgeloop/\n')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  return dir
}

function result(request: { role: string; transcriptPath?: string }, text: string): AgentRunResult {
  return {
    status: 'completed',
    text,
    sessionId: `session-fake-${request.role}`,
    reason: '',
    transcriptPath: request.transcriptPath ?? '',
    durationMs: 1,
    toolCalls: [],
  }
}

const ANALYSIS = JSON.stringify({
  goal: '实现一个可验证的小功能',
  scenarios: [SCENARIO],
  acceptance_criteria: [CRITERION],
  clarifications: [],
})

const PLAN = JSON.stringify({
  tasks: [
    {
      task_id: 'a',
      goal: '实现功能 A',
      files: ['docs/a.md'],
      acceptance: CRITERION,
      test_command: ['node', '-e', 'process.exit(0)'],
    },
    {
      task_id: 'b',
      goal: '实现功能 B',
      files: ['docs/b.md'],
      depends_on: ['a'],
      acceptance: CRITERION,
      test_command: ['node', '-e', 'process.exit(0)'],
    },
  ],
})

const VERIFICATION_REPORT = JSON.stringify({
  verdict: 'pass',
  summary: '候选满足需求',
  findings: [],
  blocking: [],
  scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: SMOKE, commands: ['smoke'] }],
})

const BUSINESS_REVIEW = JSON.stringify({
  verdict: 'pass',
  summary: '业务场景通过',
  findings: [],
  blocking: [],
  scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: SMOKE, commands: ['smoke'] }],
  acceptance: [{ criterion: CRITERION, status: 'pass', evidence: SMOKE, commands: ['smoke'] }],
})

/** 只走成功路径的确定性执行器：分析、规划、实现、独立验证与业务验收。 */
function fakeRunner(): AgentLike {
  const session = (request: AgentOpenRequest) => ({
    sessionId: `session-fl-${request.role}-test`,
    async send(turn: { prompt: string; transcriptPath: string }): Promise<AgentRunResult> {
      if (request.role === 'dev' && turn.prompt.includes('技术方案与研发任务拆解')) {
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, PLAN)
      }
      if (request.role === 'dev' && turn.prompt.includes('当前任务：')) {
        const taskId = /当前任务：(.+)/.exec(turn.prompt)?.[1]?.trim() ?? 'a'
        mkdirSync(join(request.cwd, 'docs'), { recursive: true })
        writeFileSync(join(request.cwd, `docs/${taskId}.md`), `content ${Date.now()}\n`)
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, 'done')
      }
      if (request.role === 'verify' && turn.prompt.includes('独立验证 Agent')) {
        mkdirSync(join(request.cwd, 'verification'), { recursive: true })
        writeFileSync(
          join(request.cwd, 'verification/commands.json'),
          JSON.stringify({ commands: [{ label: 'smoke', argv: ['node', '-e', `console.log('${SMOKE}')`] }] }),
        )
        writeFileSync(join(request.cwd, 'verification/report.json'), VERIFICATION_REPORT)
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, VERIFICATION_REPORT)
      }
      if (request.role === 'verify' && turn.prompt.includes('业务验收')) {
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, BUSINESS_REVIEW)
      }
      throw new Error(`unexpected role ${request.role}`)
    },
    async close() {},
  })
  return {
    async run(request: AgentRunRequest) {
      if (request.role === 'product') return result(request, ANALYSIS)
      if (request.role === 'dev' && request.prompt.includes('技术方案与研发任务拆解')) {
        return result(request, PLAN)
      }
      throw new Error(`unexpected single-turn role ${request.role}`)
    },
    async open(request: AgentOpenRequest) {
      return session(request)
    },
  }
}

function makeRuntime(runner: AgentLike = fakeRunner(), options: { autoAdvance?: boolean } = {}): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: project,
      recordsRoot: join(project, '.forgeloop'),
      owner: 'owner',
      pollSeconds: 1,
      autoAdvance: options.autoAdvance ?? true,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
      autonomy: {
        enabled: true,
        allowCodeCommit: true,
        commitCheckCommand: ['node', '-e', 'process.exit(0)'],
      },
    },
    project,
  )
  return new ForgeLoopRuntime({ ctx: {}, config, runner })
}

let sourceSeq = 0

/** 可信人类会话来源：进入需求队列并允许系统准入。 */
function submit(text: string): string {
  sourceSeq += 1
  const submitted = runtime.submit({
    text,
    by: 'owner',
    source: `dsh-session:sess-${sourceSeq}:msg-${sourceSeq}`,
  })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

async function runNext(reqId: string, action: 'analyze' | 'advance') {
  const claimed = runtime.repo.claimNextRequest('test-owner', new Date().toISOString())
  expect(claimed).not.toBeNull()
  expect(claimed!.reqId).toBe(reqId)
  expect(claimed!.action).toBe(action)
  const outcome = await runtime.executeRequest(claimed!, new AbortController().signal)
  runtime.repo.resolveRequest(claimed!.requestId, outcome.state, outcome.detail, new Date().toISOString())
  return outcome
}

beforeEach(() => {
  sourceSeq = 0
  project = makeProject()
  runtime = makeRuntime()
})

afterEach(() => {
  runtime.close()
  rmSync(project, { recursive: true, force: true })
})

describe('requirement queue intake', () => {
  it('starts an idle queued requirement without any human approval', async () => {
    const reqId = submit('实现一个可验证的小功能')

    // 入队即被领取，且只排了一条分析请求；没有规划、批准或验证的人工请求。
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(reqId)
    expect(runtime.requirementQueue.pending()).toEqual([])
    expect(runtime.repo.pendingRequests('demo').map((request) => request.action)).toEqual(['analyze'])

    const analysis = await runNext(reqId, 'analyze')
    expect(analysis.state, analysis.detail).toBe('done')
    // 自动准入，不需要任务包批准；分析后停在可自动推进的 specified。
    expect(runtime.repo.latestAdmission(reqId)?.decision).toBe('admit')
    expect(runtime.repo.planApproval(reqId, 1)).toBeNull()
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(SPECIFIED)
    expect(runtime.autoAdvanceRequests()).toContain(reqId)

    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(COMMITTED)
    expect(runtime.repo.latestCommit(reqId)).not.toBeNull()
    expect(runtime.repo.planApproval(reqId, 1)).toBeNull()
    expect(
      runtime.repo
        .requestsFor(reqId)
        .every((request) => request.action === 'analyze' || request.action === 'advance'),
    ).toBe(true)

    // 需求离开研发链路后，队列占用被收口，不会阻塞后续需求。
    expect(runtime.intakeQueuedRequirement()).toBeNull()
    expect(runtime.requirementQueue.inFlight()).toBeNull()
  })

  it('queues new requirements while development is busy and starts them in submission order', async () => {
    const first = submit('第一个需求')
    const second = submit('第二个需求')
    const third = submit('第三个需求')

    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(first)
    expect(runtime.requirementQueue.pending().map((entry) => entry.requirementId)).toEqual([second, third])
    // 研发忙时只保留队首的分析请求，后两个不并发启动。
    expect(runtime.repo.pendingRequests('demo').map((request) => request.reqId)).toEqual([first])
    expect(runtime.repo.pendingRequests('demo').some((request) => request.reqId === second)).toBe(false)

    const analyzedFirst = await runNext(first, 'analyze')
    expect(analyzedFirst.state, analyzedFirst.detail).toBe('done')
    expect(runtime.autoAdvanceRequests()).toEqual([first])
    // 队首仍在研发位，即使当前没有在途请求也不提前领取第二个需求。
    expect(runtime.intakeQueuedRequirement()).toBeNull()
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(first)
    expect(runtime.requirementQueue.pending().map((entry) => entry.requirementId)).toEqual([second, third])

    const advancedFirst = await runNext(first, 'advance')
    expect(advancedFirst.state, advancedFirst.detail).toBe('done')
    expect(runtime.repo.getRequirement(first)?.status).toBe(COMMITTED)

    expect(runtime.intakeQueuedRequirement()).toBe(second)
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(second)
    expect(runtime.requirementQueue.pending().map((entry) => entry.requirementId)).toEqual([third])
    expect(runtime.repo.pendingRequests('demo').map((request) => request.reqId)).toEqual([second])

    await runNext(second, 'analyze')
    expect(runtime.autoAdvanceRequests()).toEqual([second])
    expect(runtime.intakeQueuedRequirement()).toBeNull()
    await runNext(second, 'advance')
    expect(runtime.repo.getRequirement(second)?.status).toBe(COMMITTED)

    expect(runtime.intakeQueuedRequirement()).toBe(third)
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(third)
    expect(runtime.requirementQueue.pending()).toEqual([])
    expect(runtime.repo.pendingRequests('demo').map((request) => request.reqId)).toEqual([third])

    // 三个需求都只经过分析与推进，没有任何人工批准节点。
    for (const reqId of [first, second, third]) {
      expect(runtime.repo.planApproval(reqId, 1)).toBeNull()
      expect(runtime.repo.requestsFor(reqId).every((request) => request.action !== 'plan')).toBe(true)
    }
  })

  it('skips a cancelled queued requirement instead of blocking the queue', () => {
    const first = submit('会取消的需求')
    const second = submit('后续需求')
    expect(runtime.intakeQueuedRequirement()).toBeNull()

    expect(runtime.cancel({ reqId: first, by: 'owner', reason: '不再需要' }).ok).toBe(true)
    // 取消后该需求已成为终态，下一次空闲领取跳过它并启动第二个需求。
    expect(runtime.intakeQueuedRequirement()).toBe(second)
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(second)
    expect(runtime.repo.pendingRequests('demo').map((request) => request.reqId)).toEqual([second])
  })

  it('does not start a new requirement while the first is still in progress', () => {
    const first = submit('正在研发的需求')
    const second = submit('等待中的需求')
    // 队首尚未完成分析时，第二个需求只能排队。
    expect(runtime.repo.pendingRequests('demo').map((request) => request.reqId)).toEqual([first])
    expect(runtime.requirementQueue.pending().map((entry) => entry.requirementId)).toEqual([second])
  })

  it('starts the next queued requirement on a coordinator tick after the busy one finishes', async () => {
    const first = submit('先完成的需求')
    const second = submit('随后自动启动的需求')

    await runNext(first, 'analyze')
    runtime.autoAdvanceRequests()
    await runNext(first, 'advance')
    expect(runtime.repo.getRequirement(first)?.status).toBe(COMMITTED)
    // 完成后的下一拍由协调器收口队首占用并领取第二个需求。
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(first)

    const coordinator = new Coordinator({ runtime, pollSeconds: 60, autoAdvance: true })
    coordinator.start()
    try {
      await coordinator.kick()
    } finally {
      await coordinator.stop()
    }

    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(second)
    expect(runtime.repo.getRequirement(second)?.status).toBe(SPECIFIED)
    expect(runtime.repo.latestAdmission(second)?.decision).toBe('admit')
    expect(runtime.repo.planApproval(second, 1)).toBeNull()
  })
})
