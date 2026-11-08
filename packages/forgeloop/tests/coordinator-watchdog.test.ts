import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { Coordinator } from '../src/runtime/coordinator.js'
import { resolveConfig } from '../src/config.js'

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
      failureRoundsPerGrant: 3,
      autonomy: { allowAnySource: false },
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config })
}

function makeCoordinator(): Coordinator {
  const coordinator = new Coordinator({ runtime, pollSeconds: 3600, autoAdvance: false })
  coordinators.push(coordinator)
  return coordinator
}

function submit(): string {
  const result = runtime.submit({ text: '看门狗测试', by: 'owner', source: 'test' })
  expect(result.ok, result.message).toBe(true)
  return (result.data as { reqId: string }).reqId
}

function queueRequest(reqId: string): string {
  const requestId = 'rq-watchdog-1'
  runtime.repo.recordRequest({
    requestId,
    reqId,
    project: 'testproj',
    planVersion: 1,
    action: 'analyze',
    requestedBy: 'test',
    source: 'test',
    now: '2026-11-08T00:00:00.000Z',
  })
  return requestId
}

function staleHeartbeat(actionId: string): void {
  runtime.repo.touchAction(actionId, new Date(Date.now() - 2 * 3600 * 1000).toISOString())
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-watchdog-'))
  runtime = makeRuntime()
  coordinators = []
})

afterEach(async () => {
  for (const coordinator of coordinators) await coordinator.stop()
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('coordinator watchdog', () => {
  it('closes a stalled action together with its request and dev session, then rejects the late result', async () => {
    const reqId = submit()
    const requestId = queueRequest(reqId)
    runtime.repo.upsertDevSession({
      sessionId: 'sess-watchdog',
      project: 'testproj',
      workspace: join(dir, 'workspace'),
      now: '2026-11-08T00:00:00.000Z',
    })
    runtime.repo.bindRequirementDevSession({
      reqId,
      requirementVersion: 1,
      sessionId: 'sess-watchdog',
      workspace: join(dir, 'workspace'),
      selectedBy: 'test',
      reason: 'test',
      now: '2026-11-08T00:00:00.000Z',
    })
    runtime.repo.leaseDevSession('sess-watchdog', requestId, '2026-11-08T00:00:00.000Z')

    let signal: AbortSignal | undefined
    runtime.executeRequest = (_request, abortSignal) => {
      signal = abortSignal
      return new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(new Error('aborted by watchdog')))
      })
    }
    const coordinator = makeCoordinator()
    coordinator.start()
    await settle(150)

    const actionId = `act-${requestId}`
    staleHeartbeat(actionId)
    await expect(coordinator.runWatchdog()).resolves.toBe(1)

    expect(runtime.repo.action(actionId)?.state).toBe('interrupted')
    expect(runtime.repo.request(requestId)?.state).toBe('failed')
    expect(runtime.repo.request(requestId)?.detail).toContain('未自动重放')
    expect(runtime.repo.devSession('sess-watchdog')?.state).toBe('idle')
    expect(signal?.aborted).toBe(true)

    // 迟到结果不得覆盖看门狗写下的收口结论。
    await settle()
    expect(runtime.repo.action(actionId)?.detail).not.toContain('执行异常')
    expect(runtime.repo.request(requestId)?.state).toBe('failed')

    // 重复检查幂等：不再重复收口。
    await expect(coordinator.runWatchdog()).resolves.toBe(0)
  })

  it('keeps an executing action that still has a fresh heartbeat', async () => {
    const reqId = submit()
    const requestId = queueRequest(reqId)
    runtime.executeRequest = (_request, abortSignal) =>
      new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const coordinator = makeCoordinator()
    coordinator.start()
    await settle(150)

    const actionId = `act-${requestId}`
    runtime.repo.touchAction(actionId, new Date().toISOString())
    await expect(coordinator.runWatchdog()).resolves.toBe(0)
    expect(runtime.repo.action(actionId)?.state).toBe('started')
    expect(runtime.repo.request(requestId)?.state).toBe('claimed')
  })
  it('rejects a late successful outcome instead of overwriting the watchdog closure', async () => {
    const reqId = submit()
    const requestId = queueRequest(reqId)
    let finish: ((outcome: { state: 'done' | 'failed'; detail: string }) => void) | undefined
    runtime.executeRequest = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const coordinator = makeCoordinator()
    coordinator.start()
    await settle(150)

    const actionId = `act-${requestId}`
    staleHeartbeat(actionId)
    await expect(coordinator.runWatchdog()).resolves.toBe(1)

    finish?.({ state: 'done', detail: '迟到的成功' })
    await settle()
    expect(runtime.repo.action(actionId)?.state).toBe('interrupted')
    expect(runtime.repo.request(requestId)?.state).toBe('failed')
    expect(runtime.repo.request(requestId)?.detail).toContain('未自动重放')
  })
})
