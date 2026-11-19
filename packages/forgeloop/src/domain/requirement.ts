import { asRecord } from './json.js'
import { MalformedError, RuleViolationError, errorMessage } from './errors.js'
import { AWAITING_CLARIFICATION, DRAFT } from './status.js'
import type { ClarificationUpdate } from './analysis.js'
import type { AcceptanceCriterion, Assumption, BusinessPoint, CommitmentConflict } from './spec.js'
import { parseSpecFields } from './spec.js'
import { parseLibraryReview, type LibraryReview } from './library.js'

export interface RequirementVersion {
  readonly version: number
  readonly text: string
  readonly createdAt: string
  readonly revisedBy: string
  readonly source: string
}

export interface Requirement {
  readonly reqId: string
  readonly project: string
  readonly status: string
  readonly blockedReason: string
  readonly versions: readonly RequirementVersion[]
  readonly submittedBy: string
  readonly source: string
}

export function validateRequirement(input: {
  reqId: string
  project: string
  versions: readonly RequirementVersion[]
}): void {
  if (!input.reqId.trim()) throw new RuleViolationError('需求身份不能为空')
  if (!input.project.trim()) throw new RuleViolationError('需求必须绑定一个项目')
  if (input.versions.length === 0) throw new RuleViolationError('需求至少要有原始输入这一版本')
  input.versions.forEach((version, index) => {
    if (version.version !== index + 1) {
      throw new RuleViolationError('需求版本号必须从 1 起连续递增，历史版本不得覆盖')
    }
    if (!version.text.trim()) throw new RuleViolationError('需求版本原文不能为空')
  })
}

export function latestVersion(requirement: Requirement): RequirementVersion {
  const version = requirement.versions[requirement.versions.length - 1]
  if (!version) throw new RuleViolationError('需求至少要有原始输入这一版本')
  return version
}

export type InputKind = 'requirement' | 'problem'

export const INPUT_KINDS: readonly InputKind[] = ['requirement', 'problem']

export const DEFAULT_INPUT_KIND: InputKind = 'requirement'

export interface RequirementAnalysis {
  readonly analysisVersion: number
  readonly requirementVersion: number
  readonly inputKind?: InputKind
  readonly goal: string
  readonly scenarios: readonly string[]
  readonly businessRules?: readonly string[]
  readonly exceptions?: readonly string[]
  readonly nonGoals?: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly businessPoints?: readonly BusinessPoint[]
  readonly acceptanceItems?: readonly AcceptanceCriterion[]
  readonly assumptions?: readonly Assumption[]
  readonly conflicts?: readonly CommitmentConflict[]
  readonly clarifications: readonly string[]
  readonly model?: string
  readonly promptVersion?: string
  readonly transcriptPath?: string
  readonly toolCalls?: readonly string[]
  readonly createdAt: string
}

/** 业务背景文档的同步指令：changed=false 表示没变化，document 必须为空。 */
export interface BusinessContextDraft {
  readonly changed: boolean
  readonly document: string
  readonly reason: string
}

export interface AnalysisDraft {
  readonly inputKind: InputKind
  readonly goal: string
  readonly scenarios: readonly string[]
  readonly businessRules: readonly string[]
  readonly exceptions: readonly string[]
  readonly nonGoals: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly businessPoints: readonly BusinessPoint[]
  readonly acceptanceItems: readonly AcceptanceCriterion[]
  readonly assumptions: readonly Assumption[]
  readonly conflicts: readonly CommitmentConflict[]
  readonly clarifications: readonly string[]
  readonly clarificationUpdates: readonly ClarificationUpdate[]
  readonly libraryReview: LibraryReview | null
  readonly businessContext: BusinessContextDraft
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new MalformedError(`分析字段 ${field} 必须是字符串数组`)
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new MalformedError(`分析字段 ${field} 只能包含非空字符串`)
    }
    items.push(item.trim())
  }
  return items
}

