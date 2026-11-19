import { sha256OfText } from './delivery.js'
import { asRecord } from './json.js'

export type DocumentKind = 'inline' | 'project-doc'

export interface DesignDocumentSnapshot {
  readonly kind: DocumentKind
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly title: string
}

export const MAX_DOCUMENT_TITLE_CHARS = 120
export const UNTITLED_DOCUMENT = '未命名设计文档'

const DOCUMENT_DIRECTIVE = /^\s*(?:设计文档|文档)\s*[：:]\s*([\s\S]*)$/i

export function documentDirectiveOf(text: string): { path: string } | null {
  const match = DOCUMENT_DIRECTIVE.exec(text)
  if (!match) return null
  return { path: (match[1] ?? '').trim() }
}

function titleOf(text: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const candidate = (heading?.[1] ?? firstLine ?? '').replace(/^[-*>#\s]+/, '').trim()
  return candidate ? candidate.slice(0, MAX_DOCUMENT_TITLE_CHARS) : UNTITLED_DOCUMENT
}

export function designDocumentSnapshot(
  text: string,
  input: { readonly kind?: DocumentKind; readonly path?: string } = {},
): DesignDocumentSnapshot {
  return {
    kind: input.kind ?? 'inline',
    path: input.path ?? '',
    sha256: sha256OfText(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    title: titleOf(text),
  }
}

export type DocumentIntakeOutcome = 'created' | 'duplicate' | 'revised' | 'recreated'

export interface DocumentIntakeResult {
  readonly reqId: string
  readonly requirementVersion: number
  readonly outcome: DocumentIntakeOutcome
  readonly document: DesignDocumentSnapshot
}

function outcomeOf(value: unknown): DocumentIntakeOutcome | null {
  if (
    value === 'created' ||
    value === 'duplicate' ||
    value === 'revised' ||
    value === 'recreated'
  ) {
    return value
  }
  return null
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function snapshotOf(value: unknown): DesignDocumentSnapshot | null {
  const document = asRecord(value)
  if (!document) return null
  return {
    kind: document.kind === 'project-doc' ? 'project-doc' : 'inline',
    path: textField(document.path),
    sha256: textField(document.sha256),
    bytes: typeof document.bytes === 'number' ? document.bytes : 0,
    title: textField(document.title),
  }
}

export function documentIntakeResultOf(view: unknown): DocumentIntakeResult | null {
  const record = asRecord(view)
  if (!record) return null
  const reqId = textField(record.reqId)
  const outcome = outcomeOf(record.outcome)
  const document = snapshotOf(record.document)
  if (!reqId || !outcome || !document) return null
  return {
    reqId,
    requirementVersion:
      typeof record.requirementVersion === 'number' ? record.requirementVersion : 0,
    outcome,
    document,
  }
}
