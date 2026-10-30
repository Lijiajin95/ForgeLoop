import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'

/**
 * 业务终审：由需求 Agent 在新会话里按原始需求复核关键业务场景与实际结果，
 * 不能只读验证报告；系统判定、模型建议与所有者验收分别记录。
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
  const project = mkdtempSync(join(tmpdir(), 'forgeloop-review-'))
  git(project, ['init', '-q'])
  git(project, ['config', 'user.email', 'test@example.com'])
  git(project, ['config', 'user.name', 'Test'])
  writeFileSync(join(project, '.gitignore'), '.forgeloop/\n')
  writeFileSync(join(project, 'README.md'), 'fixture\n')
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

function businessReview(options: {
  verdict?: 'pass' | 'block'
  scenario?: string
  evidence?: string
  omitAcceptance?: boolean
} = {}): string {
  const verdict = options.verdict ?? 'pass'
  return JSON.stringify({
    verdict,
    summary: verdict === 'pass' ? '业务场景复核通过' : '业务场景复核阻断',
    findings: [],
    blocking: verdict === 'block' ? ['关键业务场景未在候选结果中复现'] : [],
    scenarios: [
      {
        scenario: options.scenario ?? SCENARIO,
        status: verdict === 'pass' ? 'pass' : 'fail',
        evidence: options.evidence ?? SMOKE_OUTPUT,
        commands: ['smoke'],
      },
    ],
    acceptance: options.omitAcceptance
      ? []
      : [
          {
            criterion: CRITERION,
            status: verdict === 'pass' ? 'pass' : 'fail',
            evidence: options.evidence ?? SMOKE_OUTPUT,
            commands: ['smoke'],
          },
        ],
  })
}

function fakeRunner(options: {
  review?: () => string
  reviewStatus?: AgentRunResult['status']
  reviewText?: string
} = {}): AgentLike {
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
      if (request.role === 'business-review') {
        if (options.reviewStatus && options.reviewStatus !== 'completed') {
          return result(request, '', options.reviewStatus)
        }
        return result(request, options.reviewText ?? options.review?.() ?? businessReview())
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
  expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'dsh-command' }).ok).toBe(true)
  return { reqId, advance: await runQueued('advance', reqId) }
}

beforeEach(() => {
  dir = makeProject()
  runtime = makeRuntime(fakeRunner())
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

describe('business final review', () => {
  it('runs the requirement agent after verification and gates acceptance on its result', async () => {
    const { reqId, advance } = await runPipeline()
    expect(advance.state, advance.detail).toBe('done')

    const review = runtime.repo.businessReview(reqId, 1)!
    expect(review.verdict).toBe('pass')
    const verification = runtime.repo.verification(reqId, 1)!
    expect(review.candidateSha256).toBe(verification.candidateSha256)
    expect(review.verificationSha256).toBe(verification.reportSha256)
    expect(readFileSync(review.reportPath, 'utf8')).toContain('业务场景复核')
    const accepted = runtime.accept({ reqId, by: 'owner', source: 'test' })
    expect(accepted.ok, accepted.message).toBe(true)
  })

  it('refuses acceptance while an interrupted request is still unknown', async () => {
    const { reqId } = await runPipeline()
    runtime.repo.recordRequest({
      requestId: 'rq-unknown-accept',
      reqId,
      project: 'testproj',
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-29T00:00:05.000Z',
    })
    runtime.repo.claimNextRequest('tester', '2026-10-29T00:00:06.000Z')
    runtime.repo.markClaimedUnknown('2026-10-29T00:00:07.000Z')
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'recovery_required',
    })
    expect(runtime.recover({ reqId, by: 'owner', confirm: true }).ok).toBe(true)
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' }).ok).toBe(true)
  })

  it('blocks acceptance when the business review reports a failure', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ review: () => businessReview({ verdict: 'block' }) }))
    const { reqId, advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('业务终审阻断')
    expect(runtime.repo.businessReview(reqId, 1)?.verdict).toBe('block')
    expect(runtime.repo.failureRounds(reqId).some((round) => round.stage === 'business_review')).toBe(true)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'business_review_blocked',
    })
  })

  it('does not accept a review that skips an acceptance criterion', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ review: () => businessReview({ omitAcceptance: true }) }))
    const { reqId, advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('业务终审缺少验收标准')
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' }).ok).toBe(false)
  })

  it('does not accept evidence that cannot be checked against the verification output', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ review: () => businessReview({ evidence: '所有场景人工确认无问题' }) }))
    const { reqId, advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('证据无法在验证输出中核对')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })

  it('fails closed when the business review agent does not complete', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ reviewStatus: 'error' }))
    const { reqId, advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('业务终审未取得结论')
    expect(runtime.repo.businessReview(reqId, 1)).toBeNull()
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'business_review_required',
    })
  })

  it('rejects acceptance when the business review is bound to another verification', async () => {
    const { reqId } = await runPipeline()
    const review = runtime.repo.businessReview(reqId, 1)!
    runtime.repo.db.handle
      .prepare('UPDATE requirement_business_reviews SET verification_sha256 = ? WHERE req_id = ?')
      .run('f'.repeat(64), reqId)
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'business_review_stale',
    })
    expect(review.verdict).toBe('pass')
  })

  it('rejects acceptance when the business review report was tampered with', async () => {
    const { reqId } = await runPipeline()
    const review = runtime.repo.businessReview(reqId, 1)!
    writeFileSync(review.reportPath, `${review.reportJson}\n篡改\n`, 'utf8')
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'business_review_invalid',
    })
  })
})
