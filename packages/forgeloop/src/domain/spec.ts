/**
 * 结构化需求说明：业务要点、可观察验收与未确认假设。
 *
 * 目标是把“用户原文 → 业务要点 → 验收项 → 研发/验证输入”串成同一份权威结构。
 * 这里只做字段合法性、编号唯一、引用有效与覆盖关系等确定性检查；
 * 语义质量（是否真的完整、是否误解业务）由真实模型样本评审，不用关键词黑名单、
 * 字数门槛或模型自报“通过”代替。
 */

import { asRecord } from './json.js'
import { MalformedError } from './errors.js'
import type { TaskPlan } from './task-plan.js'

/** 业务要点的依据：用户明确要求、已生效项目约定或外部资料。模型推断只能进假设。 */
export type PointBasis = 'user_requirement' | 'project_convention' | 'external_material'

const POINT_BASES: readonly PointBasis[] = [
  'user_requirement',
  'project_convention',
  'external_material',
]

/** 异常与边界必须说明是已评估、评估后不适用，还是尚未分析。 */
export type ExceptionStatus = 'assessed' | 'not_applicable' | 'unanalyzed'

const EXCEPTION_STATUSES: readonly ExceptionStatus[] = ['assessed', 'not_applicable', 'unanalyzed']

export interface PointExceptions {
  readonly status: ExceptionStatus
  /** assessed 时列出的异常与边界；其他状态必须为空。 */
  readonly items: readonly string[]
  /** not_applicable / unanalyzed 的理由；assessed 可为空。 */
  readonly reason: string
}

export interface BusinessPoint {
  readonly id: string
  readonly basis: PointBasis
  /** 用户原文、项目文档路径或外部资料地址；用于回查依据。 */
  readonly source: string
  readonly actor: string
  readonly trigger: string
  readonly behavior: string
  readonly rules: readonly string[]
  readonly exceptions: PointExceptions
}

/** 可观察验收：谁在什么前置条件下做什么，以及能看到什么结果。 */
export interface AcceptanceCriterion {
  readonly id: string
  readonly pointIds: readonly string[]
  readonly given: string
  readonly when: string
  readonly then: string
}

/** 尚未验证的推断或外部假设；needsConfirmation 时不得进入研发。 */
export interface Assumption {
  readonly id: string
  readonly statement: string
  readonly basis: 'inference' | 'external_material'
  readonly source: string
  readonly impact: string
  readonly needsConfirmation: boolean
}

/** 与已有承诺的冲突：必须指明是哪条需求、冲突点、可选择的取舍以及需要决定什么。 */
export interface CommitmentConflict {
  /** 已有承诺所在需求，必须是项目中真实存在的其他需求。 */
  readonly existingReqId: string
  readonly commitment: string
  readonly conflict: string
  /** 至少两种可比较的取舍，交给所有者决定。 */
  readonly options: readonly string[]
  readonly decisionNeeded: string
}

export interface AnalysisSpec {
  readonly points: readonly BusinessPoint[]
  readonly acceptance: readonly AcceptanceCriterion[]
  readonly assumptions: readonly Assumption[]
  readonly conflicts: readonly CommitmentConflict[]
}

/** 只需规格字段的分析投影；避免 domain/requirement 与 domain/spec 形成循环依赖。 */
export interface SpecBearingAnalysis {
  readonly businessPoints?: readonly BusinessPoint[] | undefined
  readonly acceptanceItems?: readonly AcceptanceCriterion[] | undefined
  readonly assumptions?: readonly Assumption[] | undefined
  readonly conflicts?: readonly CommitmentConflict[] | undefined
  readonly clarifications?: readonly string[] | undefined
}

export interface ParsedSpecFields extends AnalysisSpec {
  /** 兼容既有提示词、看板与验证文本匹配的字符串形式；由结构化项渲染。 */
  readonly acceptanceCriteria: readonly string[]
}

