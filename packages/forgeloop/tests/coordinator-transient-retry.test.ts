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
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-transient-retry-'))
  runtime = makeRuntime()
  coordinators = []
  clock = Date.parse('2026-11-24T00:00:00.000Z')
})

afterEach(async () => {
  for (const coordinator of coordinators) await coordinator.stop()
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

function submit(text: string): string {
  const result = runtime.submit({ text, by: 'owner', source: 'test' })
  expect(result.ok, result.message).toBe(true)
  return (result.data as { reqId: string }).reqId
}

function queue(reqId: string, requestId: string): void {
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
}

async function settle(ms = 120): Promise<void> {
  await new Promise((done) => setTimeout(done, ms))
}

function startCoordinator(): Coordinator {
  const coordinator = new Coordinator({
    runtime,
    pollSeconds: 3600,
    autoAdvance: false,
    now: () => clock,
  })
  coordinators.push(coordinator)
  return coordinator
}

describe('coordinator transient request retry', () => {
  it('requeues a transient execution failure automatically and stops after the bound', async () => {
    const reqId = submit('瞬态失败需求')
    queue(reqId, 'rq-transient')
    runtime.executeRequest = () => Promise.reject(new Error('socket hang up'))
    const coordinator = startCoordinator()
    await coordinator.start()
    await settle()

    const requests = runtime.repo.requestsFor(reqId)
    const retries = requests.filter((request) => request.source === 'auto-retry')
    expect(retries).toHaveLength(3)
    expect(retries.every((request) => request.action === 'analyze')).toBe(true)
    expect(requests.filter((request) => request.state === 'pending')).toHaveLength(0)
  })

  it('does not requeue a fatal failure such as a missing executable', async () => {
    const reqId = submit('配置失败需求')
    queue(reqId, 'rq-fatal')
    runtime.executeRequest = () => Promise.reject(new Error('spawn npm ENOENT'))
    const coordinator = startCoordinator()
    await coordinator.start()
    await settle()

    const requests = runtime.repo.requestsFor(reqId)
    expect(requests.filter((request) => request.source === 'auto-retry')).toHaveLength(0)
    expect(requests.map((request) => request.state)).toEqual(['failed'])
  })
})
