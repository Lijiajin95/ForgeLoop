import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { archiveDatabase } from '../../../scripts/ts/evidence-archive.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-archive-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function seed(path: string): void {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, note TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO events (id, note) VALUES (?, ?)')
  for (let index = 0; index < 5; index += 1) insert.run(`e-${index}`, `note-${index}`)
  db.close()
}

function rows(path: string): Array<[string, string]> {
  const db = new DatabaseSync(path)
  try {
    return db
      .prepare('SELECT id, note FROM events ORDER BY id')
      .all()
      .map((row) => {
        const record = row as Record<string, unknown>
        return [String(record.id), String(record.note)]
      })
  } finally {
    db.close()
  }
}

describe('evidence archive', () => {
  it('snapshots committed rows that still live in WAL', () => {
    const source = join(dir, 'records.sqlite')
    seed(source)
    const target = join(dir, 'archive', 'records.sqlite')
    const result = archiveDatabase(source, target)
    expect(result.bytes).toBeGreaterThan(0)
    expect(rows(target)).toEqual(rows(source))
    expect(rows(target)).toHaveLength(5)
    expect(existsSync(`${target}-wal`)).toBe(false)
    expect(existsSync(`${target}-shm`)).toBe(false)
  })

  it('keeps the previous archive when a later snapshot fails', () => {
    const source = join(dir, 'records.sqlite')
    seed(source)
    const target = join(dir, 'archive', 'records.sqlite')
    archiveDatabase(source, target)
    expect(() => archiveDatabase(join(dir, 'missing.sqlite'), target)).toThrow('记录库不存在')
    expect(rows(target)).toHaveLength(5)
    const files = readdirSync(join(dir, 'archive'))
    expect(files.filter((name) => name.endsWith('.partial'))).toEqual([])
  })

  it('is repeatable and each archive reopens independently', () => {
    const source = join(dir, 'records.sqlite')
    seed(source)
    const first = join(dir, 'archive', 'records.sqlite')
    const second = join(dir, 'archive', 'records-2.sqlite')
    archiveDatabase(source, first)
    archiveDatabase(source, second)
    expect(rows(first)).toEqual(rows(second))
    expect(rows(first)).toHaveLength(5)
  })
})
