import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import { candidateIdentityOf, sha256OfText } from '../src/domain/delivery.js'
import {
  judgeVerificationResult,
  parsePlanReview,
  parseVerificationCommands,
  parseRequirementVerificationPlan,
  parseVerificationReport,
  validatePlanCoverage,
  validateRequirementVerificationPlan,
  validateVerificationCoverage,
  type VerificationCheckRun,
  type VerificationPlan,
} from '../src/domain/verification.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import type { Requirement, RequirementAnalysis } from '../src/domain/requirement.js'
import {
  VerificationAgent,
  verificationPlanPrompt,
  type VerificationSessionResult,
  type VerificationSessionTurn,
} from '../src/agents/verification-agent.js'
import { VerificationCheckRegistry } from '../src/runtime/verification-checks.js'
import { parseVerificationControls } from '../src/domain/verification-controls.js'
import { runFormalTest } from '../src/runtime/formal-test.js'
import { structuredSpecOf, structuredPlanOf, structuredReviewOf } from './spec-fixture.js'

/**
 * 验证 Agent 的门禁测试：实现前评审决定能否批准，独立验证决定能否验收。
 * 这里既固定纯解析/覆盖规则，也走真实的候选副本与命令执行，避免只测模型自述。
 */

let dir = ''
let recordsDir = ''
let runtime: ForgeLoopRuntime

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'forgeloop-verify-'))
  git(project, ['init', '-q'])
  git(project, ['config', 'user.email', 'test@example.com'])
  git(project, ['config', 'user.name', 'Test'])
  writeFileSync(join(project, '.gitignore'), '.forgeloop/\ncoverage/\n')
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

const SCENARIO = '任务按依赖完成'
const CRITERION = '两个任务交付且测试通过'

const ANALYSIS = structuredSpecOf({
  goal: '实现两个小改动',
  scenarios: [SCENARIO],
  acceptance_criteria: [CRITERION],
  clarifications: [],
})

const PLAN = structuredPlanOf({
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

function planReviewOf(verdict: 'pass' | 'block'): string {
  return JSON.stringify({
    verdict,
    blocking: verdict === 'block' ? ['任务包缺少正式测试证据'] : [],
    findings: [],
    summary: verdict === 'pass' ? '任务包可进入实现' : '任务包阻断',
    verification_plan: [
      {
        scenario: SCENARIO,
        acceptance_criterion: CRITERION,
        method: '在独立候选上执行正式测试',
        required: true,
      },
    ],
  })
}

const SMOKE_OUTPUT = 'smoke ok: verified'
const DEFAULT_SMOKE_ARGV = ['node', '-e', `console.log('${SMOKE_OUTPUT}')`]

function verificationReportOf(
  options: {
    verdict?: 'pass' | 'block'
    scenario?: string
    status?: 'pass' | 'fail' | 'not_verified'
    evidence?: string
    commands?: readonly string[]
  } = {},
): string {
  return JSON.stringify({
    verdict: options.verdict ?? 'pass',
    summary: '候选通过独立验证',
    findings: [],
    blocking: options.verdict === 'block' ? ['候选未满足需求'] : [],
    scenarios: [
      {
        scenario: options.scenario ?? SCENARIO,
        status: options.status ?? 'pass',
        evidence: options.evidence ?? SMOKE_OUTPUT,
        commands: options.commands ?? ['smoke'],
      },
    ],
  })
}

function commandsOf(argv: readonly string[] = DEFAULT_SMOKE_ARGV, label = 'smoke'): string {
  return JSON.stringify({ commands: [{ label, argv }] })
}

interface VerifyOptions {
  commands?: string
  report?: string
  outside?: string
}

function fakeRunner(
  options: {
    onVerify?: (request: AgentRunRequest, workspaceOptions: VerifyOptions) => void
    verifyPlan?: (attempt: number) => string
    workspace?: VerifyOptions
  } = {},
): AgentLike {
  let reviewAttempt = 0
  return {
    async run(request) {
      if (request.role === 'product') return result(request, ANALYSIS)
      if (request.role === 'dev' && request.prompt.includes('技术方案与研发任务拆解'))
        return result(request, PLAN)
      if (request.role === 'verify' && request.prompt.includes('正在做实现前评审')) {
        reviewAttempt += 1
        return result(
          request,
          options.verifyPlan ? options.verifyPlan(reviewAttempt) : planReviewOf('pass'),
        )
      }
      if (request.role === 'verify' && request.prompt.includes('独立验证 Agent')) {
        const workspaceOptions = options.workspace ?? {}
        const verification = join(request.cwd, 'verification')
        mkdirSync(verification, { recursive: true })
        writeFileSync(
          join(verification, 'commands.json'),
          workspaceOptions.commands ?? commandsOf(),
        )
        writeFileSync(
          join(verification, 'report.json'),
          workspaceOptions.report ?? verificationReportOf(),
        )
        mkdirSync(join(verification, 'controls'), { recursive: true })
        writeFileSync(
          join(verification, 'controls.json'),
          JSON.stringify({
            controls: [
              {
                label: 'smoke',
                patch: 'verification/controls/fault.patch',
                expected_failure_output: 'target rule broken',
              },
            ],
          }),
        )
        writeFileSync(
          join(verification, 'controls', 'fault.patch'),
          'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-fixture\n+broken\n',
        )
        if (workspaceOptions.outside) {
          mkdirSync(join(request.cwd, 'docs'), { recursive: true })
          writeFileSync(join(request.cwd, workspaceOptions.outside), '越界改动\n')
        }
        options.onVerify?.(request, workspaceOptions)
        return result(request, workspaceOptions.report ?? verificationReportOf())
      }
      if (request.role === 'verify' && request.prompt.includes('业务验收')) {
        return result(
          request,
          structuredReviewOf({
            verdict: 'pass',
            summary: '业务终审通过',
            findings: [],
            blocking: [],
            scenarios: [
              { scenario: SCENARIO, status: 'pass', evidence: SMOKE_OUTPUT, commands: ['smoke'] },
            ],
            acceptance: [
              { criterion: CRITERION, status: 'pass', evidence: SMOKE_OUTPUT, commands: ['smoke'] },
            ],
          }),
        )
      }
      if (request.role === 'verify' && request.prompt.includes('独立审查')) {
        return result(
          request,
          JSON.stringify({ verdict: 'pass', blocking: [], findings: [], summary: 'ok' }),
        )
      }
      const allowed =
        /计划中列出的预期文件（仅供参考，不是禁止修改其他文件）：(.+)/
          .exec(request.prompt)?.[1]
          ?.split('、')[0] ?? 'docs/out.md'
      mkdirSync(join(request.cwd, allowed, '..'), { recursive: true })
      writeFileSync(join(request.cwd, allowed), `content ${Date.now()}\n`)
      return result(request, 'done')
    },
  }
}

/** 对照副本中的命令按“已知错误实现”失败；正式候选仍走真实命令执行。 */
const controlAwareFormalTest: typeof runFormalTest = async (request) => {
  if (request.cwd.replaceAll('\\', '/').includes('/controls/')) {
    const output = 'target rule broken: expected fixture, got broken'
    mkdirSync(dirname(request.logPath), { recursive: true })
    writeFileSync(request.logPath, output, 'utf8')
    return {
      exitCode: 1,
      timedOut: false,
      aborted: false,
      logPath: request.logPath,
      logSha256: sha256OfText(output),
      durationMs: 1,
      output,
    }
  }
  return runFormalTest(request)
}

function makeRuntime(runner: AgentLike): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: recordsDir,
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
      // 这些用例验证“阻断后重试到额度用尽”，因此显式恢复有限的失败轮次与验证次数。
      failureRoundsPerGrant: 3,
      maxVerificationAttempts: 3,
      // 这些用例走未准入的旧验证路径；放开来源会切到准入后的连续推进。
      autonomy: { allowAnySource: false },
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config, runner, formalTest: controlAwareFormalTest })
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

