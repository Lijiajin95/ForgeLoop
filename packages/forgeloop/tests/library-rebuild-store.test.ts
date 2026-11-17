import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Database } from '../src/records/db.js'
import {
  LibraryRebuildStore,
  type LibraryRebuildRun,
} from '../src/records/library-rebuild-store.js'

function run(overrides: Partial<LibraryRebuildRun> = {}): LibraryRebuildRun {
  return {
    runId: 'run-1',
    project: 'p',
    status: 'running',
    stage: 'collect',
    requestedBy: 'owner',
    source: 'test',
    pid: 1234,
    batchLogJson: '[]',
    materials: 3,
    batches: 2,
    batchesDone: 1,
    candidates: 1,
    published: 0,
    drafts: 0,
    conflicts: 0,
    unresolved: 0,
    error: '',
    startedAt: '2026-11-16T01:00:00Z',
    finishedAt: '',
    reportPath: '',
    publishedJson: '[]',
    ...overrides,
  }
}

function open(): { db: Database; store: LibraryRebuildStore } {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-rebuild-store-'))
  const db = Database.open(join(dir, 'records.sqlite'))
  return { db, store: new LibraryRebuildStore(db) }
}

describe('library rebuild store', () => {
  it('saves, updates and orders runs by start time', () => {
    const { db, store } = open()
    store.save(run())
    store.save(run({ runId: 'run-2', status: 'done', startedAt: '2026-11-16T02:00:00Z' }))

    expect(store.get('run-1')).toMatchObject({ status: 'running', stage: 'collect' })
    store.update('run-1', {
      status: 'done',
      stage: 'done',
      published: 2,
      finishedAt: '2026-11-16T01:30:00Z',
    })
    expect(store.get('run-1')).toMatchObject({ status: 'done', stage: 'done', published: 2 })

    expect(store.latest('p')?.runId).toBe('run-2')
    expect(store.recent('p', 1)).toHaveLength(1)
    expect(store.recent('other')).toEqual([])
    expect(() => store.update('missing', {})).toThrow(/不存在/)
    db.close()
  })

  it('rejects corrupted status or stage instead of defaulting', () => {
    const { db, store } = open()
    store.save(run())
    db.prepare("UPDATE library_rebuilds SET status = 'weird' WHERE run_id = 'run-1'").run()
    expect(() => store.get('run-1')).toThrow(/状态非法/)

    db.prepare("UPDATE library_rebuilds SET status = 'done', stage = 'weird'").run()
    expect(() => store.get('run-1')).toThrow(/阶段非法/)
    db.close()
  })

  it('returns null for an unknown run', () => {
    const { db, store } = open()
    expect(store.get('unknown')).toBeNull()
    expect(store.latest('p')).toBeNull()
    db.close()
  })

  it('marks runs from another process as interrupted', () => {
    const { db, store } = open()
    store.save(run({ runId: 'old', status: 'running', pid: 999 }))
    store.save(run({ runId: 'same', status: 'running', pid: 1234 }))

    expect(store.markInterrupted('p', 1234, '2026-11-17T00:00:00Z')).toBe(1)
    expect(store.get('old')).toMatchObject({
      status: 'failed',
      stage: 'done',
      error: '宿主重启导致运行中断',
      finishedAt: '2026-11-17T00:00:00Z',
    })
    expect(store.get('same')?.status).toBe('running')
    db.close()
  })
})
