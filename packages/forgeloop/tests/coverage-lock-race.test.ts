import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let dir = ''

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdirSync: () => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    },
  }
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-lock-race-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('host lock race', () => {
  it('fails closed when the lock cannot be reacquired after a stale cleanup', async () => {
    const { acquireHostLock } = await import('../src/runtime/lock.js')
    const lock = acquireHostLock(dir, 'owner-a')
    expect(lock.acquired).toBe(false)
    expect(lock.holder).toBe('未知持有者')
    expect(lock.reason).toContain('竞态中未能取得单消费者锁')
    lock.release()
  })
})
