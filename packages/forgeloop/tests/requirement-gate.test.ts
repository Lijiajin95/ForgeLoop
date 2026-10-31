import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import type { AgentOpenRequest, AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { COMMITTED } from '../src/domain/status.js'

/**
 * 需求级门禁：把需求队列、自动准入、验证判定与问题单回流放在同一条真实运行链路里，
 * 确认四个任务交付后仍能串行推进、超额度重试并可追溯。
 */

const SCENARIO = '需求功能可用'
const CRITERION = '命令输出证明功能可用'
const SMOKE = 'verified ok'

let project = ''
let runtime: ForgeLoopRuntime

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-requirement-gate-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, '.gitignore'), '.forgeloop/\n')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  return dir
}

function result(request: { role: string; transcriptPath: string }, text: string): AgentRunResult {
  mkdirSync(dirname(request.transcriptPath), { recursive: true })
  writeFileSync(request.transcriptPath, '{}\n', 'utf8')
  return {
    status: 'completed',
    text,
    sessionId: `session-gate-${request.role}`,
    reason: '',
    transcriptPath: request.transcriptPath,
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

const BUSINESS_REVIEW = JSON.stringify({
  verdict: 'pass',
  summary: '业务场景通过',
  findings: [],
  blocking: [],
  scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: SMOKE, commands: ['smoke'] }],
  acceptance: [{ criterion: CRITERION, status: 'pass', evidence: SMOKE, commands: ['smoke'] }],
})

