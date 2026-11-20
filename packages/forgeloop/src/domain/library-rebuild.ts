import {
  LIBRARY_MAX_BODY_BYTES,
  LIBRARY_MAX_ENTRIES,
  LIBRARY_MAX_SUMMARY_CHARS,
  type LibraryStatus,
} from './library.js'
import { asRecord } from './json.js'
import { errorMessage } from './errors.js'

export class RebuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RebuildError'
  }
}

export type RebuildSourceKind = 'doc' | 'acceptance' | 'git' | 'source' | 'library'

export const REBUILD_SOURCE_KINDS: readonly RebuildSourceKind[] = [
  'doc',
  'acceptance',
  'git',
  'source',
  'library',
]

export type RebuildConfidence = 'low' | 'medium' | 'high'

export const REBUILD_CONFIDENCES: readonly RebuildConfidence[] = ['low', 'medium', 'high']

export const REBUILD_ENTRY_DIR = 'docs/product/library'
export const REBUILD_SOURCE_PREFIX = 'library-rebuild:'

export interface RebuildEvidence {
  readonly kind: RebuildSourceKind
  readonly ref: string
  readonly locator: string
  readonly time: string
  readonly digest: string
}

export interface RebuildCandidate {
  readonly id: string
  readonly title: string
  readonly topics: readonly string[]
  readonly summary: string
  readonly scope: string
  readonly goal: string
  readonly actors: readonly string[]
  readonly trigger: string
  readonly behavior: string
  readonly rules: readonly string[]
  readonly exceptions: readonly string[]
  readonly acceptance: readonly string[]
  readonly evidence: readonly RebuildEvidence[]
  readonly confidence: RebuildConfidence
  readonly gaps: readonly string[]
}

export interface RebuildEntrySnapshot {
  readonly id: string
  readonly status: LibraryStatus
  readonly path: string
  readonly sha256: string
  readonly source: string
}

export interface PreviousPublishedEntry {
  readonly id: string
  readonly sha256: string
  readonly fingerprint: string
}

export type RebuildReview =
  | { readonly kind: 'unchanged'; readonly id: string; readonly reason: string }
  | { readonly kind: 'create'; readonly candidate: RebuildCandidate }
  | {
      readonly kind: 'update'
      readonly id: string
      readonly candidate: RebuildCandidate
      readonly replacesSha: string
    }
  | {
      readonly kind: 'conflict'
      readonly id: string
      readonly candidate: RebuildCandidate
      readonly reason: string
    }
  | {
      readonly kind: 'unresolved'
      readonly id: string
      readonly candidate: RebuildCandidate
      readonly reason: string
    }
  | {
      readonly kind: 'overflow'
      readonly id: string
      readonly candidate: RebuildCandidate
      readonly reason: string
    }

export interface RebuildPublishItem {
  readonly action: 'create' | 'update'
  readonly id: string
  readonly path: string
  readonly content: string
  /** update 时替换的旧文件摘要；create 为空串。 */
  readonly replacesSha: string
}

export interface RebuildPlan {
  readonly reviews: readonly RebuildReview[]
  readonly publish: readonly RebuildPublishItem[]
  readonly overflow: readonly string[]
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/
const MAX_TOPIC_CHARS = 64
const MAX_TITLE_CHARS = 120
const MAX_SCOPE_CHARS = 200
const MAX_TEXT_CHARS = 500
const MAX_TOPICS = 12

function nonEmpty(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RebuildError(`重建候选 ${field} 必须是非空字符串`)
  }
  const text = value.trim()
  if (text.length > max) throw new RebuildError(`重建候选 ${field} 超过 ${max} 个字符`)
  return text
}

function textList(value: unknown, field: string, max = MAX_TEXT_CHARS): string[] {
  if (!Array.isArray(value)) throw new RebuildError(`重建候选 ${field} 必须是字符串数组`)
  return value.map((item, index) => nonEmpty(item, `${field}[${index}]`, max))
}

const SOURCE_KIND_SET: ReadonlySet<string> = new Set(REBUILD_SOURCE_KINDS)

function isSourceKind(value: unknown): value is RebuildSourceKind {
  return typeof value === 'string' && SOURCE_KIND_SET.has(value)
}

