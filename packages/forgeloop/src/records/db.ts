/**
 * SQLite 记录层基础设施：与旧 Python 记录共用同一批表（可读旧库），
 * 新增的运行时表只承载请求领取、动作身份与证据路径。
 *
 * 数据库通过 Node 内置 `node:sqlite` 访问，不引入原生扩展，也不依赖 Python。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS requirements (
    req_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    blocked_reason TEXT NOT NULL DEFAULT '',
    submitted_by TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    client_key TEXT NOT NULL DEFAULT '',
    accepted_at TEXT NOT NULL DEFAULT '',
    accepted_by TEXT NOT NULL DEFAULT '',
    acceptance_source TEXT NOT NULL DEFAULT '',
    acceptance_fingerprint TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS requirement_versions (
    req_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revised_by TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (req_id, version)
);
CREATE TABLE IF NOT EXISTS requirement_analyses (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    requirement_version INTEGER NOT NULL,
    goal TEXT NOT NULL,
    scenarios TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL,
    clarifications TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version)
);
CREATE TABLE IF NOT EXISTS requirement_task_plans (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    task_plan_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version)
);
CREATE TABLE IF NOT EXISTS requirement_plan_approvals (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    approved_by TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    approved_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version)
);
CREATE TABLE IF NOT EXISTS requirement_task_runs (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    executed_seconds REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version, task_id)
);
CREATE TABLE IF NOT EXISTS requirement_task_artifacts (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    candidate_sha256 TEXT NOT NULL DEFAULT '',
    test_evidence_sha256 TEXT NOT NULL DEFAULT '',
    review_sha256 TEXT NOT NULL DEFAULT '',
    acceptance TEXT NOT NULL DEFAULT '',
    authorization_source TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version, task_id)
);
CREATE TABLE IF NOT EXISTS requirement_budget (
    req_id TEXT PRIMARY KEY,
    limit_seconds REAL NOT NULL,
    consumed_seconds REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS requirement_cancellations (
    req_id TEXT PRIMARY KEY,
    cancelled_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    cancelled_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_requests (
    request_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    project TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    action TEXT NOT NULL DEFAULT 'advance',
    state TEXT NOT NULL,
    requested_by TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    detail TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    claimed_at TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS service_requests_pending_by_requirement
    ON service_requests(req_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS service_requests_by_state
    ON service_requests(state, created_at);

CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    node TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    detail TEXT NOT NULL DEFAULT '',
    pid INTEGER,
    heartbeat_at TEXT
);
CREATE INDEX IF NOT EXISTS actions_by_task ON actions (task_id, started_at);

CREATE TABLE IF NOT EXISTS requirement_task_evidence (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    baseline_commit TEXT NOT NULL DEFAULT '',
    workspace_path TEXT NOT NULL DEFAULT '',
    candidate_path TEXT NOT NULL DEFAULT '',
    test_log_path TEXT NOT NULL DEFAULT '',
    review_path TEXT NOT NULL DEFAULT '',
    dev_session TEXT NOT NULL DEFAULT '',
    review_session TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version, task_id)
);
CREATE TABLE IF NOT EXISTS requirement_failure_rounds (
    req_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    summary TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    PRIMARY KEY (req_id, round_id)
);
CREATE TABLE IF NOT EXISTS requirement_grants (
    req_id TEXT NOT NULL,
    grant_index INTEGER NOT NULL,
    granted_at TEXT NOT NULL,
    granted_by TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (req_id, grant_index)
);
CREATE TABLE IF NOT EXISTS requirement_candidates (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    tarball TEXT NOT NULL,
    files_json TEXT NOT NULL,
    git_head TEXT NOT NULL DEFAULT '',
    built_at TEXT NOT NULL,
    evidence_dir TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version)
);
CREATE TABLE IF NOT EXISTS runtime_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`

/** 旧库补列：只加列，不改既有值。 */
const COLUMN_MIGRATIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['requirements', 'accepted_at', "TEXT NOT NULL DEFAULT ''"],
  ['requirements', 'accepted_by', "TEXT NOT NULL DEFAULT ''"],
  ['requirements', 'acceptance_source', "TEXT NOT NULL DEFAULT ''"],
  ['requirements', 'acceptance_fingerprint', "TEXT NOT NULL DEFAULT ''"],
  ['requirement_versions', 'revised_by', "TEXT NOT NULL DEFAULT ''"],
  ['requirement_versions', 'source', "TEXT NOT NULL DEFAULT ''"],
  ['service_requests', 'action', "TEXT NOT NULL DEFAULT 'advance'"],
  ['service_requests', 'owner', "TEXT NOT NULL DEFAULT ''"],
  ['service_requests', 'claimed_at', "TEXT NOT NULL DEFAULT ''"],
  ['service_requests', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
]

export interface OpenOptions {
  /** true 时库不存在则不创建（用于显式迁移/校验，不制造空库）。 */
  readonly readOnly?: boolean
}

export class Database {
  readonly handle: DatabaseSync
  readonly path: string

  private constructor(handle: DatabaseSync, path: string) {
    this.handle = handle
    this.path = path
  }

  static open(path: string, options: OpenOptions = {}): Database {
    if (!options.readOnly) mkdirSync(dirname(path), { recursive: true })
    const handle = new DatabaseSync(path, { readOnly: options.readOnly ?? false })
    handle.exec('PRAGMA busy_timeout = 5000')
    if (!options.readOnly) {
      handle.exec('PRAGMA journal_mode = WAL')
      handle.exec('PRAGMA foreign_keys = OFF')
      handle.exec(SCHEMA)
      for (const [table, column, definition] of COLUMN_MIGRATIONS) {
        addColumnIfMissing(handle, table, column, definition)
      }
    }
    return new Database(handle, path)
  }

  close(): void {
    this.handle.close()
  }

  /** 单事务执行；抛错回滚。供领取等需要原子性的路径使用。 */
  transaction<T>(operation: () => T): T {
    this.handle.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.handle.exec('COMMIT')
      return value
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK')
      } catch {
        // 回滚失败保留原始错误。
      }
      throw error
    }
  }
}

function addColumnIfMissing(
  handle: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
  if (!rows.some((row) => row.name === column)) {
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

export function isoNow(now = new Date()): string {
  return now.toISOString()
}