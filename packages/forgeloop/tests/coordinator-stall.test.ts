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
let clock = 0

function makeRuntime(): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 3600,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30, maxTurnSeconds: 300 },
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
  const coordinator = new Coordinator({
    runtime,
    pollSeconds: 3600,
    autoAdvance: false,
    now: () => clock,
  })
  coordinators.push(coordinator)
  return coordinator
}

function submit(text: string): string {
  const result = runtime.submit({ text, by: 'owner', source: 'test' })
  expect(result.ok, result.message).toBe(true)
  return (result.data as { reqId: string }).reqId
}

function queue(reqId: string, requestId: string): string {
  runtime.repo.recordRequest({
    requestId,
    reqId,
    project: 'testproj',
    planVersion: 1,
    action: 'analyze',
    requestedBy: 'test',
    source: 'test',
    now: new Date(clock).toISOString(),
  })
  return requestId
}

async function settle(ms = 40): Promise<void> {
  await new Promise((done) => setTimeout(done, ms))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-stall-'))
  runtime = makeRuntime()
  coordinators = []
  clock = Date.parse('2026-11-08T00:00:00.000Z')
})

afterEach(async () => {
  for (const coordinator of coordinators) await coordinator.stop()
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('coordinator stall detection', () => {
  it('closes a request whose executor never returns and never reports progress', async () => {
    const reqId = submit('挂起需求')
    const requestId = queue(reqId, 'rq-hang')
    runtime.repo.upsertDevSession({
      sessionId: 'sess-hang',
      project: 'testproj',
      workspace: join(dir, 'ws'),
      now: new Date(clock).toISOString(),
    })
    runtime.repo.leaseDevSession('sess-hang', requestId, new Date(clock).toISOString())
    let signal: AbortSignal | undefined
    runtime.executeRequest = (_request, abortSignal) => {
      signal = abortSignal
      return new Promise(() => {})
    }
    const coordinator = makeCoordinator()
    coordinator.start()
    await settle(220)

    const actionId = `act-${requestId}`
    expect(runtime.repo.action(actionId)?.state).toBe('started')

    // 阈值来自配置的 maxTurnSeconds=300：前进 400 秒后仍无任何进展，必须判停滞。
    clock += 700_000
    await expect(coordinator.runWatchdog()).resolves.toBe(1)

    expect(runtime.repo.action(actionId)?.state).toBe('interrupted')
    expect(runtime.repo.request(requestId)?.state).toBe('failed')
    expect(runtime.repo.devSession('sess-hang')?.state).toBe('idle')
    expect(signal?.aborted).toBe(true)
  })

  it('keeps a long turn that keeps reporting progress', async () => {
    const reqId = submit('长回合需求')
    const requestId = queue(reqId, 'rq-long')
    runtime.executeRequest = () => new Promise(() => {})
    const coordinator = makeCoordinator()
    coordinator.start()
    await settle(220)

    const actionId = `act-${requestId}`
    // 每 200 秒上报一次可观测进展，持续 1200 秒：没有手工改心跳。
    for (let elapsed = 0; elapsed < 1_200_000; elapsed += 200_000) {
      clock += 200_000
      runtime.progress.note(reqId)
      await coordinator.runWatchdog()
    }
    expect(runtime.repo.action(actionId)?.state).toBe('started')
    expect(runtime.repo.request(requestId)?.state).toBe('claimed')
  })

  it('is idempotent and does not overwrite the closure with a late result', async () => {
    const reqId = submit('迟到结果需求')
    const requestId = queue(reqId, 'rq-late')
    let finish: ((value: { state: 'done'; detail: string }) => void) | undefined
    runtime.executeRequest = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const coordinator = makeCoordinator()
    coordinator.start()
    await settle(220)

    clock += 700_000
    await expect(coordinator.runWatchdog()).resolves.toBe(1)
    await expect(coordinator.runWatchdog()).resolves.toBe(0)

    finish?.({ state: 'done', detail: '迟到的成功' })
    await settle(220)
    expect(runtime.repo.action(`act-${requestId}`)?.state).toBe('interrupted')
    expect(runtime.repo.request(requestId)?.state).toBe('failed')
  })

  it('keeps scheduling after closing a stuck request', async () => {
    const first = submit('阻塞需求')
    const second = submit('后续需求')
    queue(first, 'rq-first')
    queue(second, 'rq-second')
    let calls = 0
    runtime.executeRequest = (request) => {
      calls += 1
      if (request.requestId === 'rq-first') return new Promise(() => {})
      return Promise.resolve({ state: 'done', detail: '后续请求完成' })
    }
    const coordinator = makeCoordinator()
    coordinator.start()
    await settle(260)

    clock += 700_000
    await expect(coordinator.runWatchdog()).resolves.toBe(1)
    await settle(120)
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(runtime.repo.request('rq-second')?.state).toBe('done')
  })
})
