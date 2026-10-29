/**
 * SQLite 记录层基础设施：当前实现的权威表结构与事务入口。
 * 新库从空库按本结构建立，不承担旧业务库的读取、补列或迁移。
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
CREATE TABLE IF NOT EXISTS requirement_plan_reviews (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    requirement_version INTEGER NOT NULL,
    plan_sha256 TEXT NOT NULL,
    verdict TEXT NOT NULL,
    report_json TEXT NOT NULL,
    report_path TEXT NOT NULL,
    report_sha256 TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version)
);
CREATE TABLE IF NOT EXISTS requirement_verifications (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    requirement_version INTEGER NOT NULL,
    workspace_sha256 TEXT NOT NULL DEFAULT '',
    verdict TEXT NOT NULL,
    report_json TEXT NOT NULL,
    report_path TEXT NOT NULL,
    report_sha256 TEXT NOT NULL,
    evidence_dir TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    verified_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version, candidate_sha256)
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
CREATE TABLE IF NOT EXISTS requirement_business_reviews (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    requirement_version INTEGER NOT NULL,
    verification_sha256 TEXT NOT NULL,
    verdict TEXT NOT NULL,
    report_json TEXT NOT NULL,
    report_path TEXT NOT NULL,
    report_sha256 TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version, candidate_sha256)
);

CREATE TABLE IF NOT EXISTS requirement_task_artifact_history (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    candidate_sha256 TEXT NOT NULL DEFAULT '',
    test_evidence_sha256 TEXT NOT NULL DEFAULT '',
    review_sha256 TEXT NOT NULL DEFAULT '',
    acceptance TEXT NOT NULL DEFAULT '',
    authorization_source TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL DEFAULT '',
    archived_at TEXT NOT NULL,
    archived_path TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (req_id, plan_version, task_id, attempt)
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

CREATE TABLE IF NOT EXISTS ops_events (
    event_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    severity TEXT NOT NULL,
    state TEXT NOT NULL,
    title TEXT NOT NULL,
    impact TEXT NOT NULL DEFAULT '',
    opened_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    recovered_at TEXT NOT NULL DEFAULT '',
    closed_at TEXT NOT NULL DEFAULT '',
    diagnosis_json TEXT NOT NULL DEFAULT '',
    diagnosis_path TEXT NOT NULL DEFAULT '',
    diagnosis_session TEXT NOT NULL DEFAULT '',
    fix_requirement_id TEXT NOT NULL DEFAULT '',
    decision TEXT NOT NULL DEFAULT '',
    decision_by TEXT NOT NULL DEFAULT '',
    decision_source TEXT NOT NULL DEFAULT '',
    decision_at TEXT NOT NULL DEFAULT '',
    human_involved INTEGER NOT NULL DEFAULT 0,
    human_reason TEXT NOT NULL DEFAULT '',
    result_unknown INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ops_events_by_signature ON ops_events (project, signature, state);
CREATE INDEX IF NOT EXISTS ops_events_by_state ON ops_events (project, state, opened_at);

CREATE TABLE IF NOT EXISTS ops_observations (
    event_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '',
    evidence_path TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (event_id, seq)
);

CREATE TABLE IF NOT EXISTS ops_action_attempts (
    action_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    action_def_id TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL,
    authorization_source TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    exit_code INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT '',
    evidence_path TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ops_action_attempts_by_event ON ops_action_attempts (event_id, started_at);
`

export interface OpenOptions {
  /** true 时打开已有库且不创建新库，也不执行任何写入。 */
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

export function isoNow(now = new Date()): string {
  return now.toISOString()
}