function seedPlan(reqId: string, planVersion = 1, requirementVersion = 1): TaskPlan {
  const plan: TaskPlan = {
    taskPlanId: `plan-${reqId}-${planVersion}`,
    requirementId: reqId,
    project: 'testproj',
    planVersion,
    requirementVersion,
    createdAt: '2026-10-29T00:00:01.000Z',
    tasks: [
      {
        taskId: 'a',
        goal: '写文档',
        files: ['docs/a.md'],
        acceptance: '文档存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
      {
        taskId: 'b',
        goal: '补测试',
        files: ['docs/b.md'],
        acceptance: '测试存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: ['a'],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
    ],
  }
  runtime.repo.recordTaskPlan(plan)
  return runtime.repo.taskPlan(reqId, planVersion)!
}

function seedPlanReview(
  reqId: string,
  planVersion = 1,
  verdict: 'pass' | 'block' = 'pass',
): string {
  const stored = runtime.repo.taskPlan(reqId, planVersion)!
  const planSha256 = sha256OfText(JSON.stringify(stored))
  const review = {
    kind: 'plan-review',
    reqId,
    planVersion,
    requirementVersion: stored.requirementVersion,
    planSha256,
    verdict,
    blocking: verdict === 'pass' ? [] : ['任务包缺少正式测试证据'],
    findings: [],
    summary: verdict === 'pass' ? '任务包可进入实现' : '任务包阻断',
    verification_plan: [
      {
        scenario: SCENARIO,
        acceptance_criterion: CRITERION,
        method: '在独立候选上执行正式测试',
        required: true,
      },
    ],
    sessionId: 'session-plan-review',
    at: '2026-10-29T00:00:02.000Z',
  }
  const reportJson = `${JSON.stringify(review, null, 2)}\n`
  const reportPath = join(dir, 'reviews', reqId, `v${planVersion}`, 'plan', 'plan-review.json')
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, reportJson, 'utf8')
  runtime.repo.recordPlanReview({
    requirementId: reqId,
    planVersion,
    requirementVersion: stored.requirementVersion,
    planSha256,
    verdict,
    reportJson,
    reportPath,
    reportSha256: sha256OfText(reportJson),
    sessionId: review.sessionId,
    reviewedAt: review.at,
  })
  return planSha256
}

function deliver(reqId: string, taskId: string, planVersion = 1): void {
  runtime.repo.recordTaskArtifact({
    requirementId: reqId,
    planVersion,
    taskId,
    candidateSha256: `candidate-${taskId}`,
    testEvidenceSha256: `test-${taskId}`,
    reviewSha256: `review-${taskId}`,
    acceptance: '达成',
    authorizationSource: `plan-approval:${reqId}:v${planVersion}:owner`,
    recordedAt: '2026-10-29T00:00:03.000Z',
    baselineCommit: 'abc',
  })
}

function approve(reqId: string, planVersion = 1): void {
  runtime.repo.recordPlanApproval({
    requirementId: reqId,
    planVersion,
    approvedBy: 'owner',
    approvedAt: '2026-10-29T00:00:03.000Z',
    source: 'test',
  })
}

async function runPipeline(): Promise<{
  reqId: string
  advance: Awaited<ReturnType<typeof runQueued>>
}> {
  const submitted = runtime.submit({ text: '实现两个文档改动', by: 'owner', source: 'test' })
  const reqId = (submitted.data as { reqId: string }).reqId
  expect((await runQueued('analyze', reqId)).state).toBe('done')
  expect((await runQueued('plan', reqId)).state).toBe('done')
  const approval = runtime.approvePlan({
    reqId,
    planVersion: 1,
    by: 'owner',
    source: 'dsh-command',
  })
  expect(approval.ok, approval.message).toBe(true)
  return { reqId, advance: await runQueued('advance', reqId) }
}

beforeEach(() => {
  dir = makeProject()
  recordsDir = mkdtempSync(join(tmpdir(), 'forgeloop-verify-records-'))
  runtime = makeRuntime(fakeRunner())
})

afterEach(async () => {
  runtime.close()
  // 验证副本里 git 可能刚写下锁或临时文件，递归删除偶发 ENOTEMPTY；
  // 只影响测试清理，重试几次再判定失败。
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      rmSync(recordsDir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
})

describe('verification materials', () => {
  it('parses a passing plan review only with a required scenario', () => {
    const review = parsePlanReview(planReviewOf('pass'))
    expect(review.verdict).toBe('pass')
    expect(review.verificationPlan).toHaveLength(1)
    expect(review.verificationPlan[0]).toMatchObject({ scenario: SCENARIO, required: true })

    expect(() =>
      parsePlanReview(
        JSON.stringify({
          verdict: 'pass',
          blocking: [],
          findings: [],
          summary: '通过',
          verification_plan: [
            {
              scenario: SCENARIO,
              acceptance_criterion: CRITERION,
              method: '执行',
              required: false,
            },
          ],
        }),
      ),
    ).toThrow(/至少要有一种必过场景/)
    expect(() =>
      parsePlanReview(
        JSON.stringify({ verdict: 'pass', blocking: [], findings: [], summary: '通过' }),
      ),
    ).toThrow(/必须给出验证计划/)
    expect(() =>
      parsePlanReview(
        JSON.stringify({
          verdict: 'pass',
          blocking: ['有阻断'],
          findings: [],
          summary: '通过',
          verification_plan: [],
        }),
      ),
    ).toThrow(/blocking 必须为空/)
    expect(() =>
      parsePlanReview(
        JSON.stringify({ verdict: 'block', blocking: [], findings: [], summary: '阻断' }),
      ),
    ).toThrow(/至少一条阻断原因/)
  })

  it('rejects duplicate or empty verification commands', () => {
    expect(parseVerificationCommands(commandsOf())).toEqual([
      { label: 'smoke', argv: DEFAULT_SMOKE_ARGV },
    ])
    expect(() => parseVerificationCommands(JSON.stringify({ commands: [] }))).toThrow(
      /至少一条命令/,
    )
    expect(() =>
      parseVerificationCommands(
        JSON.stringify({
          commands: [
            { label: 'same', argv: ['node'] },
            { label: 'same', argv: ['node'] },
          ],
        }),
      ),
    ).toThrow(/label 不能重复/)
    expect(() =>
      parseVerificationCommands(JSON.stringify({ commands: [{ label: '', argv: ['node'] }] })),
    ).toThrow()
  })

  it('rejects structurally invalid materials instead of guessing', () => {
    expect(() => parsePlanReview('[]')).toThrow(/必须是 JSON 对象/)
    expect(() => parsePlanReview(JSON.stringify({ verdict: 'maybe' }))).toThrow(/结论必须是/)
    expect(() =>
      parsePlanReview(JSON.stringify({ verdict: 'pass', blocking: [], findings: [], summary: '' })),
    ).toThrow(/summary/)
    expect(() =>
      parsePlanReview(
        JSON.stringify({
          verdict: 'pass',
          blocking: [],
          findings: [],
          summary: '通过',
          verification_plan: 'nope',
        }),
      ),
    ).toThrow(/必须是数组/)
    expect(() =>
      parsePlanReview(
        JSON.stringify({
          verdict: 'pass',
          blocking: [],
          findings: [],
          summary: '通过',
          verification_plan: [
            {
              scenario: SCENARIO,
              acceptance_criterion: CRITERION,
              method: '执行',
              required: 'yes',
            },
          ],
        }),
      ),
    ).toThrow(/required 必须是布尔值/)
    expect(() =>
      parsePlanReview(
        JSON.stringify({
          verdict: 'pass',
          blocking: [],
          findings: [],
          summary: '通过',
          verification_plan: [
            { scenario: SCENARIO, acceptance_criterion: CRITERION, method: '执行', required: true },
            {
              scenario: SCENARIO,
              acceptance_criterion: CRITERION,
              method: '再次执行',
              required: true,
            },
          ],
        }),
      ),
    ).toThrow(/不能重复/)
    expect(() =>
      parsePlanReview(
        JSON.stringify({
          verdict: 'pass',
          blocking: [],
          findings: [],
          summary: '通过',
          verification_plan: [],
        }),
      ),
    ).toThrow(/验证计划不能为空/)

    expect(() => parseVerificationCommands(JSON.stringify({ commands: 'nope' }))).toThrow(
      /至少一条命令/,
    )
    expect(() =>
      parseVerificationCommands(JSON.stringify({ commands: [{ label: 'smoke', argv: [] }] })),
    ).toThrow(/argv/)
    expect(() =>
      parseVerificationCommands(
        JSON.stringify({
          commands: Array.from({ length: 11 }, (_, index) => ({
            label: `c${index}`,
            argv: ['node'],
          })),
        }),
      ),
    ).toThrow(/最多 10 条/)

    expect(() => parseVerificationReport('not json')).toThrow(/可解析/)
    expect(() =>
      parseVerificationReport(
        JSON.stringify({
          verdict: 'pass',
          blocking: [],
          findings: [],
          summary: '通过',
          scenarios: 'nope',
        }),
      ),
    ).toThrow(/scenarios 数组/)
    expect(() =>
      parseVerificationReport(
        JSON.stringify({
          verdict: 'block',
          blocking: [],
          findings: [],
          summary: '阻断',
          scenarios: [],
        }),
      ),
    ).toThrow(/至少一条阻断原因/)
    expect(() =>
      parseVerificationReport(
        JSON.stringify({ verdict: 'pass', blocking: [], findings: [], summary: '', scenarios: [] }),
      ),
    ).toThrow(/summary/)
  })

  it('rejects malformed or self-contradicting verification reports', () => {
    expect(parseVerificationReport(verificationReportOf()).verdict).toBe('pass')
    expect(() =>
      parseVerificationReport(
        JSON.stringify({
          verdict: 'pass',
          blocking: ['矛盾'],
          findings: [],
          summary: '通过',
          scenarios: [],
        }),
      ),
    ).toThrow(/blocking 必须为空/)
    expect(() =>
      parseVerificationReport(
        JSON.stringify({
          verdict: 'pass',
          blocking: [],
          findings: [],
          summary: '通过',
          scenarios: [{ scenario: SCENARIO, status: 'unknown', evidence: '', commands: [] }],
        }),
      ),
    ).toThrow(/status 必须是/)
    expect(() =>
      parseVerificationReport(
        JSON.stringify({
          verdict: 'pass',
          blocking: [],
          findings: [],
          summary: '通过',
          scenarios: [verificationReportOfScenario(), verificationReportOfScenario()],
        }),
      ),
    ).toThrow(/场景不能重复/)
  })

  it('requires every required scenario to pass with evidence', () => {
    const plan = parsePlanReview(planReviewOf('pass')).verificationPlan
    expect(
      validateVerificationCoverage(plan, parseVerificationReport(verificationReportOf())),
    ).toEqual([])
    expect(
      validateVerificationCoverage(
        plan,
        parseVerificationReport(verificationReportOf({ scenario: '其他场景' })),
      ),
    ).toContain(`缺少必过场景的验证结果：${SCENARIO}`)
    expect(
      validateVerificationCoverage(
        plan,
        parseVerificationReport(verificationReportOf({ status: 'fail' })),
      )[0],
    ).toContain('必过场景未通过')
    expect(
      validateVerificationCoverage(
        plan,
        parseVerificationReport(verificationReportOf({ evidence: '' })),
      ),
    ).toContain(`必过场景缺少证据：${SCENARIO}`)
  })

  it('requires the verification plan to cover every analysis scenario and criterion', () => {
    const review = parsePlanReview(planReviewOf('pass'))
    expect(
      validatePlanCoverage({ scenarios: [SCENARIO], acceptanceCriteria: [CRITERION] }, review),
    ).toEqual([])
    expect(
      validatePlanCoverage({ scenarios: ['其他场景'], acceptanceCriteria: [CRITERION] }, review),
    ).toEqual(['验证计划缺少业务场景：其他场景'])
    expect(
      validatePlanCoverage({ scenarios: [SCENARIO], acceptanceCriteria: ['其他标准'] }, review),
    ).toEqual(['验证计划缺少验收标准：其他标准'])
  })
})

function verificationReportOfScenario(): Record<string, unknown> {
  return { scenario: SCENARIO, status: 'pass', evidence: '通过', commands: ['smoke'] }
}

describe('pre-implementation review gate', () => {
  it('refuses approval without a current, passing and intact review', () => {
    const reqId = 'req-gate'
    runtime.repo.submit({
      reqId,
      project: 'testproj',
      text: '审批门禁',
      submittedBy: 'owner',
      source: 'test',
      now: '2026-10-29T00:00:00.000Z',
    })
    seedPlan(reqId)

    expect(
      runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' }),
    ).toMatchObject({
      ok: false,
      code: 'plan_review_required',
    })

    seedPlanReview(reqId, 1, 'block')
    expect(
      runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' }),
    ).toMatchObject({
      ok: false,
      code: 'plan_review_blocked',
    })

    // 评审绑定的任务包摘要与当前任务包不一致时视为过期。
    runtime.repo.recordPlanReview({
      requirementId: reqId,
      planVersion: 1,
      requirementVersion: 1,
      planSha256: 'f'.repeat(64),
      verdict: 'pass',
      reportJson: planReviewOf('pass'),
      reportPath: join(dir, 'stale-review.json'),
      reportSha256: 'e'.repeat(64),
      sessionId: 'session-stale',
      reviewedAt: '2026-10-29T00:00:02.000Z',
    })
    writeFileSync(join(dir, 'stale-review.json'), planReviewOf('pass'), 'utf8')
    expect(
      runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' }),
    ).toMatchObject({
      ok: false,
      code: 'plan_review_stale',
    })

    // 摘要匹配但证据文件缺失同样不能批准。
    const correct = seedPlanReview(reqId, 1, 'pass')
    runtime.repo.recordPlanReview({
      requirementId: reqId,
      planVersion: 1,
      requirementVersion: 1,
      planSha256: correct,
      verdict: 'pass',
      reportJson: planReviewOf('pass'),
      reportPath: join(dir, 'missing-review.json'),
      reportSha256: sha256OfText(planReviewOf('pass')),
      sessionId: 'session-missing',
      reviewedAt: '2026-10-29T00:00:02.000Z',
    })
    expect(
      runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' }),
    ).toMatchObject({
      ok: false,
      code: 'plan_review_invalid',
    })

    seedPlanReview(reqId, 1, 'pass')
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' }).ok).toBe(
      true,
    )
  })

  it('refuses to approve a stored plan that violates current task rules', () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    const reqId = 'req-invalid-plan'
    runtime.repo.submit({
      reqId,
      project: 'testproj',
      text: '旧任务包',
      submittedBy: 'owner',
      source: 'test',
      now: '2026-10-29T00:00:00.000Z',
    })
    runtime.repo.recordAnalysis({
      reqId,
      analysisVersion: 1,
      requirementVersion: 1,
      goal: '旧任务包',
      scenarios: ['任务按依赖完成'],
      acceptanceCriteria: ['两个任务交付且测试通过'],
      clarifications: [],
      createdAt: '2026-10-29T00:00:00.000Z',
    })
    // 直接写入不合规的任务包：任务没有允许修改文件。批准入口必须按现行规则拒绝。
    runtime.repo.db.handle
      .prepare(
        'INSERT INTO requirement_task_plans (req_id, plan_version, task_plan_id, plan, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        reqId,
        1,
        `plan-${reqId}-1`,
        JSON.stringify({
          task_plan_id: `plan-${reqId}-1`,
          requirement_id: reqId,
          project: 'testproj',
          plan_version: 1,
          requirement_version: 1,
          created_at: '2026-10-29T00:00:01.000Z',
          tasks: [
            {
              task_id: 'a',
              goal: '写实现',
              files: ['packages/forgeloop/src/a.ts'],
              acceptance: 'a 完成',
              test_command: ['node', '-e', 'process.exit(0)'],
              depends_on: [],
              limits: { limit_seconds: 60, max_failure_rounds: 2 },
              authorization_source: '',
            },
            {
              task_id: 'b',
              goal: '验证',
              files: [],
              acceptance: 'b 完成',
              test_command: ['node', '-e', 'process.exit(0)'],
              depends_on: ['a'],
              limits: { limit_seconds: 60, max_failure_rounds: 2 },
              authorization_source: '',
            },
          ],
        }),
        '2026-10-29T00:00:01.000Z',
      )
    seedPlanReview(reqId, 1, 'pass')
    expect(
      runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' }),
    ).toMatchObject({
      ok: false,
      code: 'plan_invalid',
    })
  })

  it('treats a review plan missing analysis coverage as blocking and replans', async () => {
    runtime.close()
    let attempts = 0
    runtime = makeRuntime(
      fakeRunner({
        verifyPlan: (attempt) => {
          attempts = attempt
          if (attempt === 1) {
            return JSON.stringify({
              verdict: 'pass',
              blocking: [],
              findings: [],
              summary: '验证计划覆盖不完整',
              verification_plan: [
                {
                  scenario: '其他场景',
                  acceptance_criterion: CRITERION,
                  method: '执行其他场景',
                  required: true,
                },
              ],
            })
          }
          return planReviewOf('pass')
        },
      }),
    )
    const submitted = runtime.submit({ text: '验证计划覆盖', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    const planned = await runQueued('plan', reqId)
    expect(planned.state, planned.detail).toBe('done')
    expect(attempts).toBe(2)
    // 覆盖缺项属于评审材料问题：带着精确缺项重试同一任务包的评审，
    // 修正后的评审才落库；任务包本身不需要因为评审措辞重生成。
    expect(runtime.repo.taskPlans(reqId)).toHaveLength(1)
    expect(runtime.repo.planReview(reqId, 1)?.verdict).toBe('pass')
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' }).ok).toBe(
      true,
    )
  })

  it('records a blocking review after coverage stays missing and sends it back to planning', async () => {
    runtime.close()
    let attempts = 0
    runtime = makeRuntime(
      fakeRunner({
        verifyPlan: (attempt) => {
          attempts = attempt
          return JSON.stringify({
            verdict: 'pass',
            blocking: [],
            findings: [],
            summary: '验证计划覆盖不完整',
            verification_plan: [
              {
                scenario: '其他场景',
                acceptance_criterion: CRITERION,
                method: '执行其他场景',
                required: true,
              },
            ],
          })
        },
      }),
    )
    const submitted = runtime.submit({ text: '覆盖持续缺失', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    const planned = await runQueued('plan', reqId)
    expect(planned.state).toBe('failed')
    expect(attempts).toBe(6) // 3 次规划 × 每次 2 次评审
    expect(runtime.repo.taskPlans(reqId)).toHaveLength(3)
    const latest = runtime.repo.latestTaskPlan(reqId)!
    const review = runtime.repo.planReview(reqId, latest.planVersion)!
    expect(review.verdict).toBe('block')
    expect(review.reportJson).toContain(`验证计划缺少业务场景：${SCENARIO}`)
    expect(
      runtime.approvePlan({ reqId, planVersion: latest.planVersion, by: 'owner', source: 'test' }),
    ).toMatchObject({
      ok: false,
      code: 'plan_review_blocked',
    })
  })

  it('keeps the plan unapproved when the review agent fails or returns malformed output', async () => {
    runtime.close()
    const base = fakeRunner()
    const failing: AgentLike = {
      async run(request) {
        if (request.role === 'verify' && request.prompt.includes('正在做实现前评审'))
          return result(request, '', 'error')
        return base.run(request)
      },
    }
    runtime = makeRuntime(failing)
    const submitted = runtime.submit({ text: '评审失败', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    const failedReview = await runQueued('plan', reqId)
    expect(failedReview.state).toBe('failed')
    expect(failedReview.detail).toContain('实现前评审未取得可用结论')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('plan_proposed')
    expect(runtime.repo.planReview(reqId, 1)).toBeNull()
    expect(
      runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' }),
    ).toMatchObject({
      ok: false,
      code: 'plan_review_required',
    })

    // 评审输出不是合法 JSON 时同样 fail-closed；旧任务包仍未被批准。
    runtime.close()
    const malformed: AgentLike = {
      async run(request) {
        if (request.role === 'verify' && request.prompt.includes('正在做实现前评审'))
          return result(request, 'not json')
        return base.run(request)
      },
    }
    runtime = makeRuntime(malformed)
    const malformedReview = await runQueued('plan', reqId)
    expect(malformedReview.state).toBe('failed')
    expect(malformedReview.detail).toContain('实现前评审结果畸形')
    expect(runtime.repo.taskPlans(reqId)).toHaveLength(2)
    expect(runtime.repo.planReview(reqId, 2)).toBeNull()
    expect(
      runtime.approvePlan({ reqId, planVersion: 2, by: 'owner', source: 'test' }),
    ).toMatchObject({
      ok: false,
      code: 'plan_review_required',
    })
  })

  it('degrades malformed stored evidence when rendering views', () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    const reqId = 'req-view'
    runtime.repo.submit({
      reqId,
      project: 'testproj',
      text: '视图降级',
      submittedBy: 'owner',
      source: 'test',
      now: '2026-10-29T00:00:00.000Z',
    })
    seedPlan(reqId)
    const reportPath = join(dir, 'malformed-review.json')
    writeFileSync(reportPath, 'not json', 'utf8')
    runtime.repo.recordPlanReview({
      requirementId: reqId,
      planVersion: 1,
      requirementVersion: 1,
      planSha256: 'a'.repeat(64),
      verdict: 'pass',
      reportJson: 'not json',
      reportPath,
      reportSha256: sha256OfText('not json'),
      sessionId: 'session-view',
      reviewedAt: '2026-10-29T00:00:02.000Z',
    })
    runtime.repo.recordVerification({
      requirementId: reqId,
      planVersion: 1,
      candidateSha256: 'b'.repeat(64),
      requirementVersion: 1,
      workspaceSha256: 'tree',
      verdict: 'pass',
      reportJson: 'not json',
      reportPath,
      reportSha256: sha256OfText('not json'),
      evidenceDir: dir,
      sessionId: 'session-view',
      verifiedAt: '2026-10-29T00:00:03.000Z',
    })

    const view = runtime.status(reqId).data as {
      planReview: { verdict: string; summary: string; verificationPlan: unknown[] }
      verification: { verdict: string; summary: string; blocking: unknown[]; fresh: boolean }
    }
    expect(view.planReview).toMatchObject({ verdict: 'pass', summary: '', verificationPlan: [] })
    expect(view.verification).toMatchObject({
      verdict: 'pass',
      summary: '',
      blocking: [],
      fresh: false,
    })
  })

  it('treats a malformed review as a retriable planning failure instead of ending the loop', async () => {
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({
        verifyPlan: (attempt) =>
          attempt === 1
            ? JSON.stringify({
                verdict: 'pass',
                blocking: [],
                findings: [],
                summary: '可进入实现',
                verification_plan: [
                  {
                    scenario: SCENARIO,
                    acceptance_criterion: CRITERION,
                    method: '在独立候选上执行验证命令',
                    required: true,
                  },
                  {
                    scenario: SCENARIO,
                    acceptance_criterion: CRITERION,
                    method: '重复场景',
                    required: true,
                  },
                ],
              })
            : planReviewOf('pass'),
      }),
    )
    const submitted = runtime.submit({ text: '评审畸形后重试', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    const planned = await runQueued('plan', reqId)
    expect(planned.state, planned.detail).toBe('done')

    // 畸形评审没有写成可批准的结论：重试后取得的合法评审才落库。
    expect(runtime.repo.taskPlans(reqId)).toHaveLength(1)
    expect(runtime.repo.planReview(reqId, 1)?.verdict).toBe('pass')
    expect(runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' }).ok).toBe(
      true,
    )
  })

  it('stops after repeated malformed reviews and keeps the failure visible', async () => {
    runtime.close()
    runtime = makeRuntime({
      ...fakeRunner(),
      async run(request) {
        if (request.role === 'verify' && request.prompt.includes('正在做实现前评审'))
          return result(request, 'not json at all')
        return fakeRunner().run(request)
      },
    } as AgentLike)
    const submitted = runtime.submit({ text: '评审持续畸形', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    const planned = await runQueued('plan', reqId)
    expect(planned.state).toBe('failed')
    expect(planned.detail).toContain('实现前评审')
    expect(runtime.repo.planReview(reqId, 1)).toBeNull()
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('plan_proposed')
    expect(runtime.repo.getRequirement(reqId)?.blockedReason).toContain('实现前评审')
  })

  it('feeds a blocking review back to planning and accepts the corrected plan', async () => {
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({
        verifyPlan: (attempt) => planReviewOf(attempt === 1 ? 'block' : 'pass'),
      }),
    )
    const submitted = runtime.submit({ text: '先阻断再修正', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runQueued('analyze', reqId)
    const planned = await runQueued('plan', reqId)
    expect(planned.state, planned.detail).toBe('done')

    // 第一次任务包被阻断后重新规划；两个版本都保留评审记录。
    expect(runtime.repo.taskPlans(reqId)).toHaveLength(2)
    expect(runtime.repo.planReview(reqId, 1)?.verdict).toBe('block')
    expect(runtime.repo.planReview(reqId, 2)?.verdict).toBe('pass')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('plan_proposed')
    expect(runtime.approvePlan({ reqId, planVersion: 2, by: 'owner', source: 'test' }).ok).toBe(
      true,
    )
  })
})

describe('coverage acceptance of wording variance', () => {
  it('accepts a plan entry that quotes the analysis text verbatim and adds testable detail', () => {
    const review = parsePlanReview(
      JSON.stringify({
        verdict: 'pass',
        blocking: [],
        findings: [],
        summary: '可进入实现',
        verification_plan: [
          {
            scenario: `${SCENARIO}（覆盖依赖顺序）`,
            acceptance_criterion: `${CRITERION}；并核对两个任务的交付证据`,
            method: '在独立候选上执行验证命令',
            required: true,
          },
        ],
      }),
    )
    expect(
      validatePlanCoverage({ scenarios: [SCENARIO], acceptanceCriteria: [CRITERION] }, review),
    ).toEqual([])
  })

  it('still blocks a plan entry that paraphrases instead of referencing the analysis text', () => {
    const review = parsePlanReview(
      JSON.stringify({
        verdict: 'pass',
        blocking: [],
        findings: [],
        summary: '可进入实现',
        verification_plan: [
          {
            scenario: '依赖按顺序完成',
            acceptance_criterion: '两个任务都交付了',
            method: '在独立候选上执行验证命令',
            required: true,
          },
        ],
      }),
    )
    expect(
      validatePlanCoverage({ scenarios: [SCENARIO], acceptanceCriteria: [CRITERION] }, review),
    ).toEqual([`验证计划缺少业务场景：${SCENARIO}`, `验证计划缺少验收标准：${CRITERION}`])
  })

  it('matches references after collapsing whitespace differences', () => {
    const review = parsePlanReview(
      JSON.stringify({
        verdict: 'pass',
        blocking: [],
        findings: [],
        summary: '可进入实现',
        verification_plan: [
          {
            scenario: '任务按依赖   完成',
            acceptance_criterion: '两个任务交付且测试通过',
            method: '在独立候选上执行验证命令',
            required: true,
          },
        ],
      }),
    )
    expect(
      validatePlanCoverage({ scenarios: [SCENARIO], acceptanceCriteria: [CRITERION] }, review),
    ).toEqual([])
  })
})

describe('verification result judgement', () => {
  const plan: VerificationPlan = {
    scenarios: [
      {
        scenario: SCENARIO,
        acceptanceCriterion: CRITERION,
        method: '运行方案里的命令并核对输出',
        required: true,
        checks: [
          { label: 'slow', argv: ['node', '-e', 'sleep'], expectedOutput: '' },
          { label: 'noisy', argv: ['node', '-e', 'print'], expectedOutput: 'READY' },
        ],
      },
    ],
  }
  const artifact = {
    requirementVersion: 1,
    candidateSha256: 'a'.repeat(64),
    workspace: '/tmp/forgeloop-verification',
  }
  const environment = {
    platform: 'darwin',
    nodeVersion: 'v22.0.0',
    startedAt: '2026-11-02T00:00:00.000Z',
  }
  const finishedAt = '2026-11-02T00:01:00.000Z'
  const run = (over: Partial<VerificationCheckRun>): VerificationCheckRun => ({
    label: 'slow',
    argv: [],
    exitCode: 0,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    output: '',
    ...over,
  })

  it('fails a timed-out command and an output that misses the expected evidence', () => {
    const result = judgeVerificationResult({
      plan,
      artifact,
      environment,
      finishedAt,
      checks: [run({ label: 'slow', timedOut: true }), run({ label: 'noisy', output: 'done' })],
    })
    expect(result.verdict).toBe('failed')
    expect(result.failures).toEqual([
      '验证命令超时：slow',
      '验证命令输出缺少预期片段：noisy（预期 READY）',
    ])
  })

  it('fails a missing run, an aborted command, an unknown exit code and an empty scenario', () => {
    const missing = judgeVerificationResult({
      plan,
      artifact,
      environment,
      finishedAt,
      checks: [run({ label: 'noisy', output: 'READY' })],
    })
    expect(missing.failures).toEqual(['缺少验证命令执行结果：slow'])

    const aborted = judgeVerificationResult({
      plan,
      artifact,
      environment,
      finishedAt,
      checks: [run({ label: 'slow', aborted: true }), run({ label: 'noisy', output: 'READY' })],
    })
    expect(aborted.failures).toEqual(['验证命令被中止：slow'])

    const unknown = judgeVerificationResult({
      plan,
      artifact,
      environment,
      finishedAt,
      checks: [run({ label: 'slow', exitCode: null }), run({ label: 'noisy', output: 'READY' })],
    })
    expect(unknown.failures).toEqual(['验证命令失败：slow（退出码 null）'])

    const empty = judgeVerificationResult({
      plan: {
        scenarios: [{ ...plan.scenarios[0]!, checks: [] }],
      },
      artifact,
      environment,
      finishedAt,
      checks: [],
    })
    expect(empty.failures).toEqual([`验证场景没有可执行命令：${SCENARIO}`])
  })
})

describe('independent verification gate', () => {
  it('requires delivery, a passing review and a recorded request to start verification', () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    const reqId = 'req-request'
    runtime.repo.submit({
      reqId,
      project: 'testproj',
      text: '验证请求门禁',
      submittedBy: 'owner',
      source: 'test',
      now: '2026-10-29T00:00:00.000Z',
    })
    seedPlan(reqId)
    approve(reqId)

    expect(
      runtime.requestOperation({ reqId, action: 'verify', by: 'owner', source: 'test' }),
    ).toMatchObject({ ok: false, code: 'not_delivered' })

    deliver(reqId, 'a')
    deliver(reqId, 'b')
    const queued = runtime.requestOperation({
      reqId,
      action: 'verify',
      by: 'owner',
      source: 'test',
    })
    expect(queued.ok, queued.message).toBe(true)
    expect((queued.data as { action: string }).action).toBe('verify')
  })

  it('verifies the fixed candidate, records evidence and unlocks acceptance', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    const { reqId, advance } = await runPipeline()
    expect(advance.state, advance.detail).toBe('done')

    const plan = runtime.repo.latestTaskPlan(reqId)!
    const artifacts = runtime.repo.taskArtifacts(reqId, plan.planVersion)
    const identity = candidateIdentityOf({
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      baselineCommit: artifacts[0]!.baselineCommit,
      candidateHashes: artifacts.map((artifact) => artifact.candidateSha256),
    })
    const verification = runtime.repo.verification(reqId, plan.planVersion)!
    expect(verification.verdict).toBe('pass')
    expect(verification.candidateSha256).toBe(identity)
    expect(verification.requirementVersion).toBe(1)
    expect(verification.reportPath).toContain(identity.slice(0, 16))
    expect(sha256OfText(readFileSync(verification.reportPath, 'utf8'))).toBe(
      verification.reportSha256,
    )
    const report = parseVerificationReport(verification.reportJson)
    expect(report.verdict).toBe('pass')
    expect(report.scenarios[0]).toMatchObject({ scenario: SCENARIO, status: 'pass' })
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('executing')

    const accepted = runtime.accept({ reqId, by: 'owner', source: 'test' })
    expect(accepted.ok, accepted.message).toBe(true)
    const binding = (accepted.data as { binding: Record<string, string> }).binding
    expect(binding.verificationSha256).toBe(verification.reportSha256)
    expect(binding.verificationCandidateSha256).toBe(identity)
  })

  it('does not rerun verification for a candidate that already passed', async () => {
    let verifyRuns = 0
    runtime.close()
    runtime = makeRuntime(fakeRunner({ onVerify: () => (verifyRuns += 1) }))
    const { reqId } = await runPipeline()
    expect(verifyRuns).toBe(1)

    const again = await runQueued('verify', reqId)
    expect(again.state, again.detail).toBe('done')
    expect(again.detail).toContain('已通过独立验证')
    expect(verifyRuns).toBe(1)
  })

  it('reports a failed verification agent without inventing a verdict', async () => {
    runtime.close()
    const base = fakeRunner()
    const failing: AgentLike = {
      async run(request) {
        if (request.role === 'verify' && request.prompt.includes('独立验证 Agent'))
          return result(request, '', 'error')
        return base.run(request)
      },
    }
    runtime = makeRuntime(failing)
    const { reqId, advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('独立验证未取得可用结论')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
    expect(runtime.repo.verification(reqId, 1)).toBeNull()
  })

  it('fails closed on malformed verification materials', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ workspace: { report: 'not json' } }))
    const { advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('独立验证材料畸形')
  })

  it('reports an already blocked candidate instead of rerunning it', async () => {
    let verifyRuns = 0
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({
        workspace: {
          commands: commandsOf([
            'node',
            '-e',
            "console.error('AssertionError: expected 3 rounds, got 4'); process.exit(1)",
          ]),
        },
        onVerify: () => (verifyRuns += 1),
      }),
    )
    const { reqId } = await runPipeline()
    // 每次阻断都会回研发修复；额度用尽后停在 blocked，不再自动重跑。
    expect(verifyRuns).toBe(3)
    const again = runtime.requestOperation({ reqId, action: 'verify', by: 'owner', source: 'test' })
    expect(again).toMatchObject({ ok: false, code: 'grant_required' })
    expect(verifyRuns).toBe(3)
  })

  it('blocks on a failing verification command and counts a verification failure round', async () => {
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({ workspace: { commands: commandsOf(['node', '-e', 'process.exit(1)']) } }),
    )
    const { reqId, advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('验证命令失败')
    const plan = runtime.repo.latestTaskPlan(reqId)!
    expect(runtime.repo.verification(reqId, plan.planVersion)?.verdict).toBe('block')
    expect(runtime.repo.failureRounds(reqId).some((round) => round.stage === 'verification')).toBe(
      true,
    )
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'verification_blocked',
    })
  })

  it('blocks when the required scenario lacks evidence even if every command passed', async () => {
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({ workspace: { report: verificationReportOf({ evidence: '' }) } }),
    )
    const { reqId, advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain(`必过场景缺少证据：${SCENARIO}`)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })

  it('rejects a verification agent that edits outside the verification directory', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ workspace: { outside: 'docs/evil.md' } }))
    const { advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('越出独立验证目录')
  })

  it('fails closed when the verification agent writes no materials', async () => {
    runtime.close()
    const runner = fakeRunner()
    const silent: AgentLike = {
      async run(request) {
        if (request.role === 'verify' && request.prompt.includes('独立验证 Agent')) {
          return result(request, verificationReportOf())
        }
        return runner.run(request)
      },
    }
    runtime = makeRuntime(silent)
    const { advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('未产出命令清单或逐场景报告')
  })

  it('rejects acceptance against a tampered report or a different candidate', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner())
    const { reqId } = await runPipeline()
    const plan = runtime.repo.latestTaskPlan(reqId)!
    const verification = runtime.repo.verification(reqId, plan.planVersion)!

    writeFileSync(verification.reportPath, `${verification.reportJson}\n篡改\n`, 'utf8')
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'verification_invalid',
    })

    // 还原报告后，候选身份变化同样使旧验证失效。
    writeFileSync(verification.reportPath, verification.reportJson, 'utf8')
    const artifact = runtime.repo.taskArtifact(reqId, plan.planVersion, 'b')!
    runtime.repo.recordTaskArtifact({ ...artifact, candidateSha256: 'f'.repeat(64) })
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'verification_stale',
    })
  })

  it('blocks a report that cites a verification command that was never executed', async () => {
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({ workspace: { report: verificationReportOf({ commands: ['never-run'] }) } }),
    )
    const { reqId, advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('引用了未执行的验证命令：never-run')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })

  it('blocks scenario evidence that cannot be checked against the executed output', async () => {
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({
        workspace: {
          commands: commandsOf(),
          report: verificationReportOf({ evidence: '所有场景均已通过，无需复核' }),
        },
      }),
    )
    const { reqId, advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('证据无法在验证命令输出中核对')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })

  it('blocks verification commands that change the fixed candidate', async () => {
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({
        workspace: {
          commands: commandsOf([
            'node',
            '-e',
            `require('fs').appendFileSync('docs/a.md', 'tampered\\n'); console.log('${SMOKE_OUTPUT}')`,
          ]),
        },
      }),
    )
    const { reqId, advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('验证命令修改了固定候选：docs/a.md')
    expect(runtime.repo.verification(reqId, 1)?.verdict).toBe('block')
    expect(runtime.accept({ reqId, by: 'owner', source: 'test' })).toMatchObject({
      ok: false,
      code: 'verification_blocked',
    })
  })

  it('blocks verification commands that add unprotected files outside verification/', async () => {
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({
        workspace: {
          commands: commandsOf([
            'node',
            '-e',
            `require('fs').mkdirSync('docs', { recursive: true }); require('fs').writeFileSync('docs/extra.md', 'x'); console.log('${SMOKE_OUTPUT}')`,
          ]),
        },
      }),
    )
    const { advance } = await runPipeline()
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('验证命令修改了固定候选：docs/extra.md')
  })

  it('allows ignored build output while the tracked candidate stays unchanged', async () => {
    runtime.close()
    runtime = makeRuntime(
      fakeRunner({
        workspace: {
          commands: commandsOf([
            'node',
            '-e',
            `require('fs').mkdirSync('coverage', { recursive: true }); require('fs').writeFileSync('coverage/out.txt', 'x'); console.log('${SMOKE_OUTPUT}')`,
          ]),
        },
      }),
    )
    const { reqId, advance } = await runPipeline()
    expect(advance.state, advance.detail).toBe('done')
    expect(runtime.repo.verification(reqId, 1)?.verdict).toBe('pass')
  })
})

