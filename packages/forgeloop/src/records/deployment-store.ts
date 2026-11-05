/**
 * 部署记录：intent、工具调用、脚本摘要与变更历史。
 * 单独成类，避免业务仓储不断膨胀；表结构在 db.ts 的 SCHEMA 中。
 */

import {
  DEPLOYMENT_OPERATIONS,
  DEPLOYMENT_STATES,
  type DeploymentAttemptRecord,
  type DeploymentAttemptState,
  type DeploymentIntentRecord,
  type DeploymentOperation,
  type DeploymentToolChangeRecord,
  type DeploymentToolScriptRecord,
} from '../domain/deployment.js'
import type { Database } from './db.js'
import { num, text, type Row } from './rows.js'

export class DeploymentStore {
  constructor(readonly db: Database) {}

  recordDeploymentIntent(intent: DeploymentIntentRecord): void {
    this.db
      .prepare(
        `INSERT INTO deployment_intents
          (intent_id, project, target_id, requirement_id, artifact_sha256, artifact_path,
           artifact_version, source, approval, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        intent.intentId,
        intent.project,
        intent.targetId,
        intent.requirementId,
        intent.artifactSha256,
        intent.artifactPath,
        intent.artifactVersion,
        intent.source,
        intent.approval,
        intent.state,
        intent.createdAt,
        intent.updatedAt,
      )
  }

  updateDeploymentIntentState(intentId: string, state: string, updatedAt: string): void {
    this.db
      .prepare('UPDATE deployment_intents SET state = ?, updated_at = ? WHERE intent_id = ?')
      .run(state, updatedAt, intentId)
  }

  deploymentIntent(intentId: string): DeploymentIntentRecord | null {
    const row = this.db
      .prepare('SELECT * FROM deployment_intents WHERE intent_id = ?')
      .get(intentId)
    return row ? deploymentIntentRow(row) : null
  }

  deploymentIntents(limit = 20): DeploymentIntentRecord[] {
    return this.db
      .prepare('SELECT * FROM deployment_intents ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map(deploymentIntentRow)
  }

  recordDeploymentDecision(decision: {
    intentId: string
    decision: string
    by: string
    at: string
    detail?: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO deployment_decisions (intent_id, decision, decided_by, decided_at, detail)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(decision.intentId, decision.decision, decision.by, decision.at, decision.detail ?? '')
  }

  deploymentDecisions(intentId: string): Array<{
    intentId: string
    decision: string
    by: string
    at: string
    detail: string
  }> {
    return this.db
      .prepare('SELECT * FROM deployment_decisions WHERE intent_id = ? ORDER BY decided_at, rowid')
      .all(intentId)
      .map((row) => ({
        intentId: text(row, 'intent_id'),
        decision: text(row, 'decision'),
        by: text(row, 'decided_by'),
        at: text(row, 'decided_at'),
        detail: text(row, 'detail'),
      }))
  }

  deploymentIntentsForRequirement(reqId: string, limit = 50): DeploymentIntentRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM deployment_intents WHERE requirement_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(reqId, limit)
      .map(deploymentIntentRow)
  }

  recordDeploymentAttempt(attempt: DeploymentAttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO deployment_attempts
          (intent_id, op, state, exit_code, result_json, detail, tool_sha256, evidence_path,
           started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.intentId,
        attempt.op,
        attempt.state,
        attempt.exitCode,
        attempt.resultJson,
        attempt.detail,
        attempt.toolSha256,
        attempt.evidencePath,
        attempt.startedAt,
        attempt.finishedAt,
      )
  }

  deploymentAttempts(intentId: string): DeploymentAttemptRecord[] {
    return this.db
      .prepare('SELECT * FROM deployment_attempts WHERE intent_id = ? ORDER BY started_at')
      .all(intentId)
      .map(deploymentAttemptRow)
  }

  deploymentToolScript(toolId: string): DeploymentToolScriptRecord | null {
    const row = this.db
      .prepare('SELECT * FROM deployment_tool_scripts WHERE tool_id = ?')
      .get(toolId)
    return row
      ? {
          toolId: text(row, 'tool_id'),
          path: text(row, 'path'),
          sha256: text(row, 'sha256'),
          size: num(row, 'size'),
          recordedAt: text(row, 'recorded_at'),
        }
      : null
  }

  recordDeploymentToolScript(record: DeploymentToolScriptRecord): void {
    this.db
      .prepare(
        `INSERT INTO deployment_tool_scripts (tool_id, path, sha256, size, recorded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tool_id) DO UPDATE SET
           path = excluded.path, sha256 = excluded.sha256, size = excluded.size,
           recorded_at = excluded.recorded_at`,
      )
      .run(record.toolId, record.path, record.sha256, record.size, record.recordedAt)
  }

  recordDeploymentToolChange(change: DeploymentToolChangeRecord): void {
    this.db
      .prepare(
        `INSERT INTO deployment_tool_changes
          (change_id, tool_id, path, previous_sha256, sha256, changed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        change.changeId,
        change.toolId,
        change.path,
        change.previousSha256,
        change.sha256,
        change.changedAt,
      )
  }

  deploymentToolChanges(toolId: string): DeploymentToolChangeRecord[] {
    return this.db
      .prepare('SELECT * FROM deployment_tool_changes WHERE tool_id = ? ORDER BY changed_at')
      .all(toolId)
      .map((row) => ({
        changeId: text(row, 'change_id'),
        toolId: text(row, 'tool_id'),
        path: text(row, 'path'),
        previousSha256: text(row, 'previous_sha256'),
        sha256: text(row, 'sha256'),
        changedAt: text(row, 'changed_at'),
      }))
  }
}

const STATE_BY_NAME: Record<string, DeploymentAttemptState> = Object.fromEntries(
  DEPLOYMENT_STATES.map((state) => [state, state]),
)
const OP_BY_NAME: Record<string, DeploymentOperation> = Object.fromEntries(
  DEPLOYMENT_OPERATIONS.map((op) => [op, op]),
)

function deploymentIntentRow(row: Row): DeploymentIntentRecord {
  return {
    intentId: text(row, 'intent_id'),
    project: text(row, 'project'),
    targetId: text(row, 'target_id'),
    requirementId: text(row, 'requirement_id'),
    artifactSha256: text(row, 'artifact_sha256'),
    artifactPath: text(row, 'artifact_path'),
    artifactVersion: text(row, 'artifact_version'),
    source: text(row, 'source'),
    approval: text(row, 'approval') === 'auto' ? 'auto' : 'owner',
    state: STATE_BY_NAME[text(row, 'state')] ?? 'draft',
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  }
}

function deploymentAttemptRow(row: Row): DeploymentAttemptRecord {
  return {
    intentId: text(row, 'intent_id'),
    op: OP_BY_NAME[text(row, 'op')] ?? 'preflight',
    state: STATE_BY_NAME[text(row, 'state')] ?? 'draft',
    exitCode: num(row, 'exit_code'),
    resultJson: text(row, 'result_json'),
    detail: text(row, 'detail'),
    toolSha256: text(row, 'tool_sha256'),
    evidencePath: text(row, 'evidence_path'),
    startedAt: text(row, 'started_at'),
    finishedAt: text(row, 'finished_at'),
  }
}