const POINT_ID = /^BP-(\d+)$/
const ACCEPTANCE_ID = /^AC-(\d+)$/
const ASSUMPTION_ID = /^AS-(\d+)$/

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MalformedError(`分析字段 ${field} 必须是非空字符串`)
  }
  return value.trim()
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new MalformedError(`分析字段 ${field} 必须是字符串数组`)
  return value.map((item) => nonEmpty(item, field))
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  const record = asRecord(value)
  if (!record || Array.isArray(value)) {
    throw new MalformedError(`分析字段 ${field} 必须是对象`)
  }
  return record
}

function parseExceptions(value: unknown, field: string): PointExceptions {
  const data = objectAt(value, field)
  const status = data.status
  const found = EXCEPTION_STATUSES.find((item) => item === status)
  if (!found) {
    throw new MalformedError(
      `分析字段 ${field}.status 必须是 assessed、not_applicable 或 unanalyzed`,
    )
  }
  const items = stringList(data.items, `${field}.items`)
  const reason = typeof data.reason === 'string' ? data.reason.trim() : ''
  if (found === 'assessed' && items.length === 0) {
    throw new MalformedError(`业务要点 ${field} 标记已评估时必须列出异常与边界`)
  }
  if (found !== 'assessed' && items.length > 0) {
    throw new MalformedError(`业务要点 ${field} 不是 assessed 时 items 必须为空`)
  }
  if (found !== 'assessed' && !reason) {
    throw new MalformedError(`业务要点 ${field} 标记 ${found} 时必须说明理由`)
  }
  return { status: found, items, reason }
}

function parsePoint(value: unknown, index: number): BusinessPoint {
  const field = `business_points[${index}]`
  const data = objectAt(value, field)
  const id = nonEmpty(data.id, `${field}.id`)
  const basis = POINT_BASES.find((item) => item === data.basis)
  if (!basis) {
    throw new MalformedError(
      `分析字段 ${field}.basis 必须是 user_requirement、project_convention 或 external_material；模型推断只能放进 assumptions`,
    )
  }
  return {
    id,
    basis,
    source: nonEmpty(data.source, `${field}.source`),
    actor: nonEmpty(data.actor, `${field}.actor`),
    trigger: nonEmpty(data.trigger, `${field}.trigger`),
    behavior: nonEmpty(data.behavior, `${field}.behavior`),
    rules: stringList(data.rules, `${field}.rules`),
    exceptions: parseExceptions(data.exceptions, `${field}.exceptions`),
  }
}

function parseAcceptance(value: unknown, index: number): AcceptanceCriterion {
  const field = `acceptance_criteria[${index}]`
  const data = objectAt(value, field)
  return {
    id: nonEmpty(data.id, `${field}.id`),
    pointIds: stringList(data.point_ids, `${field}.point_ids`),
    given: nonEmpty(data.given, `${field}.given`),
    when: nonEmpty(data.when, `${field}.when`),
    then: nonEmpty(data.then, `${field}.then`),
  }
}

function parseAssumption(value: unknown, index: number): Assumption {
  const field = `assumptions[${index}]`
  const data = objectAt(value, field)
  const basis = data.basis
  if (basis !== 'inference' && basis !== 'external_material') {
    throw new MalformedError(
      `分析字段 ${field}.basis 必须是 inference 或 external_material；用户要求应写成业务要点`,
    )
  }
  // 存储层按 snake_case 序列化；旧行或驼峰字段也接受，避免读回时整条分析不可读。
  const needsConfirmation = data.needs_confirmation ?? data.needsConfirmation
  if (typeof needsConfirmation !== 'boolean') {
    throw new MalformedError(`分析字段 ${field}.needs_confirmation 必须是布尔值`)
  }
  return {
    id: nonEmpty(data.id, `${field}.id`),
    statement: nonEmpty(data.statement, `${field}.statement`),
    basis,
    source: nonEmpty(data.source, `${field}.source`),
    impact: nonEmpty(data.impact, `${field}.impact`),
    needsConfirmation,
  }
}

export function renderAcceptanceCriterion(item: AcceptanceCriterion): string {
  return `${item.id}：给定 ${item.given}；当 ${item.when}；则 ${item.then}`
}

