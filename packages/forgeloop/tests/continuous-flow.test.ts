import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import type { AgentOpenRequest, AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { COMMITTED } from '../src/domain/status.js'

const SCENARIO = '需求功能可用'
const CRITERION = '命令输出证明功能可用'
const SMOKE = 'verified ok'

let project = ''
let runtime: ForgeLoopRuntime

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

function verificationReport(verdict: 'pass' | 'block'): string {
  return JSON.stringify({
    verdict,
    summary: verdict === 'pass' ? '候选满足需求' : '候选未满足需求',
    findings: [],
    blocking: verdict === 'pass' ? [] : ['功能未实现'],
    scenarios: [
      {
        scenario: SCENARIO,
        status: verdict === 'pass' ? 'pass' : 'fail',
        evidence: verdict === 'pass' ? SMOKE : 'broken',
        commands: ['smoke'],
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
})

function fakeRunner(options: {
  failFirstVerification?: boolean
  verifyMode?: 'malformed' | 'outside' | 'business-malformed'
  repairNoChange?: boolean
  devTimeout?: boolean
  devAborted?: boolean
  badPlanFirst?: boolean
  languageViolationFirst?: boolean
  verifyError?: boolean
  verifyAborted?: boolean
  businessError?: boolean
  planTimeout?: boolean
  planError?: boolean
  planAborted?: boolean
  repairTimeout?: boolean
  devNoChange?: boolean
  businessIncomplete?: boolean
  businessBlock?: boolean
} = {}): AgentLike {
  let verifications = 0
  let plans = 0
  const session = (request: AgentOpenRequest) => ({
    sessionId: `session-fl-${request.role}-test`,
    async send(turn: { prompt: string; transcriptPath: string }): Promise<AgentRunResult> {
      if (request.role === 'dev' && turn.prompt.includes('技术方案与研发任务拆解')) {
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
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, PLAN)
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
        mkdirSync(join(request.cwd, 'docs'), { recursive: true })
        writeFileSync(join(request.cwd, `docs/${taskId}.md`), `content ${Date.now()}\n`)
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
      if (request.role === 'verify' && turn.prompt.includes('独立验证 Agent')) {
        if (options.verifyAborted) {
          return {
            status: 'aborted', text: '', sessionId: 'verify-aborted', reason: 'verify aborted',
            transcriptPath: turn.transcriptPath, durationMs: 1, toolCalls: [],
          }
        }
        if (options.verifyError) {
          return {
            status: 'error',
            text: '',
            sessionId: 'verify-error',
            reason: 'model unavailable',
            transcriptPath: turn.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        verifications += 1
        const fail = options.failFirstVerification === true && verifications === 1
        mkdirSync(join(request.cwd, 'verification'), { recursive: true })
        writeFileSync(
          join(request.cwd, 'verification/commands.json'),
          JSON.stringify({
            commands: [
              {
                label: 'smoke',
                argv: ['node', '-e', fail ? "console.log('broken');process.exit(1)" : `console.log('${SMOKE}')`],
              },
            ],
          }),
        )
        if (options.verifyMode === 'outside') {
          mkdirSync(join(request.cwd, 'docs'), { recursive: true })
          writeFileSync(join(request.cwd, 'docs/outside.md'), 'outside\n')
        }
        const report = options.verifyMode === 'malformed' ? 'not json' : verificationReport(fail ? 'block' : 'pass')
        writeFileSync(join(request.cwd, 'verification/report.json'), report)
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, report)
      }
      if (request.role === 'verify' && turn.prompt.includes('业务验收')) {
        if (options.businessError) {
          return {
            status: 'error',
            text: '',
            sessionId: 'business-error',
            reason: 'business model unavailable',
            transcriptPath: turn.transcriptPath,
            durationMs: 1,
            toolCalls: [],
          }
        }
        if (options.businessBlock) {
          return result(
            { role: request.role, transcriptPath: turn.transcriptPath },
            JSON.stringify({
              verdict: 'block',
              summary: '业务不通过',
              findings: [],
              blocking: ['业务结果不符合预期'],
              scenarios: [{ scenario: SCENARIO, status: 'fail', evidence: SMOKE, commands: ['smoke'] }],
              acceptance: [{ criterion: CRITERION, status: 'fail', evidence: SMOKE, commands: ['smoke'] }],
            }),
          )
        }
        if (options.businessIncomplete) {
          return result(
            { role: request.role, transcriptPath: turn.transcriptPath },
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
        return result(
          { role: request.role, transcriptPath: turn.transcriptPath },
          options.verifyMode === 'business-malformed' ? 'not json' : BUSINESS_REVIEW,
        )
      }
      return result({ role: request.role, transcriptPath: turn.transcriptPath }, '')
    },
    async close() {},
  })
  return {
    async run(request: AgentRunRequest) {
      if (request.role === 'product') return result(request, ANALYSIS)
      if (request.role === 'dev' && request.prompt.includes('技术方案与研发任务拆解')) {
        if (options.planAborted) {
          return {
            status: 'aborted', text: '', sessionId: 'plan-aborted', reason: 'plan aborted',
            transcriptPath: request.transcriptPath, durationMs: 1, toolCalls: [],
          }
        }
        if (options.planError) {
          return {
            status: 'error', text: '', sessionId: 'plan-error', reason: 'plan model error',
            transcriptPath: request.transcriptPath, durationMs: 1, toolCalls: [],
          }
        }
        if (options.planTimeout) {
          return {
            status: 'timeout', text: '', sessionId: 'plan-timeout', reason: 'plan timeout',
            transcriptPath: request.transcriptPath, durationMs: 1, toolCalls: [],
          }
        }
        plans += 1
        if (options.badPlanFirst && plans === 1) {
          return result(request, JSON.stringify({ tasks: [{ task_id: 'a' }] }))
        }
        if (options.languageViolationFirst && plans === 1) {
          return result(request, JSON.stringify({
            technical_solution: { summary: '方案', approach: ['步骤'], risks: [] },
            tasks: [
              { task_id: 'a', goal: '实现 A', files: ['src/forgeloop/app.py'], acceptance: CRITERION, test_command: ['node', '-e', 'process.exit(0)'] },
              { task_id: 'b', goal: '实现 B', files: ['docs/b.md'], acceptance: CRITERION, test_command: ['node', '-e', 'process.exit(0)'], depends_on: ['a'] },
            ],
          }))
        }
        return result(request, PLAN)
      }
      throw new Error(`unexpected single-turn role ${request.role}`)
    },
    async open(request: AgentOpenRequest) {
      return session(request)
    },
  }
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
  runtime.repo.resolveRequest(claimed!.requestId, outcome.state, outcome.detail, new Date().toISOString())
  return outcome
}

beforeEach(() => {
  project = makeProject()
  runtime = makeRuntime(fakeRunner())
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
    expect(runtime.repo.taskArtifacts(reqId, 1).map((artifact) => artifact.taskId)).toEqual(['a', 'b'])

    const commit = runtime.repo.latestCommit(reqId)
    expect(commit).not.toBeNull()
    expect(commit?.files).toEqual(['docs/a.md', 'docs/b.md'])
    const committed = git(project, ['show', '--name-only', '--pretty=format:', commit!.commitSha])
      .split('\n')
      .filter(Boolean)
    expect(committed.sort()).toEqual(['docs/a.md', 'docs/b.md'])
    expect(git(project, ['status', '--porcelain'])).toBe('')
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

  it('records a verifiable failure when the verification agent writes no materials', async () => {
    const base = fakeRunner()
    const silent: AgentLike = {
      async run(request) {
        return base.run(request)
      },
      async open(request) {
        if (request.role === 'verify') {
          return {
            sessionId: 'verify-silent',
            async send(turn) {
              return result({ role: request.role, transcriptPath: turn.transcriptPath }, '{}')
            },
            async close() {},
          }
        }
        return base.open!(request)
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
    expect(advance.detail).toContain('未产出 commands.json')
    expect(runtime.repo.failureRounds(reqId).length).toBeGreaterThan(0)
  })

  it('does not admit a requirement that still has clarification questions', async () => {
    const base = fakeRunner()
    const asking: AgentLike = {
      async run(request) {
        return result(request, JSON.stringify({
          goal: '需要澄清',
          scenarios: [SCENARIO],
          acceptance_criteria: [CRITERION],
          clarifications: ['目标用户是谁？'],
        }))
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
      expect(advance.detail).toMatch(/验证材料畸形|验证修改了 verification\/ 之外的文件/)
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
    const workspace = join(project, '.forgeloop', 'projects', 'demo', 'workspaces', reqId, 'dev')
    writeFileSync(join(workspace, 'continued.txt'), 'continued\n')
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(git(project, ['show', '--name-only', '--pretty=format:', runtime.repo.latestCommit(reqId)!.commitSha]))
      .toContain('continued.txt')
  })

  it('rebuilds the development workspace when its metadata is damaged', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ devTimeout: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-13:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    expect((await runNext(reqId, 'advance')).state).toBe('failed')
    const meta = join(project, '.forgeloop', 'projects', 'demo', 'workspaces', reqId, 'dev-meta.json')
    writeFileSync(meta, '{bad json')
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('committed')
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
    runtime.repo.resolveRequest(claimed.requestId, outcome.state, outcome.detail, new Date().toISOString())
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('停止请求')
    expect(runtime.repo.taskRuns(reqId, 1).every((run) => run.state !== 'running')).toBe(true)
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
    expect(plan.tasks.flatMap((task) => task.files).some((file) => file.endsWith('.py'))).toBe(false)
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
    expect(runtime.requestOperation({ reqId, action: 'advance', by: 'owner', source: 'test' }).ok).toBe(true)
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
    rmSync(join(project, '.forgeloop', 'projects', 'demo', 'workspaces', reqId, 'dev', '.git'), { recursive: true, force: true })
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
  })

  it('rebuilds a workspace whose metadata has no usable baseline', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ devTimeout: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-29:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    expect((await runNext(reqId, 'advance')).state).toBe('failed')
    const meta = join(project, '.forgeloop', 'projects', 'demo', 'workspaces', reqId, 'dev-meta.json')
    writeFileSync(meta, JSON.stringify({ requirementVersion: 1, baselineCommit: null, snapshotCommit: 'x' }))
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
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
    rmSync(join(project, '.forgeloop', 'projects', 'demo', 'workspaces', reqId, 'dev'), { recursive: true, force: true })
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('committed')
  })

  it('rebuilds a workspace recorded for another requirement version', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ devTimeout: true }))
    const submitted = runtime.submit({
      text: '实现一个可验证的小功能',
      by: 'owner',
      source: 'dsh-session:sess-31:msg-1',
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runNext(reqId, 'analyze')
    runtime.autoAdvanceRequests()
    expect((await runNext(reqId, 'advance')).state).toBe('failed')
    const meta = join(project, '.forgeloop', 'projects', 'demo', 'workspaces', reqId, 'dev-meta.json')
    writeFileSync(meta, JSON.stringify({ requirementVersion: 99, baselineCommit: 'x', snapshotCommit: 'y' }))
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    runtime.autoAdvanceRequests()
    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
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
    const resumed = runtime.requestOperation({ reqId, action: 'advance', by: 'owner', source: 'test-explicit-resume' })
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
    const submitted = runtime.submit({ text: '实现一个可验证的小功能', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    runtime.stop({ reqId, by: 'owner', reason: '' })
    expect(runtime.repo.stop(reqId)?.reason).toBe('未说明')
    runtime.repo.markStopSettled(reqId, runtime.now())
    expect(runtime.repo.stop(reqId)?.settledAt).not.toBe('')
    runtime.repo.resumeStop({ requirementId: reqId, resumedBy: 'owner', reason: '恢复', resumedAt: runtime.now() })
    expect(runtime.repo.activeStop(reqId)).toBeNull()
    runtime.repo.resumeStop({ requirementId: reqId, resumedBy: 'owner', reason: '重复恢复', resumedAt: runtime.now() })
    runtime.repo.markStopSettled(reqId, runtime.now())
    runtime.repo.recordStop({ requirementId: reqId, requestedBy: 'owner', reason: '再次停止', requestedAt: runtime.now() })
    expect(runtime.repo.activeStop(reqId)?.resumedAt).toBe('')
    expect(runtime.repo.activeStop(reqId)?.settledAt).toBe('')
  })

  it('refuses stop on missing or terminal requirements and ignores active requests when scanning', async () => {
    expect(runtime.stop({ reqId: 'req-missing', by: 'owner', reason: 'x' })).toMatchObject({ ok: false, code: 'not_found' })
    const submitted = runtime.submit({ text: '实现一个可验证的小功能', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    expect(runtime.cancel({ reqId, by: 'owner', reason: 'test' }).ok).toBe(true)
    expect(runtime.stop({ reqId, by: 'owner', reason: 'x' })).toMatchObject({ ok: false, code: 'terminal' })
    expect(runtime.autoAdvanceRequests()).not.toContain(reqId)
    const other = runtime.submit({ text: '另一个需求', by: 'owner', source: 'test' })
    const otherId = (other.data as { reqId: string }).reqId
    runtime.requestOperation({ reqId: otherId, action: 'analyze', by: 'owner', source: 'test' })
    expect(runtime.autoAdvanceRequests()).not.toContain(otherId)
  })

  it('returns deterministic retry and build errors for missing requirements', () => {
    expect(runtime.retryDecisionFor('req-missing')).toMatchObject({ allowed: false })
    expect(runtime.buildCandidate({ reqId: 'req-missing', by: 'owner' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(runtime.verifyDeployment({ reqId: 'req-missing', targetProfile: 'x', by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    const submitted = runtime.submit({ text: '一个需求', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    expect(runtime.verifyDeployment({ reqId, targetProfile: 'Bad!', by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'profile_invalid',
    })
    runtime.cancel({ reqId, by: 'owner', reason: 'test' })
    expect(runtime.retryDecisionFor(reqId).allowed).toBe(false)
  })

})
