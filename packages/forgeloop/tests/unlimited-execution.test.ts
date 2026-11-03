import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig, type RawConfig } from '../src/config.js'
import { GrantLedger, type FailureRound } from '../src/domain/counting.js'
import { ExecutionBudget, attemptAllowed, unlimitedLimit } from '../src/domain/limits.js'
import { planLimitSeconds, type PlannedTask } from '../src/domain/task-plan.js'
import { extendWorkBudget } from '../src/runtime/budget.js'
import { turnTimeoutSeconds } from '../src/runtime/execution-dev.js'

/**
 * 默认不施加任务执行限制：回合超时、看门狗、工时、尝试次数、失败轮次与验证重试都为 -1（不限，页面显示 MAX）。
 * 限额配置仍然保留，> 0 时按原语义生效；失败轮次、工时等统计照常累计。
 */

let dir = ''
let runtime: ForgeLoopRuntime

const RETRY_PLAN = {
  taskPlanId: 'plan-unlimited-1',
  requirementId: '',
  project: 'testproj',
  planVersion: 1,
  requirementVersion: 1,
  createdAt: '2026-11-03T00:00:00.000Z',
  tasks: [
    {
      taskId: 'a',
      goal: '先改文档',
      files: ['docs/a.md'],
      acceptance: 'a 完成',
      testCommand: ['node', '-e', 'process.exit(0)'],
      dependsOn: [],
      limits: { limitSeconds: -1, maxFailureRounds: -1 },
      authorizationSource: '',
    },
    {
      taskId: 'b',
      goal: '再补测试',
      files: ['docs/b.md'],
      acceptance: 'b 完成',
      testCommand: ['node', '-e', 'process.exit(0)'],
      dependsOn: ['a'],
      limits: { limitSeconds: -1, maxFailureRounds: -1 },
      authorizationSource: '',
    },
  ],
}

function makeRuntime(overrides: RawConfig = {}): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      ...overrides,
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config })
}

function failureRound(index: number): FailureRound {
  return {
    roundId: `a-a${index}`,
    stage: 'formal_test',
    summary: `第 ${index} 轮失败`,
    occurredAt: `2026-11-03T00:${String(index).padStart(2, '0')}:00.000Z`,
  }
}