const EXTRA_SCENARIO = '异常输入被拒绝'
const EXTRA_CRITERION = '错误输出包含原因'
const BUSINESS_RULE = '未登录用户的写入请求一律拒绝'
const EDGE_CASE = '空标题必须返回明确错误'

/** 验证 Agent 只拿需求原文与分析；不接触任务包、候选或实现代码。 */
function requirementForVerificationPlan(): {
  requirement: Requirement
  analysis: RequirementAnalysis
} {
  return {
    requirement: {
      reqId: 'req-verification-agent-1',
      project: 'testproj',
      status: 'specified',
      blockedReason: '',
      versions: [
        {
          version: 1,
          text: '实现验证 Agent：依据需求说明生成验证方案并执行。',
          createdAt: '2026-10-31T00:00:00.000Z',
          revisedBy: 'owner',
          source: 'dsh-session:sess-plan:msg-plan',
        },
      ],
      submittedBy: 'owner',
      source: 'dsh-session:sess-plan:msg-plan',
    },
    analysis: {
      analysisVersion: 1,
      requirementVersion: 1,
      goal: '验证 Agent 依据需求说明验证研发产物',
      scenarios: [SCENARIO, EXTRA_SCENARIO],
      acceptanceCriteria: [CRITERION, EXTRA_CRITERION],
      businessRules: [BUSINESS_RULE],
      exceptions: [EDGE_CASE],
      clarifications: [],
      createdAt: '2026-10-31T00:01:00.000Z',
    },
  }
}