function evidenceList(value: unknown): RebuildEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RebuildError('重建候选必须包含至少一条证据')
  }
  return value.map((item, index) => {
    const record = asRecord(item)
    if (!record) {
      throw new RebuildError(`重建候选 evidence[${index}] 必须是对象`)
    }
    if (!isSourceKind(record.kind)) {
      throw new RebuildError(
        `重建候选 evidence[${index}].kind 只能是 ${REBUILD_SOURCE_KINDS.join('、')}`,
      )
    }
    const time = typeof record.time === 'string' ? record.time.trim() : ''
    if (time && !TIME_PATTERN.test(time)) {
      throw new RebuildError(`重建候选 evidence[${index}].time 必须是日期或 ISO 时间`)
    }
    return {
      kind: record.kind,
      ref: nonEmpty(record.ref, `evidence[${index}].ref`, 300),
      locator: nonEmpty(record.locator, `evidence[${index}].locator`, 300),
      time,
      digest: typeof record.digest === 'string' ? record.digest.trim().slice(0, 200) : '',
    }
  })
}

export function validateCandidate(candidate: RebuildCandidate): void {
  if (!ID_PATTERN.test(candidate.id)) {
    throw new RebuildError(`重建候选 id 只能是小写字母、数字、点、下划线与连字符：${candidate.id}`)
  }
  nonEmpty(candidate.title, 'title', MAX_TITLE_CHARS)
  nonEmpty(candidate.summary, 'summary', LIBRARY_MAX_SUMMARY_CHARS)
  nonEmpty(candidate.scope, 'scope', MAX_SCOPE_CHARS)
  nonEmpty(candidate.goal, 'goal', MAX_TEXT_CHARS)
  nonEmpty(candidate.trigger, 'trigger', MAX_TEXT_CHARS)
  nonEmpty(candidate.behavior, 'behavior', MAX_TEXT_CHARS)
  if (!Array.isArray(candidate.topics) || candidate.topics.length === 0) {
    throw new RebuildError('重建候选 topics 必须是非空数组')
  }
  if (candidate.topics.length > MAX_TOPICS) {
    throw new RebuildError(`重建候选 topics 最多 ${MAX_TOPICS} 个`)
  }
  const topics = new Set<string>()
  for (const topic of candidate.topics) {
    const text = nonEmpty(topic, 'topics', MAX_TOPIC_CHARS).toLowerCase()
    if (topics.has(text)) throw new RebuildError(`重建候选 topics 重复：${text}`)
    topics.add(text)
  }
  if (!Array.isArray(candidate.actors) || candidate.actors.length === 0) {
    throw new RebuildError('重建候选 actors 必须至少包含一个用户或角色')
  }
  textList(candidate.actors, 'actors', 120)
  textList(candidate.rules, 'rules')
  textList(candidate.exceptions, 'exceptions')
  const acceptance = textList(candidate.acceptance, 'acceptance')
  if (acceptance.length === 0) {
    throw new RebuildError('重建候选必须包含至少一条可观察验收条件')
  }
  if (!REBUILD_CONFIDENCES.includes(candidate.confidence)) {
    throw new RebuildError('重建候选 confidence 只能是 low、medium 或 high')
  }
  evidenceList(candidate.evidence)
  textList(candidate.gaps, 'gaps')
}

export function orderEvidence(evidence: readonly RebuildEvidence[]): RebuildEvidence[] {
  return [...evidence].sort((left, right) => {
    const leftTime = left.time || ''
    const rightTime = right.time || ''
    if (leftTime && rightTime && leftTime !== rightTime) return rightTime.localeCompare(leftTime)
    if (leftTime && !rightTime) return -1
    if (!leftTime && rightTime) return 1
    return (
      left.kind.localeCompare(right.kind) ||
      left.ref.localeCompare(right.ref) ||
      left.locator.localeCompare(right.locator)
    )
  })
}

function canonicalEvidence(evidence: RebuildEvidence): string {
  return `${evidence.kind}|${evidence.ref}|${evidence.locator}|${evidence.time}|${evidence.digest}`
}

export function candidateFingerprint(candidate: RebuildCandidate): string {
  const payload = {
    id: candidate.id,
    title: candidate.title,
    topics: [...candidate.topics],
    summary: candidate.summary,
    scope: candidate.scope,
    goal: candidate.goal,
    actors: [...candidate.actors],
    trigger: candidate.trigger,
    behavior: candidate.behavior,
    rules: [...candidate.rules],
    exceptions: [...candidate.exceptions],
    acceptance: [...candidate.acceptance],
    evidence: [...candidate.evidence].map(canonicalEvidence).sort(),
    confidence: candidate.confidence,
    gaps: [...candidate.gaps],
  }
  return JSON.stringify(payload)
}

function bulletList(values: readonly string[]): string {
  return values.length === 0 ? '（无）' : values.map((value) => `- ${value}`).join('\n')
}