/**
 * 解析分析载荷里的规格字段。兼容历史记录：缺字段得到空规格，
 * acceptance_criteria 仍是字符串时按旧格式读入；一旦给出业务要点，
 * 验收标准必须是带编号和 given/when/then 的对象，避免两套口径并存。
 */
function parseAcceptanceField(
  raw: unknown,
  points: readonly BusinessPoint[],
): { acceptance: AcceptanceCriterion[]; acceptanceCriteria: string[] } {
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new MalformedError('分析字段 acceptance_criteria 必须是数组')
  }
  const items = raw ?? []
  const strings = items.filter((item): item is string => typeof item === 'string')
  if (strings.length === items.length) {
    if (points.length > 0) {
      throw new MalformedError('给出业务要点时 acceptance_criteria 必须使用带编号的对象')
    }
    const criteria = strings.map((item) => item.trim())
    if (criteria.some((item) => !item)) {
      throw new MalformedError('分析字段 acceptance_criteria 只能包含非空字符串')
    }
    return { acceptance: [], acceptanceCriteria: criteria }
  }
  if (strings.length > 0) {
    throw new MalformedError('分析字段 acceptance_criteria 不能混用字符串与对象')
  }
  const acceptance = items.map((item, index) => parseAcceptance(item, index))
  // 顶层字符串保持纯可观察结果，供旧看板/文本覆盖使用；编号与 given/when 在结构化项中。
  return { acceptance, acceptanceCriteria: acceptance.map((item) => item.then) }
}

function parseConflicts(raw: unknown): CommitmentConflict[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new MalformedError('分析字段 conflicts 必须是数组')
  return raw.map((item, index) => {
    const field = `conflicts[${index}]`
    const data = objectAt(item, field)
    const options = stringList(data.options, `${field}.options`)
    if (options.length < 2) {
      throw new MalformedError(`${field}.options 必须给出至少两种可比较的取舍`)
    }
    return {
      existingReqId: nonEmpty(
        data.existing_req_id ?? data.existingReqId,
        `${field}.existing_req_id`,
      ),
      commitment: nonEmpty(data.commitment, `${field}.commitment`),
      conflict: nonEmpty(data.conflict, `${field}.conflict`),
      options,
      decisionNeeded: nonEmpty(
        data.decision_needed ?? data.decisionNeeded,
        `${field}.decision_needed`,
      ),
    } satisfies CommitmentConflict
  })
}

export function parseSpecFields(data: Record<string, unknown>): ParsedSpecFields {
  const rawPoints = data.business_points
  if (rawPoints !== undefined && !Array.isArray(rawPoints)) {
    throw new MalformedError('分析字段 business_points 必须是数组')
  }
  const points = (rawPoints ?? []).map((item, index) => parsePoint(item, index))
  const { acceptance, acceptanceCriteria } = parseAcceptanceField(data.acceptance_criteria, points)
  const rawAssumptions = data.assumptions
  if (rawAssumptions !== undefined && !Array.isArray(rawAssumptions)) {
    throw new MalformedError('分析字段 assumptions 必须是数组')
  }
  const assumptions = (rawAssumptions ?? []).map((item, index) => parseAssumption(item, index))
  const conflicts = parseConflicts(data.conflicts)
  return { points, acceptance, assumptions, conflicts, acceptanceCriteria }
}

function maxId(items: readonly { id: string }[], pattern: RegExp, label: string): number {
  let max = 0
  for (const item of items) {
    const match = pattern.exec(item.id)
    if (!match) throw new MalformedError(`${label} 编号必须形如 ${label}-1，实际 ${item.id}`)
    max = Math.max(max, Number(match[1]))
  }
  return max
}

function uniqueIds(items: readonly { id: string }[], label: string): void {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) throw new MalformedError(`${label} 编号不能重复：${item.id}`)
    seen.add(item.id)
  }
}