function listField(data: Record<string, unknown>, key: string): readonly string[] {
  return stringList(data[key] ?? [], key)
}

function businessContextField(data: Record<string, unknown>): BusinessContextDraft {
  const raw = data.business_context
  if (raw === undefined || raw === null) return { changed: false, document: '', reason: '' }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MalformedError('分析字段 business_context 必须是对象')
  }
  const record = asRecord(raw) ?? {}
  if (typeof record.changed !== 'boolean') {
    throw new MalformedError('分析字段 business_context.changed 必须是布尔值')
  }
  const document = record.document
  if (document !== undefined && typeof document !== 'string') {
    throw new MalformedError('分析字段 business_context.document 必须是字符串')
  }
  const text = typeof document === 'string' ? document : ''
  const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
  return record.changed ? changedContext(text, reason) : unchangedContext(text, reason)
}

function changedContext(document: string, reason: string): BusinessContextDraft {
  if (!document.trim()) {
    throw new MalformedError('business_context.changed 为 true 时必须给出完整的业务背景文档')
  }
  if (!reason) {
    throw new MalformedError(
      'business_context.changed 为 true 时必须给出 reason（需求原文、回答或项目资料依据）',
    )
  }
  return { changed: true, document, reason }
}

function unchangedContext(document: string, reason: string): BusinessContextDraft {
  if (document.trim()) {
    throw new MalformedError('business_context.changed 为 false 时 document 必须为空')
  }
  if (reason) {
    throw new MalformedError('business_context.changed 为 false 时 reason 必须为空')
  }
  return { changed: false, document: '', reason: '' }
}

function inputKindField(data: Record<string, unknown>): InputKind {
  const raw = data.input_kind
  if (raw === undefined || raw === null || raw === '') return DEFAULT_INPUT_KIND
  if (raw === 'requirement' || raw === 'problem') return raw
  throw new MalformedError('分析字段 input_kind 只能是 requirement 或 problem')
}

function clarificationUpdatesField(data: Record<string, unknown>): ClarificationUpdate[] {
  const raw = data.clarification_updates
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new MalformedError('分析字段 clarification_updates 必须是数组')
  const updates = raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new MalformedError(`分析字段 clarification_updates[${index}] 必须是对象`)
    }
    const record = asRecord(item) ?? {}
    const questionId = typeof record.question_id === 'string' ? record.question_id.trim() : ''
    if (!questionId) {
      throw new MalformedError(`分析字段 clarification_updates[${index}].question_id 不能为空`)
    }
    const status = record.status
    if (status !== 'resolved' && status !== 'open') {
      throw new MalformedError(
        `分析字段 clarification_updates[${index}].status 只能是 resolved 或 open`,
      )
    }
    const resolution = typeof record.resolution === 'string' ? record.resolution.trim() : ''
    const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
    if (status === 'resolved' && !resolution) {
      throw new MalformedError(
        `分析字段 clarification_updates[${index}] 标记已解决时必须给出 resolution`,
      )
    }
    if (status === 'open' && !reason) {
      throw new MalformedError(`分析字段 clarification_updates[${index}] 仍未解决时必须给出 reason`)
    }
    return { questionId, status, resolution, reason } satisfies ClarificationUpdate
  })
  const ids = updates.map((update) => update.questionId)
  if (new Set(ids).size !== ids.length) {
    throw new MalformedError('分析字段 clarification_updates 不能重复引用同一问题')
  }
  return updates
}

function assertDraftCompleteness(input: {
  inputKind: InputKind
  scenarios: readonly string[]
  acceptanceCriteria: readonly string[]
  clarifications: readonly string[]
  clarificationUpdates: readonly ClarificationUpdate[]
}): void {
  const openAfter =
    input.clarifications.length +
    input.clarificationUpdates.filter((update) => update.status === 'open').length
  if (openAfter > 0) return
  if (input.inputKind === 'problem') {
    if (input.acceptanceCriteria.length === 0) {
      throw new MalformedError('问题必须给出可检查的修复判据（acceptance_criteria）')
    }
    return
  }
  if (input.scenarios.length === 0 || input.acceptanceCriteria.length === 0) {
    throw new MalformedError('没有待澄清项时必须给出业务场景与验收标准')
  }
}

