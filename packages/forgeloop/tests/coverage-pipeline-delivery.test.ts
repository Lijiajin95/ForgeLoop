import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { Repository } from '../src/records/repository.js'
import { Database } from '../src/records/db.js'
import { evidenceDir, resolveConfig, workspaceDir, type ForgeLoopConfig } from '../src/config.js'
import { TaskDelivery, type TaskDeliveryDeps } from '../src/runtime/task-delivery.js'
import { applyDiffFile } from '../src/runtime/diff-apply.js'
import type { TestRunRequest, TestRunResult, runFormalTest } from '../src/runtime/formal-test.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import type { PlannedTask, TaskPlan } from '../src/domain/task-plan.js'
import type { Requirement } from '../src/domain/requirement.js'
import { sha256OfText } from '../src/domain/delivery.js'
import {
  EXECUTING,
  TASK_RUN_BLOCKED,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
} from '../src/domain/status.js'

/**
 * 覆盖率门禁补充：任务交付的动作边界。
 * 全部通过 TaskDelivery.deliver 的公开返回值、仓库记录（运行记录/失败轮次/产物/证据）
 * 与执行器实际收到的提示词观察结果——失败轮次、停止、无输出、审查结论、正式测试、
 * 上游依赖、工作副本准备命令与验证任务各条路径都在这里固定。
 */

const REQ_ID = 'req-cov-delivery'
const NOW = '2026-11-03T00:00:00.000Z'

let project = ''
let repo: Repository

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-delivery-cov-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, '.gitignore'), '.forgeloop/\n')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  return dir
}

function configOf(
  overrides: {
    maxTaskAttempts?: number
    failureRoundsPerGrant?: number
    worktreePrepareCommand?: string[]
  } = {},
): ForgeLoopConfig {
  return resolveConfig(
    {
      project: 'demo',
      projectPath: project,
      recordsRoot: join(project, '.forgeloop'),
      owner: 'owner',
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: overrides.maxTaskAttempts ?? 1,
      failureRoundsPerGrant: overrides.failureRoundsPerGrant ?? 3,
      ...(overrides.worktreePrepareCommand
        ? { worktreePrepareCommand: overrides.worktreePrepareCommand }
        : {}),
    },
    project,
  )
}

const REQUIREMENT: Requirement = {
  reqId: REQ_ID,
  project: 'demo',
  status: 'executing',
  blockedReason: '',
  versions: [
    {
      version: 1,
      text: '补一份交付文档',
      createdAt: NOW,
      revisedBy: 'owner',
      source: 'test',
    },
  ],
  submittedBy: 'owner',
  source: 'test',
}

function taskOf(taskId: string, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    taskId,
    goal: `写 ${taskId}`,
    files: [`docs/${taskId}.md`],
    acceptance: `${taskId} 存在`,
    testCommand: ['node', '-e', 'process.exit(0)'],
    dependsOn: [],
    limits: { limitSeconds: 60, maxFailureRounds: 2 },
    authorizationSource: 'plan-approval:owner',
    ...overrides,
  }
}

function planOf(tasks: readonly PlannedTask[]): TaskPlan {
  return {
    taskPlanId: `plan-${REQ_ID}-v1`,
    requirementId: REQ_ID,
    project: 'demo',
    planVersion: 1,
    requirementVersion: 1,
    tasks,
    createdAt: NOW,
  }
}

function agentResult(
  request: AgentRunRequest,
  text: string,
  status: AgentRunResult['status'] = 'completed',
  reason = '',
): AgentRunResult {
  return {
    status,
    text,
    sessionId: `session-fake-${request.role}`,
    reason,
    transcriptPath: request.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  }
}

function testResult(
  request: TestRunRequest,
  overrides: Partial<TestRunResult> = {},
): TestRunResult {
  return {
    exitCode: 0,
    timedOut: false,
    aborted: false,
    logPath: request.logPath,
    logSha256: sha256OfText('ok'),
    durationMs: 1,
    output: 'ok',
    ...overrides,
  }
}

/** 默认实现者：在工作副本里写入本任务的文档。 */
function writeTaskFile(request: AgentRunRequest): AgentRunResult {
  const taskId = /当前任务：(\S+)/.exec(request.prompt)?.[1] ?? 'a'
  mkdirSync(join(request.cwd, 'docs'), { recursive: true })
  writeFileSync(join(request.cwd, `docs/${taskId}.md`), `content ${Date.now()}\n`)
  return agentResult(request, 'done')
}