export function renderCandidateBody(candidate: RebuildCandidate): string {
  const evidence = orderEvidence(candidate.evidence)
    .map((item) => {
      const time = item.time ? ` · ${item.time}` : ''
      const digest = item.digest ? ` · ${item.digest}` : ''
      return `- [${item.kind}] ${item.ref} · ${item.locator}${time}${digest}`
    })
    .join('\n')
  return [
    `# ${candidate.title}`,
    '',
    '## 业务目标',
    candidate.goal,
    '',
    '## 用户与角色',
    bulletList(candidate.actors),
    '',
    '## 触发与前提',
    candidate.trigger,
    '',
    '## 预期行为',
    candidate.behavior,
    '',
    '## 业务规则',
    bulletList(candidate.rules),
    '',
    '## 例外与边界',
    bulletList(candidate.exceptions),
    '',
    '## 可观察验收',
    bulletList(candidate.acceptance),
    '',
    '## 适用范围与版本',
    candidate.scope,
    '',
    '## 证据',
    evidence,
    ...(candidate.gaps.length > 0 ? ['', '## 证据缺口与待澄清', bulletList(candidate.gaps)] : []),
    '',
  ].join('\n')
}

export function candidateEntryPath(id: string): string {
  return `${REBUILD_ENTRY_DIR}/${id}.md`
}

export function candidateSource(runId: string, id: string): string {
  return `${REBUILD_SOURCE_PREFIX}${runId}#${id}`
}

export interface RenderEntryInput {
  readonly runId: string
  readonly updatedAt: string
}

export function renderCandidateEntry(candidate: RebuildCandidate, input: RenderEntryInput): string {
  validateCandidate(candidate)
  if (!TIME_PATTERN.test(input.updatedAt)) {
    throw new RebuildError('重建条目 updatedAt 必须是日期或 ISO 时间')
  }
  const body = renderCandidateBody(candidate)
  if (Buffer.byteLength(body, 'utf8') > LIBRARY_MAX_BODY_BYTES) {
    throw new RebuildError(`重建条目正文超过 ${LIBRARY_MAX_BODY_BYTES} 字节：${candidate.id}`)
  }
  const header = JSON.stringify(
    {
      id: candidate.id,
      title: candidate.title,
      status: 'draft',
      topics: candidate.topics,
      summary: candidate.summary,
      source: candidateSource(input.runId, candidate.id),
      updatedAt: input.updatedAt,
    },
    null,
    2,
  )
  return `<!-- library\n${header}\n-->\n\n${body}`
}

const CONFIDENCE_RANK: Record<RebuildConfidence, number> = { high: 0, medium: 1, low: 2 }

export function orderCandidates(candidates: readonly RebuildCandidate[]): RebuildCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence] ||
      right.evidence.length - left.evidence.length ||
      left.id.localeCompare(right.id),
  )
}

export interface ReviewCandidatesInput {
  readonly candidates: readonly RebuildCandidate[]
  readonly existing: readonly RebuildEntrySnapshot[]
  readonly previous: ReadonlyMap<string, PreviousPublishedEntry>
  readonly runId: string
  readonly updatedAt: string
  readonly capacity?: number
}

function reviewOne(input: {
  candidate: RebuildCandidate
  existing: RebuildEntrySnapshot | undefined
  previous: PreviousPublishedEntry | undefined
}): RebuildReview {
  const { candidate, existing, previous } = input
  if (!existing) return { kind: 'create', candidate }
  if (existing.status !== 'draft' || !existing.source.startsWith(REBUILD_SOURCE_PREFIX)) {
    return {
      kind: 'conflict',
      id: candidate.id,
      candidate,
      reason: '同 id 条目不是本功能生成的草稿（人工条目或已确认规则），保留原条目',
    }
  }
  if (!previous) {
    return {
      kind: 'unresolved',
      id: candidate.id,
      candidate,
      reason: '缺少上次发布记录摘要，无法核实是否被人工修改，保留原条目',
    }
  }
  if (previous.sha256 !== existing.sha256) {
    return {
      kind: 'conflict',
      id: candidate.id,
      candidate,
      reason: '文件与上次发布摘要不一致，按人工改动保护，保留原条目',
    }
  }
  if (previous.fingerprint === candidateFingerprint(candidate)) {
    return { kind: 'unchanged', id: candidate.id, reason: '业务规则一致，原样保留' }
  }
  return { kind: 'update', id: candidate.id, candidate, replacesSha: existing.sha256 }
}

