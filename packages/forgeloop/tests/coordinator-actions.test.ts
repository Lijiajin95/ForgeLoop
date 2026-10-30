import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { Coordinator } from '../src/runtime/coordinator.js'
import { resolveConfig } from '../src/config.js'
import { projectDir } from '../src/config.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

let dir = ''
let runtime: ForgeLoopRuntime
let coordinators: Coordinator[] = []

function makeRuntime(): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 3600,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config })
}

function makeCoordinator(autoAdvance: boolean): Coordinator {
  const coordinator = new Coordinator({ runtime, pollSeconds: 3600, autoAdvance })
  coordinators.push(coordinator)
  return coordinator
}

function submit(): string {
  const result = runtime.submit({ text: '协调器测试', by: 'owner', source: 'test' })
  expect(result.ok, result.message).toBe(true)
  return (result.data as { reqId: string }).reqId
}

function plan(reqId: string): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}-1`,
    requirementId: reqId,
    project: 'testproj',
    planVersion: 1,
    requirementVersion: 1,
    createdAt: '2026-10-23T00:00:01.000Z',
    tasks: [
      {
        taskId: 't1',
        goal: '写文档',
        files: ['packages/forgeloop/README.md'],
        acceptance: '文档存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
      {
        taskId: 't2',
        goal: '补测试',
        files: ['packages/forgeloop/tests/coordinator.md'],
        acceptance: '测试存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: ['t1'],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
    ],
  }
}

function approveWithPlan(reqId: string): void {
  const value = plan(reqId)
  runtime.repo.recordTaskPlan(value)
  runtime.repo.recordPlanApproval({
    requirementId: reqId,
    planVersion: 1,
    approvedBy: 'owner',
    approvedAt: '2026-10-23T00:00:02.000Z',
    source: 'test',
  })
  runtime.repo.setStatus(reqId, 'approved')
}

function deliverAll(reqId: string): void {
  for (const taskId of ['t1', 't2']) {
    runtime.repo.recordTaskArtifact({
      requirementId: reqId,
      planVersion: 1,
      taskId,
      candidateSha256: `c-${taskId}`,
      testEvidenceSha256: `t-${taskId}`,
      reviewSha256: `r-${taskId}`,
      acceptance: '达成',
      authorizationSource: `plan-approval:${reqId}:v1:owner`,
      recordedAt: '2026-10-23T00:00:03.000Z',
      baselineCommit: 'abc',
    })
  }
}

function autoAdvanceScan(coordinator: Coordinator): void {
  ;(coordinator as unknown as { ensureAutoAdvanceRequests(): void }).ensureAutoAdvanceRequests()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-coordinator-'))
  runtime = makeRuntime()
  coordinators = []
})

afterEach(async () => {
  for (const coordinator of coordinators) await coordinator.stop()
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('coordinator lifecycle', () => {
  it('acquires the single-consumer lock on start and releases it on stop', async () => {
    const coordinator = makeCoordinator(false)
    coordinator.start()
    expect(coordinator.snapshot()).toMatchObject({ running: true, lock: { acquired: true } })
    expect(existsSync(join(projectDir(runtime.config), 'host.lock'))).toBe(true)
    await coordinator.stop()
    expect(coordinator.snapshot().running).toBe(false)
    expect(existsSync(join(projectDir(runtime.config), 'host.lock'))).toBe(false)
  })

  it('stays read-only when another live coordinator owns the lock', async () => {
    const first = makeCoordinator(false)
    first.start()
    const second = makeCoordinator(false)
    second.start()
    const snapshot = second.snapshot()
    expect(snapshot.running).toBe(false)
    expect(snapshot.lastError).toContain('单消费者锁未取得')
    await second.stop()
    await first.stop()
  })

  it('marks task runs left running by a previous host as blocked and never replays them', () => {
    const reqId = submit()
    runtime.repo.recordTaskRun({
      requirementId: reqId,
      planVersion: 1,
      taskId: 'a',
      state: 'running',
      reason: '执行步骤 35',
      executedSeconds: 0,
      updatedAt: '2026-10-23T00:00:02.000Z',
    })
    const coordinator = makeCoordinator(false)
    coordinator.start()
    const run = runtime.repo.taskRuns(reqId, 1)[0]!
    expect(run.state).toBe('blocked')
    expect(run.reason).toContain('宿主中断')
    expect(run.reason).toContain('核对')
    const meta = JSON.parse(String(runtime.repo.getMeta('last_recovery'))) as {
      interruptedRuns?: number
    }
    expect(meta.interruptedRuns).toBe(1)
    // 恢复只记录中断，不自动重放任务。
    expect(runtime.repo.taskArtifact(reqId, 1, 'a')).toBeNull()
    coordinator.stop()
  })

  it('records the claimed requests and started actions as recovered on start', async () => {
    const reqId = submit()
    runtime.repo.recordRequest({
      requestId: 'rq-claimed',
      reqId,
      project: 'testproj',
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-23T00:00:02.000Z',
    })
    runtime.repo.claimNextRequest('other-owner', '2026-10-23T00:00:03.000Z')
    const coordinator = makeCoordinator(false)
    coordinator.start()
    expect(runtime.repo.request('rq-claimed')?.state).toBe('unknown')
    coordinator.stop()
  })
})

describe('auto advance requests', () => {
  it('queues and runs an advance request for an approved, undelivered plan', async () => {
    const reqId = submit()
    approveWithPlan(reqId)
    const executed: string[] = []
    runtime.executeRequest = async (request) => {
      executed.push(request.requestId)
      return { state: 'failed', detail: 'stub' }
    }
    const coordinator = makeCoordinator(true)
    coordinator.start()
    await coordinator.kick()
    const requests = runtime.repo.requestsFor(reqId)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ action: 'advance', source: 'auto-advance', state: 'failed' })
    expect(executed).toEqual([requests[0]!.requestId])
    const actions = coordinator.describeActions(reqId) as Array<{
      request: string
      action: string
      state: string
      record: { state: string } | null
    }>
    expect(actions[0]).toMatchObject({ request: requests[0]!.requestId, state: 'failed' })
    expect(actions[0]!.record?.state).toBe('failed')
    await coordinator.stop()
  })

  it('skips requirements that are not approved, fully delivered or already queued', () => {
    const draftId = submit()
    const deliveredId = submit()
    approveWithPlan(deliveredId)
    deliverAll(deliveredId)
    const queuedId = submit()
    approveWithPlan(queuedId)
    runtime.repo.recordRequest({
      requestId: 'rq-active',
      reqId: queuedId,
      project: 'testproj',
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-23T00:00:05.000Z',
    })
    const coordinator = makeCoordinator(true)
    autoAdvanceScan(coordinator)
    expect(runtime.repo.requestsFor(draftId)).toHaveLength(0)
    expect(runtime.repo.requestsFor(deliveredId)).toHaveLength(0)
    expect(runtime.repo.requestsFor(queuedId)).toHaveLength(1)
  })

  it('auto-requeues a failed requirement but not one blocked by quota or unknown', async () => {
    const coordinator = makeCoordinator(true)

    const failedId = submit()
    approveWithPlan(failedId)
    runtime.repo.recordTaskRun({
      requirementId: failedId,
      planVersion: 1,
      taskId: 't1',
      state: 'failed',
      reason: '正式测试失败（退出码 1）',
      executedSeconds: 1,
      updatedAt: '2026-10-23T00:00:06.000Z',
    })
    runtime.repo.setStatus(failedId, 'blocked', '任务 t1 失败：正式测试退出码 1')

    const exhaustedId = submit()
    approveWithPlan(exhaustedId)
    runtime.repo.setStatus(exhaustedId, 'blocked', '任务失败')
    for (let index = 0; index < 3; index += 1) {
      runtime.repo.recordFailureRound(exhaustedId, {
        roundId: `exhaust-${index}`,
        stage: 'formal_test',
        summary: '失败',
        occurredAt: '2026-10-23T00:00:07.000Z',
      })
    }

    const unknownId = submit()
    approveWithPlan(unknownId)
    runtime.repo.setStatus(unknownId, 'blocked', '任务失败')
    runtime.repo.recordRequest({
      requestId: 'rq-unknown-auto',
      reqId: unknownId,
      project: 'testproj',
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-23T00:00:08.000Z',
    })
    runtime.repo.claimNextRequest('tester', '2026-10-23T00:00:08.500Z')
    runtime.repo.markClaimedUnknown('2026-10-23T00:00:09.000Z')

    autoAdvanceScan(coordinator)
    expect(runtime.repo.requestsFor(failedId)).toHaveLength(1)
    expect(runtime.repo.requestsFor(failedId)[0]?.source).toBe('auto-requeue')
    expect(runtime.repo.requestsFor(exhaustedId)).toHaveLength(0)
    // unknown 请求本身保留，但不会再自动排一条新的推进。
    expect(
      runtime.repo.requestsFor(unknownId).filter((request) => request.state === 'pending'),
    ).toHaveLength(0)
    expect(runtime.repo.requestsFor(unknownId)[0]?.state).toBe('unknown')
  })

  it('keeps the last error instead of crashing when a scan fails', async () => {
    runtime.repo.claimNextRequest = () => {
      throw new Error('claim failed')
    }
    const coordinator = makeCoordinator(false)
    coordinator.start()
    await coordinator.kick()
    expect(coordinator.snapshot().lastError).toContain('claim failed')
  })
})
