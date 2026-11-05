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

export type RequirementItemKind =
  'scenario' | 'business_rule' | 'exception' | 'acceptance' | 'non_goal'

export type RequirementItemBasis = 'customer_explicit' | 'verified_fact' | 'assumption' | 'unknown'

/** 稳定需求条目：同一分析版本内身份稳定，供任务、验证与证据逐项追踪。 */
export interface RequirementItem {
  readonly itemId: string
  readonly kind: RequirementItemKind
  readonly text: string
  readonly basis: RequirementItemBasis
}

export interface RequirementAnalysis {
  readonly analysisVersion: number
  readonly requirementVersion: number
  /** 输入分诊结论；缺省表示历史记录，按需求处理。 */
  readonly inputKind?: InputKind
  readonly goal: string
  /** 结构化的需求条目；历史记录可能没有，读取时按字符串数组派生兼容 ID。 */
  readonly items?: readonly RequirementItem[]
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
  readonly items: readonly RequirementItem[]
  readonly itemsProvided: boolean
  readonly scenarios: readonly string[]
  readonly businessRules: readonly string[]
  readonly exceptions: readonly string[]
  readonly nonGoals: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly clarifications: readonly string[]
  readonly businessContext: BusinessContextDraft
}

const ITEM_KINDS: readonly RequirementItemKind[] = [
  'scenario',
  'business_rule',
  'exception',
  'acceptance',
  'non_goal',
]

const ITEM_KIND_SET: ReadonlySet<string> = new Set(ITEM_KINDS)

const ITEM_BASES: readonly RequirementItemBasis[] = [
  'customer_explicit',
  'verified_fact',
  'assumption',
  'unknown',
]

const ITEM_BASIS_SET: ReadonlySet<string> = new Set(ITEM_BASES)

export function isItemKind(value: unknown): value is RequirementItemKind {
  return typeof value === 'string' && ITEM_KIND_SET.has(value)
}

export function isItemBasis(value: unknown): value is RequirementItemBasis {
  return typeof value === 'string' && ITEM_BASIS_SET.has(value)
}

const ITEM_KIND_PREFIX: Record<RequirementItemKind, string> = {
  scenario: 'scenario',
  business_rule: 'rule',
  exception: 'exception',
  acceptance: 'acceptance',
  non_goal: 'non-goal',
}

function itemKindOf(value: unknown, field: string): RequirementItemKind {
  if (!isItemKind(value)) {
    throw new MalformedError(`分析条目 ${field}.kind 只能是 ${ITEM_KINDS.join('、')}`)
  }
  return value
}

function itemBasisOf(value: unknown, field: string): RequirementItemBasis {
  if (value === undefined || value === null || value === '') return 'unknown'
  if (!isItemBasis(value)) {
    throw new MalformedError(`分析条目 ${field}.basis 只能是 ${ITEM_BASES.join('、')}`)
  }
  return value
}

function itemsField(data: Record<string, unknown>): RequirementItem[] {
  const raw = data.items
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new MalformedError('分析字段 items 必须是数组')
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new MalformedError(`分析条目 items[${index}] 必须是对象`)
    }
    const record = asRecord(entry) ?? {}
    const itemId = typeof record.item_id === 'string' ? record.item_id.trim() : ''
    if (!itemId) throw new MalformedError(`分析条目 items[${index}].item_id 不能为空`)
    if (seen.has(itemId)) throw new MalformedError(`分析条目 item_id 不能重复：${itemId}`)
    seen.add(itemId)
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (!text) throw new MalformedError(`分析条目 items[${index}].text 不能为空`)
    return {
      itemId,
      kind: itemKindOf(record.kind, `items[${index}]`),
      text,
      basis: itemBasisOf(record.basis, `items[${index}]`),
    }
  })
}

/** 历史分析没有 items 时，按数组顺序派生稳定 ID；依据统一标为 unknown，不补造确认。 */
function legacyItems(input: {
  scenarios: readonly string[]
  businessRules: readonly string[]
  exceptions: readonly string[]
  acceptanceCriteria: readonly string[]
  nonGoals: readonly string[]
}): RequirementItem[] {
  const groups: Array<[RequirementItemKind, readonly string[]]> = [
    ['scenario', input.scenarios],
    ['business_rule', input.businessRules],
    ['exception', input.exceptions],
    ['acceptance', input.acceptanceCriteria],
    ['non_goal', input.nonGoals],
  ]
  const items: RequirementItem[] = []
  for (const [kind, texts] of groups) {
    texts.forEach((text, index) => {
      items.push({
        itemId: `${ITEM_KIND_PREFIX[kind]}-${index + 1}`,
        kind,
        text,
        basis: 'unknown',
      })
    })
  }
  return items
}

