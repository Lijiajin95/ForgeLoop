/**
 * 需求库重建运行记录：状态、阶段、计数与发布摘要。
 *
 * 报告正文、证据目录与发布回执另存文件；本表只保证运行可查询、可恢复与可审计。
 * 状态与阶段在写入时校验，损坏记录按记录错误处理而不是静默降级。
 */

import type { Database } from './db.js'
import { num, text, type Row } from './rows.js'
import { asRecord } from '../domain/json.js'
import { RuleViolationError } from '../domain/errors.js'

export type LibraryRebuildStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export const LIBRARY_REBUILD_STATUSES: readonly LibraryRebuildStatus[] = [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
]

export type LibraryRebuildStage = 'collect' | 'synthesize' | 'review' | 'publish' | 'done'

export const LIBRARY_REBUILD_STAGES: readonly LibraryRebuildStage[] = [
  'collect',
  'synthesize',
  'review',
  'publish',
  'done',
]

export interface LibraryRebuildRun {
  readonly runId: string
  readonly project: string
  readonly status: LibraryRebuildStatus
  readonly stage: LibraryRebuildStage
  /** 触发重建的所有者与来源；与看板其他 owner 动作同一口径。 */
  readonly requestedBy: string
  readonly source: string
  readonly materials: number
  readonly batches: number
  readonly batchesDone: number
  readonly candidates: number
  readonly published: number
  readonly drafts: number
  readonly conflicts: number
  readonly unresolved: number
  readonly error: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly reportPath: string
  /** 发布清单：[{ id, sha256, fingerprint }]；重跑与人工改动保护依赖它。 */
  readonly publishedJson: string
}

export class LibraryRebuildStore {
  constructor(readonly db: Database) {}

  save(run: LibraryRebuildRun): void {
    this.db
      .prepare(
        `INSERT INTO library_rebuilds
          (run_id, project, status, stage, requested_by, source, materials, batches, batches_done,
           candidates, published, drafts, conflicts, unresolved, error, started_at, finished_at,
           report_path, published_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status,
           stage = excluded.stage,
           requested_by = excluded.requested_by,
           source = excluded.source,
           materials = excluded.materials,
           batches = excluded.batches,
           batches_done = excluded.batches_done,
           candidates = excluded.candidates,
           published = excluded.published,
           drafts = excluded.drafts,
           conflicts = excluded.conflicts,
           unresolved = excluded.unresolved,
           error = excluded.error,
           finished_at = excluded.finished_at,
           report_path = excluded.report_path,
           published_json = excluded.published_json`,
      )
      .run(
        run.runId,
        run.project,
        run.status,
        run.stage,
        run.requestedBy,
        run.source,
        run.materials,
        run.batches,
        run.batchesDone,
        run.candidates,
        run.published,
        run.drafts,
        run.conflicts,
        run.unresolved,
        run.error,
        run.startedAt,
        run.finishedAt,
        run.reportPath,
        run.publishedJson,
      )
  }

  update(
    runId: string,
    patch: Partial<Omit<LibraryRebuildRun, 'runId' | 'project' | 'startedAt'>>,
  ): void {
    const current = this.get(runId)
    if (!current) throw new RuleViolationError(`重建运行不存在：${runId}`)
    this.save({ ...current, ...patch })
  }

  get(runId: string): LibraryRebuildRun | null {
    const row = asRecord(
      this.db.prepare('SELECT * FROM library_rebuilds WHERE run_id = ?').get(runId),
    )
    return row ? runRow(row) : null
  }

  latest(project: string): LibraryRebuildRun | null {
    const row = asRecord(
      this.db
        .prepare(
          'SELECT * FROM library_rebuilds WHERE project = ? ORDER BY started_at DESC, run_id DESC LIMIT 1',
        )
        .get(project),
    )
    return row ? runRow(row) : null
  }

  /** 最近一次成功完成的重建；重跑与人工改动保护只信任它。 */
  latestDone(project: string): LibraryRebuildRun | null {
    const row = asRecord(
      this.db
        .prepare(
          "SELECT * FROM library_rebuilds WHERE project = ? AND status = 'done' ORDER BY started_at DESC, run_id DESC LIMIT 1",
        )
        .get(project),
    )
    return row ? runRow(row) : null
  }

  recent(project: string, limit = 10): LibraryRebuildRun[] {
    return this.db
      .prepare(
        'SELECT * FROM library_rebuilds WHERE project = ? ORDER BY started_at DESC, run_id DESC LIMIT ?',
      )
      .all(project, limit)
      .map((row: Row) => runRow(row))
  }
}

function statusOf(value: string): LibraryRebuildStatus {
  const found = LIBRARY_REBUILD_STATUSES.find((status) => status === value)
  if (!found) throw new RuleViolationError(`记录损坏：重建状态非法（${value}）`)
  return found
}

function stageOf(value: string): LibraryRebuildStage {
  const found = LIBRARY_REBUILD_STAGES.find((stage) => stage === value)
  if (!found) throw new RuleViolationError(`记录损坏：重建阶段非法（${value}）`)
  return found
}

function runRow(row: Row): LibraryRebuildRun {
  return {
    runId: text(row, 'run_id'),
    project: text(row, 'project'),
    status: statusOf(text(row, 'status')),
    stage: stageOf(text(row, 'stage')),
    requestedBy: text(row, 'requested_by'),
    source: text(row, 'source'),
    materials: num(row, 'materials'),
    batches: num(row, 'batches'),
    batchesDone: num(row, 'batches_done'),
    candidates: num(row, 'candidates'),
    published: num(row, 'published'),
    drafts: num(row, 'drafts'),
    conflicts: num(row, 'conflicts'),
    unresolved: num(row, 'unresolved'),
    error: text(row, 'error'),
    startedAt: text(row, 'started_at'),
    finishedAt: text(row, 'finished_at'),
    reportPath: text(row, 'report_path'),
    publishedJson: text(row, 'published_json'),
  }
}
