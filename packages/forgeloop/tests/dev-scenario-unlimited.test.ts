import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig, type RawConfig } from '../src/config.js'
import {
  AgentRunner,
  type AgentOpenRequest,
  type AgentRunRequest,
  type AgentRunResult,
} from '../src/runtime/agent-runner.js'
import { COMMITTED } from '../src/domain/status.js'

/**
 * 研发场景下的真实执行链路：产品、验证与业务回合用脚本化房间，
 * 研发回合走真实 `AgentRunner`（真实定时器、真实工作区、真实正式测试进程）。
 *
 * 覆盖两件事：
 * 1. 默认 `-1`（MAX）：慢回合不被回合定时器打断，超过 3 次尝试仍继续，慢的正式测试不被杀掉；
 * 2. 把限额写成正数后，研发回合仍会按上限取消。
 */

const SCENARIO = '需求功能可用'
const CRITERION = '命令输出证明功能可用'
const RULE = '金额必须包含税费'
const EDGE = '输入为空时给出明确错误'
const SMOKE = 'verified ok'
/** 正式测试故意慢于 0.6 秒：限额为 -1 时不应被杀掉。 */
const SLOW_TEST = ['node', '-e', 'setTimeout(() => process.exit(0), 600)']

const ANALYSIS = JSON.stringify({
  goal: '实现一个可验证的小功能',
  scenarios: [SCENARIO],
  business_rules: [RULE],
  exceptions: [EDGE],
  acceptance_criteria: [CRITERION],
  clarifications: [],
})

const PLAN = JSON.stringify({
  technical_solution: { summary: '最小实现', approach: ['写文档', '跑测试'], risks: [] },
  tasks: [
    {
      task_id: 'a',
      goal: '实现功能 A',
      files: ['docs/a.md'],
      acceptance: CRITERION,
      test_command: SLOW_TEST,
    },
    {
      task_id: 'b',
      goal: '实现功能 B',
      files: ['docs/b.md'],
      depends_on: ['a'],
      acceptance: CRITERION,
      test_command: SLOW_TEST,
    },
  ],
})

const VERIFICATION_PLAN = JSON.stringify({
  scenarios: [
    {
      scenario: SCENARIO,
      acceptance_criterion: CRITERION,
      method: `运行冒烟命令并核对输出；业务规则：${RULE}；异常与边界：${EDGE}`,
      required: true,
      checks: [
        {
          label: 'smoke',
          argv: ['node', '-e', `console.log('${SMOKE}')`],
          expected_output: SMOKE,
        },
      ],
    },
  ],
})

const BUSINESS_REVIEW = JSON.stringify({
  verdict: 'pass',
  summary: '业务场景通过',
  findings: [],
  blocking: [],
  scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: SMOKE, commands: ['smoke'] }],
  acceptance: [{ criterion: CRITERION, status: 'pass', evidence: SMOKE, commands: ['smoke'] }],
  business_rules: [{ rule: RULE, status: 'pass', evidence: SMOKE, commands: ['smoke'] }],
  exceptions: [{ exception: EDGE, status: 'pass', evidence: SMOKE, commands: ['smoke'] }],
})

function event(type: string, data: unknown) {
  return { type, seq: 0, time: 0, data }
}

interface DevTurn {
  readonly prompt: string
  readonly kind: 'plan' | 'task' | 'summary'
  readonly taskId: string
  readonly elapsedMs: number
  readonly outcome: 'completed' | 'cancelled'
}