export function parseAnalysisDraft(raw: unknown): AnalysisDraft {
  let payload = raw
  if (typeof payload === 'string') {
    payload = parseJsonLoose(payload, '分析结果')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new MalformedError('分析结果必须是 JSON 对象')
  }
  const data = asRecord(payload) ?? {}
  const inputKind = inputKindField(data)
  const goal = typeof data.goal === 'string' ? data.goal.trim() : ''
  if (!goal) throw new MalformedError('分析缺少非空目标')
  const scenarios = listField(data, 'scenarios')
  const businessRules = listField(data, 'business_rules')
  const exceptions = listField(data, 'exceptions')
  const nonGoals = listField(data, 'non_goals')
  const spec = parseSpecFields(data)
  const acceptanceCriteria = spec.acceptanceCriteria
  const clarifications = listField(data, 'clarifications')
  const clarificationUpdates = clarificationUpdatesField(data)
  const businessContext = businessContextField(data)
  if (inputKind === 'problem' && (clarifications.length > 0 || clarificationUpdates.length > 0)) {
    throw new MalformedError('问题直接交研发处理，不能带待澄清项；需要澄清时按需求处理')
  }
  assertDraftCompleteness({
    inputKind,
    scenarios,
    acceptanceCriteria,
    clarifications,
    clarificationUpdates,
  })
  return {
    inputKind,
    goal,
    scenarios,
    businessRules,
    exceptions,
    nonGoals,
    acceptanceCriteria,
    businessPoints: spec.points,
    acceptanceItems: spec.acceptance,
    assumptions: spec.assumptions,
    conflicts: spec.conflicts,
    clarifications,
    clarificationUpdates,
    libraryReview: parseLibraryReview(data.library_review),
    businessContext,
  }
}

export function parseJsonLoose(text: string, what: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1]?.trim() ?? text.trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  // 模型也可能只返回数组（例如测试命令清单）。数组载荷按方括号取整体，
  // 不能套用对象的花括号切片，否则 [{...}] 会被切成单个对象而丢掉数组语义。
  const arrayStart = candidate.indexOf('[')
  const arrayEnd = candidate.lastIndexOf(']')
  const body =
    candidate.startsWith('[') && arrayStart >= 0 && arrayEnd > arrayStart
      ? candidate.slice(arrayStart, arrayEnd + 1)
      : start >= 0 && end > start
        ? candidate.slice(start, end + 1)
        : candidate
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new MalformedError(`${what}不是可解析的 JSON：${errorMessage(error)}`)
  }
}

export function statusForAnalysis(analysis: Pick<RequirementAnalysis, 'clarifications'>): string {
  return analysis.clarifications.length > 0 ? AWAITING_CLARIFICATION : DRAFT
}

export function inputKindOf(analysis: Pick<RequirementAnalysis, 'inputKind'>): InputKind {
  return analysis.inputKind ?? DEFAULT_INPUT_KIND
}

export function validateAnalysis(
  analysis: RequirementAnalysis,
  requirementVersionCount: number,
): void {
  if (analysis.analysisVersion < 1) throw new RuleViolationError('分析版本号必须从 1 开始')
  if (analysis.requirementVersion < 1) throw new RuleViolationError('分析必须绑定一个需求版本')
  if (analysis.requirementVersion > requirementVersionCount) {
    throw new RuleViolationError('分析绑定的需求版本超出实际版本')
  }
  if (!analysis.goal.trim()) throw new MalformedError('分析缺少非空目标')
  if (analysis.inputKind === 'problem' && analysis.clarifications.length > 0) {
    throw new RuleViolationError('问题输入不能带待澄清项；需要澄清时按需求处理')
  }
}
