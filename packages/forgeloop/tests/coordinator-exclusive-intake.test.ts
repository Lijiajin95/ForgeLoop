import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { Coordinator } from '../src/runtime/coordinator.js'
import { acquireHostLock } from '../src/runtime/lock.js'
import { projectDir, resolveConfig } from '../src/config.js'

let dir = ''
let runtime: ForgeLoopRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-exclusive-intake-'))
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 3600,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      autonomy: { allowAnySource: true },
    },
    dir,
  )
  runtime = new ForgeLoopRuntime({ ctx: {}, config })
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('coordinator ownership', () => {
  it('starts background work in a host that owns the single-consumer lock', () => {
    expect(runtime.coordinatorOwner).toBe(true)
    const coordinator = new Coordinator({ runtime, pollSeconds: 3600, autoAdvance: false })
    coordinator.start()
    try {
      expect(runtime.coordinatorOwner).toBe(true)
    } finally {
      coordinator.stop()
    }
  })

  it('only queues intake when another host owns the lock', () => {
    const holder = acquireHostLock(projectDir(runtime.config), 'other-host')
    try {
      const coordinator = new Coordinator({ runtime, pollSeconds: 3600, autoAdvance: false })
      coordinator.start()
      expect(runtime.coordinatorOwner).toBe(false)
      const result = runtime.submit({
        text: '锁被其他宿主持有时只入队',
        by: 'owner',
        source: 'dsh-tool:submit_requirement',
      })
      expect(result.ok, result.message).toBe(true)
      const reqId = (result.data as { reqId: string }).reqId
      expect(result.message).toContain('等待研发任务空闲')
      expect(runtime.requirementQueue.pending().map((entry) => entry.requirementId)).toEqual([reqId])
      expect(runtime.repo.latestAnalysis(reqId)).toBeNull()
    } finally {
      holder.release()
    }
  })
})