/** 新编号必须大于历史上已用编号，防止重新分析时把新增项悄悄挤回旧编号。 */
function stableIds(
  items: readonly { id: string }[],
  previous: readonly { id: string }[],
  label: string,
  historical: readonly string[] = [],
): void {
  const previousIds = new Set(previous.map((item) => item.id))
  const retired = new Set(historical)
  const previousMax = previous.reduce((max, item) => {
    const match = /\d+$/.exec(item.id)
    return Math.max(max, match ? Number(match[0]) : 0)
  }, 0)
  for (const item of items) {
    if (retired.has(item.id) && !previousIds.has(item.id)) {
      throw new MalformedError(
        `${label}编号 ${item.id} 已被历史版本使用，退役后不能复用；请使用更大的新编号`,
      )
    }
    if (previousIds.has(item.id)) continue
    const number = Number(/\d+$/.exec(item.id)?.[0] ?? 0)
    if (number <= previousMax) {
      throw new MalformedError(`${label} 新编号 ${item.id} 必须大于既有最大编号，不能重排历史编号`)
    }
  }
}

export interface SpecValidationInput {
  readonly spec: AnalysisSpec
  readonly complete: boolean
  readonly inputKind: 'requirement' | 'problem'
  readonly previous?: AnalysisSpec | null | undefined
  /** 当前需求的全部版本原文；用户要求类依据必须能在其中逐字核对。 */
  readonly requirementTexts?: readonly string[] | undefined
  /** 项目内 Markdown 文档是否存在；用于核对项目约定依据。 */
  readonly projectDocExists?: ((relative: string) => boolean) | undefined
  /** 项目内已存在的需求身份；冲突引用必须指向真实存在的其他需求。 */
  readonly knownRequirementIds?: readonly string[] | undefined
  readonly currentReqId?: string | undefined
  /** 历史分析用过的业务要点/验收编号；退役后不得复用。 */
  readonly historicalIds?: readonly string[] | undefined
}