export function planRebuild(input: ReviewCandidatesInput): RebuildPlan {
  const capacity = input.capacity ?? LIBRARY_MAX_ENTRIES
  const existingById = new Map(input.existing.map((entry) => [entry.id, entry]))
  const ordered = orderCandidates(input.candidates)
  const reviews: RebuildReview[] = []
  const publish: RebuildPublishItem[] = []
  const overflow: string[] = []
  let remaining = Math.max(0, capacity - input.existing.length)
  for (const candidate of ordered) {
    validateCandidate(candidate)
    const review = reviewOne({
      candidate,
      existing: existingById.get(candidate.id),
      previous: input.previous.get(candidate.id),
    })
    if (review.kind === 'create') {
      if (remaining <= 0) {
        overflow.push(candidate.id)
        reviews.push({
          kind: 'overflow',
          id: candidate.id,
          candidate,
          reason: '整库容量已满，候选仅进入报告，不写入库',
        })
        continue
      }
      remaining -= 1
      reviews.push(review)
      publish.push({
        action: 'create',
        id: candidate.id,
        path: candidateEntryPath(candidate.id),
        content: renderCandidateEntry(candidate, input),
        replacesSha: '',
      })
      continue
    }
    reviews.push(review)
    if (review.kind === 'update') {
      publish.push({
        action: 'update',
        id: candidate.id,
        path: candidateEntryPath(candidate.id),
        content: renderCandidateEntry(candidate, input),
        replacesSha: review.replacesSha,
      })
    }
  }
  return { reviews, publish, overflow }
}

export interface RebuildReviewSummary {
  readonly unchanged: number
  readonly created: number
  readonly updated: number
  readonly conflicts: number
  readonly unresolved: number
  readonly overflow: number
}

export function summarizeRebuildPlan(plan: RebuildPlan): RebuildReviewSummary {
  const summary = {
    unchanged: 0,
    created: 0,
    updated: 0,
    conflicts: 0,
    unresolved: 0,
    overflow: plan.overflow.length,
  }
  for (const review of plan.reviews) {
    if (review.kind === 'unchanged') summary.unchanged += 1
    if (review.kind === 'create') summary.created += 1
    if (review.kind === 'update') summary.updated += 1
    if (review.kind === 'conflict') summary.conflicts += 1
    if (review.kind === 'unresolved') summary.unresolved += 1
  }
  return summary
}

function candidateFromRecord(record: Record<string, unknown>, index: number): RebuildCandidate {
  const confidence = record.confidence
  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') {
    throw new RebuildError(`重建候选 candidates[${index}].confidence 只能是 low、medium 或 high`)
  }
  if (!Array.isArray(record.topics)) {
    throw new RebuildError(`重建候选 candidates[${index}].topics 必须是数组`)
  }
  const candidate: RebuildCandidate = {
    id: nonEmpty(record.id, `candidates[${index}].id`, 64),
    title: nonEmpty(record.title, `candidates[${index}].title`, MAX_TITLE_CHARS),
    topics: record.topics.map((topic, topicIndex) =>
      nonEmpty(topic, `candidates[${index}].topics[${topicIndex}]`, MAX_TOPIC_CHARS),
    ),
    summary: nonEmpty(record.summary, `candidates[${index}].summary`, LIBRARY_MAX_SUMMARY_CHARS),
    scope: nonEmpty(record.scope, `candidates[${index}].scope`, MAX_SCOPE_CHARS),
    goal: nonEmpty(record.goal, `candidates[${index}].goal`, MAX_TEXT_CHARS),
    actors: textList(record.actors, `candidates[${index}].actors`, 120),
    trigger: nonEmpty(record.trigger, `candidates[${index}].trigger`, MAX_TEXT_CHARS),
    behavior: nonEmpty(record.behavior, `candidates[${index}].behavior`, MAX_TEXT_CHARS),
    rules: textList(record.rules, `candidates[${index}].rules`),
    exceptions: textList(record.exceptions, `candidates[${index}].exceptions`),
    acceptance: textList(record.acceptance, `candidates[${index}].acceptance`),
    evidence: evidenceList(record.evidence),
    confidence,
    gaps: record.gaps === undefined ? [] : textList(record.gaps, `candidates[${index}].gaps`),
  }
  validateCandidate(candidate)
  return candidate
}

export function parseRebuildCandidates(text: string): RebuildCandidate[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let payload: unknown
  try {
    payload = JSON.parse(cleaned)
  } catch (error) {
    throw new RebuildError(`重建输出不是合法 JSON：${errorMessage(error)}`)
  }
  const record = asRecord(payload)
  if (!record) throw new RebuildError('重建输出必须是 JSON 对象')
  const list = record.candidates
  if (!Array.isArray(list)) throw new RebuildError('重建输出缺少 candidates 数组')
  return list.map((item, index) => {
    const candidate = asRecord(item)
    if (!candidate) throw new RebuildError(`重建候选 candidates[${index}] 必须是对象`)
    return candidateFromRecord(candidate, index)
  })
}