function requirementVerificationPlanOf(
  options: { skipExtraScenario?: boolean; skipRules?: 'rule' | 'exception' } = {},
): string {
  const rule = options.skipRules === 'rule' ? '' : `；业务规则：${BUSINESS_RULE}`
  const edge = options.skipRules === 'exception' ? '' : `；异常与边界：${EDGE_CASE}`
  const scenarios: Array<Record<string, unknown>> = [
    {
      scenario: SCENARIO,
      acceptance_criterion: CRITERION,
      method: `在独立工作区执行成功路径并核对输出${rule}${edge}`,
      required: true,
      checks: [
        {
          label: 'happy-path',
          argv: ['node', '-e', "console.log('verified ok')"],
          expected_output: 'verified ok',
        },
        {
          label: 'happy-path-negative',
          argv: ['node', '-e', 'process.exit(1)'],
          expect_failure: true,
        },
      ],
    },
  ]
  if (!options.skipExtraScenario) {
    scenarios.push({
      scenario: EXTRA_SCENARIO,
      acceptance_criterion: EXTRA_CRITERION,
      method: '在独立工作区执行异常输入并核对错误原因',
      required: true,
      checks: [
        {
          label: 'reject-path',
          argv: ['node', '-e', "console.log('rejected: bad input')"],
          expected_output: 'rejected',
        },
        {
          label: 'reject-path-negative',
          argv: ['node', '-e', 'process.exit(1)'],
          expect_failure: true,
        },
      ],
    })
  }
  return JSON.stringify({ scenarios })
}