interface HarnessOptions {
  maxTaskAttempts?: number
  failureRoundsPerGrant?: number
  worktreePrepareCommand?: string[]
  dev?: (request: AgentRunRequest, call: number) => Promise<AgentRunResult> | AgentRunResult
  review?: (request: AgentRunRequest) => Promise<AgentRunResult> | AgentRunResult
  formalTest?: (request: TestRunRequest, call: number) => TestRunResult
  previousFailure?: () => string
  applyDiff?: TaskDeliveryDeps['applyDiffFile']
  onDev?: (request: AgentRunRequest) => void
}

function harness(options: HarnessOptions = {}) {
  const config = configOf(options)
  const devPrompts: string[] = []
  const reviewPrompts: string[] = []
  const upstreamCommits: string[] = []
  const heartbeats: string[] = []
  let devCalls = 0
  let reviewCalls = 0
  let testCalls = 0
  let charges = 0

  const runner = {
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      if (request.role === 'dev') {
        devCalls += 1
        devPrompts.push(request.prompt)
        upstreamCommits.push(git(request.cwd, ['log', '-1', '--pretty=%s']))
        // 活动回报应写入任务运行记录，供看板区分“还在跑”和“已经中断”。
        request.onActivity?.([{ type: 'tool/call', data: { name: 'bash' } }])
        heartbeats.push(repo.taskRuns(REQ_ID, 1)[0]?.reason ?? '')
        options.onDev?.(request)
        return options.dev ? options.dev(request, devCalls) : writeTaskFile(request)
      }
      reviewCalls += 1
      reviewPrompts.push(request.prompt)
      if (options.review) return options.review(request)
      return agentResult(
        request,
        JSON.stringify({ verdict: 'pass', blocking: [], findings: [], summary: '改动可用' }),
      )
    },
  }

  const formalTest = async (request: TestRunRequest): Promise<TestRunResult> => {
    testCalls += 1
    return options.formalTest ? options.formalTest(request, testCalls) : testResult(request)
  }

  const delivery = new TaskDelivery({
    config,
    repo,
    now: () => NOW,
    charge: () => {
      charges += 1
    },
    runner,
    formalTest: formalTest as unknown as typeof runFormalTest,
    ctx: {} as never,
    recordRun: (reqId, plan, task, outcome) => {
      repo.recordTaskRun({
        requirementId: reqId,
        planVersion: plan.planVersion,
        taskId: task.taskId,
        state: outcome.state,
        reason: outcome.reason,
        executedSeconds: 0,
        updatedAt: NOW,
      })
    },
    previousTaskFailure: options.previousFailure ?? (() => ''),
    applyDiffFile: options.applyDiff ?? applyDiffFile,
  })

  return {
    delivery,
    config,
    devPrompts,
    reviewPrompts,
    upstreamCommits,
    heartbeats,
    charges: () => charges,
    devCalls: () => devCalls,
    reviewCalls: () => reviewCalls,
    testCalls: () => testCalls,
  }
}

function deliver(
  built: ReturnType<typeof harness>,
  plan: TaskPlan,
  taskId: string,
  signal = new AbortController().signal,
) {
  return built.delivery.deliver({
    requirement: REQUIREMENT,
    plan,
    taskId,
    baseline: git(project, ['rev-parse', 'HEAD']),
    authorizationSource: 'plan-approval:owner',
    signal,
    requestId: 'req-advance-1',
  })
}

function taskRunState(): string {
  return repo.taskRuns(REQ_ID, 1)[0]?.state ?? ''
}

function taskRunReason(): string {
  return repo.taskRuns(REQ_ID, 1)[0]?.reason ?? ''
}

beforeEach(() => {
  project = makeProject()
  repo = new Repository(Database.open(join(project, '.forgeloop', 'records.sqlite')))
})

afterEach(() => {
  repo.close()
  rmSync(project, { recursive: true, force: true })
})

describe('TaskDelivery preconditions', () => {
  it('refuses a task id that is not part of the plan without starting any work', async () => {
    const built = harness()
    const outcome = await deliver(built, planOf([taskOf('a')]), 'missing')
    expect(outcome.state).toBe('blocked')
    expect(outcome.reason).toBe('任务包内没有任务 missing')
    expect(outcome.requirementStatus).toBe('blocked')
    expect(built.devCalls()).toBe(0)
    expect(repo.taskRuns(REQ_ID, 1)).toEqual([])
  })

  it('stops before the first attempt when the request was already cancelled', async () => {
    const built = harness()
    const controller = new AbortController()
    controller.abort()
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a', controller.signal)
    expect(outcome.state).toBe('blocked')
    expect(outcome.interrupted).toBe(true)
    expect(outcome.reason).toContain('停止请求：任务未交付')
    expect(built.devCalls()).toBe(0)
    expect(repo.taskRuns(REQ_ID, 1)).toEqual([])
  })
})

