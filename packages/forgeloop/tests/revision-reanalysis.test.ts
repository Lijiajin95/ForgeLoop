import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRuntime(autoAdvance: boolean): ForgeLoopRuntime {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-revision-'))
  roots.push(root)
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      owner: 'owner',
      pollSeconds: 3600,
      autoAdvance,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
    },
    root,
  )
  return new ForgeLoopRuntime({ ctx: {}, config })
}

function submit(runtime: ForgeLoopRuntime): string {
  const result = runtime.submit({
    text: '门店订单列表支持按状态筛选',
    by: 'owner',
    source: 'test',
    analyze: false,
  })
  expect(result.ok, result.message).toBe(true)
  return (result.data as { reqId: string }).reqId
}

describe('revision re-analysis handoff', () => {
  it('queues the revised requirement for automatic re-analysis when auto advance is on', () => {
    const runtime = makeRuntime(true)
    try {
      const reqId = submit(runtime)
      const revised = runtime.revise({
        reqId,
        text: '门店订单列表支持按状态与时间筛选',
        by: 'owner',
        source: 'test:revise',
      })
      expect(revised.ok, revised.message).toBe(true)
      expect(revised.message).toContain('已加入自动推进队列')
      expect(
        runtime.requirementQueue.pending().some((entry) => entry.requirementId === reqId),
      ).toBe(true)
    } finally {
      runtime.close()
    }
  })

  it('leaves the queue untouched when automatic advance is off', () => {
    const runtime = makeRuntime(false)
    try {
      const reqId = submit(runtime)
      const revised = runtime.revise({
        reqId,
        text: '门店订单列表支持按状态与时间筛选',
        by: 'owner',
        source: 'test:revise',
      })
      expect(revised.ok, revised.message).toBe(true)
      expect(revised.message).not.toContain('自动推进队列')
      expect(
        runtime.requirementQueue.pending().some((entry) => entry.requirementId === reqId),
      ).toBe(false)
    } finally {
      runtime.close()
    }
  })
})
