import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireHostLock } from '../src/runtime/lock.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-lock-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function lockDir(): string {
  return join(dir, 'host.lock')
}

describe('host lock', () => {
  it('acquires the directory atomically and releases only its own lock', () => {
    const lock = acquireHostLock(dir, 'owner-a')
    expect(lock.acquired).toBe(true)
    expect(lock.reason).toBe('')
    expect(existsSync(lockDir())).toBe(true)
    const record = JSON.parse(readFileSync(join(lockDir(), 'owner.json'), 'utf8')) as {
      owner: string
      pid: number
    }
    expect(record.owner).toBe('owner-a')
    expect(record.pid).toBe(process.pid)
    lock.release()
    expect(existsSync(lockDir())).toBe(false)
    lock.release()
    expect(existsSync(lockDir())).toBe(false)
  })

  it('refuses a second live consumer without touching the first lock', () => {
    const first = acquireHostLock(dir, 'owner-a')
    expect(first.acquired).toBe(true)
    const second = acquireHostLock(dir, 'owner-b')
    expect(second.acquired).toBe(false)
    expect(second.reason).toContain('另一个宿主正在消费同一记录根')
    expect(second.release).toBeTypeOf('function')
    second.release()
    expect(existsSync(lockDir())).toBe(true)
    first.release()
    expect(existsSync(lockDir())).toBe(false)
  })

  it('cleans a stale lock whose holder process is gone, then retries once', () => {
    mkdirSync(lockDir())
    writeFileSync(
      join(lockDir(), 'owner.json'),
      `${JSON.stringify({ owner: 'dead-owner', pid: 999999, acquiredAt: '2026-10-23T00:00:00.000Z' })}\n`,
      'utf8',
    )
    const lock = acquireHostLock(dir, 'owner-a')
    expect(lock.acquired).toBe(true)
    const record = JSON.parse(readFileSync(join(lockDir(), 'owner.json'), 'utf8')) as {
      owner: string
    }
    expect(record.owner).toBe('owner-a')
    lock.release()
  })

  it('treats an unreadable lock record as stale', () => {
    mkdirSync(lockDir())
    writeFileSync(join(lockDir(), 'owner.json'), 'not json', 'utf8')
    const lock = acquireHostLock(dir, 'owner-a')
    expect(lock.acquired).toBe(true)
    lock.release()
  })

  it('treats a non-positive holder pid as a stale lock', () => {
    mkdirSync(lockDir())
    writeFileSync(
      join(lockDir(), 'owner.json'),
      `${JSON.stringify({ owner: 'dead-owner', pid: 0, acquiredAt: '2026-10-23T00:00:00.000Z' })}\n`,
      'utf8',
    )
    const lock = acquireHostLock(dir, 'owner-a')
    expect(lock.acquired).toBe(true)
    lock.release()
  })

  it('treats a permission error as a live holder instead of stealing the lock', () => {
    mkdirSync(lockDir())
    writeFileSync(
      join(lockDir(), 'owner.json'),
      `${JSON.stringify({ owner: 'other', pid: 4242, acquiredAt: '2026-10-23T00:00:00.000Z' })}\n`,
      'utf8',
    )
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    try {
      const lock = acquireHostLock(dir, 'owner-a')
      expect(lock.acquired).toBe(false)
      expect(lock.reason).toContain('另一个宿主正在消费同一记录根')
    } finally {
      kill.mockRestore()
    }
  })

  it('treats an unknown kill error as a dead holder', () => {
    mkdirSync(lockDir())
    writeFileSync(
      join(lockDir(), 'owner.json'),
      `${JSON.stringify({ owner: 'other', pid: 4242, acquiredAt: '2026-10-23T00:00:00.000Z' })}\n`,
      'utf8',
    )
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('boom')
    })
    try {
      const lock = acquireHostLock(dir, 'owner-a')
      expect(lock.acquired).toBe(true)
      lock.release()
    } finally {
      kill.mockRestore()
    }
  })

  it('does not delete a lock another live owner replaced before release', () => {
    const lock = acquireHostLock(dir, 'owner-a')
    expect(lock.acquired).toBe(true)
    writeFileSync(
      join(lockDir(), 'owner.json'),
      `${JSON.stringify({ owner: 'owner-b', pid: process.pid, acquiredAt: '2026-10-23T00:00:00.000Z' })}\n`,
      'utf8',
    )
    lock.release()
    expect(existsSync(lockDir())).toBe(true)
  })
})
