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
-- 解除依据必须引用这里的决定编号，只有来源前缀不再视为有效。
-- 正文不另存一份，仍以 requirement_versions.text 为权威；快照只证明“这一版对应哪份文档”。
CREATE TABLE IF NOT EXISTS requirement_documents (
    req_id TEXT NOT NULL,
    requirement_version INTEGER NOT NULL,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    doc_path TEXT NOT NULL DEFAULT '',
    doc_sha256 TEXT NOT NULL,
    doc_bytes INTEGER NOT NULL,
    title TEXT NOT NULL,
    submitted_by TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    captured_at TEXT NOT NULL,
    PRIMARY KEY (req_id, requirement_version)
);
CREATE INDEX IF NOT EXISTS requirement_documents_by_path
    ON requirement_documents (project, doc_path, captured_at);

CREATE TABLE IF NOT EXISTS customer_decisions (
    decision_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    requirement_version INTEGER NOT NULL,
    existing_req_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    decision_source TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    decided_at TEXT NOT NULL,
    UNIQUE (req_id, requirement_version, existing_req_id)
);
CREATE TABLE IF NOT EXISTS requirement_commitment_resolutions (
    req_id TEXT NOT NULL,
    requirement_version INTEGER NOT NULL,
    existing_req_id TEXT NOT NULL,
    decision_id TEXT NOT NULL DEFAULT '',
    decision_source TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    decided_at TEXT NOT NULL,
    PRIMARY KEY (req_id, requirement_version, existing_req_id)
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
-- 历史分析没有该行时按无结构化规格处理，不补造。
CREATE TABLE IF NOT EXISTS requirement_analysis_specs (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    spec_json TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version)
);
CREATE TABLE IF NOT EXISTS requirement_assumption_results (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    assumption_id TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence TEXT NOT NULL,
    recorded_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version, assumption_id)
);
CREATE TABLE IF NOT EXISTS requirement_reviews (
    req_id TEXT NOT NULL,
    review_version INTEGER NOT NULL,
    analysis_version INTEGER NOT NULL,
    reviewer TEXT NOT NULL,
    verdict TEXT NOT NULL,
    summary TEXT NOT NULL,
    checks_json TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, review_version)
);
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
    library_digest TEXT NOT NULL DEFAULT '',
    library_review TEXT NOT NULL DEFAULT '',
    library_warnings TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, requirement_version, attempt)
);
-- 补列：已有库按 CREATE TABLE IF NOT EXISTS 建立，不做迁移或 ALTER；缺行按需求处理。
CREATE TABLE IF NOT EXISTS requirement_analysis_input_kinds (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version)
);
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
CREATE TABLE IF NOT EXISTS requirement_dev_clarifications (
    req_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    requirement_version INTEGER NOT NULL,
    question TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, seq)
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

CREATE TABLE IF NOT EXISTS requirement_installable_deliveries (
    delivery_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    delivery_version INTEGER NOT NULL,
    project TEXT NOT NULL,
    requirement_version INTEGER NOT NULL,
    plan_version INTEGER NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    package_version TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL,
    tarball TEXT NOT NULL,
    instructions_path TEXT NOT NULL,
    instructions_sha256 TEXT NOT NULL,
    instructions_bytes INTEGER NOT NULL,
    verification_sha256 TEXT NOT NULL,
    business_review_sha256 TEXT NOT NULL,
    trial_target TEXT NOT NULL,
    trial_runtime_version TEXT NOT NULL,
    trial_artifact_sha256 TEXT NOT NULL,
    available_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    evidence_dir TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requirement_installable_deliveries_by_project
    ON requirement_installable_deliveries (project, available_at);
CREATE INDEX IF NOT EXISTS requirement_installable_deliveries_by_req
    ON requirement_installable_deliveries (req_id, delivery_version);

-- 已有权威记录（澄清回答、业务决定、授权、延长、停止、取消）只有时刻，不会写这里；
-- 同一人的重叠区间在聚合时合并，缺结束时刻按“时长未知”展示。
CREATE TABLE IF NOT EXISTS human_interventions (
    intervention_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    project TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS human_interventions_by_project
    ON human_interventions (project, started_at);
CREATE INDEX IF NOT EXISTS human_interventions_by_req
    ON human_interventions (req_id, started_at);

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

-- 只追加、不改写，页面按时间倒序展示最近若干条。
CREATE TABLE IF NOT EXISTS reliability_metric_samples (
    sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    sampled_at TEXT NOT NULL,
    revision TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reliability_metric_samples_by_project
    ON reliability_metric_samples (project, sample_id);

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

-- 分析时按 id 取索引、按 path/ref 读正文，并据此生成注入摘要。
CREATE TABLE IF NOT EXISTS library_entries (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    topics_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    always INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    declared_at TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    missing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS library_entries_by_status ON library_entries (status, missing);

CREATE TABLE IF NOT EXISTS library_rebuilds (
  run_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  requested_by TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  pid INTEGER NOT NULL DEFAULT 0,
  batch_log_json TEXT NOT NULL DEFAULT '[]',
  materials INTEGER NOT NULL DEFAULT 0,
  batches INTEGER NOT NULL DEFAULT 0,
  batches_done INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  drafts INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  unresolved INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  report_path TEXT NOT NULL DEFAULT '',
  published_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS library_rebuilds_by_project ON library_rebuilds (project, started_at);
`

export type SqlParam = string | number | bigint | Uint8Array | null

function ensureColumn(
  handle: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = handle.prepare(`PRAGMA table_info(${table})`).all()
  if (rows.some((row) => String(row.name) === column)) return
  handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

export interface OpenOptions {
  readonly readOnly?: boolean
}

import type { Row } from './rows.js'

export class Database {
  readonly handle: DatabaseSync
  readonly path: string
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
      ensureColumn(
        handle,
        'requirement_commitment_resolutions',
        'decision_id',
        "TEXT NOT NULL DEFAULT ''",
      )
      ensureColumn(
        handle,
        'requirement_analysis_attempts',
        'library_digest',
        "TEXT NOT NULL DEFAULT ''",
      )
      ensureColumn(
        handle,
        'requirement_analysis_attempts',
        'library_review',
        "TEXT NOT NULL DEFAULT ''",
      )
      ensureColumn(
        handle,
        'requirement_analysis_attempts',
        'library_warnings',
        "TEXT NOT NULL DEFAULT '[]'",
      )
      ensureColumn(handle, 'library_rebuilds', 'pid', 'INTEGER NOT NULL DEFAULT 0')
      ensureColumn(handle, 'library_rebuilds', 'batch_log_json', "TEXT NOT NULL DEFAULT '[]'")
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

  transaction<T>(operation: () => T): T {
    this.handle.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.handle.exec('COMMIT')
      return value
    } catch (error) {
      this.rollback()
      throw error
    }
  }

  private rollback(): boolean {
    try {
      this.handle.exec('ROLLBACK')
      return true
    } catch {
      return false
    }
  }
}

export function isoNow(now = new Date()): string {
  return now.toISOString()
}
