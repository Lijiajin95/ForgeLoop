import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { LibraryStore, type LibrarySyncEntry } from '../src/records/library-store.js'
import type { LibraryEntry } from '../src/domain/library.js'

let dir = ''
let db: Database
let store: LibraryStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-library-store-'))
  db = Database.open(join(dir, 'records.sqlite'))
  store = new LibraryStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: 'a',
    title: 'A',
    status: 'confirmed',
    topics: ['a', 'b'],
    summary: 'A 摘要',
    path: 'docs/product/library/a.md',
    ref: '',
    always: false,
    source: 'docs/product/product.md',
    updatedAt: '2026-11-13',
    body: '正文',
    ...overrides,
  }
}

function syncEntry(value: LibraryEntry, sha256 = 'aa', bytes = 2): LibrarySyncEntry {
  return { entry: value, sha256, bytes }
}

describe('library index store', () => {
  it('round-trips entries and reads one by id', () => {
    store.sync(
      [
        syncEntry(entry({ id: 'a', always: true }), 'sha-a', 10),
        syncEntry(entry({ id: 'b', status: 'draft', ref: 'docs/product/b.md' }), 'sha-b', 20),
      ],
      '2026-11-13T00:00:00.000Z',
    )
    expect(store.list().map((row) => row.id)).toEqual(['a', 'b'])
    expect(store.byId('a')).toMatchObject({
      id: 'a',
      status: 'confirmed',
      topics: ['a', 'b'],
      always: true,
      sha256: 'sha-a',
      bytes: 10,
      missing: false,
      syncedAt: '2026-11-13T00:00:00.000Z',
    })
    expect(store.byId('b')).toMatchObject({
      status: 'draft',
      ref: 'docs/product/b.md',
      always: false,
    })
    expect(store.byId('missing')).toBeNull()
  })

  it('marks removed entries missing and clears the flag on return', () => {
    store.sync([syncEntry(entry({ id: 'a' })), syncEntry(entry({ id: 'b' }))], 't1')
    store.sync([syncEntry(entry({ id: 'a' }))], 't2')
    expect(store.byId('a')?.missing).toBe(false)
    expect(store.byId('b')?.missing).toBe(true)

    store.sync([syncEntry(entry({ id: 'a' })), syncEntry(entry({ id: 'b' }))], 't3')
    expect(store.byId('b')?.missing).toBe(false)
  })

  it('marks every entry missing when the library is emptied', () => {
    store.sync([syncEntry(entry({ id: 'a' }))], 't1')
    store.sync([], 't2')
    expect(store.list().every((row) => row.missing)).toBe(true)
  })

  it('fails closed when a stored row is corrupted', () => {
    store.sync([syncEntry(entry({ id: 'a' }))], 't1')
    db.prepare("UPDATE library_entries SET status = 'active' WHERE id = 'a'").run()
    expect(() => store.byId('a')).toThrowError('status 取值非法')

    db.prepare(
      "UPDATE library_entries SET status = 'confirmed', topics_json = 'x' WHERE id = 'a'",
    ).run()
    expect(() => store.byId('a')).toThrowError('topics_json')
  })
})
