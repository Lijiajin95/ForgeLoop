import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { evidenceDir, resolveConfig } from '../src/config.js'
import type {
  AgentOpenRequest,
  AgentResumeRequest,
  AgentRunRequest,
  AgentRunResult,
} from '../src/runtime/agent-runner.js'
import { COMMITTED } from '../src/domain/status.js'

const SCENARIO = '需求功能可用'
const CRITERION = '命令输出证明功能可用'
const RULE = '金额必须包含税费'
const EDGE = '输入为空时给出明确错误'
const SMOKE = 'verified ok'

let project = ''
let runtime: ForgeLoopRuntime
let runner: ReturnType<typeof fakeRunner>

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-continuous-'))
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
  business_rules: [RULE],
  exceptions: [EDGE],
  acceptance_criteria: [CRITERION],
  clarifications: [],
})

/** 自验门禁用：只有第二次研发回合写入 docs/ready 才通过，用来证明自验失败在同一会话修。 */
const GATED_TEST_COMMAND = [
  'node',
  '-e',
  "process.exit(require('fs').existsSync('docs/ready') ? 0 : 1)",
]

function planText(gated = false): string {
  const first = gated ? GATED_TEST_COMMAND : ['node', '-e', 'process.exit(0)']
  return JSON.stringify({
    tasks: [
      {
        task_id: 'a',
        goal: '实现功能 A',
        files: ['docs/a.md'],
        acceptance: CRITERION,
        test_command: first,
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
}

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

/** 需求说明派生的验证方案；同一个验证会话通过工具执行命令。 */
function verificationPlan(fail = false, outside = false): string {
  const repaired =
    "const fs=require('node:fs');const t=fs.existsSync('docs/a.md')?fs.readFileSync('docs/a.md','utf8'):'';if(t.startsWith('fixed')){console.log('verified ok');process.exit(0)}console.log('broken');process.exit(1)"
  const argv = outside
    ? [
        'node',
        '-e',
        "const fs=require('node:fs');fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/outside.md','outside');",
      ]
    : ['node', '-e', fail ? repaired : `console.log('${SMOKE}')`]
  return JSON.stringify({
    scenarios: [
      {
        scenario: SCENARIO,
        acceptance_criterion: CRITERION,
        method: `运行冒烟命令并核对输出；业务规则：${RULE}；异常与边界：${EDGE}`,
        required: true,
        checks: [
          {
            label: 'smoke',
            argv,
            ...(outside ? {} : { expected_output: SMOKE }),
          },
        ],
      },
    ],
  })
}

async function executePlanThroughTool(sessionId: string, prompt: string): Promise<AgentRunResult> {
  const reqId = /需求身份：(\S+)/.exec(prompt)?.[1] ?? ''
  const labels = [...prompt.matchAll(/- label: (.+)/g)].map((match) => match[1]!.trim())
  for (const label of labels) {
    const outcome = await runtime.runVerificationCheck(reqId, label)
    if (!outcome.ok) throw new Error(outcome.text)
  }
  return {
    status: 'completed',
    text: JSON.stringify({ executed: labels, summary: 'executed' }),
    sessionId,
    reason: '',
    transcriptPath: '',
    durationMs: 1,
    toolCalls: ['forgeloop_run_verification_check'],
  }
}

function fakeRunner(
  options: {
    failFirstVerification?: boolean
    verifyMode?: 'malformed' | 'outside' | 'business-malformed'
    repairNoChange?: boolean
    devTimeout?: boolean
    devTimeoutAfterEdit?: boolean
    devAborted?: boolean
    badPlanFirst?: boolean
    languageViolationFirst?: boolean
    verifyError?: boolean
    verifyAborted?: boolean
    skipExecution?: boolean
    businessError?: boolean
    planTimeout?: boolean
    planError?: boolean
    planAborted?: boolean
    repairTimeout?: boolean
    devNoChange?: boolean
    businessIncomplete?: boolean
    businessBlock?: boolean
    orchestratorSessionId?: () => string | null
    resumeFails?: boolean
    selfTestGate?: boolean
  } = {},
): AgentLike {
  let verifications = 0
  let plans = 0
  let devAttempts = 0
  const closed: string[] = []
  const roleTrace: string[] = []
  const devPrompts: string[] = []
  const devWorkspaces: string[] = []
  const session = (request: AgentOpenRequest) => ({
    sessionId: `session-fl-${request.role}-test`,
    async send(turn: { prompt: string; transcriptPath: string }): Promise<AgentRunResult> {
      roleTrace.push(request.role)
      const reply = (
        text: string,
        status: AgentRunResult['status'] = 'completed',
        reason = '',
      ): AgentRunResult => ({
        status,
        text,
        sessionId: `session-fl-${request.role}-test`,
        reason,
        transcriptPath: turn.transcriptPath,
        durationMs: 1,
        toolCalls: [],
      })
      if (request.role === 'verify' && turn.prompt.includes('现在只依据需求说明')) {
        if (options.verifyError) return reply('', 'error', 'model unavailable')
        if (options.verifyAborted) return reply('', 'aborted', 'verify aborted')
        verifications += 1
        return reply(
          options.verifyMode === 'malformed'
            ? 'not json'
            : verificationPlan(
                options.failFirstVerification === true && verifications === 1,
                options.verifyMode === 'outside',
              ),
        )
      }
      if (request.role === 'verify' && turn.prompt.includes('你必须使用工具')) {
        // 模型声称已执行但没调用工具时，运行时不能把自述当证据。
        if (options.skipExecution) return reply(JSON.stringify({ executed: ['smoke'] }))
        return executePlanThroughTool(`session-fl-${request.role}-test`, turn.prompt)
      }
      if (request.role === 'dev' && turn.prompt.includes('技术方案与研发任务拆解')) {
        if (options.planAborted) {
          return {
            status: 'aborted',
            text: '',
            sessionId: 'plan-aborted',
            reason: 'plan aborted',
            transcriptPath: turn.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        if (options.planError) {
          return {
            status: 'error',
            text: '',
            sessionId: 'plan-error',
            reason: 'plan model error',
            transcriptPath: turn.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        if (options.planTimeout) {
          return {
            status: 'timeout',
            text: '',
            sessionId: 'plan-timeout',
            reason: 'plan timeout',
            transcriptPath: turn.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        plans += 1
        if (options.badPlanFirst && plans === 1) {
          return result(
            { role: request.role, transcriptPath: turn.transcriptPath },
            JSON.stringify({ tasks: [{ task_id: 'a' }] }),
          )
        }
        if (options.languageViolationFirst && plans === 1) {
          return result(
            { role: request.role, transcriptPath: turn.transcriptPath },
            JSON.stringify({
              technical_solution: { summary: '方案', approach: ['步骤'], risks: [] },
              tasks: [
                {
                  task_id: 'a',
                  goal: '实现 A',
                  files: ['src/forgeloop/app.py'],
                  acceptance: CRITERION,
                  test_command: ['node', '-e', 'process.exit(0)'],
                },
                {
                  task_id: 'b',
                  goal: '实现 B',
                  files: ['docs/b.md'],
                  acceptance: CRITERION,
                  test_command: ['node', '-e', 'process.exit(0)'],
                  depends_on: ['a'],
                },
              ],
            }),
          )
        }
        return result(
          { role: request.role, transcriptPath: turn.transcriptPath },
          planText(options.selfTestGate === true),
        )
      }
      if (request.role === 'dev' && turn.prompt.includes('当前任务：')) {
        if (options.devAborted) {
          return {
            status: 'aborted',
            text: '',
            sessionId: 'dev-aborted',
            reason: 'aborted',
            transcriptPath: turn.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        if (options.devTimeoutAfterEdit) {
          const taskId = /当前任务：(.+)/.exec(turn.prompt)?.[1]?.trim() ?? 'a'
          mkdirSync(join(request.cwd, 'docs'), { recursive: true })
          writeFileSync(join(request.cwd, `docs/${taskId}.md`), `partial ${Date.now()}\n`)
          return {
            status: 'timeout',
            text: '',
            sessionId: 'dev-timeout-after-edit',
            reason: 'timeout',
            transcriptPath: turn.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        if (options.devTimeout) {
          return {
            status: 'timeout',
            text: '',
            sessionId: 'dev-timeout',
            reason: 'timeout',
            transcriptPath: turn.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        if (options.devNoChange) {
          return result({ role: request.role, transcriptPath: turn.transcriptPath }, 'no change')
        }
        const taskId = /当前任务：(.+)/.exec(turn.prompt)?.[1]?.trim() ?? 'a'
        devAttempts += 1
        devPrompts.push(turn.prompt)
        devWorkspaces.push(request.cwd)
        mkdirSync(join(request.cwd, 'docs'), { recursive: true })
        writeFileSync(join(request.cwd, `docs/${taskId}.md`), `content ${Date.now()}\n`)
        if (options.selfTestGate === true && devAttempts >= 2) {
          writeFileSync(join(request.cwd, 'docs/ready'), 'ready\n')
        }
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, 'done')
      }
      if (request.role === 'dev' && turn.prompt.includes('发现缺陷')) {
        if (options.repairTimeout) {
          return {
            status: 'timeout',
            text: '',
            sessionId: 'repair-timeout',
            reason: 'repair timeout',
            transcriptPath: turn.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        if (options.repairNoChange) {
          return result({ role: request.role, transcriptPath: turn.transcriptPath }, 'no change')
        }
        writeFileSync(join(request.cwd, 'docs/a.md'), `fixed ${Date.now()}\n`)
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, 'fixed')
      }
      if (request.role === 'verify' && turn.prompt.includes('业务验收')) {
        if (options.businessError) return reply('', 'error', 'business model unavailable')
        if (options.businessBlock) {
          return reply(
            JSON.stringify({
              verdict: 'block',
              summary: '业务不通过',
              findings: [],
              blocking: ['业务结果不符合预期'],
              scenarios: [
                { scenario: SCENARIO, status: 'fail', evidence: SMOKE, commands: ['smoke'] },
              ],
              acceptance: [
                { criterion: CRITERION, status: 'fail', evidence: SMOKE, commands: ['smoke'] },
              ],
            }),
          )
        }
        if (options.businessIncomplete) {
          return reply(
            JSON.stringify({
              verdict: 'pass',
              summary: '看起来通过',
              findings: [],
              blocking: [],
              scenarios: [],
              acceptance: [],
            }),
          )
        }
        return reply(options.verifyMode === 'business-malformed' ? 'not json' : BUSINESS_REVIEW)
      }
      return reply('')
    },
    async close() {
      closed.push(request.role)
    },
  })
  return {
    async run(request: AgentRunRequest) {
      if (request.role === 'orchestrator') {
        return result(
          request,
          JSON.stringify({
            session_id: options.orchestratorSessionId?.() ?? null,
            reason: 'test route',
          }),
        )
      }
      if (request.role === 'product') return result(request, ANALYSIS)
      if (request.role === 'dev' && request.prompt.includes('技术方案与研发任务拆解')) {
        if (options.planAborted) {
          return {
            status: 'aborted',
            text: '',
            sessionId: 'plan-aborted',
            reason: 'plan aborted',
            transcriptPath: request.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        if (options.planError) {
          return {
            status: 'error',
            text: '',
            sessionId: 'plan-error',
            reason: 'plan model error',
            transcriptPath: request.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        if (options.planTimeout) {
          return {
            status: 'timeout',
            text: '',
            sessionId: 'plan-timeout',
            reason: 'plan timeout',
            transcriptPath: request.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        plans += 1
        if (options.badPlanFirst && plans === 1) {
          return result(request, JSON.stringify({ tasks: [{ task_id: 'a' }] }))
        }
        if (options.languageViolationFirst && plans === 1) {
          return result(
            request,
            JSON.stringify({
              technical_solution: { summary: '方案', approach: ['步骤'], risks: [] },
              tasks: [
                {
                  task_id: 'a',
                  goal: '实现 A',
                  files: ['src/forgeloop/app.py'],
                  acceptance: CRITERION,
                  test_command: ['node', '-e', 'process.exit(0)'],
                },
                {
                  task_id: 'b',
                  goal: '实现 B',
                  files: ['docs/b.md'],
                  acceptance: CRITERION,
                  test_command: ['node', '-e', 'process.exit(0)'],
                  depends_on: ['a'],
                },
              ],
            }),
          )
        }
        return result(request, planText(options.selfTestGate === true))
      }
      throw new Error(`unexpected single-turn role ${request.role}`)
    },
    async open(request: AgentOpenRequest) {
      return session(request)
    },
    async resume(request: AgentResumeRequest) {
      if (options.resumeFails) throw new Error('session not found on host')
      return session({
        role: request.role,
        cwd: request.cwd ?? '',
        permission: request.permission,
        ...(request.tools ? { tools: request.tools } : {}),
      })
    },
    closedRoles: closed,
    roleTrace,
    devPrompts,
    devWorkspaces,
  }
}

function boundWorkspace(reqId: string, requirementVersion = 1): string {
  const binding = runtime.repo.requirementDevSession(reqId, requirementVersion)
  if (!binding) throw new Error(`需求 ${reqId} 没有研发会话绑定`)
  return binding.workspace
}

function boundSessionId(reqId: string, requirementVersion = 1): string {
  const binding = runtime.repo.requirementDevSession(reqId, requirementVersion)
  if (!binding) throw new Error(`需求 ${reqId} 没有研发会话绑定`)
  return binding.sessionId
}

function makeRuntime(
  runner: AgentLike,
  autonomy: { allowCodeCommit?: boolean; commitCheckCommand?: string[] } = {},
): ForgeLoopRuntime {
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
      failureRoundsPerGrant: 3,
      maxVerificationAttempts: 3,
      autonomy: {
        enabled: true,
        allowCodeCommit: autonomy.allowCodeCommit ?? true,
        commitCheckCommand: autonomy.commitCheckCommand ?? ['node', '-e', 'process.exit(0)'],
      },
    },
    project,
  )
  return new ForgeLoopRuntime({ ctx: {}, config, runner })
}

async function runNext(reqId: string, action: string) {
  const claimed = runtime.repo.claimNextRequest('test-owner', new Date().toISOString())
  expect(claimed).not.toBeNull()
  expect(claimed!.reqId).toBe(reqId)
  expect(claimed!.action).toBe(action)
  const outcome = await runtime.executeRequest(claimed!, new AbortController().signal)
  runtime.repo.resolveRequest(
    claimed!.requestId,
    outcome.state,
    outcome.detail,
    new Date().toISOString(),
  )
  return outcome
}

beforeEach(() => {
  // 故障注入只由用例显式开启，避免宿主进程的外部环境变量污染临时夹具。
  delete process.env.FORGELOOP_FAULT_INJECT
  project = makeProject()
  runner = fakeRunner()
  runtime = makeRuntime(runner)
})

afterEach(() => {
  runtime.close()
  rmSync(project, { recursive: true, force: true })
})

describe('continuous four-Agent flow', () => {
  it('takes one trusted requirement from product analysis to a controlled commit without human approvals', async () => {
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-1:msg-1',
    })
    expect(submitted.ok, submitted.message).toBe(true)
    const reqId = (submitted.data as { reqId: string }).reqId

    const analysis = await runNext(reqId, 'analyze')
    expect(analysis.state).toBe('done')
    expect(runtime.repo.latestAdmission(reqId)?.decision).toBe('admit')
    expect(runtime.repo.planApproval(reqId, 1)).toBeNull()
    expect(runtime.autoAdvanceRequests()).toContain(reqId)

    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(COMMITTED)
    expect(runtime.autoAdvanceRequests()).not.toContain(reqId)
    expect(runtime.repo.taskArtifacts(reqId, 1).map((artifact) => artifact.taskId)).toEqual([
      'a',
      'b',
    ])

    const commit = runtime.repo.latestCommit(reqId)
    expect(commit).not.toBeNull()
    expect(commit?.files).toEqual(['docs/a.md', 'docs/b.md'])
    const committed = git(project, ['show', '--name-only', '--pretty=format:', commit!.commitSha])
      .split('\n')
      .filter(Boolean)
    expect(committed.sort()).toEqual(['docs/a.md', 'docs/b.md'])
    expect(git(project, ['status', '--porcelain'])).toBe('')

    // 研发会话不因需求结束而销毁，只回到空闲并留下与会话 ID 关联的总结；验证会话验完即关。
    expect(runner.closedRoles).not.toContain('dev')
    expect(runner.closedRoles).toContain('verify')
    const sessionId = boundSessionId(reqId)
    expect(runtime.repo.devSession(sessionId)?.state).toBe('idle')
    expect(runtime.repo.latestDevSessionSummary(sessionId)?.reqId).toBe(reqId)
  })

  it('admits an ops-sourced requirement submitted by the ops agent and records its source', async () => {
    const submitted = runtime.submit({
      text: '修复内存接近耗尽的根因',
      by: 'ops-agent',
      source: 'ops:evt-20261103-1',
    })
    expect(submitted.ok, submitted.message).toBe(true)
    const reqId = (submitted.data as { reqId: string }).reqId

    const analysis = await runNext(reqId, 'analyze')
    expect(analysis.state).toBe('done')
    expect(runtime.repo.latestAdmission(reqId)).toMatchObject({
      decision: 'admit',
      basis: { source: 'ops:evt-20261103-1', submittedBy: 'ops-agent' },
    })
    expect(runtime.autoAdvanceRequests()).toContain(reqId)

    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(COMMITTED)
  })

  it('plans, executes and reviews in one verification session without leaking the candidate', async () => {
    const openRequests: AgentOpenRequest[] = []
    const turns: Array<{ prompt: string; sessionId: string }> = []
    const base = fakeRunner()
    const spying: AgentLike = {
      async run(request) {
        return base.run(request)
      },
      async open(request) {
        if (request.role === 'verify') openRequests.push(request)
        const session = await base.open!(request)
        if (request.role !== 'verify') return session
        return {
          sessionId: session.sessionId,
          async send(turn) {
            turns.push({ prompt: turn.prompt, sessionId: session.sessionId })
            // 真实会话把本轮结果归属到自己的会话；测试替身显式对齐。
            const outcome = await session.send(turn)
            return { ...outcome, sessionId: session.sessionId }
          },
          async close() {
            await session.close()
          },
        }
      },
    }
    runtime.close()
    runtime = makeRuntime(spying)
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-split:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId

    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')

    // 方案阶段在同一个验证会话里只读需求说明与已准入任务目标：
    // 不用标准编码 preset，只暴露执行验证方案命令的工具。
    expect(openRequests).toHaveLength(1)
    const openRequest = openRequests[0]!
    expect(openRequest.tools).toBeUndefined()
    expect(openRequest.allowTools).toEqual(['forgeloop_run_verification_check'])
    expect(openRequest.cwd).toBe(project)

    expect(turns).toHaveLength(3)
    const planTurn = turns[0]!
    expect(planTurn.prompt).toContain(SCENARIO)
    expect(planTurn.prompt).toContain(CRITERION)
    expect(planTurn.prompt).toContain(RULE)
    expect(planTurn.prompt).toContain(EDGE)
    expect(planTurn.prompt).toContain('实现功能 A')
    expect(planTurn.prompt).not.toMatch(/diff --git|candidate\.diff|docs\/a\.md/)

    // 执行与业务验收复用方案会话：执行提示词只列方案命令，业务验收只看工具真实输出。
    const executionTurn = turns[1]!
    expect(executionTurn.prompt).toContain('forgeloop_run_verification_check')
    expect(executionTurn.prompt).toContain('label: smoke')
    const reviewTurn = turns[2]!
    expect(reviewTurn.prompt).toContain('业务验收')
    expect(reviewTurn.prompt).toContain(SMOKE)
    expect(reviewTurn.prompt).toContain(RULE)
    expect(reviewTurn.prompt).toContain(EDGE)
    expect(reviewTurn.prompt).not.toContain('diff --git')
    expect(reviewTurn.prompt).not.toContain('content ')
    expect(new Set(turns.map((turn) => turn.sessionId))).toEqual(
      new Set(['session-fl-verify-test']),
    )

    const verification = runtime.repo.verification(reqId, 1)!
    const business = runtime.repo.businessReview(reqId, 1)!
    expect(verification.sessionId).toBe('session-fl-verify-test')
    expect(business.sessionId).toBe(verification.sessionId)
    expect(business.reportJson).toContain(RULE)
    expect(business.reportJson).toContain(EDGE)

    const report = JSON.parse(readFileSync(verification.reportPath, 'utf8')) as {
      verificationPlan: { scenarios: Array<{ checks: Array<{ label: string }> }> }
      commands: Array<{ label: string; exitCode: number | null }>
      environment: { nodeVersion: string }
      candidateIntegrity: { allowedPaths: string[] }
    }
    expect(report.verificationPlan.scenarios[0]?.checks[0]?.label).toBe('smoke')
    expect(report.commands[0]).toMatchObject({ label: 'smoke', exitCode: 0 })
    expect(report.environment.nodeVersion).toBe(process.version)
    expect(report.candidateIntegrity.allowedPaths).toEqual(['verification/'])
  })

  it('keeps delivered work and repairs only the verified defect before a new candidate is committed', async () => {
    const repaired = makeRuntime(fakeRunner({ failFirstVerification: true }))
    runtime.close()
    runtime = repaired
    const submitted = runtime.submit({
      text: '实现一个需要修复的小功能',
      by: 'owner',
      source: 'dsh-session:sess-2:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId

    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(COMMITTED)
    expect(runtime.repo.codeCandidates(reqId, 1)).toHaveLength(2)
    expect(runtime.repo.taskArtifacts(reqId, 1)).toHaveLength(2)
    expect(runtime.repo.failureRounds(reqId)).toHaveLength(1)
    expect(runtime.repo.failureRounds(reqId)[0]?.stage).toBe('verification')
  })

  it('blocks a dirty real project instead of mixing other work into the commit', async () => {
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-3:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    // 在研发期间保留一个与本需求无关的在途改动。
    writeFileSync(join(project, 'README.md'), 'unrelated in-flight change\n')
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('未提交改动')
    expect(runtime.repo.latestCommit(reqId)).toBeNull()
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })
  it('blocks before commit when code commit is not authorized', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner(), { allowCodeCommit: false })
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-4:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('不允许代码提交')
    expect(runtime.repo.latestCommit(reqId)).toBeNull()
    expect(runtime.repo.codeCandidates(reqId, 1).length).toBeGreaterThan(0)
  })

  it('blocks without committing when the configured commit check fails', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner(), { commitCheckCommand: ['node', '-e', 'process.exit(1)'] })
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-5:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('受控提交未完成')
    expect(runtime.repo.latestCommit(reqId)).toBeNull()
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })

  it('records a verifiable failure when the verification agent produces no usable plan', async () => {
    const base = fakeRunner()
    const silent: AgentLike = {
      async run(request) {
        return base.run(request)
      },
      async open(request) {
        const session = await base.open!(request)
        if (request.role !== 'verify') return session
        return {
          sessionId: session.sessionId,
          async send(turn) {
            // 验证方案阶段拿不到可解析的方案：程序按畸形方案阻断，而不是先执行再猜。
            return {
              status: 'completed',
              text: '{}',
              sessionId: session.sessionId,
              reason: '',
              transcriptPath: turn.transcriptPath,
              durationMs: 1,
              toolCalls: [],
            }
          },
          async close() {
            await session.close()
          },
        }
      },
    }
    runtime.close()
    runtime = makeRuntime(silent)
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-6:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('验证方案')
    expect(runtime.repo.failureRounds(reqId).length).toBeGreaterThan(0)
  })

  it('does not admit a requirement that still has clarification questions', async () => {
    const base = fakeRunner()
    const asking: AgentLike = {
      async run(request) {
        return result(
          request,
          JSON.stringify({
            goal: '需要澄清',
            scenarios: [SCENARIO],
            acceptance_criteria: [CRITERION],
            clarifications: ['目标用户是谁？'],
          }),
        )
      },
      async open(request) {
        return base.open!(request)
      },
    }
    runtime.close()
    runtime = makeRuntime(asking)
    const submitted = runtime.submit({
      text: '一个还有歧义的需求',
      by: 'owner',
      source: 'dsh-session:sess-7:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    const analysis = await runNext(reqId, 'analyze')
    expect(analysis.state).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('awaiting_clarification')
    expect(runtime.repo.latestAdmission(reqId)).toBeNull()
    expect(runtime.autoAdvanceRequests()).not.toContain(reqId)
  })

  it('blocks when the development turn times out and keeps the workspace for recovery', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ devTimeout: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-8:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('现场保留')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })

  it('blocks when verification materials are malformed or modify outside verification', async () => {
    for (const mode of ['malformed', 'outside'] as const) {
      runtime.close()
      runtime = makeRuntime(fakeRunner({ verifyMode: mode }))
      const submitted = runtime.submit({
        text: '实现一个可验证的小功能',
        by: 'owner',
        source: `dsh-session:sess-${mode}:msg-1`,
      })
      const reqId = (submitted.data as { reqId: string }).reqId
      await runNext(reqId, 'analyze')
      runtime.autoAdvanceRequests()
      const advance = await runNext(reqId, 'advance')
      expect(advance.state).toBe('failed')
      expect(advance.detail).toMatch(/验证方案|验证命令修改了固定候选/)
    }
  })

  it('blocks when business acceptance is malformed', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ verifyMode: 'business-malformed' }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-9:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('业务验收材料畸形')
  })

  it('stops after a repair round that produces no changes', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ failFirstVerification: true, repairNoChange: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-10:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('定向修复未完成')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })

  it('retries an invalid plan in the same development session', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ badPlanFirst: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-11:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('committed')
  })

  it('reuses the persisted development workspace after an interrupted task', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ devTimeout: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-12:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    expect((await runNext(reqId, 'advance')).state).toBe('failed')
    const sessionId = boundSessionId(reqId)
    const workspace = boundWorkspace(reqId)
    writeFileSync(join(workspace, 'continued.txt'), 'continued\n')
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(boundSessionId(reqId)).toBe(sessionId)
    expect(
      git(project, [
        'show',
        '--name-only',
        '--pretty=format:',
        runtime.repo.latestCommit(reqId)!.commitSha,
      ]),
    ).toContain('continued.txt')
  })

  it('writes a session summary bound to the session and requirement', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-13:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    const sessionId = boundSessionId(reqId)
    const summaries = runtime.repo.devSessionSummaries(sessionId)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.reqId).toBe(reqId)
    expect(summaries[0]?.summaryPath).toContain(sessionId)
    expect(existsSync(summaries[0]!.summaryPath)).toBe(true)
    expect(runtime.repo.devSession(sessionId)).toMatchObject({
      state: 'idle',
      lastReqId: reqId,
    })
  })

  it('records a stopped development turn without leaving the task running', async () => {
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-14:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const claimed = runtime.repo.claimNextRequest('test-owner', new Date().toISOString())!
    const controller = new AbortController()
    controller.abort()
    const outcome = await runtime.executeRequest(claimed, controller.signal)
    runtime.repo.resolveRequest(
      claimed.requestId,
      outcome.state,
      outcome.detail,
      new Date().toISOString(),
    )
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('停止请求')
    expect(runtime.repo.taskRuns(reqId, 1).every((run) => run.state !== 'running')).toBe(true)
  })

  it('saves an undelivered diff when the development turn times out', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ devTimeoutAfterEdit: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-13b:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    const taskDir = evidenceDir(runtime.config, reqId, 1, 'a')
    const diffPath = join(taskDir, 'checkpoint-a1.diff')
    expect(existsSync(diffPath)).toBe(true)
    expect(readFileSync(diffPath, 'utf8')).toContain('docs/a.md')
    expect(existsSync(join(taskDir, 'checkpoint-a1.json'))).toBe(true)
  })

  it('blocks when the verification model itself fails', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ verifyError: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-15:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('model unavailable')
    expect(runtime.repo.failureRounds(reqId).length).toBeGreaterThan(0)
  })

  it('blocks when the verification session never runs the planned commands through the tool', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ skipExecution: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-15b:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('验证 Agent 没有通过工具执行方案中的命令：smoke')
    expect(runtime.repo.verificationsFor(reqId)).toEqual([])
    expect(runtime.issues.issuesFor(reqId)).toEqual([])
  })

  it('blocks when the business acceptance model fails', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ businessError: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-16:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('business model unavailable')
  })

  it('rejects a plan that leaves the TypeScript project boundary and retries', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ languageViolationFirst: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-17:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    const plan = runtime.repo.latestTaskPlan(reqId)!
    expect(plan.tasks.flatMap((task) => task.files).some((file) => file.endsWith('.py'))).toBe(
      false,
    )
  })

  it('blocks when the planning turn times out', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ planTimeout: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-18:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('技术方案未形成')
    expect(runtime.repo.failureRounds(reqId).length).toBe(1)
    expect(runtime.autoAdvanceRequests()).not.toContain(reqId)
  })

  it('blocks when the repair turn times out', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ failFirstVerification: true, repairTimeout: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-19:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('定向修复未完成')
  })

  it('blocks after repeated development turns that produce no file changes', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ devNoChange: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-20:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('已尝试 2 次')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })

  it('rejects a business acceptance that skips every required scenario', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ businessIncomplete: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-21:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('业务验收阻断')
    expect(runtime.repo.failureRounds(reqId).length).toBeGreaterThanOrEqual(3)
  })

  it('blocks when the business acceptance reports a real failure', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ businessBlock: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-22:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('业务结果不符合预期')
  })

  it('does not duplicate an advance request that is already queued', async () => {
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-23:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    expect(
      runtime.requestOperation({
        reqId,
        action: 'advance',
        by: 'owner',
        source: 'dsh-session:sess-fault:msg-1',
      }).ok,
    ).toBe(true)
    expect(runtime.autoAdvanceRequests()).not.toContain(reqId)
  })

  it('retries a model error during planning before forming the plan', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ planError: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-24:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    // 规划模型错误会反馈重试；第三次仍无有效方案时阻塞，而不是伪造成功。
    expect(advance.state).toBe('failed')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })

  it('auto-requeues an interrupted plan within quota but stops at exhausted quota', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ devTimeout: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-25:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    expect((await runNext(reqId, 'advance')).state).toBe('failed')
    expect(runtime.repo.latestTaskPlan(reqId)).not.toBeNull()
    expect(runtime.autoAdvanceRequests()).toContain(reqId)
    for (let index = 0; index < 3; index += 1) {
      runtime.repo.recordFailureRound(reqId, {
        roundId: `quota-${index}`,
        stage: 'formal_test',
        summary: 'quota',
        occurredAt: new Date().toISOString(),
      })
    }
    expect(runtime.autoAdvanceRequests()).not.toContain(reqId)
  })

  it('records an aborted planning turn without creating a plan', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ planAborted: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-26:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('技术方案未形成')
    expect(runtime.repo.latestTaskPlan(reqId)).toBeNull()
  })

  it('blocks when verification is aborted', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ verifyAborted: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-27:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('verify aborted')
  })

  it('rebuilds a workspace whose git metadata disappeared', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ devTimeout: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-28:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    expect((await runNext(reqId, 'advance')).state).toBe('failed')
    const sessionId = boundSessionId(reqId)
    rmSync(join(boundWorkspace(reqId), '.git'), { recursive: true, force: true })
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(boundSessionId(reqId)).toBe(sessionId)
  })

  it('waits for a busy development session instead of starting another', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    const first = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-29a:msg-1',
    })
    const firstId = (first.data as { reqId: string }).reqId
    await runNext(firstId, 'analyze')
    runtime.autoAdvanceRequests()
    expect((await runNext(firstId, 'advance')).state).toBe('done')
    const sessionId = boundSessionId(firstId)
    const workspace = boundWorkspace(firstId)

    const second = runtime.submit({
      text: '继续完善同一个功能',
      by: 'owner',
      source: 'dsh-session:sess-29b:msg-1',
    })
    const secondId = (second.data as { reqId: string }).reqId
    await runNext(secondId, 'analyze')
    const now = new Date().toISOString()
    runtime.repo.bindRequirementDevSession({
      reqId: secondId,
      requirementVersion: 1,
      sessionId,
      workspace,
      selectedBy: 'test',
      reason: '等待忙碌会话',
      now,
    })
    expect(runtime.repo.leaseDevSession(sessionId, 'other-request', now)).toBe(true)

    runtime.autoAdvanceRequests()
    const waiting = await runNext(secondId, 'advance')
    expect(waiting.state).toBe('done')
    expect(waiting.detail).toContain('等待')
    expect(runtime.repo.getRequirement(secondId)?.status).toBe('awaiting_dev_session')
    expect(runtime.autoAdvanceRequests()).not.toContain(secondId)

    runtime.repo.releaseDevSession(sessionId, new Date().toISOString())
    expect(runtime.autoAdvanceRequests()).toContain(secondId)
    const advance = await runNext(secondId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(boundSessionId(secondId)).toBe(sessionId)
  })

  it('restores delivered task diffs into a fresh workspace before continuing', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ failFirstVerification: true, repairNoChange: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-30:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    expect((await runNext(reqId, 'advance')).state).toBe('failed')
    expect(runtime.repo.taskArtifacts(reqId, 1)).toHaveLength(2)
    const sessionId = boundSessionId(reqId)
    rmSync(boundWorkspace(reqId), { recursive: true, force: true })
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('committed')
    expect(boundSessionId(reqId)).toBe(sessionId)
  })

  it('routes a new requirement into the development session chosen by the orchestrator', async () => {
    let routed = ''
    runtime.close()
    runtime = makeRuntime(fakeRunner({ orchestratorSessionId: () => routed || null }))
    const first = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-31a:msg-1',
    })
    const firstId = (first.data as { reqId: string }).reqId
    await runNext(firstId, 'analyze')
    runtime.autoAdvanceRequests()
    expect((await runNext(firstId, 'advance')).state).toBe('done')
    const sessionId = boundSessionId(firstId)
    const workspace = boundWorkspace(firstId)
    routed = sessionId

    const second = runtime.submit({
      text: '在同一个功能上增加一个验收点',
      by: 'owner',
      source: 'dsh-session:sess-31b:msg-1',
    })
    const secondId = (second.data as { reqId: string }).reqId
    await runNext(secondId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(secondId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(boundSessionId(secondId)).toBe(sessionId)
    expect(boundWorkspace(secondId)).toBe(workspace)
    expect(runtime.repo.requirementDevSession(secondId, 1)?.selectedBy).toBe('orchestrator')
  })

  it('blocks before development when the execution budget is exhausted', async () => {
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-32:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.repo.ensureBudget(reqId, 0)
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('工时已用尽')
    expect(runtime.repo.latestTaskPlan(reqId)).toBeNull()
  })

  it('records an aborted development turn as blocked without a running task', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ devAborted: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-33:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('被停止')
    expect(runtime.repo.taskRuns(reqId, 1).every((run) => run.state !== 'running')).toBe(true)
  })

  it('does not auto-resume an explicitly stopped requirement until an explicit decision', async () => {
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-stop:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    expect(runtime.autoAdvanceRequests()).toContain(reqId)
    const stopped = runtime.stop({ reqId, by: 'owner', reason: '暂停一下' })
    expect(stopped.ok).toBe(true)
    expect(runtime.repo.activeStop(reqId)?.requestedAt).toBeTruthy()
    expect(runtime.repo.activeStop(reqId)?.settledAt).toBeTruthy()
    expect(runtime.autoAdvanceRequests()).not.toContain(reqId)
    expect(runtime.retryDecisionFor(reqId).allowed).toBe(false)
    const resumed = runtime.requestOperation({
      reqId,
      action: 'advance',
      by: 'owner',
      source: 'test-explicit-resume',
    })
    expect(resumed.ok, resumed.message).toBe(true)
    expect(runtime.repo.stop(reqId)?.resumedAt).toBeTruthy()
  })

  it('keeps a stop request open while a claimed request is still winding down', async () => {
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-stop-live:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const claimed = runtime.repo.claimNextRequest('owner', runtime.now())
    expect(claimed?.reqId).toBe(reqId)
    runtime.stop({ reqId, by: 'owner', reason: '在途时停止' })
    expect(runtime.repo.activeStop(reqId)?.settledAt).toBe('')
    runtime.repo.resolveRequest(claimed!.requestId, 'failed', 'test', runtime.now())
    runtime.settleStopIfQuiet(reqId)
    expect(runtime.repo.activeStop(reqId)?.settledAt).not.toBe('')
    expect(runtime.autoAdvanceRequests()).not.toContain(reqId)
  })

  it('records, settles, resumes and re-records a stop without losing audit fields', async () => {
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-fault:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    runtime.stop({ reqId, by: 'owner', reason: '' })
    expect(runtime.repo.stop(reqId)?.reason).toBe('未说明')
    runtime.repo.markStopSettled(reqId, runtime.now())
    expect(runtime.repo.stop(reqId)?.settledAt).not.toBe('')
    runtime.repo.resumeStop({
      requirementId: reqId,
      resumedBy: 'owner',
      reason: '恢复',
      resumedAt: runtime.now(),
    })
    expect(runtime.repo.activeStop(reqId)).toBeNull()
    runtime.repo.resumeStop({
      requirementId: reqId,
      resumedBy: 'owner',
      reason: '重复恢复',
      resumedAt: runtime.now(),
    })
    runtime.repo.markStopSettled(reqId, runtime.now())
    runtime.repo.recordStop({
      requirementId: reqId,
      requestedBy: 'owner',
      reason: '再次停止',
      requestedAt: runtime.now(),
    })
    expect(runtime.repo.activeStop(reqId)?.resumedAt).toBe('')
    expect(runtime.repo.activeStop(reqId)?.settledAt).toBe('')
  })

  it('refuses stop on missing or terminal requirements and ignores active requests when scanning', async () => {
    expect(runtime.stop({ reqId: 'req-missing', by: 'owner', reason: 'x' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-fault:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    expect(runtime.cancel({ reqId, by: 'owner', reason: 'test' }).ok).toBe(true)
    expect(runtime.stop({ reqId, by: 'owner', reason: 'x' })).toMatchObject({
      ok: false,
      code: 'terminal',
    })
    expect(runtime.autoAdvanceRequests()).not.toContain(reqId)
    const other = runtime.submit({
      text: '另一个需求',
      by: 'owner',
      source: 'dsh-session:sess-fault:msg-1',
    })
    const otherId = (other.data as { reqId: string }).reqId
    runtime.requestOperation({
      reqId: otherId,
      action: 'analyze',
      by: 'owner',
      source: 'dsh-session:sess-fault:msg-1',
    })
    expect(runtime.autoAdvanceRequests()).not.toContain(otherId)
  })

  it('returns deterministic retry and build errors for missing requirements', () => {
    expect(runtime.retryDecisionFor('req-missing')).toMatchObject({ allowed: false })
    expect(runtime.buildCandidate({ reqId: 'req-missing', by: 'owner' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    expect(
      runtime.verifyDeployment({
        reqId: 'req-missing',
        targetProfile: 'x',
        by: 'owner',
        source: 'dsh-session:sess-fault:msg-1',
      }),
    ).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    const submitted = runtime.submit({
      text: '一个需求',
      by: 'owner',
      source: 'dsh-session:sess-fault:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    expect(
      runtime.verifyDeployment({
        reqId,
        targetProfile: 'Bad!',
        by: 'owner',
        source: 'dsh-session:sess-fault:msg-1',
      }),
    ).toMatchObject({
      ok: false,
      code: 'profile_invalid',
    })
    runtime.cancel({ reqId, by: 'owner', reason: 'test' })
    expect(runtime.retryDecisionFor(reqId).allowed).toBe(false)
  })

  it('injects an explicitly requested fault once and records its evidence', async () => {
    process.env.FORGELOOP_FAULT_INJECT = JSON.stringify({
      file: 'README.md',
      append: '\nfault-injected\n',
    })
    try {
      runtime = makeRuntime(fakeRunner())
      const submitted = runtime.submit({
        text: '实现一个可验证的小功能',
        by: 'owner',
        source: 'dsh-session:sess-fault:msg-1',
      })
      const reqId = (submitted.data as { reqId: string }).reqId
      await runNext(reqId, 'analyze')
      runtime.autoAdvanceRequests()
      const advance = await runNext(reqId, 'advance')
      expect(advance.state, advance.detail).toBe('done')
      const marker = join(
        project,
        '.forgeloop/projects/demo/candidates',
        reqId,
        'v1',
        'fault-injection.json',
      )
      expect(existsSync(marker)).toBe(true)
      const record = JSON.parse(readFileSync(marker, 'utf8')) as { kind: string; file: string }
      expect(record.kind).toBe('isolated-fault-injection')
      expect(record.file).toBe('README.md')
    } finally {
      delete process.env.FORGELOOP_FAULT_INJECT
    }
  })

  it('rejects malformed or ineffective fault specs without creating a candidate', async () => {
    const specs = [
      {},
      { file: '../outside.txt', append: 'x' },
      { file: 'missing.txt', append: 'x' },
      { file: 'README.md', append: '' },
    ]
    for (const spec of specs) {
      process.env.FORGELOOP_FAULT_INJECT = JSON.stringify(spec)
      let reqId = ''
      try {
        runtime = makeRuntime(fakeRunner())
        const submitted = runtime.submit({
          text: '实现一个可验证的小功能',
          by: 'owner',
          source: 'dsh-session:sess-fault-bad:msg-1',
        })
        reqId = (submitted.data as { reqId: string }).reqId
        await runNext(reqId, 'analyze')
        runtime.autoAdvanceRequests()
        await expect(runNext(reqId, 'advance')).rejects.toThrow()
        expect(runtime.repo.codeCandidates(reqId, 1)).toHaveLength(0)
      } finally {
        delete process.env.FORGELOOP_FAULT_INJECT
        // 需求队列按提出时间串行：收口本轮需求，避免它作为在研需求阻塞下一轮新需求。
        if (reqId) runtime.cancel({ reqId, by: 'owner', reason: '故障注入用例隔离' })
      }
    }
  })

  it('supports a replacement fault and does not inject it twice', async () => {
    process.env.FORGELOOP_FAULT_INJECT = JSON.stringify({
      file: 'README.md',
      replaceFrom: 'fixture',
      replaceTo: 'fault-replaced',
    })
    try {
      runtime = makeRuntime(fakeRunner())
      const submitted = runtime.submit({
        text: '实现一个可验证的小功能',
        by: 'owner',
        source: 'dsh-session:sess-fault-replace:msg-1',
      })
      const reqId = (submitted.data as { reqId: string }).reqId
      await runNext(reqId, 'analyze')
      runtime.autoAdvanceRequests()
      expect((await runNext(reqId, 'advance')).state).toBe('done')
      const candidate = runtime.repo.codeCandidates(reqId, 1)[0]!
      expect(candidate.diffPath).toBeTruthy()
      const marker = join(
        project,
        '.forgeloop/projects/demo/candidates',
        reqId,
        'v1',
        'fault-injection.json',
      )
      expect(existsSync(marker)).toBe(true)
    } finally {
      delete process.env.FORGELOOP_FAULT_INJECT
    }
  })
})

/** 造一个“既有研发会话”的工作区：真实 Git 仓库，可按需留下未提交现场。 */
function seedDevSession(sessionId: string, options: { dirty?: boolean } = {}): string {
  // 放在被忽略的 .forgeloop/ 下：夹具自身的 Git 仓库不能把真实项目工作树弄脏。
  const workspace = join(project, '.forgeloop/seeded-sessions', sessionId)
  mkdirSync(workspace, { recursive: true })
  git(workspace, ['init', '-q'])
  git(workspace, ['config', 'user.email', 'test@example.com'])
  git(workspace, ['config', 'user.name', 'Test'])
  writeFileSync(join(workspace, 'README.md'), 'session fixture\n')
  git(workspace, ['add', '-A'])
  git(workspace, ['commit', '-qm', 'session base'])
  if (options.dirty) writeFileSync(join(workspace, 'leftover.txt'), 'uncommitted\n')
  runtime.repo.upsertDevSession({
    sessionId,
    project: 'demo',
    workspace,
    now: new Date().toISOString(),
  })
  return workspace
}

describe('development session routing failures', () => {
  it('falls back to another candidate when the chosen session cannot be reused', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ orchestratorSessionId: () => 'session-dirty' }))
    seedDevSession('session-clean')
    seedDevSession('session-dirty', { dirty: true })

    const submitted = runtime.submit({
      text: '在可用研发会话里实现功能',
      by: 'owner',
      source: 'dsh-session:sess-fallback:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')

    expect(advance.state, advance.detail).toBe('done')
    expect(boundSessionId(reqId)).toBe('session-clean')
  })

  it('opens a new session when no candidate can be reused', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ orchestratorSessionId: () => 'session-broken' }))
    seedDevSession('session-broken', { dirty: true })

    const submitted = runtime.submit({
      text: '所有候选都不可用时新建会话',
      by: 'owner',
      source: 'dsh-session:sess-new:msg-1',
    })
    expect(submitted.ok, submitted.message).toBe(true)
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')

    expect(advance.state, advance.detail).toBe('done')
    const sessionId = boundSessionId(reqId)
    expect(sessionId).not.toBe('session-broken')
    expect(sessionId.startsWith('session-fl-dev-')).toBe(true)
    // 旧会话记录与现场保留，只把需求改派到新会话。
    expect(runtime.repo.devSession('session-broken')).not.toBeNull()
  })

  it('keeps self-verification inside the development session', async () => {
    const gated = fakeRunner({ selfTestGate: true })
    runtime.close()
    runtime = makeRuntime(gated)

    const submitted = runtime.submit({
      text: '研发会话自己跑测试并修到通过',
      by: 'owner',
      source: 'dsh-session:sess-self:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')

    expect(advance.state, advance.detail).toBe('done')
    // 自验失败的日志回到同一个研发会话继续修，不换工作区、不新开会话。
    expect(gated.devPrompts.some((prompt) => prompt.includes('研发自验未通过'))).toBe(true)
    expect(new Set(gated.devWorkspaces)).toEqual(new Set([boundWorkspace(reqId)]))
    expect(gated.devWorkspaces.length).toBeGreaterThan(1)
    // 修复在同一次研发里完成：自验失败后的回合仍在同一研发会话与工作区。
    const firstDev = gated.roleTrace.indexOf('dev')
    const secondDev = gated.roleTrace.indexOf('dev', firstDev + 1)
    expect(secondDev).toBeGreaterThan(firstDev)
    // 验证会话在研发前生成方案、交付后才执行与验收；研发会话不因结束而关闭。
    expect(gated.roleTrace.lastIndexOf('verify')).toBeGreaterThan(secondDev)
    expect(gated.closedRoles).toContain('verify')
    expect(gated.closedRoles).not.toContain('dev')
  })

  it('recovers with a new session when the host cannot restore the bound one', async () => {
    const first = runtime.submit({
      text: '第一个需求占用研发会话',
      by: 'owner',
      source: 'dsh-session:sess-resume-1:msg-1',
    })
    const firstReq = (first.data as { reqId: string }).reqId
    await runNext(firstReq, 'analyze')
    runtime.autoAdvanceRequests()
    expect((await runNext(firstReq, 'advance')).state).toBe('done')
    const firstSession = boundSessionId(firstReq)
    const firstWorkspace = boundWorkspace(firstReq)

    // 宿主重启：进程内没有句柄，agents.resume 又失败。
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({ orchestratorSessionId: () => firstSession, resumeFails: true }),
    )
    const second = runtime.submit({
      text: '宿主无法恢复旧会话时继续新需求',
      by: 'owner',
      source: 'dsh-session:sess-resume-2:msg-1',
    })
    const secondReq = (second.data as { reqId: string }).reqId
    await runNext(secondReq, 'analyze')
    runtime.autoAdvanceRequests()
    const advance = await runNext(secondReq, 'advance')

    expect(advance.state, advance.detail).toBe('done')
    const rebound = boundSessionId(secondReq)
    expect(rebound).not.toBe(firstSession)
    // 旧会话记录与工作区不删除，只换绑定。
    expect(runtime.repo.devSession(firstSession)?.workspace).toBe(firstWorkspace)
    expect(existsSync(firstWorkspace)).toBe(true)
  })
})
