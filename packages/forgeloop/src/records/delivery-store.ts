/**
 * 交付交接记录：按需求 + 候选 + 目标持久化“构建/部署/核对”进度。
 * 协调器重复轮询、宿主重启后按该记录续跑，不重复构建或重复发起部署。
 */

import type { Database } from './db.js'
import { text, type Row } from './rows.js'

export type DeliveryHandoffState =
  | 'built'
  | 'build_failed'
  | 'proposed'
  | 'deployed'
  | 'deploy_failed'
  | 'verified'
  | 'verify_failed'

export interface DeliveryHandoffRecord {
  readonly reqId: string
  readonly candidateSha256: string
  readonly targetId: string
  readonly state: DeliveryHandoffState
  readonly detail: string
  readonly updatedAt: string
}

const STATES: ReadonlySet<string> = new Set([
  'built',
  'build_failed',
  'proposed',
  'deployed',
  'deploy_failed',
  'verified',
  'verify_failed',
])

function isHandoffState(value: string): value is DeliveryHandoffState {
  return STATES.has(value)
}

function handoffRow(row: Row): DeliveryHandoffRecord {
  const state = text(row, 'state')
  return {
    reqId: text(row, 'req_id'),
    candidateSha256: text(row, 'candidate_sha256'),
    targetId: text(row, 'target_id'),
    state: isHandoffState(state) ? state : 'build_failed',
    detail: text(row, 'detail'),
    updatedAt: text(row, 'updated_at'),
  }
}

export interface DeliveryRecheckRecord {
  readonly reqId: string
  readonly intentId: string
  readonly eventId: string
  readonly state: 'pending' | 'done'
  readonly detail: string
  readonly updatedAt: string
}

function recheckRow(row: Row): DeliveryRecheckRecord {
  return {
    reqId: text(row, 'req_id'),
    intentId: text(row, 'intent_id'),
    eventId: text(row, 'event_id'),
    state: text(row, 'state') === 'done' ? 'done' : 'pending',
    detail: text(row, 'detail'),
    updatedAt: text(row, 'updated_at'),
  }
}

export class DeliveryStore {
  constructor(readonly db: Database) {}

  handoff(reqId: string, candidateSha256: string, targetId: string): DeliveryHandoffRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM delivery_handoffs
          WHERE req_id = ? AND candidate_sha256 = ? AND target_id = ?`,
      )
      .get(reqId, candidateSha256, targetId)
    return row ? handoffRow(row) : null
  }

  recordHandoff(record: DeliveryHandoffRecord): void {
    this.db
      .prepare(
        `INSERT INTO delivery_handoffs
          (req_id, candidate_sha256, target_id, state, detail, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, candidate_sha256, target_id) DO UPDATE SET
           state = excluded.state, detail = excluded.detail, updated_at = excluded.updated_at`,
      )
      .run(
        record.reqId,
        record.candidateSha256,
        record.targetId,
        record.state,
        record.detail,
        record.updatedAt,
      )
  }

  /**
   * 事件复核待办：与“部署核对完成”分开持久化，部署不重复而复核可以续跑。
   * 同一需求+部署+事件只保留一条；已完成的不会被重新打开。
   */
  ensureRechecks(input: {
    reqId: string
    intentId: string
    eventIds: readonly string[]
    at: string
  }): void {
    for (const eventId of input.eventIds) {
      this.db
        .prepare(
          `INSERT INTO delivery_rechecks (req_id, intent_id, event_id, state, detail, updated_at)
           VALUES (?, ?, ?, 'pending', '', ?)
           ON CONFLICT(req_id, intent_id, event_id) DO NOTHING`,
        )
        .run(input.reqId, input.intentId, eventId, input.at)
    }
  }

  pendingRechecks(reqId: string): DeliveryRecheckRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM delivery_rechecks WHERE req_id = ? AND state = 'pending'
          ORDER BY updated_at, rowid`,
      )
      .all(reqId)
      .map(recheckRow)
  }

  allPendingRechecks(): DeliveryRecheckRecord[] {
    return this.db
      .prepare("SELECT * FROM delivery_rechecks WHERE state = 'pending' ORDER BY updated_at, rowid")
      .all()
      .map(recheckRow)
  }

  recordRecheckOutcome(input: {
    reqId: string
    intentId: string
    eventId: string
    state: 'pending' | 'done'
    detail: string
    at: string
  }): void {
    this.db
      .prepare(
        `UPDATE delivery_rechecks SET state = ?, detail = ?, updated_at = ?
          WHERE req_id = ? AND intent_id = ? AND event_id = ?`,
      )
      .run(
        input.state,
        input.detail.slice(0, 1000),
        input.at,
        input.reqId,
        input.intentId,
        input.eventId,
      )
  }
}
