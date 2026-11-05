/**
 * 需求受理的身份与修订规则（迁移自旧 `domain/requirement.py`）：
 * - 首次提交原文占用版本 1，永久保留；修订只追加，不覆盖。
 * - 同一目标的修订不重新分配身份，版本号从 1 起连续。
 * - 未知身份明确失败。
 * - 分析结果必须是结构化对象；有待澄清项时等待回答，不进入实现。
 */

import { asRecord } from './json.js'
import { MalformedError, RuleViolationError, errorMessage } from './errors.js'
import { AWAITING_CLARIFICATION, DRAFT } from './status.js'
import type { ClarificationUpdate } from './analysis.js'

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

/** 构造并校验一条需求的全部版本：版本号连续、原文非空、绑定项目。 */
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

/**
 * 输入分诊结果：需求走需求分析流程，问题直接交研发定位与修复。
 * 历史分析没有该字段，一律按需求处理。
 */
export type InputKind = 'requirement' | 'problem'

export const INPUT_KINDS: readonly InputKind[] = ['requirement', 'problem']

export const DEFAULT_INPUT_KIND: InputKind = 'requirement'

export interface RequirementAnalysis {
  readonly analysisVersion: number
  readonly requirementVersion: number
  /** 输入分诊结论；缺省表示历史记录，按需求处理。 */
  readonly inputKind?: InputKind
  readonly goal: string
  readonly scenarios: readonly string[]
  /** 业务规则：哪些业务约束必须成立。 */
  readonly businessRules?: readonly string[]
  /** 异常与边界：异常路径、边界条件与不可用状态。 */
  readonly exceptions?: readonly string[]
  /** 非目标：本需求明确不做的范围。 */
  readonly nonGoals?: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly clarifications: readonly string[]
  /** 产生该结论的模型与提示词版本；历史记录可能为空。 */
  readonly model?: string
  readonly promptVersion?: string
  /** 该次分析的 Agent 轨迹文件。 */
  readonly transcriptPath?: string
  readonly toolCalls?: readonly string[]
  readonly createdAt: string
}

/** 业务背景文档的同步指令：changed=false 表示没变化，document 必须为空。 */
export interface BusinessContextDraft {
  readonly changed: boolean
  readonly document: string
}

export interface AnalysisDraft {
  readonly inputKind: InputKind
  readonly goal: string
  readonly scenarios: readonly string[]
  readonly businessRules: readonly string[]
  readonly exceptions: readonly string[]
  readonly nonGoals: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly clarifications: readonly string[]
  /** 本轮对上一轮未解决问题的逐项处置；首次分析为空。 */
  readonly clarificationUpdates: readonly ClarificationUpdate[]
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

/** 缺字段按空数组处理；字段存在但不是字符串数组时交给 stringList 报畸形。 */
function listField(data: Record<string, unknown>, key: string): readonly string[] {
  return stringList(data[key] ?? [], key)
}

/**
 * 业务背景同步指令：缺字段视为“没有变化”，兼容历史分析；
 * changed=true 必须带完整文档，changed=false 不许夹带内容，避免程序写半截文档。
 */
function businessContextField(data: Record<string, unknown>): BusinessContextDraft {
  const raw = data.business_context
  if (raw === undefined || raw === null) return { changed: false, document: '' }
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
  if (record.changed) {
    if (!text.trim()) {
      throw new MalformedError('business_context.changed 为 true 时必须给出完整的业务背景文档')
    }
    return { changed: true, document: text }
  }
  if (text.trim()) {
    throw new MalformedError('business_context.changed 为 false 时 document 必须为空')
  }
  return { changed: false, document: '' }
}

/**
 * 输入分诊字段：缺省按需求处理，兼容历史分析；出现未知取值时按畸形失败，
 * 不猜测输入类型。
 */
function inputKindField(data: Record<string, unknown>): InputKind {
  const raw = data.input_kind
  if (raw === undefined || raw === null || raw === '') return DEFAULT_INPUT_KIND
  if (raw === 'requirement' || raw === 'problem') return raw
  throw new MalformedError('分析字段 input_kind 只能是 requirement 或 problem')
}

/**
 * 本轮对旧问题的处置。问题身份必须指向上一轮未解决问题（程序在调用方核对）；
 * 这里只校验结构、非空理由与重复引用，不猜测模型想解决哪个问题。
 */
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

/**
 * 处理完本轮旧问题后仍有开放项时，不要求场景与验收标准已经完整；
 * 全部开放项都已解决或本轮没有待澄清项时，才要求给出可研发可验证的完整内容。
 */
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

/**
 * 解析模型返回的分析载荷。默认容忍 ```json 围栏与前后说明，但字段本身必须合法；
 * 缺字段或类型不符按畸形失败，不静默补空值。
 */
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
  // 业务规则、异常与边界、非目标允许为空（历史分析没有这些字段），但给定时必须是字符串数组。
  const businessRules = listField(data, 'business_rules')
  const exceptions = listField(data, 'exceptions')
  const nonGoals = listField(data, 'non_goals')
  const acceptanceCriteria = listField(data, 'acceptance_criteria')
  const clarifications = listField(data, 'clarifications')
  const clarificationUpdates = clarificationUpdatesField(data)
  const businessContext = businessContextField(data)
  // 问题不做产品侧澄清：带待澄清项或旧问题处置都说明它需要需求澄清，按需求处理，不能悄悄放行。
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
    clarifications,
    clarificationUpdates,
    businessContext,
  }
}

export function parseJsonLoose(text: string, what: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1]?.trim() ?? text.trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  // 模型也可能只返回数组（例如验证命令清单）。数组载荷按方括号取整体，
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

/** 一次分析完成后的需求状态：有待澄清项时等待回答，否则仍是 draft。 */
export function statusForAnalysis(analysis: Pick<RequirementAnalysis, 'clarifications'>): string {
  return analysis.clarifications.length > 0 ? AWAITING_CLARIFICATION : DRAFT
}

/** 读取输入分诊结果；旧分析没有该字段时按需求处理，不改变既有流程。 */
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
  // 问题直接交研发处理：带待澄清项会让下游把它当需求等待回答，落库前就拒绝。
  if (analysis.inputKind === 'problem' && analysis.clarifications.length > 0) {
    throw new RuleViolationError('问题输入不能带待澄清项；需要澄清时按需求处理')
  }
}
