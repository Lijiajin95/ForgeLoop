/**
 * 需求队列的 SQLite 适配：把 `domain/requirement-queue.ts` 的存储端口落到权威表。
 *
 * 领取在一次 `BEGIN IMMEDIATE` 事务内完成“无在研需求时取队首并标记 claimed”，
 * 排序口径与领域层一致：提出时间升序，时间相同按入队序号升序。
 */

import type { Database } from './db.js'
import { QUEUE_CLAIMED, QUEUE_QUEUED } from '../domain/requirement-queue.js'
import type {
  NewQueueEntry,
  RequirementQueueEntry,
  RequirementQueueStore,
} from '../domain/requirement-queue.js'

type Row = Record<string, unknown>

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

function entryFromRow(row: Row): RequirementQueueEntry {
  return {
    requirementId: text(row, 'req_id'),
    project: text(row, 'project'),
    enqueuedAt: text(row, 'enqueued_at'),
    sequence: Number(row.sequence ?? 0),
    state: text(row, 'state') === QUEUE_CLAIMED ? QUEUE_CLAIMED : QUEUE_QUEUED,
    claimedAt: text(row, 'claimed_at'),
  }
}

export class SqliteRequirementQueueStore implements RequirementQueueStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  append(entry: NewQueueEntry): RequirementQueueEntry {
    return this.db.transaction(() => {
      const row = this.db.handle
        .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM requirement_queue')
        .get() as Row
      const sequence = Number(row.next ?? 1)
      this.db.handle
        .prepare(
          `INSERT INTO requirement_queue (req_id, project, enqueued_at, sequence, state, claimed_at)
           VALUES (?, ?, ?, ?, ?, '')`,
        )
        .run(entry.requirementId, entry.project, entry.enqueuedAt, sequence, QUEUE_QUEUED)
      return { ...entry, sequence, state: QUEUE_QUEUED, claimedAt: '' }
    })
  }

  find(requirementId: string): RequirementQueueEntry | null {
    const row = this.db.handle
      .prepare('SELECT * FROM requirement_queue WHERE req_id = ?')
      .get(requirementId) as Row | undefined
    return row ? entryFromRow(row) : null
  }

  list(): readonly RequirementQueueEntry[] {
    const rows = this.db.handle
      .prepare('SELECT * FROM requirement_queue ORDER BY enqueued_at ASC, sequence ASC')
      .all() as Row[]
    return rows.map(entryFromRow)
  }

  claimNext(claimedAt: string): RequirementQueueEntry | null {
    return this.db.transaction(() => {
      const busy = this.db.handle
        .prepare("SELECT req_id FROM requirement_queue WHERE state = 'claimed' LIMIT 1")
        .get()
      if (busy) return null
      const row = this.db.handle
        .prepare(
          `SELECT * FROM requirement_queue WHERE state = 'queued'
           ORDER BY enqueued_at ASC, sequence ASC LIMIT 1`,
        )
        .get() as Row | undefined
      if (!row) return null
      this.db.handle
        .prepare("UPDATE requirement_queue SET state = 'claimed', claimed_at = ? WHERE req_id = ?")
        .run(claimedAt, text(row, 'req_id'))
      return { ...entryFromRow(row), state: QUEUE_CLAIMED, claimedAt }
    })
  }

  remove(requirementId: string): boolean {
    const result = this.db.handle.prepare('DELETE FROM requirement_queue WHERE req_id = ?').run(requirementId)
    return Number(result.changes ?? 0) > 0
  }
}
