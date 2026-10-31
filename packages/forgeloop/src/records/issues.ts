/**
 * 内建问题单的 SQLite 适配。问题单只追加、通过状态收口；
 * 读取失败按畸形拒绝，不返回半份证据。
 */

import { MalformedError } from '../domain/errors.js'
import type { Database } from './db.js'
import {
  ISSUE_FIXED,
  ISSUE_OPEN,
  ISSUE_RESOLVED,
  type IssueStage,
  type IssueStatus,
  type RequirementIssue,
  type RequirementIssueEvidence,
} from '../domain/issue.js'

type Row = Record<string, unknown>

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

function num(row: Row, key: string): number {
  const value = row[key]
  return typeof value === 'number' ? value : Number(value)
}

function issueFromRow(row: Row): RequirementIssue {
  let evidence: RequirementIssueEvidence
  try {
    evidence = JSON.parse(text(row, 'evidence_json')) as RequirementIssueEvidence
  } catch (error) {
    throw new MalformedError(`问题单 ${text(row, 'issue_id')} 的证据不是可解析 JSON：${(error as Error).message}`)
  }
  return {
    issueId: text(row, 'issue_id'),
    requirementId: text(row, 'req_id'),
    project: text(row, 'project'),
    attempt: num(row, 'attempt'),
    stage: text(row, 'stage') as IssueStage,
    status: text(row, 'status') as IssueStatus,
    summary: text(row, 'summary'),
    evidence,
    verificationSha256: text(row, 'verification_sha256'),
    candidateSha256: text(row, 'candidate_sha256'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    resolvedAt: text(row, 'resolved_at'),
  }
}

export class IssueStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  /** 追加问题单；同一身份重复写入保持幂等，不覆盖既有证据。 */
  record(issue: RequirementIssue): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_issues
          (issue_id, req_id, project, attempt, stage, status, summary, evidence_json,
           verification_sha256, candidate_sha256, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO NOTHING`,
      )
      .run(
        issue.issueId,
        issue.requirementId,
        issue.project,
        issue.attempt,
        issue.stage,
        issue.status,
        issue.summary,
        JSON.stringify(issue.evidence),
        issue.verificationSha256,
        issue.candidateSha256,
        issue.createdAt,
        issue.updatedAt,
        issue.resolvedAt,
      )
  }

  get(issueId: string): RequirementIssue | null {
    const row = this.db.handle
      .prepare('SELECT * FROM requirement_issues WHERE issue_id = ?')
      .get(issueId) as Row | undefined
    return row ? issueFromRow(row) : null
  }

  /** 一个需求的全部问题单，按 attempt 升序；历史不删除。 */
  issuesFor(reqId: string): RequirementIssue[] {
    const rows = this.db.handle
      .prepare('SELECT * FROM requirement_issues WHERE req_id = ? ORDER BY attempt, created_at')
      .all(reqId) as Row[]
    return rows.map(issueFromRow)
  }

  /** 仍未收口的问题单：open 或已修复待验证。 */
  latestOpen(reqId: string): RequirementIssue | null {
    const row = this.db.handle
      .prepare(
        `SELECT * FROM requirement_issues
         WHERE req_id = ? AND status IN (?, ?)
         ORDER BY attempt DESC LIMIT 1`,
      )
      .get(reqId, ISSUE_OPEN, ISSUE_FIXED) as Row | undefined
    return row ? issueFromRow(row) : null
  }

  updateStatus(issueId: string, status: IssueStatus, now: string, summary?: string): boolean {
    const result =
      summary === undefined
        ? this.db.handle
            .prepare('UPDATE requirement_issues SET status = ?, updated_at = ? WHERE issue_id = ?')
            .run(status, now, issueId)
        : this.db.handle
            .prepare('UPDATE requirement_issues SET status = ?, updated_at = ?, summary = ? WHERE issue_id = ?')
            .run(status, now, summary, issueId)
    return Number(result.changes) > 0
  }

  /** 验证通过后收口该需求全部未解决问题单；返回收口数量。 */
  resolveOpen(reqId: string, now: string): number {
    const result = this.db.handle
      .prepare(
        `UPDATE requirement_issues
         SET status = ?, resolved_at = ?, updated_at = ?
         WHERE req_id = ? AND status IN (?, ?)`,
      )
      .run(ISSUE_RESOLVED, now, now, reqId, ISSUE_OPEN, ISSUE_FIXED)
    return Number(result.changes)
  }
}
