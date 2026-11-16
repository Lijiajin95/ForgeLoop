/**
 * 设计文档受理：用户提交的功能设计文档就是需求原文，同时保存可回查的快照。
 *
 * 入口只有两种：业务会话里粘贴正文（inline），或引用项目内一份 Markdown（project-doc）。
 * 文档身份由项目内路径与内容摘要共同确定：同一份内容重复投递返回原需求，
 * 内容变化在原需求下追加版本；已终态需求不再修订，改为新需求并重新绑定路径。
 */

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

/** 快照标题只用于列表与对话里指认文档，完整正文始终以需求版本原文为准。 */
export const MAX_DOCUMENT_TITLE_CHARS = 120
export const UNTITLED_DOCUMENT = '未命名设计文档'

/** 文档入口前缀：只能在消息开头，避免正文里提到“文档：”被误判成提交。 */
const DOCUMENT_DIRECTIVE = /^\s*(?:设计文档|文档)\s*[：:]\s*([\s\S]*)$/i

/** 解析文档引用；前缀存在但路径为空时返回空路径，由受理层明确报错而不是静默当普通需求。 */
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

/** 计算一份文档的可核对快照：类型、路径、内容摘要、字节数与标题。正文仍由需求版本保存。 */
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

/** 一次文档提交的受理结论：新建、重复投递、追加版本，或旧需求已终态后新建。 */
export type DocumentIntakeOutcome = 'created' | 'duplicate' | 'revised' | 'recreated'

export interface DocumentIntakeResult {
  readonly reqId: string
  readonly requirementVersion: number
  readonly outcome: DocumentIntakeOutcome
  readonly document: DesignDocumentSnapshot
}

/** 从运行时返回的受理结果里读出稳定身份；字段缺失或畸形返回 null，不做猜测。 */
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