/** 去掉引号、来源前缀与空白后比较，保留字词与标点本身。 */
function normalizeQuote(text: string): string {
  return text
    .replace(/^\s*(?:需求原文|用户原文|用户要求)\s*[：:]\s*/u, '')
    .replace(/^[「『“"']|[」』”"']$/gu, '')
    .replace(/\s+/gu, '')
}

function validatePointSource(point: BusinessPoint, input: SpecValidationInput): void {
  const source = point.source.trim()
  if (point.basis === 'user_requirement') {
    const texts = (input.requirementTexts ?? []).map(normalizeQuote)
    const quote = normalizeQuote(source)
    if (quote.length < 2 || !texts.some((text) => text.includes(quote))) {
      throw new MalformedError(
        `业务要点 ${point.id} 的用户原文依据无法在需求版本中逐字核对：${source}`,
      )
    }
    return
  }
  if (point.basis === 'project_convention') {
    const relative = source.split('#')[0]?.trim() ?? ''
    if (!relative || !input.projectDocExists?.(relative)) {
      throw new MalformedError(`业务要点 ${point.id} 引用的项目约定文档不存在或不可读：${source}`)
    }
    return
  }
  if (!/^https?:\/\/\S+$/u.test(source)) {
    throw new MalformedError(`业务要点 ${point.id} 的外部资料必须是 http(s) 地址：${source}`)
  }
}

/**
 * 确定性校验：编号、引用、覆盖与完成度。
 * complete=false（仍有待澄清）时允许规格不完整，但不允许非法引用；
 * complete=true 时缺业务要点、要点无验收、未分析异常或未确认假设都阻断。
 */
function validateIds(
  spec: AnalysisSpec,
  previous: AnalysisSpec | null | undefined,
  historicalIds: readonly string[],
): void {
  uniqueIds(spec.points, 'BP')
  uniqueIds(spec.acceptance, 'AC')
  uniqueIds(spec.assumptions, 'AS')
  maxId(spec.points, POINT_ID, 'BP')
  maxId(spec.acceptance, ACCEPTANCE_ID, 'AC')
  maxId(spec.assumptions, ASSUMPTION_ID, 'AS')
  stableIds(spec.points, previous?.points ?? [], '业务要点', historicalIds)
  stableIds(spec.acceptance, previous?.acceptance ?? [], '验收项', historicalIds)
  stableIds(spec.assumptions, previous?.assumptions ?? [], '假设', historicalIds)
}

function validateReferences(spec: AnalysisSpec): void {
  const pointIds = new Set(spec.points.map((point) => point.id))
  for (const item of spec.acceptance) {
    if (item.pointIds.length === 0) {
      throw new MalformedError(`验收项 ${item.id} 必须引用至少一个业务要点`)
    }
    for (const pointId of item.pointIds) {
      if (!pointIds.has(pointId)) {
        throw new MalformedError(`验收项 ${item.id} 引用了不存在的业务要点 ${pointId}`)
      }
    }
  }
  const covered = new Set(spec.acceptance.flatMap((item) => item.pointIds))
  for (const point of spec.points) {
    if (!covered.has(point.id)) {
      throw new MalformedError(`业务要点 ${point.id} 没有对应的可观察验收项`)
    }
    if (point.basis === 'project_convention' && !/\.md(?:#|$)/.test(point.source)) {
      throw new MalformedError(`业务要点 ${point.id} 引用项目约定时必须给出项目文档路径`)
    }
  }
}

function validateComplete(spec: AnalysisSpec): void {
  if (spec.points.length === 0) {
    throw new MalformedError('没有待澄清项时必须给出业务要点（business_points）')
  }
  for (const point of spec.points) {
    if (point.exceptions.status === 'unanalyzed') {
      throw new MalformedError(
        `业务要点 ${point.id} 的异常与边界尚未分析；必须评估、说明不适用，或先提出澄清`,
      )
    }
  }
  for (const assumption of spec.assumptions) {
    if (assumption.needsConfirmation) {
      throw new MalformedError(`假设 ${assumption.id} 仍需所有者确认；不能带着未确认假设进入研发`)
    }
  }
}

/**
 * 确定性校验：编号、引用、覆盖与完成度。
 * complete=false（仍有待澄清）时允许规格不完整，但不允许非法引用；
 * complete=true 时缺业务要点、要点无验收、未分析异常或未确认假设都阻断。
 */
export function validateSpec(input: SpecValidationInput): void {
  const { spec, complete, inputKind, previous } = input
  if (inputKind === 'problem') {
    if (
      spec.points.length > 0 ||
      spec.acceptance.length > 0 ||
      spec.assumptions.length > 0 ||
      spec.conflicts.length > 0
    ) {
      throw new MalformedError('问题输入不做业务要点拆解；只给现象与可检查的修复判据')
    }
    return
  }
  validateIds(spec, previous, input.historicalIds ?? [])
  validateReferences(spec)
  for (const point of spec.points) validatePointSource(point, input)
  validateConflicts(spec, input)
  if (complete) validateComplete(spec)
}

/** 冲突必须引用真实存在的其他需求，并给出可比较的取舍。 */
function validateConflicts(spec: AnalysisSpec, input: SpecValidationInput): void {
  const known = new Set(input.knownRequirementIds ?? [])
  for (const conflict of spec.conflicts) {
    if (conflict.existingReqId === input.currentReqId || !known.has(conflict.existingReqId)) {
      throw new MalformedError(
        `冲突引用 ${conflict.existingReqId} 不是项目中已存在的其他需求；不能据此暂停准入`,
      )
    }
  }
}

export function analysisSpecOf(analysis: SpecBearingAnalysis): AnalysisSpec {
  return {
    points: analysis.businessPoints ?? [],
    acceptance: analysis.acceptanceItems ?? [],
    assumptions: analysis.assumptions ?? [],
    conflicts: analysis.conflicts ?? [],
  }
}

export function hasStructuredSpec(analysis: SpecBearingAnalysis): boolean {
  return (analysis.businessPoints?.length ?? 0) > 0
}

export interface SpecChanges {
  readonly addedPoints: readonly string[]
  readonly changedPoints: readonly string[]
  readonly removedPoints: readonly string[]
  readonly addedAcceptance: readonly string[]
  readonly changedAcceptance: readonly string[]
  readonly removedAcceptance: readonly string[]
  readonly resolvedClarifications: readonly string[]
  readonly remainingClarifications: readonly string[]
  readonly newClarifications: readonly string[]
  readonly addedAssumptions: readonly string[]
  readonly changedAssumptions: readonly string[]
}

function byId(items: readonly { id: string }[]): Map<string, string> {
  return new Map(items.map((item) => [item.id, JSON.stringify(item)]))
}

/**
 * 两次分析之间的确定性差异：新增/修改/移除的要点与验收，以及澄清项的解决与新开。
 * 只按编号与序列化内容比较，不做语义推断。
 */
export function specChanges(
  previous: SpecBearingAnalysis | null,
  latest: SpecBearingAnalysis | null,
): SpecChanges {
  const before = previous
    ? analysisSpecOf(previous)
    : { points: [], acceptance: [], assumptions: [] }
  const after = latest ? analysisSpecOf(latest) : { points: [], acceptance: [], assumptions: [] }
  const beforePoints = byId(before.points)
  const afterPoints = byId(after.points)
  const beforeAcceptance = byId(before.acceptance)
  const afterAcceptance = byId(after.acceptance)
  const beforeAssumptions = byId(before.assumptions)
  const afterAssumptions = byId(after.assumptions)
  const diff = (
    beforeMap: Map<string, string>,
    afterMap: Map<string, string>,
  ): { added: string[]; changed: string[]; removed: string[] } => ({
    added: [...afterMap.keys()].filter((id) => !beforeMap.has(id)),
    changed: [...afterMap.entries()]
      .filter(([id, value]) => beforeMap.has(id) && beforeMap.get(id) !== value)
      .map(([id]) => id),
    removed: [...beforeMap.keys()].filter((id) => !afterMap.has(id)),
  })
  const points = diff(beforePoints, afterPoints)
  const acceptance = diff(beforeAcceptance, afterAcceptance)
  const assumptions = diff(beforeAssumptions, afterAssumptions)
  const beforeClarifications = previous?.clarifications ?? []
  const afterClarifications = latest?.clarifications ?? []
  return {
    addedPoints: points.added,
    changedPoints: points.changed,
    removedPoints: points.removed,
    addedAcceptance: acceptance.added,
    changedAcceptance: acceptance.changed,
    removedAcceptance: acceptance.removed,
    resolvedClarifications: beforeClarifications.filter(
      (question) => !afterClarifications.includes(question),
    ),
    remainingClarifications: afterClarifications.filter((question) =>
      beforeClarifications.includes(question),
    ),
    newClarifications: afterClarifications.filter(
      (question) => !beforeClarifications.includes(question),
    ),
    addedAssumptions: assumptions.added,
    changedAssumptions: assumptions.changed,
  }
}
export interface PlanCoverageIssue {
  readonly code: 'unknown_point' | 'missing_point'
  readonly detail: string
}

/** 任务包必须显式覆盖每条业务要点；没有结构化规格的旧分析不套用。 */
export function planCoverageIssues(
  analysis: SpecBearingAnalysis,
  plan: TaskPlan,
): PlanCoverageIssue[] {
  if (!hasStructuredSpec(analysis)) return []
  const points = new Set((analysis.businessPoints ?? []).map((point) => point.id))
  const issues: PlanCoverageIssue[] = []
  for (const task of plan.tasks) {
    for (const pointId of task.covers ?? []) {
      if (!points.has(pointId)) {
        issues.push({
          code: 'unknown_point',
          detail: `任务 ${task.taskId} 覆盖了不存在的业务要点 ${pointId}`,
        })
      }
    }
  }
  const covered = new Set(plan.tasks.flatMap((task) => task.covers ?? []))
  for (const pointId of points) {
    if (!covered.has(pointId)) {
      issues.push({
        code: 'missing_point',
        detail: `没有任务覆盖业务要点 ${pointId}`,
      })
    }
  }
  return issues
}
