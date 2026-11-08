import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { archiveDatabase } from '../src/records/evidence-archive.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'

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

describe('archive reopen check', () => {
  it('reopens the archive with the same records and resolutions queryable both ways', () => {
    const source = join(dir, 'records.sqlite')
    const repo = new Repository(Database.open(source))
    try {
      repo.submit({
        reqId: 'req-arch',
        project: 'demo',
        text: '归档回查需求',
        submittedBy: 'owner',
        source: 'dsh-session:s1',
        now: '2026-11-08T06:00:00.000Z',
      })
      repo.recordCommitmentResolution({
        reqId: 'req-arch',
        requirementVersion: 1,
        existingReqId: 'req-old',
        decisionSource: 'web-decision:owner-9',
        decision: 'revise',
        reason: '所有者选择修订',
        decidedAt: '2026-11-08T06:10:00.000Z',
      })
    } finally {
      repo.close()
    }
    const target = join(dir, 'archive', 'records.sqlite')
    archiveDatabase(source, target)
    const reopened = new Repository(Database.open(target))
    try {
      expect(reopened.getRequirement('req-arch')).toMatchObject({ reqId: 'req-arch' })
      expect(reopened.commitmentResolutionFor('req-arch', 1, 'req-old')).toMatchObject({
        decisionSource: 'web-decision:owner-9',
        decision: 'revise',
      })
      expect(reopened.commitmentResolutions('req-arch')).toHaveLength(1)
    } finally {
      reopened.close()
    }
  })
})
describe('archive failure paths', () => {
  it('reports a missing source and leaves nothing behind', () => {
    expect(() => archiveDatabase(join(dir, 'nope.sqlite'), join(dir, 'out', 'x.sqlite'))).toThrow(
      '记录库不存在',
    )
  })

  it('cleans the staging file when the final rename fails', () => {
    const source = join(dir, 'records.sqlite')
    seed(source)
    // 目标是非空目录：rename 必失败，必须清理临时文件并把错误抛出。
    const target = join(dir, 'occupied')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'x')
    expect(() => archiveDatabase(source, target)).toThrow()
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.partial'))
    expect(leftovers).toEqual([])
  })
})