/** 前 N 次独立验证判阻断，之后通过；研发修复回合写真实改动。 */
function gateRunner(options: { failVerifications: number }): AgentLike {
  let verificationRuns = 0
  const session = (request: AgentOpenRequest) => ({
    sessionId: `session-gate-${request.role}`,
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
      if (request.role === 'dev' && turn.prompt.includes('发现缺陷')) {
        writeFileSync(join(request.cwd, 'docs/a.md'), `fixed ${verificationRuns} ${Date.now()}\n`)
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, 'fixed')
      }
      if (request.role === 'verify' && turn.prompt.includes('独立验证 Agent')) {
        verificationRuns += 1
        const fail = verificationRuns <= options.failVerifications
        mkdirSync(join(request.cwd, 'verification'), { recursive: true })
        writeFileSync(
          join(request.cwd, 'verification/commands.json'),
          JSON.stringify({
            commands: [
              {
                label: 'smoke',
                argv: [
                  'node',
                  '-e',
                  fail ? "console.log('broken');process.exit(1)" : `console.log('${SMOKE}')`,
                ],
              },
            ],
          }),
        )
        const report = JSON.stringify({
          verdict: fail ? 'block' : 'pass',
          summary: fail ? '候选未满足需求' : '候选满足需求',
          findings: [],
          blocking: fail ? ['功能未实现', '验证命令退出码 1'] : [],
          scenarios: [
            {
              scenario: SCENARIO,
              status: fail ? 'fail' : 'pass',
              evidence: fail ? 'broken' : SMOKE,
              commands: ['smoke'],
            },
          ],
        })
        writeFileSync(join(request.cwd, 'verification/report.json'), report)
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, report)
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

function makeRuntime(runner: AgentLike): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: project,
      recordsRoot: join(project, '.forgeloop'),
      owner: 'owner',
      pollSeconds: 1,
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

async function runNext(reqId: string, action: 'analyze' | 'advance') {
  const claimed = runtime.repo.claimNextRequest('gate-owner', new Date().toISOString())
  expect(claimed).not.toBeNull()
  expect(claimed!.reqId).toBe(reqId)
  expect(claimed!.action).toBe(action)
  const outcome = await runtime.executeRequest(claimed!, new AbortController().signal)
  runtime.repo.resolveRequest(claimed!.requestId, outcome.state, outcome.detail, new Date().toISOString())
  return outcome
}

function submit(text: string, session: string): string {
  const submitted = runtime.submit({
    text,
    by: 'owner',
    source: `dsh-session:${session}:msg-1`,
  })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

beforeEach(() => {
  project = makeProject()
  runtime = makeRuntime(gateRunner({ failVerifications: 4 }))
})

afterEach(() => {
  runtime.close()
  rmSync(project, { recursive: true, force: true })
})

describe('requirement pipeline gate', () => {
  it('runs queue, auto admission, verification issue retry and completion without human approval', async () => {
    const first = submit('实现第一个可验证功能', 'gate-first')
    const second = submit('实现第二个可验证功能', 'gate-second')

    // 需求队列：第一个领取，第二个等待；不接受人工批准或并发启动。
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(first)
    expect(runtime.requirementQueue.pending().map((entry) => entry.requirementId)).toEqual([second])
    expect(runtime.repo.pendingRequests('demo').map((request) => request.reqId)).toEqual([first])

    // 自动分析 + 系统准入，不产生 plan/approve 请求。
    expect((await runNext(first, 'analyze')).state).toBe('done')
    expect(runtime.repo.latestAdmission(first)?.decision).toBe('admit')
    expect(runtime.repo.planApproval(first, 1)).toBeNull()
    expect(runtime.autoAdvanceRequests()).toEqual([first])

    // 第一轮推进：连续 3 次验证阻断，建单并停在 blocked；额度已用尽但问题单让它继续排队。
    const firstAttempt = await runNext(first, 'advance')
    expect(firstAttempt.state).toBe('failed')
    expect(runtime.repo.failureRounds(first)).toHaveLength(3)
    expect(runtime.issues.issuesFor(first).map((issue) => issue.attempt)).toEqual([1, 2, 3])
    expect(runtime.issues.latestOpen(first)?.attempt).toBe(3)
    expect(runtime.repo.getRequirement(first)?.status).toBe('blocked')
    expect(runtime.autoAdvanceRequests()).toContain(first)
    // 第一个需求未收口时，第二个需求仍保持排队且没有分析请求。
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(first)
    expect(runtime.requirementQueue.pending().map((entry) => entry.requirementId)).toEqual([second])
    expect(runtime.repo.pendingRequests('demo').some((request) => request.reqId === second)).toBe(false)

    // 第二轮推进：先按问题单修复，再验证失败一次，继续修复后通过并提交。
    const secondAttempt = await runNext(first, 'advance')
    expect(secondAttempt.state, secondAttempt.detail).toBe('done')
    expect(runtime.repo.getRequirement(first)?.status).toBe(COMMITTED)
    expect(runtime.repo.latestCommit(first)).not.toBeNull()
    expect(runtime.issues.issuesFor(first).map((issue) => issue.attempt)).toEqual([1, 2, 3, 4])
    expect(runtime.issues.issuesFor(first).every((issue) => issue.status === 'resolved')).toBe(true)
    expect(runtime.repo.grantCount(first)).toBe(1)
    expect(runtime.repo.failureRounds(first)).toHaveLength(4)
    expect(runtime.repo.verificationsFor(first).filter((item) => item.verdict === 'block')).toHaveLength(4)
    expect(runtime.repo.verificationsFor(first).filter((item) => item.verdict === 'pass')).toHaveLength(1)

    // 第一个需求完成后释放研发位，第二个需求自动领取并完成分析、验证与提交。
    expect(runtime.intakeQueuedRequirement()).toBe(second)
    expect(runtime.requirementQueue.pending()).toEqual([])
    expect((await runNext(second, 'analyze')).state).toBe('done')
    expect(runtime.repo.latestAdmission(second)?.decision).toBe('admit')
    expect(runtime.autoAdvanceRequests()).toEqual([second])
    const secondRequirement = await runNext(second, 'advance')
    expect(secondRequirement.state, secondRequirement.detail).toBe('done')
    expect(runtime.repo.getRequirement(second)?.status).toBe(COMMITTED)
    expect(runtime.repo.latestCommit(second)).not.toBeNull()
    expect(runtime.issues.issuesFor(second)).toEqual([])

    // 反查与收口：问题单、验证历史、提交都绑定各自需求；队列没有遗留。
    const verifications = runtime.repo.verificationsFor(second)
    expect(verifications).toHaveLength(1)
    expect(verifications[0]?.verdict).toBe('pass')
    expect(runtime.repo.verificationsFor(first)).toHaveLength(5)
    for (const issue of runtime.issues.issuesFor(first)) {
      expect(issue.requirementId).toBe(first)
      expect(issue.evidence.environment.verificationReportPath).not.toBe('')
      expect(issue.evidence.commands.length).toBeGreaterThan(0)
    }
    expect(runtime.intakeQueuedRequirement()).toBeNull()
    expect(runtime.requirementQueue.inFlight()).toBeNull()

    // 整条链路没有任何人工批准请求；每个需求只经过分析和推进。
    for (const reqId of [first, second]) {
      expect(runtime.repo.planApproval(reqId, 1)).toBeNull()
      expect(
        runtime.repo.requestsFor(reqId).every((request) => request.action === 'analyze' || request.action === 'advance'),
      ).toBe(true)
    }
  })
})
