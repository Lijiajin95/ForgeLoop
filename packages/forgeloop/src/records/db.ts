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
    business_rules TEXT NOT NULL DEFAULT '[]',
    exceptions TEXT NOT NULL DEFAULT '[]',
    non_goals TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    transcript_path TEXT NOT NULL DEFAULT '',
    tool_calls TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version)
);
-- 结构化需求说明（业务要点、验收项、假设）。旁置 JSON 表，避免给已有 analyses 表补列；
-- 历史分析没有该行时按无结构化规格处理，不补造。
CREATE TABLE IF NOT EXISTS requirement_analysis_specs (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    spec_json TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version)
);
-- 需求修订使旧分析失效：只追加审计，不删除旧分析；准入按版本号判定过期。
CREATE TABLE IF NOT EXISTS requirement_analysis_invalidations (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    from_requirement_version INTEGER NOT NULL,
    to_requirement_version INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version, to_requirement_version)
);
CREATE TABLE IF NOT EXISTS requirement_analysis_attempts (
    req_id TEXT NOT NULL,
    requirement_version INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    kind TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    transcript_path TEXT NOT NULL DEFAULT '',
    tool_calls TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, requirement_version, attempt)
);
-- 输入分诊：每条分析记录判断输入是需求还是问题。旁置表而不是给 requirement_analyses
-- 补列：已有库按 CREATE TABLE IF NOT EXISTS 建立，不做迁移或 ALTER；缺行按需求处理。
CREATE TABLE IF NOT EXISTS requirement_analysis_input_kinds (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version)
);
-- 澄清问题：每个问题在首次提出的分析版本内获得稳定编号（Q<分析版本>-<序号>）。
-- 问题只追加；解决时写结论与解决版本，不删除历史。旁置表避免给已有 analyses 表补列。
CREATE TABLE IF NOT EXISTS requirement_clarification_questions (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    question_index INTEGER NOT NULL,
    question_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolution TEXT NOT NULL DEFAULT '',
    resolved_analysis_version INTEGER,
    resolved_requirement_version INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version, question_index)
);
-- 澄清回答（历史格式）：按分析版本一条，question_ids 存所答问题。只读回退，不再写入。
CREATE TABLE IF NOT EXISTS requirement_clarification_answers (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    requirement_version INTEGER NOT NULL,
    answered_version INTEGER NOT NULL,
    question_ids TEXT NOT NULL DEFAULT '[]',
    answer TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    answered_at TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version)
);
-- 逐题回答：一道题一行；同一道题可有多条历次回答，未回答的题保持开放。
CREATE TABLE IF NOT EXISTS requirement_clarification_question_answers (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    answer_seq INTEGER NOT NULL,
    requirement_version INTEGER NOT NULL,
    answered_version INTEGER NOT NULL,
    answer TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    answered_at TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version, question_id, answer_seq)
);
-- 业务背景变更：draft 只落库不写正式文档；分析校验通过后由程序同步并标记 applied。
-- 记录需求版本、分析版本与明确依据，保证背景变化可回查、可审计。
CREATE TABLE IF NOT EXISTS requirement_business_context_changes (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    requirement_version INTEGER NOT NULL,
    changed INTEGER NOT NULL DEFAULT 1,
    reason TEXT NOT NULL DEFAULT '',
    document TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    doc_sha256 TEXT NOT NULL DEFAULT '',
    applied_at TEXT NOT NULL DEFAULT '',
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
-- 每次验证尝试独立追加；requirement_verifications 只是“当前有效结果”的投影，
-- 不能反向覆盖历史。旧库没有本表时按新表建立，不迁移旧行。
CREATE TABLE IF NOT EXISTS requirement_verification_attempts (
    attempt_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    previous_attempt_id TEXT NOT NULL DEFAULT '',
    requirement_version INTEGER NOT NULL,
    workspace_sha256 TEXT NOT NULL DEFAULT '',
    verdict TEXT NOT NULL,
    failure_kind TEXT NOT NULL DEFAULT '',
    blocking_json TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL DEFAULT '',
    report_json TEXT NOT NULL,
    report_path TEXT NOT NULL,
    report_sha256 TEXT NOT NULL,
    evidence_dir TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    verified_at TEXT NOT NULL,
    UNIQUE (req_id, plan_version, candidate_sha256, attempt_number)
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
-- 工时延长审计：人工延长或改为不限都要留痕，供自主率统计回查。
CREATE TABLE IF NOT EXISTS requirement_budget_extensions (
    req_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    seconds REAL NOT NULL,
    extended_by TEXT NOT NULL,
    source TEXT NOT NULL,
    extended_at TEXT NOT NULL,
    PRIMARY KEY (req_id, seq)
);

CREATE TABLE IF NOT EXISTS requirement_cancellations (
    req_id TEXT PRIMARY KEY,
    cancelled_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    cancelled_at TEXT NOT NULL
);

-- 需求队列：按提出时间先后领取，同一时间最多一条处于研发中（claimed）。
CREATE TABLE IF NOT EXISTS requirement_queue (
    req_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    claimed_at TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS requirement_queue_sequence
    ON requirement_queue(sequence);
CREATE INDEX IF NOT EXISTS requirement_queue_pending
    ON requirement_queue(state, enqueued_at, sequence);

-- 内建问题单：验证未通过时自动创建，关联需求与验证报告，驱动研发修复后重新验证。
CREATE TABLE IF NOT EXISTS requirement_issues (
    issue_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    project TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    verification_sha256 TEXT NOT NULL DEFAULT '',
    candidate_sha256 TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS requirement_issues_by_requirement
    ON requirement_issues(req_id, attempt);
CREATE INDEX IF NOT EXISTS requirement_issues_by_status
    ON requirement_issues(req_id, status, attempt);

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
-- 研发会话：一个需求绑定一个研发会话与一份工作区；会话不随需求结束销毁。
CREATE TABLE IF NOT EXISTS dev_sessions (
    session_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    workspace TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'idle',
    summary TEXT NOT NULL DEFAULT '',
    summary_sha256 TEXT NOT NULL DEFAULT '',
    summary_path TEXT NOT NULL DEFAULT '',
    last_req_id TEXT NOT NULL DEFAULT '',
    lease_request_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dev_sessions_by_project ON dev_sessions(project, state, updated_at);

-- 需求与研发会话的绑定：同一需求版本重复推进时沿用同一会话与工作区。
CREATE TABLE IF NOT EXISTS requirement_dev_sessions (
    req_id TEXT NOT NULL,
    requirement_version INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    baseline_commit TEXT NOT NULL DEFAULT '',
    snapshot_commit TEXT NOT NULL DEFAULT '',
    selected_by TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    assigned_at TEXT NOT NULL,
    released_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (req_id, requirement_version)
);
CREATE INDEX IF NOT EXISTS requirement_dev_sessions_by_session
    ON requirement_dev_sessions(session_id, assigned_at);

-- 研发会话结束时的总结：绑定会话 ID 与需求，保留可回查文本。
CREATE TABLE IF NOT EXISTS dev_session_summaries (
    session_id TEXT NOT NULL,
    req_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    summary_sha256 TEXT NOT NULL,
    summary_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, req_id)
);
CREATE INDEX IF NOT EXISTS dev_session_summaries_by_req ON dev_session_summaries(req_id, created_at);

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
CREATE TABLE IF NOT EXISTS requirement_candidate_builds (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    verification_sha256 TEXT NOT NULL,
    package_version TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL,
    tarball TEXT NOT NULL,
    files_json TEXT NOT NULL,
    git_head TEXT NOT NULL DEFAULT '',
    built_at TEXT NOT NULL,
    evidence_dir TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version, candidate_sha256)
);

CREATE TABLE IF NOT EXISTS requirement_deployments (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    package_version TEXT NOT NULL,
    target_profile TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL,
    runtime_version TEXT NOT NULL,
    state TEXT NOT NULL,
    checks_json TEXT NOT NULL,
    evidence_dir TEXT NOT NULL,
    recorded_by TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version, candidate_sha256, target_profile)
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

-- 系统准入与人类批准分开记录；这里不写 by=owner，也不代表所有者批准。
CREATE TABLE IF NOT EXISTS requirement_admissions (
    admission_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    requirement_version INTEGER NOT NULL,
    decision TEXT NOT NULL,
    code TEXT NOT NULL,
    reason TEXT NOT NULL,
    basis_json TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requirement_admissions_by_req
    ON requirement_admissions(req_id, requirement_version, created_at);

-- 主动停止与可恢复失败分开记录；停止后不会因扫描或重启自动恢复。
CREATE TABLE IF NOT EXISTS requirement_stops (
    req_id TEXT PRIMARY KEY,
    requested_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    settled_at TEXT NOT NULL DEFAULT '',
    resumed_by TEXT NOT NULL DEFAULT '',
    resume_reason TEXT NOT NULL DEFAULT '',
    resumed_at TEXT NOT NULL DEFAULT ''
);

-- 需求级代码候选：同一需求可有多版候选，旧候选、验证与报告保留。
CREATE TABLE IF NOT EXISTS requirement_code_candidates (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    candidate_version INTEGER NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    requirement_version INTEGER NOT NULL,
    baseline_commit TEXT NOT NULL DEFAULT '',
    snapshot_commit TEXT NOT NULL DEFAULT '',
    diff_path TEXT NOT NULL,
    diff_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version, candidate_version)
);
CREATE INDEX IF NOT EXISTS requirement_code_candidates_by_sha
    ON requirement_code_candidates(req_id, plan_version, candidate_sha256);

-- 受控整合提交：只记录真实项目中的提交，不包含临时快照基线提交。
CREATE TABLE IF NOT EXISTS requirement_commits (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    commit_message TEXT NOT NULL,
    check_command_json TEXT NOT NULL,
    check_log_path TEXT NOT NULL,
    check_sha256 TEXT NOT NULL,
    files_json TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version, candidate_sha256)
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
    human_reason TEXT NOT NULL DEFAULT ''
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

CREATE TABLE IF NOT EXISTS deployment_intents (
    intent_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    target_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    artifact_version TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    approval TEXT NOT NULL DEFAULT 'owner',
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployment_intents_by_target ON deployment_intents (target_id, created_at);
CREATE INDEX IF NOT EXISTS deployment_intents_by_requirement ON deployment_intents (requirement_id, created_at);

CREATE TABLE IF NOT EXISTS deployment_decisions (
    intent_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS deployment_decisions_by_intent ON deployment_decisions (intent_id, decided_at);

CREATE TABLE IF NOT EXISTS delivery_rechecks (
    req_id TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    state TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (req_id, intent_id, event_id)
);
CREATE INDEX IF NOT EXISTS delivery_rechecks_by_req ON delivery_rechecks (req_id, state);

CREATE TABLE IF NOT EXISTS delivery_handoffs (
    req_id TEXT NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    target_id TEXT NOT NULL,
    state TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (req_id, candidate_sha256, target_id)
);

CREATE TABLE IF NOT EXISTS deployment_attempts (
    intent_id TEXT NOT NULL,
    op TEXT NOT NULL,
    state TEXT NOT NULL,
    exit_code INTEGER NOT NULL DEFAULT -1,
    result_json TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    tool_sha256 TEXT NOT NULL DEFAULT '',
    evidence_path TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS deployment_attempts_by_intent ON deployment_attempts (intent_id, started_at);

CREATE TABLE IF NOT EXISTS deployment_tool_scripts (
    tool_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment_tool_changes (
    change_id TEXT PRIMARY KEY,
    tool_id TEXT NOT NULL,
    path TEXT NOT NULL,
    previous_sha256 TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployment_tool_changes_by_tool ON deployment_tool_changes (tool_id, changed_at);
`

export type SqlParam = string | number | bigint | Uint8Array | null

export interface OpenOptions {
  /** true 时打开已有库且不创建新库，也不执行任何写入。 */
  readonly readOnly?: boolean
}

import type { Row } from './rows.js'

export class Database {
  readonly handle: DatabaseSync
  readonly path: string
  /** 释放是幂等的：重复关闭不再抛错，但关闭后的读写仍然失败。 */
  private closed = false

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

  prepare(sql: string): {
    get: (...params: readonly SqlParam[]) => Row | undefined
    all: (...params: readonly SqlParam[]) => Row[]
    run: (...params: readonly SqlParam[]) => { changes: number; lastInsertRowid: number | bigint }
  } {
    const statement = this.handle.prepare(sql)
    return {
      get: (...params) => statement.get(...params),
      all: (...params) => statement.all(...params),
      run: (...params) =>
        statement.run(...params) as {
          changes: number
          lastInsertRowid: number | bigint
        },
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
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
