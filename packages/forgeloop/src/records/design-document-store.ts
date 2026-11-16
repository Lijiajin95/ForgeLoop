/**
 * 设计文档快照记录：需求版本与“当时提交的是哪份文档”的对应关系。
 *
 * 只追加：同一需求版本只有一条快照，重复写入不覆盖；修订产生新版本时另行追加。
 * 正文仍保存在 requirement_versions，本表只提供身份与内容摘要，避免同一份文档存两份。
 */

import type { Database } from './db.js'
import { num, text, type Row } from './rows.js'
import type { DesignDocumentSnapshot, DocumentKind } from '../domain/design-document.js'

export interface RequirementDocumentRecord extends DesignDocumentSnapshot {
  readonly reqId: string
  readonly requirementVersion: number
  readonly project: string
  readonly submittedBy: string
  readonly source: string
  readonly capturedAt: string
}

function kindOf(value: string): DocumentKind {
  return value === 'project-doc' ? 'project-doc' : 'inline'
}

function documentRow(row: Row): RequirementDocumentRecord {
  return {
    reqId: text(row, 'req_id'),
    requirementVersion: num(row, 'requirement_version'),
    project: text(row, 'project'),
    kind: kindOf(text(row, 'kind')),
    path: text(row, 'doc_path'),
    sha256: text(row, 'doc_sha256'),
    bytes: num(row, 'doc_bytes'),
    title: text(row, 'title'),
    submittedBy: text(row, 'submitted_by'),
    source: text(row, 'source'),
    capturedAt: text(row, 'captured_at'),
  }
}

export class DesignDocumentStore {
  constructor(readonly db: Database) {}

  /** 快照是不可变事实：同一需求版本重复写入只保留首次记录。 */
  record(record: RequirementDocumentRecord): void {
    this.db
      .prepare(
        `INSERT INTO requirement_documents
          (req_id, requirement_version, project, kind, doc_path, doc_sha256, doc_bytes,
           title, submitted_by, source, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, requirement_version) DO NOTHING`,
      )
      .run(
        record.reqId,
        record.requirementVersion,
        record.project,
        record.kind,
        record.path,
        record.sha256,
        record.bytes,
        record.title,
        record.submittedBy,
        record.source,
        record.capturedAt,
      )
  }

  documentsOf(reqId: string): RequirementDocumentRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM requirement_documents WHERE req_id = ? ORDER BY requirement_version, rowid',
      )
      .all(reqId)
      .map(documentRow)
  }

  /** 项目内同一路径最近一次绑定的快照；内联提交没有路径，不参与项目文档去重。 */
  latestByPath(project: string, path: string): RequirementDocumentRecord | null {
    const target = path.trim()
    if (!target) return null
    const row = this.db
      .prepare(
        `SELECT * FROM requirement_documents
          WHERE project = ? AND doc_path = ?
          ORDER BY captured_at DESC, rowid DESC LIMIT 1`,
      )
      .get(project, target)
    return row ? documentRow(row) : null
  }
}