/** 读取分析条目；旧记录没有 items 时按数组派生，保证下游始终有稳定 ID。 */
export function analysisItems(analysis: RequirementAnalysis): RequirementItem[] {
  if (analysis.items && analysis.items.length > 0) return [...analysis.items]
  return legacyItems({
    scenarios: analysis.scenarios,
    businessRules: analysis.businessRules ?? [],
    exceptions: analysis.exceptions ?? [],
    acceptanceCriteria: analysis.acceptanceCriteria,
    nonGoals: analysis.nonGoals ?? [],
  })
}

function textsOf(items: readonly RequirementItem[], kind: RequirementItemKind): string[] {
  return items.filter((item) => item.kind === kind).map((item) => item.text)
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

function validateClarificationRules(input: {
  inputKind: InputKind
  clarifications: readonly string[]
  acceptanceCriteria: readonly string[]
  scenarios: readonly string[]
  allowProblemClarifications: boolean
}): void {
  if (
    input.inputKind === 'problem' &&
    input.clarifications.length > 0 &&
    !input.allowProblemClarifications
  ) {
    throw new MalformedError('问题直接交研发处理，不能带待澄清项；需要澄清时走研发回交澄清')
  }
  if (input.clarifications.length > 0) return
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

function analysisFields(data: Record<string, unknown>): {
  scenarios: readonly string[]
  businessRules: readonly string[]
  exceptions: readonly string[]
  nonGoals: readonly string[]
  acceptanceCriteria: readonly string[]
  clarifications: readonly string[]
  businessContext: BusinessContextDraft
  items: readonly RequirementItem[]
  itemsProvided: boolean
} {
  const scenarios = listField(data, 'scenarios')
  const businessRules = listField(data, 'business_rules')
  const exceptions = listField(data, 'exceptions')
  const nonGoals = listField(data, 'non_goals')
  const acceptanceCriteria = listField(data, 'acceptance_criteria')
  const clarifications = listField(data, 'clarifications')
  const businessContext = businessContextField(data)
  const items = itemsField(data)
  const provided = items.length > 0
  return {
    scenarios: provided ? textsOf(items, 'scenario') : scenarios,
    businessRules: provided ? textsOf(items, 'business_rule') : businessRules,
    exceptions: provided ? textsOf(items, 'exception') : exceptions,
    nonGoals: provided ? textsOf(items, 'non_goal') : nonGoals,
    acceptanceCriteria: provided ? textsOf(items, 'acceptance') : acceptanceCriteria,
    clarifications,
    businessContext,
    items,
    itemsProvided: provided,
  }
}

/**
 * 解析模型返回的分析载荷。默认容忍 ```json 围栏与前后说明，但字段本身必须合法；
 * 缺字段或类型不符按畸形失败，不静默补空值。
 */
export function parseAnalysisDraft(
  raw: unknown,
  options: { allowProblemClarifications?: boolean } = {},
): AnalysisDraft {
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
  const fields = analysisFields(data)
  const { clarifications } = fields
  const finalScenarios = fields.scenarios
  const finalAcceptance = fields.acceptanceCriteria
  validateClarificationRules({
    inputKind,
    clarifications,
    acceptanceCriteria: finalAcceptance,
    scenarios: finalScenarios,
    allowProblemClarifications: options.allowProblemClarifications === true,
  })
  return {
    inputKind,
    goal,
    items: fields.items,
    itemsProvided: fields.itemsProvided,
    scenarios: finalScenarios,
    businessRules: fields.businessRules,
    exceptions: fields.exceptions,
    nonGoals: fields.nonGoals,
    acceptanceCriteria: finalAcceptance,
    clarifications,
    businessContext: fields.businessContext,
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
  options: { allowProblemClarifications?: boolean } = {},
): void {
  if (analysis.analysisVersion < 1) throw new RuleViolationError('分析版本号必须从 1 开始')
  if (analysis.requirementVersion < 1) throw new RuleViolationError('分析必须绑定一个需求版本')
  if (analysis.requirementVersion > requirementVersionCount) {
    throw new RuleViolationError('分析绑定的需求版本超出实际版本')
  }
  if (!analysis.goal.trim()) throw new MalformedError('分析缺少非空目标')
  // 问题默认直接交研发处理；研发回交澄清时才允许带待澄清项。
  if (
    analysis.inputKind === 'problem' &&
    analysis.clarifications.length > 0 &&
    options.allowProblemClarifications !== true
  ) {
    throw new RuleViolationError('问题输入不能带待澄清项；需要澄清时走研发回交澄清')
  }
}
