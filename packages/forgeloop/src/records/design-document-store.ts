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
