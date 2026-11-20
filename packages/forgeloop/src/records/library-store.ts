import type { Database } from './db.js'
import { num, text, type Row } from './rows.js'
import { RuleViolationError } from '../domain/errors.js'
import { asRecord } from '../domain/json.js'
import type { LibraryEntry, LibraryStatus } from '../domain/library.js'

export interface LibrarySyncEntry {
  readonly entry: LibraryEntry
  readonly sha256: string
  readonly bytes: number
}

export interface LibraryEntryRow {
  readonly id: string
  readonly path: string
  readonly ref: string
  readonly title: string
  readonly status: LibraryStatus
  readonly topics: readonly string[]
  readonly summary: string
  readonly always: boolean
  readonly source: string
  readonly sha256: string
  readonly bytes: number
  readonly declaredAt: string
  readonly syncedAt: string
  readonly missing: boolean
}

const STATUSES: readonly LibraryStatus[] = ['confirmed', 'draft', 'superseded']

export class LibraryStore {
  constructor(readonly db: Database) {}

  sync(entries: readonly LibrarySyncEntry[], now: string): void {
    this.db.transaction(() => {
      for (const item of entries) this.upsert(item, now)
      this.markMissing(entries.map((item) => item.entry.id))
    })
  }

  list(): LibraryEntryRow[] {
    return this.db
      .prepare('SELECT * FROM library_entries ORDER BY id')
      .all()
      .map((row: Row) => entryRow(row))
  }

  byId(id: string): LibraryEntryRow | null {
    const row = asRecord(this.db.prepare('SELECT * FROM library_entries WHERE id = ?').get(id))
    return row ? entryRow(row) : null
  }

  private upsert(item: LibrarySyncEntry, now: string): void {
    const { entry } = item
    this.db
      .prepare(
        `INSERT INTO library_entries
          (id, path, ref, title, status, topics_json, summary, always, source,
           sha256, bytes, declared_at, synced_at, missing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path,
           ref = excluded.ref,
           title = excluded.title,
           status = excluded.status,
           topics_json = excluded.topics_json,
           summary = excluded.summary,
           always = excluded.always,
           source = excluded.source,
           sha256 = excluded.sha256,
           bytes = excluded.bytes,
           declared_at = excluded.declared_at,
           synced_at = excluded.synced_at,
           missing = 0`,
      )
      .run(
        entry.id,
        entry.path,
        entry.ref,
        entry.title,
        entry.status,
        JSON.stringify(entry.topics),
        entry.summary,
        entry.always ? 1 : 0,
        entry.source,
        item.sha256,
        item.bytes,
        entry.updatedAt,
        now,
      )
  }

  private markMissing(ids: readonly string[]): void {
    if (ids.length === 0) {
      this.db.prepare('UPDATE library_entries SET missing = 1').run()
      return
    }
    const placeholders = ids.map(() => '?').join(', ')
    this.db
      .prepare(`UPDATE library_entries SET missing = 1 WHERE id NOT IN (${placeholders})`)
      .run(...ids)
  }
}

function entryRow(row: Row): LibraryEntryRow {
  return {
    id: text(row, 'id'),
    path: text(row, 'path'),
    ref: text(row, 'ref'),
    title: text(row, 'title'),
    status: statusOf(text(row, 'status')),
    topics: topicsOf(text(row, 'topics_json')),
    summary: text(row, 'summary'),
    always: num(row, 'always') === 1,
    source: text(row, 'source'),
    sha256: text(row, 'sha256'),
    bytes: num(row, 'bytes'),
    declaredAt: text(row, 'declared_at'),
    syncedAt: text(row, 'synced_at'),
    missing: num(row, 'missing') === 1,
  }
}

function statusOf(value: string): LibraryStatus {
  const found = STATUSES.find((status) => status === value)
  if (!found) throw new RuleViolationError(`记录损坏：library status 取值非法（${value}）`)
  return found
}

function topicsOf(value: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new RuleViolationError('记录损坏：library topics_json 不是合法 JSON')
  }
  if (!Array.isArray(parsed)) {
    throw new RuleViolationError('记录损坏：library topics_json 不是字符串数组')
  }
  const topics: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') {
      throw new RuleViolationError('记录损坏：library topics_json 不是字符串数组')
    }
    topics.push(item)
  }
  return topics
}