function seedFailedTask(reqId: string): void {
  runtime.repo.submit({
    reqId,
    project: 'testproj',
    text: `重试 ${reqId}`,
    submittedBy: 'owner',
    source: 'test',
    now: '2026-11-03T00:00:00.000Z',
  })
  runtime.repo.recordTaskPlan({ ...RETRY_PLAN, requirementId: reqId })
  runtime.repo.recordPlanApproval({
    requirementId: reqId,
    planVersion: 1,
    approvedBy: 'owner',
    approvedAt: '2026-11-03T00:00:01.000Z',
    source: 'test',
  })
  runtime.repo.setStatus(reqId, 'approved')
  runtime.repo.recordTaskRun({
    requirementId: reqId,
    planVersion: 1,
    taskId: 'a',
    state: 'failed',
    reason: '正式测试失败（退出码 1）',
    executedSeconds: 1,
    updatedAt: '2026-11-03T00:00:02.000Z',
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-unlimited-'))
  runtime = makeRuntime()
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('default execution limits', () => {
  it('parses every execution limit as -1 (unlimited) by default', () => {
    const config = resolveConfig(
      { project: 'testproj', projectPath: dir, recordsRoot: join(dir, '.forgeloop') },
      dir,
    )
    expect(config.agent.timeoutSeconds).toBe(-1)
    expect(config.agent.maxTurnSeconds).toBe(-1)
    expect(config.agent.idleTimeoutSeconds).toBe(-1)
    expect(config.formalTestTimeoutSeconds).toBe(-1)
    expect(config.maxTaskAttempts).toBe(-1)
    expect(config.failureRoundsPerGrant).toBe(-1)
    expect(config.maxVerificationAttempts).toBe(-1)
  })

  it('keeps the limit helpers honest about -1 meaning unlimited', () => {
    expect(unlimitedLimit(-1)).toBe(true)
    expect(unlimitedLimit(0)).toBe(false)
    expect(attemptAllowed(999, -1)).toBe(true)
    expect(attemptAllowed(1, 0)).toBe(false)
    expect(attemptAllowed(2, 2)).toBe(true)
    expect(attemptAllowed(3, 2)).toBe(false)
  })

  it('makes a requirement budget unlimited when any task is unlimited', () => {
    const tasks = RETRY_PLAN.tasks.map((task) => ({
      ...task,
      limits: { ...task.limits, limitSeconds: 10 },
    })) as PlannedTask[]
    expect(planLimitSeconds(tasks)).toBe(20)
    expect(
      planLimitSeconds([
        tasks[0]!,
        { ...tasks[1]!, limits: { ...tasks[1]!.limits, limitSeconds: -1 } },
      ]),
    ).toBe(-1)
  })

  it('keeps an unlimited dev turn from becoming an immediate timeout', () => {
    // 三者都为 -1 时必须返回 -1（不建定时器）；历史上这里返回 0 会让每个研发回合立即超时。
    expect(turnTimeoutSeconds(-1, -1)).toBe(-1)
    expect(turnTimeoutSeconds(-1, 3600)).toBe(3600)
    expect(turnTimeoutSeconds(1200, -1)).toBe(1200)
    expect(turnTimeoutSeconds(7200, 3600)).toBe(3600)
  })
})

describe('unlimited grant ledger', () => {
  it('records every failure round without an exhausted quota', () => {
    const ledger = new GrantLedger(1, [], -1)
    for (let index = 1; index <= 12; index += 1) {
      expect(ledger.recordFailure(failureRound(index)).recorded).toBe(true)
    }
    expect(ledger.cumulativeFailures).toBe(12)
    expect(ledger.remainingInCurrentGrant).toBe(Number.POSITIVE_INFINITY)
    expect(ledger.canRecordFailure).toBe(true)
    expect(ledger.awaitingGrantDecision).toBe(false)
    expect(ledger.roundsPerGrant).toBe(-1)
  })

  it('still enforces an explicit per-grant quota', () => {
    const ledger = new GrantLedger(1, [], 2)
    ledger.recordFailure(failureRound(1))
    ledger.recordFailure(failureRound(2))
    expect(ledger.awaitingGrantDecision).toBe(true)
    expect(() => ledger.recordFailure(failureRound(3))).toThrow(/失败轮次已用尽/)
  })
})

describe('unlimited execution budget', () => {
  it('never exhausts and never blocks starting a new action', () => {
    const budget = new ExecutionBudget(-1)
    budget.charge(86_400)
    expect(budget.unlimited).toBe(true)
    expect(budget.exhausted).toBe(false)
    expect(budget.canStartAction()).toBe(true)
    expect(budget.remainingSeconds).toBe(Number.POSITIVE_INFINITY)
    expect(budget.consumedSeconds).toBe(86_400)
    expect(() => budget.extend(-1)).not.toThrow()
  })

  it('keeps an explicit budget meaningful', () => {
    const budget = new ExecutionBudget(10)
    budget.charge(10)
    expect(budget.exhausted).toBe(true)
    expect(budget.canStartAction()).toBe(false)
  })
})

describe('runtime defaults', () => {
  it('does not block retries after many failure rounds but still reports them', () => {
    const reqId = 'req-unlimited-retry'
    seedFailedTask(reqId)
    for (let index = 1; index <= 12; index += 1) {
      expect(runtime.repo.recordFailureRound(reqId, failureRound(index))).toBe(true)
    }

    const retried = runtime.retryTask({
      reqId,
      planVersion: 1,
      taskId: 'a',
      by: 'owner',
      source: 'test-retry',
    })
    expect(retried.ok, retried.message).toBe(true)

    const view = runtime.status(reqId).data as {
      failureRoundDetails: readonly FailureRound[]
      grantQuota: { grants: number; used: number; remaining: number | null }
    }
    expect(view.failureRoundDetails).toHaveLength(12)
    expect(
      view.failureRoundDetails.map(({ roundId, stage, summary, occurredAt }) => ({
        roundId,
        stage,
        summary,
        occurredAt,
      })),
    ).toEqual(runtime.repo.failureRounds(reqId))
    expect(view.grantQuota).toEqual({ grants: 1, used: 12, remaining: null })

    const board = runtime.statusBoard()
    expect(board.requirements[0]?.remainingRounds).toBeNull()
    expect(board.issues[0]?.detail).toContain('额度 MAX')
  })

  it('still enforces a configured failure-round quota', () => {
    runtime.close()
    runtime = makeRuntime({ failureRoundsPerGrant: 2 })
    const reqId = 'req-limited-retry'
    seedFailedTask(reqId)
    for (let index = 1; index <= 3; index += 1) {
      runtime.repo.recordFailureRound(reqId, failureRound(index))
    }

    const view = runtime.status(reqId).data as {
      grantQuota: { grants: number; used: number; remaining: number | null }
    }
    expect(view.grantQuota).toEqual({ grants: 1, used: 3, remaining: 0 })
    const retried = runtime.retryTask({
      reqId,
      planVersion: 1,
      taskId: 'a',
      by: 'owner',
      source: 'test-retry',
    })
    expect(retried.code).toBe('grant_required')
  })

  it('keeps charging and reporting work time while the budget stays unlimited', () => {
    const reqId = 'req-unlimited-budget'
    seedFailedTask(reqId)
    runtime.repo.ensureBudget(reqId, -1)
    runtime.repo.chargeBudget(reqId, 5400)

    expect(runtime.repo.budget(reqId)).toEqual({ limitSeconds: -1, consumedSeconds: 5400 })
    const extended = extendWorkBudget(runtime.repo, {
      reqId,
      seconds: 3600,
      by: 'owner',
      source: 'test',
    })
    expect(extended).toMatchObject({
      ok: true,
      message: '当前为 MAX 工时，无需延长',
      data: { limitSeconds: -1, consumedSeconds: 5400, extendedSeconds: 0 },
    })
  })
})
