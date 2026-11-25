import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig, type RawConfig } from '../src/config.js'
import {
  FAILURE_USER_ACCEPTANCE,
  FAILURE_VERIFICATION,
  type FailureStage,
} from '../src/domain/counting.js'
import { MAX_AUTO_RETRIES, autoRetrySource } from '../src/domain/auto-retry.js'

const PROJECT = 'testproj'
const REQ = 'req-auto-retry'

let dir = ''
let runtime: ForgeLoopRuntime
let clock = new Date('2026-11-03T00:00:00.000Z')

function makeRuntime(overrides: RawConfig = {}): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: PROJECT,
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      ...overrides,
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config, now: () => clock })
}

function seedBlocked(
  stage: FailureStage = FAILURE_VERIFICATION,
  at = '2026-11-03T00:00:00.000Z',
  reason = '失败',
): void {
  runtime.repo.submit({
    reqId: REQ,
    project: PROJECT,
    text: '自动重试',
    submittedBy: 'owner',
    source: 'test',
    now: '2026-11-03T00:00:00.000Z',
  })
  runtime.repo.recordTaskPlan({
    taskPlanId: `plan-${REQ}-1`,
    requirementId: REQ,
    project: PROJECT,
    planVersion: 1,
    requirementVersion: 1,
    createdAt: '2026-11-03T00:00:00.000Z',
    tasks: [
      {
        taskId: 'a',
        goal: '写实现',
        files: ['docs/a.md'],
        acceptance: 'a 完成',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: -1, maxFailureRounds: -1 },
        authorizationSource: '',
      },
    ],
  })
  runtime.repo.recordPlanApproval({
    requirementId: REQ,
    planVersion: 1,
    approvedBy: 'owner',
    approvedAt: '2026-11-03T00:00:01.000Z',
    source: 'test',
  })
  runtime.repo.recordFailureRound(REQ, {
    roundId: 'round-1',
    stage,
    summary: '失败',
    occurredAt: at,
  })
  runtime.repo.setStatus(REQ, 'blocked', reason)
}

function pendingSource(): string {
  return runtime.repo.pendingRequests(PROJECT)[0]?.source ?? ''
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-auto-retry-'))
  runtime = makeRuntime()
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('automatic retry of blocking failures', () => {
  it('requeues a retryable block only after the first backoff', () => {
    seedBlocked()
    expect(runtime.autoRetryBlocked('2026-11-03T00:00:10.000Z')).toEqual([])
    expect(runtime.autoRetryBlocked('2026-11-03T00:01:00.000Z')).toEqual([REQ])
    expect(pendingSource()).toBe(autoRetrySource(1))
  })

  it('backs off longer on consecutive automatic retries', () => {
    seedBlocked()
    clock = new Date('2026-11-03T00:01:00.000Z')
    expect(runtime.autoRetryBlocked('2026-11-03T00:01:00.000Z')).toEqual([REQ])
    const claimed = runtime.repo.claimNextRequest('owner', '2026-11-03T00:01:01.000Z')
    runtime.repo.resolveRequest(claimed!.requestId, 'done', '', '2026-11-03T00:01:02.000Z')
    clock = new Date('2026-11-03T00:01:30.000Z')
    expect(runtime.autoRetryBlocked('2026-11-03T00:01:30.000Z')).toEqual([])
    clock = new Date('2026-11-03T00:02:10.000Z')
    expect(runtime.autoRetryBlocked('2026-11-03T00:02:10.000Z')).toEqual([REQ])
  })

  it('stops after the automatic retry limit', () => {
    seedBlocked()
    for (let attempt = 1; attempt <= MAX_AUTO_RETRIES; attempt += 1) {
      const { request } = runtime.repo.recordRequest({
        requestId: `rq-retry-${attempt}`,
        reqId: REQ,
        project: PROJECT,
        planVersion: 1,
        action: 'advance',
        requestedBy: 'system:auto-retry',
        source: autoRetrySource(attempt),
        now: `2026-11-03T00:${String(attempt).padStart(2, '0')}:00.000Z`,
      })
      runtime.repo.resolveRequest(
        request.requestId,
        'done',
        '',
        `2026-11-03T00:${String(attempt).padStart(2, '0')}:30.000Z`,
      )
    }
    expect(runtime.autoRetryBlocked('2026-11-04T00:00:00.000Z')).toEqual([])
  })

  it('leaves blocks that need a business decision to the owner', () => {
    seedBlocked(FAILURE_USER_ACCEPTANCE)
    expect(runtime.autoRetryBlocked('2026-11-04T00:00:00.000Z')).toEqual([])
  })

  it('leaves requirement disputes and clarifications out of automatic retry', () => {
    seedBlocked(
      FAILURE_VERIFICATION,
      '2026-11-03T00:00:00.000Z',
      '独立测试阻断（requirement_dispute）：范围不清',
    )
    expect(runtime.autoRetryBlocked('2026-11-04T00:00:00.000Z')).toEqual([])
  })

  it('does not retry a stopped requirement', () => {
    seedBlocked()
    runtime.repo.recordStop({
      requirementId: REQ,
      requestedBy: 'owner',
      reason: '暂停',
      requestedAt: '2026-11-03T00:00:05.000Z',
    })
    expect(runtime.autoRetryBlocked('2026-11-04T00:00:00.000Z')).toEqual([])
  })

  it('does not queue a second request while one is pending', () => {
    seedBlocked()
    expect(runtime.autoRetryBlocked('2026-11-03T00:01:00.000Z')).toEqual([REQ])
    expect(runtime.autoRetryBlocked('2026-11-03T00:05:00.000Z')).toEqual([])
  })
})