describe('TaskDelivery development rounds', () => {
  it('delivers a task after development, independent review and the formal test', async () => {
    const built = harness()
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')

    expect(outcome.state).toBe('delivered')
    expect(outcome.requirementStatus).toBe(EXECUTING)
    expect(taskRunState()).toBe(TASK_RUN_DELIVERED)

    // 研发回合的活动回报写入运行记录。
    expect(built.heartbeats[0]).toBe('正在调用工具 bash')

    const artifacts = repo.taskArtifacts(REQ_ID, 1)
    expect(artifacts.map((artifact) => artifact.taskId)).toEqual(['a'])
    expect(artifacts[0]?.authorizationSource).toBe('plan-approval:owner')
    expect(artifacts[0]?.candidateSha256).toMatch(/^[0-9a-f]{64}$/)

    const evidence = repo.evidence(REQ_ID, 1, 'a')
    expect(evidence?.devSession).toBe('session-fake-dev')
    expect(evidence?.reviewSession).toBe('session-fake-verify')
    expect(existsSync(evidence!.candidatePath)).toBe(true)
    expect(readFileSync(evidence!.candidatePath, 'utf8')).toContain('docs/a.md')

    // 审查证据与候选一起落盘，交付后一次性工作副本被清掉。
    const taskDir = evidenceDir(built.config, REQ_ID, 1, 'a')
    expect(JSON.parse(readFileSync(join(taskDir, 'review.json'), 'utf8')).verdict).toBe('pass')
    expect(existsSync(join(taskDir, 'baseline.json'))).toBe(true)
    expect(existsSync(workspaceDir(built.config, REQ_ID, 1, 'a'))).toBe(false)
    // 研发、审查、正式测试各计一次工时。
    expect(built.charges()).toBe(3)
    expect(built.reviewPrompts[0]).toContain('独立审查者')
  })

  it('hands the previous failure and its feedback back to the implementer', async () => {
    const built = harness({
      maxTaskAttempts: 1,
      previousFailure: () => '\n\n上一次正式测试失败（退出码 1）。',
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('delivered')
    expect(built.devPrompts[0]).toContain('上一次正式测试失败（退出码 1）。')
  })

  it('reports a stopped development turn as an interrupted blocked round', async () => {
    const built = harness({ dev: (request) => agentResult(request, '', 'aborted', 'stopped') })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('blocked')
    expect(outcome.interrupted).toBe(true)
    expect(outcome.reason).toBe('开发回合被停止：任务未交付，一次性工作副本可丢弃；可重新执行')
    expect(taskRunState()).toBe(TASK_RUN_BLOCKED)
  })

  it('reports a development turn that exceeded its time limit', async () => {
    const built = harness({ dev: (request) => agentResult(request, '', 'timeout', 'no output') })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('blocked')
    expect(outcome.interrupted).toBe(true)
    expect(outcome.reason).toContain('开发回合超时（no output）')
    expect(taskRunState()).toBe(TASK_RUN_BLOCKED)
  })

  it('retries a failed development round with the failure reason and then waits for a human', async () => {
    const built = harness({
      maxTaskAttempts: 2,
      dev: (request) => agentResult(request, '', 'error', 'model unavailable'),
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('awaiting_user')
    expect(outcome.reason).toBe('任务 a 已尝试 2 次仍未通过；等待人工决定')
    expect(built.devCalls()).toBe(2)
    expect(built.devPrompts[1]).toContain('上一次实现回合失败：model unavailable。请重新完成。')
    expect(taskRunState()).toBe(TASK_RUN_FAILED)
    expect(taskRunReason()).toBe('model unavailable')
  })

  it('rejects an implementation round that changed nothing and retries in the same task', async () => {
    const built = harness({
      maxTaskAttempts: 2,
      dev: (request, call) =>
        call === 1 ? agentResult(request, '没有改动') : writeTaskFile(request),
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('delivered')
    expect(built.devCalls()).toBe(2)
    expect(built.devPrompts[1]).toContain('上一次实现没有产生任何文件改动')
    expect(repo.failureRounds(REQ_ID)).toEqual([])
  })
})

describe('TaskDelivery independent review', () => {
  it('blocks when the review turn did not finish and does not count it as an interruption', async () => {
    const built = harness({
      review: (request) => agentResult(request, '', 'error', 'review model down'),
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('blocked')
    expect(outcome.interrupted).toBe(false)
    expect(outcome.reason).toBe('独立审查未取得可用结论：review model down')
    expect(taskRunState()).toBe(TASK_RUN_BLOCKED)
  })

  it('counts an aborted review turn as an interruption', async () => {
    const built = harness({
      review: (request) => agentResult(request, '', 'aborted', 'stopped'),
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('blocked')
    expect(outcome.interrupted).toBe(true)
  })

  it('fails closed when the review answer cannot be parsed', async () => {
    const built = harness({ review: (request) => agentResult(request, 'not json at all') })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('blocked')
    expect(outcome.reason).toContain('审查结果畸形（fail-closed）')
    expect(taskRunState()).toBe(TASK_RUN_BLOCKED)
    // 畸形结论不写 review.json，也不消耗失败轮次额度。
    expect(existsSync(join(evidenceDir(built.config, REQ_ID, 1, 'a'), 'review.json'))).toBe(false)
    expect(repo.failureRounds(REQ_ID)).toEqual([])
  })

  it('feeds a blocking review back to the implementer and delivers after the repair', async () => {
    let reviews = 0
    const built = harness({
      maxTaskAttempts: 2,
      failureRoundsPerGrant: 2,
      review: (request) => {
        reviews += 1
        if (reviews === 1) {
          return agentResult(
            request,
            JSON.stringify({
              verdict: 'block',
              blocking: ['缺少测试', '未覆盖异常路径'],
              findings: [],
              summary: '需修',
            }),
          )
        }
        return agentResult(
          request,
          JSON.stringify({ verdict: 'pass', blocking: [], findings: [], summary: 'ok' }),
        )
      },
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('delivered')
    expect(built.reviewCalls()).toBe(2)
    expect(built.devPrompts[1]).toContain('上一次独立审查阻断，必须修复：')
    expect(built.devPrompts[1]).toContain('- 缺少测试')
    expect(built.devPrompts[1]).toContain('- 未覆盖异常路径')
    expect(repo.failureRounds(REQ_ID).map((round) => round.stage)).toEqual([
      'implementation_review',
    ])
  })

  it('waits for an explicit decision when the review blocks and the failure budget is spent', async () => {
    const built = harness({
      failureRoundsPerGrant: 1,
      review: (request) =>
        agentResult(
          request,
          JSON.stringify({
            verdict: 'block',
            blocking: ['缺少测试'],
            findings: [],
            summary: '需修',
          }),
        ),
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('awaiting_user')
    expect(outcome.reason).toContain('独立审查阻断且失败轮次额度已用尽（1/1）')
    expect(taskRunState()).toBe(TASK_RUN_FAILED)
    expect(repo.failureRounds(REQ_ID).map((round) => round.stage)).toEqual([
      'implementation_review',
    ])
  })
})

describe('TaskDelivery formal test', () => {
  it('reports a stopped formal test as an interrupted blocked round', async () => {
    const built = harness({
      formalTest: (request) => testResult(request, { aborted: true, exitCode: null }),
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('blocked')
    expect(outcome.interrupted).toBe(true)
    expect(outcome.reason).toBe('正式测试被停止：任务未交付，一次性工作副本可丢弃；可重新执行')
    expect(taskRunState()).toBe(TASK_RUN_BLOCKED)
    expect(repo.taskArtifacts(REQ_ID, 1)).toEqual([])
  })

  it('reports a formal test that exceeded its limit as an interrupted blocked round', async () => {
    const built = harness({
      formalTest: (request) => testResult(request, { timedOut: true, exitCode: null }),
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('blocked')
    expect(outcome.interrupted).toBe(true)
    expect(outcome.reason).toBe('正式测试超过 30 秒上限并被终止：任务未交付，可重新执行')
    expect(taskRunState()).toBe(TASK_RUN_BLOCKED)
  })

  it('feeds a failing formal test back with its log tail and delivers after the repair', async () => {
    let tests = 0
    const built = harness({
      maxTaskAttempts: 2,
      failureRoundsPerGrant: 2,
      formalTest: (request) => {
        tests += 1
        return tests === 1
          ? testResult(request, { exitCode: 1, output: 'assertion failed: docs/a.md missing' })
          : testResult(request)
      },
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('delivered')
    expect(built.testCalls()).toBe(2)
    expect(built.devPrompts[1]).toContain('上一次正式测试失败（退出码 1）')
    expect(built.devPrompts[1]).toContain('assertion failed: docs/a.md missing')
    expect(repo.failureRounds(REQ_ID).map((round) => round.stage)).toEqual(['formal_test'])
    expect(repo.taskArtifact(REQ_ID, 1, 'a')?.testEvidenceSha256).toBe(sha256OfText('ok'))
  })

  it('waits for an explicit decision when the formal test fails and the budget is spent', async () => {
    const built = harness({
      failureRoundsPerGrant: 1,
      formalTest: (request) => testResult(request, { exitCode: null, output: 'killed' }),
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('awaiting_user')
    expect(outcome.reason).toContain('正式测试失败且失败轮次额度已用尽（1/1）')
    expect(repo.failureRounds(REQ_ID)[0]?.summary).toBe('正式测试退出码 null')
    expect(repo.taskArtifacts(REQ_ID, 1)).toEqual([])
  })
})

describe('TaskDelivery upstream dependencies', () => {
  it('blocks a dependent task whose upstream delivery evidence is missing', async () => {
    const built = harness()
    const plan = planOf([taskOf('a'), taskOf('b', { dependsOn: ['a'] })])
    const outcome = await deliver(built, plan, 'b')
    expect(outcome.state).toBe('blocked')
    expect(outcome.reason).toBe('任务 b 依赖 a，但缺少其交付证据；不能继续')
    expect(built.devCalls()).toBe(0)
  })

  it('blocks a dependent task whose upstream diff cannot be applied', async () => {
    const built = harness()
    const brokenDiff = join(project, 'broken.diff')
    writeFileSync(
      brokenDiff,
      [
        'diff --git a/docs/a.md b/docs/a.md',
        'index 1111111..2222222 100644',
        '--- a/docs/a.md',
        '+++ b/docs/a.md',
        '@@ -1,2 +1,2 @@',
        ' missing context line',
        '-old line',
        '+new line',
        '',
      ].join('\n'),
    )
    repo.recordEvidence({
      requirementId: REQ_ID,
      planVersion: 1,
      taskId: 'a',
      baselineCommit: 'deadbeef',
      workspacePath: '/tmp/nowhere',
      candidatePath: brokenDiff,
      testLogPath: '/tmp/nowhere.log',
      reviewPath: '/tmp/nowhere.json',
      devSession: 's',
      reviewSession: 'r',
      recordedAt: NOW,
    })
    const plan = planOf([taskOf('a'), taskOf('b', { dependsOn: ['a'] })])
    const outcome = await deliver(built, plan, 'b')
    expect(outcome.state).toBe('blocked')
    expect(outcome.reason).toContain('应用上游任务 a 的候选 diff 失败')
    expect(built.devCalls()).toBe(0)
  })

  it('starts a dependent task on top of the upstream candidate commit', async () => {
    const first = harness()
    const planA = planOf([taskOf('a')])
    expect((await deliver(first, planA, 'a')).state).toBe('delivered')

    const second = harness()
    const planAB = planOf([taskOf('a'), taskOf('b', { dependsOn: ['a'] })])
    const outcome = await deliver(second, planAB, 'b')
    expect(outcome.state).toBe('delivered')
    // 上游候选先落成副本里的提交，再交给实现者，避免依赖任务重写上游实现。
    expect(second.upstreamCommits[0]).toBe('forgeloop: upstream artifacts a')
    const diff = readFileSync(repo.evidence(REQ_ID, 1, 'b')!.candidatePath, 'utf8')
    expect(diff).toContain('docs/b.md')
    expect(diff).not.toContain('docs/a.md')
  })
})

describe('TaskDelivery workspace preparation', () => {
  it('runs the prepare command, records its log and keeps only the implementation changes', async () => {
    let markerDuringDev: boolean | null = null
    const prepareWrite = [
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync('.prepare-marker', 'prepared\\n')",
    ]
    const built = harness({
      worktreePrepareCommand: prepareWrite,
      onDev: (request) => {
        markerDuringDev = existsSync(join(request.cwd, '.prepare-marker'))
      },
    })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('delivered')
    // 准备命令写下的文件不算候选改动，必须被还原掉。
    expect(markerDuringDev).toBe(false)
    const log = readFileSync(
      join(evidenceDir(built.config, REQ_ID, 1, 'a'), 'workspace-prepare.log'),
      'utf8',
    )
    expect(log).toContain('exit_code: 0')
    const diff = readFileSync(repo.evidence(REQ_ID, 1, 'a')!.candidatePath, 'utf8')
    expect(diff).not.toContain('.prepare-marker')
  })

  it('blocks the task when the prepare command fails', async () => {
    const prepareFailure = [process.execPath, '-e', 'process.exit(3)']
    const built = harness({ worktreePrepareCommand: prepareFailure })
    const outcome = await deliver(built, planOf([taskOf('a')]), 'a')
    expect(outcome.state).toBe('blocked')
    expect(outcome.reason).toBe(`工作副本准备命令失败（退出码 3）：${prepareFailure.join(' ')}`)
    expect(built.devCalls()).toBe(0)
  })
})

describe('TaskDelivery verification tasks', () => {
  function verificationPlan(): TaskPlan {
    return planOf([taskOf('v', { files: [], verification: true, goal: '复验既有交付' })])
  }

  it('delivers a verification task with an empty candidate and a verification-only review note', async () => {
    const built = harness()
    const outcome = await deliver(built, verificationPlan(), 'v')
    expect(outcome.state).toBe('delivered')
    expect(outcome.requirementStatus).toBe(EXECUTING)
    expect(built.devCalls()).toBe(0)
    expect(built.reviewCalls()).toBe(0)

    const taskDir = evidenceDir(built.config, REQ_ID, 1, 'v')
    expect(readFileSync(join(taskDir, 'candidate.diff'), 'utf8')).toBe('')
    const note = JSON.parse(readFileSync(join(taskDir, 'review.json'), 'utf8'))
    expect(note.kind).toBe('verification')
    expect(note.verdict).toBe('pass')

    const artifact = repo.taskArtifact(REQ_ID, 1, 'v')
    expect(artifact?.candidateSha256).toBe(sha256OfText(''))
    expect(artifact?.authorizationSource).toBe('plan-approval:owner')
    expect(repo.evidence(REQ_ID, 1, 'v')?.devSession).toBe('')
    expect(taskRunState()).toBe(TASK_RUN_DELIVERED)
  })

  it('reports a stopped verification task as an interrupted blocked round', async () => {
    const built = harness({
      formalTest: (request) => testResult(request, { aborted: true, exitCode: null }),
    })
    const outcome = await deliver(built, verificationPlan(), 'v')
    expect(outcome.state).toBe('blocked')
    expect(outcome.interrupted).toBe(true)
    expect(outcome.reason).toBe('验证任务被停止：任务未交付，一次性工作副本可丢弃；可重新执行')
    expect(taskRunState()).toBe(TASK_RUN_BLOCKED)
  })

  it('reports a verification task that exceeded its time limit', async () => {
    const built = harness({
      formalTest: (request) => testResult(request, { timedOut: true, exitCode: null }),
    })
    const outcome = await deliver(built, verificationPlan(), 'v')
    expect(outcome.state).toBe('blocked')
    expect(outcome.interrupted).toBe(true)
    expect(outcome.reason).toBe('验证任务超过 30 秒上限并被终止：任务未交付，可重新执行')
  })

  it('retries a failing verification task and then delivers it', async () => {
    let tests = 0
    const built = harness({
      maxTaskAttempts: 2,
      failureRoundsPerGrant: 2,
      formalTest: (request) => {
        tests += 1
        return tests === 1
          ? testResult(request, { exitCode: 2, output: 'red' })
          : testResult(request)
      },
    })
    const outcome = await deliver(built, verificationPlan(), 'v')
    expect(outcome.state).toBe('delivered')
    expect(built.testCalls()).toBe(2)
    expect(built.devCalls()).toBe(0)
    expect(repo.failureRounds(REQ_ID)[0]?.summary).toBe('验证任务正式测试退出码 2')
  })

  it('waits for an explicit decision when the verification task failure budget is spent', async () => {
    const built = harness({
      failureRoundsPerGrant: 1,
      formalTest: (request) => testResult(request, { exitCode: 1, output: 'red' }),
    })
    const outcome = await deliver(built, verificationPlan(), 'v')
    expect(outcome.state).toBe('awaiting_user')
    expect(outcome.reason).toContain('验证任务失败且失败轮次额度已用尽（1/1）')
    expect(taskRunState()).toBe(TASK_RUN_FAILED)
    expect(repo.taskArtifacts(REQ_ID, 1)).toEqual([])
  })
})