/** 脚本化宿主：研发回合按固定延迟产出事件与文件改动，取消时立即收口。 */
function devHost(options: { planDelayMs: number; turnDelayMs: number; noChangeAttempts: number }) {
  const turns: DevTurn[] = []
  let taskAttempts = 0
  const ctx = {
    agents: {
      create: async (createOptions: Record<string, unknown>) => {
        const cwd = String((createOptions.meta as { cwd?: string } | undefined)?.cwd ?? '')
        const events: Array<Record<string, unknown>> = []
        let settle: (() => void) | undefined
        let finished = true
        let timer: NodeJS.Timeout | undefined
        let startedAt = 0
        let current: DevTurn | undefined

        const finish = (outcome: 'completed' | 'cancelled'): void => {
          if (!current) return
          finished = true
          turns.push({ ...current, elapsedMs: Date.now() - startedAt, outcome })
          current = undefined
          settle?.()
        }

        const agent = {
          session: { ownEvents: () => events },
          followup: (message: { content?: readonly { type?: string; text?: string }[] }) => {
            const prompt = (message.content ?? []).map((part) => part.text ?? '').join('')
            const plan = prompt.includes('技术方案与研发任务拆解')
            const summary = prompt.includes('本次研发会话即将结束')
            const taskId = /当前任务：(.+)/.exec(prompt)?.[1]?.trim() ?? 'a'
            // 尝试次数在回合开始时计，超时取消也算一次尝试。
            const attempt = plan || summary ? 0 : (taskAttempts += 1)
            current = {
              prompt,
              kind: plan ? 'plan' : summary ? 'summary' : 'task',
              taskId,
              elapsedMs: 0,
              outcome: 'completed',
            }
            startedAt = Date.now()
            finished = false
            timer = setTimeout(
              () => {
                if (finished) return
                if (plan) {
                  events.push(
                    event('assistant/message', {
                      message: { content: [{ type: 'text', text: PLAN }] },
                    }),
                  )
                } else if (!summary) {
                  const changed = attempt > options.noChangeAttempts
                  if (changed) {
                    mkdirSync(join(cwd, 'docs'), { recursive: true })
                    writeFileSync(join(cwd, `docs/${taskId}.md`), `content ${attempt}\n`)
                  }
                  events.push(
                    event('assistant/message', {
                      message: { content: [{ type: 'text', text: changed ? 'done' : '没有改动' }] },
                    }),
                  )
                } else {
                  events.push(
                    event('assistant/message', {
                      message: { content: [{ type: 'text', text: '本次会话完成 A 与 B。' }] },
                    }),
                  )
                }
                events.push(event('turn/end', { reason: { kind: 'completed' } }))
                finish('completed')
              },
              plan ? options.planDelayMs : options.turnDelayMs,
            )
            timer.unref?.()
          },
          whenIdle: () => {
            if (finished) return Promise.resolve()
            return new Promise<void>((resolve) => {
              settle = resolve
            })
          },
          cancel: () => {
            if (timer) clearTimeout(timer)
            if (finished) return
            events.push(event('turn/end', { reason: { kind: 'aborted' } }))
            finish('cancelled')
          },
        }
        return { agent, dispose: async () => undefined }
      },
    },
    agentPresets: { mount: async () => undefined },
    tools: { schemas: () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  }
  return { ctx, turns, attempts: () => taskAttempts }
}

/** 非研发身份：产品分析、验证方案、工具执行与业务验收都用确定性脚本回答。 */
function otherRoles(runtimeOf: () => ForgeLoopRuntime): AgentLike {
  const reply = (
    request: { role: string; transcriptPath?: string },
    text: string,
    toolCalls: readonly string[] = [],
  ): AgentRunResult => ({
    status: 'completed',
    text,
    sessionId: `session-${request.role}`,
    reason: '',
    transcriptPath: request.transcriptPath ?? '',
    durationMs: 1,
    toolCalls: [...toolCalls],
  })
  const answer = async (turn: { prompt: string; transcriptPath: string }, role: string) => {
    if (turn.prompt.includes('现在只依据需求说明')) return reply({ role }, VERIFICATION_PLAN)
    if (turn.prompt.includes('你必须使用工具')) {
      const reqId = /需求身份：(\S+)/.exec(turn.prompt)?.[1] ?? ''
      const labels = [...turn.prompt.matchAll(/- label: (.+)/g)].map((match) => match[1]!.trim())
      for (const label of labels) {
        const outcome = await runtimeOf().runVerificationCheck(reqId, label)
        if (!outcome.ok) throw new Error(outcome.text)
      }
      return reply({ role }, JSON.stringify({ executed: labels, summary: 'executed' }), [
        'forgeloop_run_verification_check',
      ])
    }
    if (turn.prompt.includes('业务验收')) return reply({ role }, BUSINESS_REVIEW)
    return reply({ role }, '')
  }
  return {
    async run(request: AgentRunRequest) {
      if (request.role === 'product') return reply(request, ANALYSIS)
      if (request.role === 'orchestrator') {
        return reply(request, JSON.stringify({ session_id: null, reason: 'test route' }))
      }
      return answer(
        { prompt: request.prompt, transcriptPath: request.transcriptPath },
        request.role,
      )
    },
    async open(request: AgentOpenRequest) {
      return {
        sessionId: `session-${request.role}`,
        async send(turn) {
          return answer(turn, request.role)
        },
        async close() {
          // 脚本化会话没有需要收口的宿主资源。
        },
      }
    },
  }
}

let project = ''
let runtime: ForgeLoopRuntime | undefined

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-dev-scenario-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  writeFileSync(join(dir, '.gitignore'), '.forgeloop/\n')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'base'])
  return dir
}

function makeRuntime(
  host: ReturnType<typeof devHost>,
  overrides: RawConfig = {},
): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: project,
      recordsRoot: join(project, '.forgeloop'),
      owner: 'owner',
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake' },
      autonomy: {
        enabled: true,
        allowCodeCommit: true,
        commitCheckCommand: ['node', '-e', 'process.exit(0)'],
      },
      ...overrides,
    },
    project,
  )
  const real = new AgentRunner({ ctx: host.ctx as never, agent: config.agent })
  const holder: { current?: ForgeLoopRuntime } = {}
  const fake = otherRoles(() => holder.current!)
  const runner: AgentLike = {
    run: (request) => (request.role === 'dev' ? real.run(request) : fake.run(request)),
    open: (request) => (request.role === 'dev' ? real.open(request) : fake.open!(request)),
    resume: (request) =>
      request.role === 'dev' ? real.resume(request) : Promise.reject(new Error('unsupported')),
  }
  holder.current = new ForgeLoopRuntime({ ctx: {}, config, runner })
  return holder.current
}