function taskPlanForVerification(): TaskPlan {
  return {
    taskPlanId: 'plan-verification-agent-1',
    requirementId: 'req-verification-agent-1',
    project: 'testproj',
    planVersion: 2,
    requirementVersion: 1,
    createdAt: '2026-10-31T00:02:00.000Z',
    tasks: [
      {
        taskId: 't1',
        goal: '依据需求说明生成结构化验证方案',
        files: ['src/agents/verification-agent.ts'],
        acceptance: '方案可以解析并覆盖需求说明',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
    ],
  }
}

function makeVerificationAgent(
  options: {
    planText?: string
    /** 按调用顺序返回的方案文本；用完后回落到 planText 或默认方案。 */
    planTexts?: string[]
    planStatus?: VerificationSessionResult['status']
  } = {},
): { agent: VerificationAgent; turns: VerificationSessionTurn[] } {
  const turns: VerificationSessionTurn[] = []
  let call = 0
  const agent = new VerificationAgent({
    session: {
      sessionId: 'session-verify-plan',
      async send(turn) {
        turns.push(turn)
        const scripted = options.planTexts?.[call]
        call += 1
        return {
          status: options.planStatus ?? 'completed',
          text: scripted ?? options.planText ?? requirementVerificationPlanOf(),
          reason: '模型未完成',
        }
      },
    },
    timeoutMs: 30_000,
  })
  return { agent, turns }
}

const VERIFY_PLAN_TRANSCRIPT = () => join(dir, 'sessions', 'verify-plan.jsonl')

describe('requirement-derived verification plan', () => {
  it('designs a structured executable plan from the requirement description before any artifact exists', async () => {
    const { requirement, analysis } = requirementForVerificationPlan()
    const harness = makeVerificationAgent()

    const plan = await harness.agent.plan({
      requirement,
      analysis,
      plan: taskPlanForVerification(),
      transcriptPath: VERIFY_PLAN_TRANSCRIPT(),
    })

    expect(plan.scenarios).toHaveLength(2)
    expect(plan.scenarios[0]).toMatchObject({
      scenario: SCENARIO,
      acceptanceCriterion: CRITERION,
      required: true,
    })
    expect(plan.scenarios[0]?.checks[0]).toMatchObject({
      label: 'happy-path',
      expectedOutput: 'verified ok',
    })
    expect(validateRequirementVerificationPlan(analysis, plan)).toEqual([])

    expect(harness.turns).toHaveLength(1)
    const prompt = harness.turns[0]!.prompt
    expect(prompt).toContain(requirement.versions[0]!.text)
    expect(prompt).toContain(SCENARIO)
    expect(prompt).toContain(EXTRA_CRITERION)
    // 业务规则与异常边界进入方案输入，非目标只作背景。
    expect(prompt).toContain(BUSINESS_RULE)
    expect(prompt).toContain(EDGE_CASE)
    // 已准入任务包只提供任务目标用于核对覆盖面。
    expect(prompt).toContain('依据需求说明生成结构化验证方案')
    // 异常断言给出可复制的自包含骨架，减少自由发挥。
    expect(prompt).toContain('异常断言可参考这个骨架')
    expect(prompt).toContain('mkdtempSync')
    // 方案阶段不接触候选身份、diff 或任务包字段名。
    expect(prompt).not.toContain('candidateSha256')
    expect(prompt).not.toContain('diff --git')
    expect(prompt).not.toContain('task_id')
  })

  it('refuses a plan that misses an analysis scenario or criterion', async () => {
    const { requirement, analysis } = requirementForVerificationPlan()
    const harness = makeVerificationAgent({
      planText: requirementVerificationPlanOf({ skipExtraScenario: true }),
    })

    await expect(
      harness.agent.plan({
        requirement,
        analysis,
        plan: taskPlanForVerification(),
        transcriptPath: VERIFY_PLAN_TRANSCRIPT(),
      }),
    ).rejects.toThrow('验证方案未覆盖需求说明')
  })

  it('repairs a plan that misses an analysis item by retrying with the missing text', async () => {
    const { requirement, analysis } = requirementForVerificationPlan()
    const harness = makeVerificationAgent({
      planTexts: [
        requirementVerificationPlanOf({ skipExtraScenario: true }),
        requirementVerificationPlanOf(),
      ],
    })

    const plan = await harness.agent.plan({
      requirement,
      analysis,
      plan: taskPlanForVerification(),
      transcriptPath: VERIFY_PLAN_TRANSCRIPT(),
    })

    expect(harness.turns).toHaveLength(2)
    // 第二次投递必须带上缺失原文，模型才能逐字补抄。
    expect(harness.turns[1]!.prompt).toContain('上一次方案未通过覆盖校验')
    expect(harness.turns[1]!.prompt).toContain(EXTRA_CRITERION)
    expect(harness.turns[1]!.transcriptPath).toContain('-a2.jsonl')
    expect(validateRequirementVerificationPlan(analysis, plan)).toEqual([])
  })

  it('retries a paraphrased plan a third time and still fails closed', async () => {
    const { requirement, analysis } = requirementForVerificationPlan()
    const missing = requirementVerificationPlanOf({ skipRules: 'rule' })
    const repaired = makeVerificationAgent({
      planTexts: [missing, missing, requirementVerificationPlanOf()],
    })
    const plan = await repaired.agent.plan({
      requirement,
      analysis,
      plan: taskPlanForVerification(),
      transcriptPath: VERIFY_PLAN_TRANSCRIPT(),
    })
    // 同一处漏抄连续两次后仍允许第三次补抄，且反馈里给出要逐字复制的原文。
    expect(repaired.turns).toHaveLength(3)
    expect(repaired.turns[2]!.prompt).toContain('逐字复制')
    expect(repaired.turns[2]!.prompt).toContain(BUSINESS_RULE)
    expect(repaired.turns[2]!.transcriptPath).toContain('-a3.jsonl')
    expect(validateRequirementVerificationPlan(analysis, plan)).toEqual([])

    const hopeless = makeVerificationAgent({ planTexts: [missing, missing, missing] })
    await expect(
      hopeless.agent.plan({
        requirement,
        analysis,
        plan: taskPlanForVerification(),
        transcriptPath: VERIFY_PLAN_TRANSCRIPT(),
      }),
    ).rejects.toThrow('验证方案未覆盖需求说明')
  })

  it('requires an executable assertion for the output marker named by an exception', () => {
    const analysis = {
      scenarios: [SCENARIO],
      acceptanceCriteria: [CRITERION],
      exceptions: ['文件缺失时测试命令必须退出非零并输出 missing。'],
    }
    const withoutMarker = parseRequirementVerificationPlan(requirementVerificationPlanOf())
    const issues = validateRequirementVerificationPlan(analysis, withoutMarker)
    expect(issues.join('；')).toContain('缺少异常标记断言')
    expect(issues.join('；')).toContain('missing')

    const withMarker = parseRequirementVerificationPlan(
      requirementVerificationPlanOf().replace(
        '"expected_output":"verified ok"',
        '"expected_output":"missing"',
      ),
    )
    expect(
      validateRequirementVerificationPlan(analysis, withMarker).filter((issue) =>
        issue.includes('异常标记断言'),
      ),
    ).toEqual([])
  })

  it('requires the exception assertion command to build its own temp input', () => {
    const analysis = {
      scenarios: [SCENARIO],
      acceptanceCriteria: [CRITERION],
      exceptions: ['文件缺失时测试命令必须退出非零并输出 missing。'],
    }
    const repoDependent = parseRequirementVerificationPlan(
      requirementVerificationPlanOf()
        .replace('"expected_output":"verified ok"', '"expected_output":"missing"')
        .replace(
          "console.log('verified ok')",
          "console.log(require('node:fs').existsSync('docs/x.md') ? 'missing' : 'ok')",
        ),
    )
    expect(validateRequirementVerificationPlan(analysis, repoDependent).join('；')).toContain(
      '必须自建临时输入',
    )

    const selfContained = parseRequirementVerificationPlan(
      requirementVerificationPlanOf()
        .replace('"expected_output":"verified ok"', '"expected_output":"missing"')
        .replace(
          "console.log('verified ok')",
          "const d=require('node:fs').mkdtempSync(require('node:os').tmpdir()+'/m-');console.log('missing')",
        ),
    )
    expect(
      validateRequirementVerificationPlan(analysis, selfContained).filter((issue) =>
        issue.includes('自建临时输入'),
      ),
    ).toEqual([])
  })

  it('refuses a plan that misses a business rule or an exception boundary', async () => {
    const { requirement, analysis } = requirementForVerificationPlan()
    const missingRule = makeVerificationAgent({
      planText: requirementVerificationPlanOf({ skipRules: 'rule' }),
    })
    await expect(
      missingRule.agent.plan({
        requirement,
        analysis,
        plan: taskPlanForVerification(),
        transcriptPath: VERIFY_PLAN_TRANSCRIPT(),
      }),
    ).rejects.toThrow(`验证方案缺少业务规则：${BUSINESS_RULE}`)

    const missingEdge = makeVerificationAgent({
      planText: requirementVerificationPlanOf({ skipRules: 'exception' }),
    })
    await expect(
      missingEdge.agent.plan({
        requirement,
        analysis,
        plan: taskPlanForVerification(),
        transcriptPath: VERIFY_PLAN_TRANSCRIPT(),
      }),
    ).rejects.toThrow(`验证方案缺少异常与边界：${EDGE_CASE}`)
  })

  it('fails closed when the planning model fails or returns a malformed plan', async () => {
    const { requirement, analysis } = requirementForVerificationPlan()
    const failed = makeVerificationAgent({ planStatus: 'timeout' })
    await expect(
      failed.agent.plan({
        requirement,
        analysis,
        plan: taskPlanForVerification(),
        transcriptPath: VERIFY_PLAN_TRANSCRIPT(),
      }),
    ).rejects.toThrow('验证方案生成未完成')

    const malformed = makeVerificationAgent({
      planText: JSON.stringify({
        scenarios: [
          {
            scenario: SCENARIO,
            acceptance_criterion: CRITERION,
            method: '空命令',
            required: true,
            checks: [],
          },
        ],
      }),
    })
    await expect(
      malformed.agent.plan({
        requirement,
        analysis,
        plan: taskPlanForVerification(),
        transcriptPath: VERIFY_PLAN_TRANSCRIPT(),
      }),
    ).rejects.toThrow('checks 必须给出至少一条可执行命令')
  })

  it('rejects duplicate command labels and plans without a required scenario', () => {
    const duplicate = JSON.parse(requirementVerificationPlanOf()) as {
      scenarios: Array<{ checks: Array<Record<string, unknown>> }>
    }
    duplicate.scenarios[0]!.checks[0]!.label = 'same-label'
    duplicate.scenarios[1]!.checks[0]!.label = 'same-label'
    expect(() => parseRequirementVerificationPlan(JSON.stringify(duplicate))).toThrow(
      'label 不能重复',
    )

    const optionalOnly = JSON.parse(requirementVerificationPlanOf()) as {
      scenarios: Array<Record<string, unknown>>
    }
    optionalOnly.scenarios[0]!.required = false
    optionalOnly.scenarios[1]!.required = false
    expect(() => parseRequirementVerificationPlan(JSON.stringify(optionalOnly))).toThrow(
      '至少要有一个必过场景',
    )
  })
})

/**
 * 验证执行上下文：命令由验证会话通过工具触发，运行时只接受当前方案里的 label，
 * 退出码、超时、中止、日志与完整性全部由程序记录，模型自述不构成证据。
 */
describe('verification check registry', () => {
  function checkHarness(
    options: {
      formalTest?: typeof runFormalTest
      planText?: string
      timeoutMs?: number
      signal?: AbortSignal
      checksDir?: string
    } = {},
  ) {
    const raw = options.planText ?? requirementVerificationPlanOf()
    const normalized = (() => {
      try {
        const data = JSON.parse(raw) as {
          scenarios?: Array<{ required?: boolean; checks?: unknown[] }>
        }
        for (const scenario of data.scenarios ?? []) {
          if (scenario.required !== true || !Array.isArray(scenario.checks)) continue
          const hasNegative = scenario.checks.some(
            (check) =>
              typeof check === 'object' &&
              check !== null &&
              (check as { expect_failure?: boolean }).expect_failure === true,
          )
          if (!hasNegative) {
            scenario.checks.push({
              label: `control-${Math.random().toString(36).slice(2, 8)}`,
              argv: ['node', '-e', 'process.exit(1)'],
              expect_failure: true,
            })
          }
        }
        return JSON.stringify(data)
      } catch {
        return raw
      }
    })()
    const plan = parseRequirementVerificationPlan(normalized)
    const registry = new VerificationCheckRegistry({
      ctx: {},
      formalTest: options.formalTest ?? runFormalTest,
      now: () => '2026-10-31T03:00:00.000Z',
    })
    const reqId = 'req-check-1'
    const handle = registry.activate({
      reqId,
      candidateSha256: 'a'.repeat(64),
      workspace: dir,
      dir: options.checksDir ?? join(dir, '.forgeloop', 'checks'),
      head: git(dir, ['rev-parse', 'HEAD']).trim(),
      plan,
      signal: options.signal ?? new AbortController().signal,
      timeoutMs: options.timeoutMs ?? 30_000,
    })
    return { registry, reqId, handle, plan }
  }

  it('executes plan commands through the tool and records logs and checksums', async () => {
    const { registry, reqId, handle } = checkHarness()

    const first = await registry.run(reqId, 'happy-path')
    expect(first.ok).toBe(true)
    expect(first.text).toContain('退出码 0')
    expect(first.text).toContain('verified ok')
    expect(first.data).toMatchObject({ label: 'happy-path', exitCode: 0, timedOut: false })

    const snapshot = registry.snapshot(reqId, handle.token)
    expect(snapshot?.startedAt).toBe('2026-10-31T03:00:00.000Z')
    expect(snapshot?.runs.map((run) => run.label)).toEqual(['happy-path'])
    expect(snapshot?.integrityIssues).toEqual([])
    const record = snapshot!.runs[0]!
    expect(record.logSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(record.logPath, 'utf8')).toContain('verified ok')

    // 释放后再调用不会沿用旧上下文，也不会执行任何命令。
    handle.release()
    expect(registry.snapshot(reqId, handle.token)).toBeNull()
    const late = await registry.run(reqId, 'happy-path')
    expect(late.ok).toBe(false)
    expect(late.text).toContain('没有正在进行的验证')
  })

  it('registers a sensitivity control and proves the command fails on the faulty copy', async () => {
    const readCommand =
      "const fs=require('node:fs');if(fs.readFileSync('README.md','utf8')!=='fixture\\n'){console.error('target rule broken: expected fixture');process.exit(1)}console.log('verified ok')"
    const planText = JSON.stringify({
      scenarios: [
        {
          scenario: SCENARIO,
          acceptance_criterion: CRITERION,
          method: '读取真实文件',
          required: true,
          checks: [
            { label: 'read', argv: ['node', '-e', readCommand], expected_output: 'verified ok' },
          ],
        },
      ],
    })
    const { registry, reqId, handle, plan } = checkHarness({
      planText,
      checksDir: mkdtempSync(join(tmpdir(), 'forgeloop-controls-dir-')),
    })
    const written = await registry.writeControl(reqId, {
      label: 'read',
      patch:
        'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-fixture\n+broken\n',
      expectedFailureOutput: 'target rule broken',
    })
    expect(written.ok, written.text).toBe(true)
    const controls = parseVerificationControls(
      readFileSync(join(dir, 'verification/controls.json'), 'utf8'),
    )
    expect(controls.map((control) => control.label)).toEqual(['read'])

    expect((await registry.run(reqId, 'read')).ok).toBe(true)
    const outcome = await registry.executeControls(
      reqId,
      handle.token,
      plan.scenarios.flatMap((scenario) => scenario.checks),
      controls,
    )
    expect(outcome).not.toBeNull()
    expect(outcome?.issues).toEqual([])
    expect(outcome?.results[0]).toMatchObject({ applied: true, exitCode: 1 })
    // 正式候选没有被对照修改。
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('fixture\n')
    handle.release()
  })

  it('refuses labels outside the plan and a second concurrent context', async () => {
    const { registry, reqId } = checkHarness()
    const outside = await registry.run(reqId, 'rm -rf')
    expect(outside.ok).toBe(false)
    expect(outside.text).toContain('不在当前验证方案中')
    expect(() =>
      registry.activate({
        reqId,
        candidateSha256: 'b'.repeat(64),
        workspace: dir,
        dir: join(dir, '.forgeloop', 'other'),
        head: git(dir, ['rev-parse', 'HEAD']).trim(),
        plan: parseRequirementVerificationPlan(requirementVerificationPlanOf()),
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
    ).toThrow('已有进行中的验证执行上下文')
    expect((await registry.run('req-unknown', 'happy-path')).ok).toBe(false)
  })

  it('returns the recorded result for a repeated label without running it again', async () => {
    let executions = 0
    const counting: typeof runFormalTest = async (request) => {
      executions += 1
      return runFormalTest(request)
    }
    const { registry, reqId } = checkHarness({ formalTest: counting })

    const first = await registry.run(reqId, 'happy-path')
    const again = await registry.run(reqId, 'happy-path')
    expect(executions).toBe(1)
    expect(again.ok).toBe(true)
    expect(again.text).toContain('返回上一次的真实结果')
    expect(again.data).toMatchObject({ exitCode: first.data?.exitCode })
  })

  it('records failing exit codes, missing output, timeouts and aborts instead of a pass', async () => {
    const failing = checkHarness({
      planText: JSON.stringify({
        scenarios: [
          {
            scenario: SCENARIO,
            acceptance_criterion: CRITERION,
            method: '故意失败',
            required: true,
            checks: [
              {
                label: 'broken',
                argv: ['node', '-e', "console.log('broken');process.exit(1)"],
                expected_output: 'broken',
              },
              { label: 'silent', argv: ['node', '-e', 'process.exit(0)'] },
            ],
          },
        ],
      }),
    })
    const broken = await failing.registry.run(failing.reqId, 'broken')
    expect(broken.text).toContain('退出码 1')
    expect(broken.data).toMatchObject({ exitCode: 1 })

    const timedOut = checkHarness({
      timeoutMs: 250,
      planText: JSON.stringify({
        scenarios: [
          {
            scenario: SCENARIO,
            acceptance_criterion: CRITERION,
            method: '超时',
            required: true,
            checks: [{ label: 'slow', argv: ['node', '-e', 'setTimeout(() => {}, 5000)'] }],
          },
        ],
      }),
    })
    const timeout = await timedOut.registry.run(timedOut.reqId, 'slow')
    expect(timeout.text).toContain('超时')
    expect(timeout.data).toMatchObject({ timedOut: true })

    const controller = new AbortController()
    const aborted = checkHarness({ signal: controller.signal })
    controller.abort()
    const abort = await aborted.registry.run(aborted.reqId, 'happy-path')
    expect(abort.text).toContain('已中止')
    expect(abort.data).toMatchObject({ aborted: true })
    const snapshot = aborted.registry.snapshot(aborted.reqId, aborted.handle.token)
    expect(snapshot?.runs).toHaveLength(1)
  })

  it('turns an executor exception into a recorded failure instead of inventing a pass', async () => {
    const { registry, reqId } = checkHarness({
      formalTest: async () => {
        throw new Error('spawn failed')
      },
    })
    const outcome = await registry.run(reqId, 'happy-path')
    expect(outcome.data).toMatchObject({ exitCode: null, logPath: '' })
    expect(outcome.text).toContain('验证命令执行异常：spawn failed')
  })

  it('flags a changed candidate commit or files written outside verification/', async () => {
    const committed = checkHarness()
    writeFileSync(join(dir, 'leaked.txt'), 'oops\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'outside change'])
    const changed = await committed.registry.run(committed.reqId, 'happy-path')
    expect(changed.ok).toBe(false)
    expect(changed.text).toContain('候选提交在验证开始后发生变化')

    const writing = checkHarness({
      planText: JSON.stringify({
        scenarios: [
          {
            scenario: SCENARIO,
            acceptance_criterion: CRITERION,
            method: '写入候选外的文件',
            required: true,
            checks: [
              {
                label: 'writes',
                argv: [
                  'node',
                  '-e',
                  "const fs=require('node:fs');fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/leak.txt','x')",
                ],
              },
            ],
          },
        ],
      }),
    })
    const outcome = await writing.registry.run(writing.reqId, 'writes')
    expect(outcome.text).toContain('候选完整性告警')
    expect(outcome.text).toContain('docs/leak.txt')
    const snapshot = writing.registry.snapshot(writing.reqId, writing.handle.token)
    expect(snapshot?.integrityIssues.join('；')).toContain('docs/leak.txt')
  })
})

describe('verification agent session facts', () => {
  it('exposes the planning session id', () => {
    const { agent } = makeVerificationAgent()
    expect(agent.sessionId).toBe('session-verify-plan')
  })

  it('renders missing optional analysis lists as empty placeholders', () => {
    const prompt = verificationPlanPrompt({
      requirement: {
        reqId: 'req-1',
        project: 'forgeloop',
        versions: [{ version: 1, text: '需求', createdAt: '2026-11-01T00:00:00.000Z' }],
      } as never,
      analysis: {
        analysisVersion: 1,
        requirementVersion: 1,
        goal: '目标',
        scenarios: ['场景'],
        acceptanceCriteria: ['标准'],
        clarifications: [],
      } as never,
      plan: { planVersion: 1, tasks: [] } as never,
    })
    expect(prompt).toContain('（没有额外业务规则）')
    expect(prompt).toContain('（没有额外异常或边界）')
    expect(prompt).toContain('（未声明非目标）')
  })
})