async function runNext(reqId: string, action: string) {
  const claimed = runtime!.repo.claimNextRequest('test-owner', new Date().toISOString())
  expect(claimed, `没有可领取的请求：${action}`).not.toBeNull()
  expect(claimed!.reqId).toBe(reqId)
  expect(claimed!.action).toBe(action)
  const outcome = await runtime!.executeRequest(claimed!, new AbortController().signal)
  runtime!.repo.resolveRequest(
    claimed!.requestId,
    outcome.state,
    outcome.detail,
    new Date().toISOString(),
  )
  return outcome
}

async function submitAndAnalyze(): Promise<string> {
  const submitted = runtime!.submit({
    text: '实现一个可验证的小功能',
    by: 'owner',
    source: 'dsh-session:sess-1:msg-1',
  })
  expect(submitted.ok, submitted.message).toBe(true)
  const reqId = (submitted.data as { reqId: string }).reqId
  expect((await runNext(reqId, 'analyze')).state).toBe('done')
  // 系统准入后由自动推进队列排一次 advance（与协调器同一条路径）。
  expect(runtime!.autoAdvanceRequests()).toContain(reqId)
  return reqId
}

beforeEach(() => {
  project = makeProject()
  runtime = undefined
})

afterEach(() => {
  runtime?.close()
  runtime = undefined
  rmSync(project, { recursive: true, force: true })
})

describe('development scenario under MAX limits', () => {
  it(
    'runs slow development turns, extra attempts and a slow formal test without stopping',
    { timeout: 60_000 },
    async () => {
      const host = devHost({ planDelayMs: 200, turnDelayMs: 300, noChangeAttempts: 3 })
      runtime = makeRuntime(host)
      const reqId = await submitAndAnalyze()

      const advance = await runNext(reqId, 'advance')
      expect(advance.state, advance.detail).toBe('done')
      expect(runtime.repo.getRequirement(reqId)?.status).toBe(COMMITTED)

      // 默认 maxTaskAttempts = -1：任务 a 前 3 次没有改动也继续到第 4 次交付。
      const taskTurns = host.turns.filter((turn) => turn.kind === 'task')
      expect(taskTurns.filter((turn) => turn.taskId === 'a')).toHaveLength(4)
      expect(taskTurns.filter((turn) => turn.taskId === 'b')).toHaveLength(1)
      const taskRuns = runtime.repo.taskRuns(reqId, 1)
      expect(taskRuns.map((run) => [run.taskId, run.state])).toEqual([
        ['a', 'delivered'],
        ['b', 'delivered'],
      ])

      // 默认 agent.timeoutSeconds = -1：回合跑满自己的时长，没有被定时器取消。
      expect(host.turns.filter((turn) => turn.kind === 'plan')).toHaveLength(1)
      expect(host.turns.every((turn) => turn.outcome === 'completed')).toBe(true)
      expect(Math.min(...host.turns.map((turn) => turn.elapsedMs))).toBeGreaterThanOrEqual(150)

      // 默认 formalTestTimeoutSeconds = -1：每次 0.6 秒的正式测试跑完才判通过。
      expect(taskRuns.every((run) => run.state !== 'running')).toBe(true)

      // 看板把不限显示为 MAX。
      expect(runtime.statusBoard().requirements[0]?.remainingRounds).toBeNull()
      expect(runtime.repo.failureRounds(reqId)).toHaveLength(0)
    },
  )

  it(
    'cancels the development turn once a positive timeout is configured',
    { timeout: 60_000 },
    async () => {
      const host = devHost({ planDelayMs: 50, turnDelayMs: 2_000, noChangeAttempts: 0 })
      runtime = makeRuntime(host, {
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 1 },
        maxTaskAttempts: 1,
      })
      const reqId = await submitAndAnalyze()

      const advance = await runNext(reqId, 'advance')
      expect(advance.state).not.toBe('done')
      expect(runtime.repo.getRequirement(reqId)?.status).not.toBe(COMMITTED)
      const runs = runtime.repo.taskRuns(reqId, 1)
      expect(runs.some((run) => run.state === 'blocked')).toBe(true)
      expect(runs.some((run) => run.reason.includes('超时') && run.reason.includes('上限'))).toBe(
        true,
      )
      expect(runs.every((run) => run.state !== 'delivered')).toBe(true)
      expect(host.turns.some((turn) => turn.outcome === 'cancelled')).toBe(true)
      expect(host.attempts()).toBe(1)
    },
  )
})
