import { asRecord } from './json.js'
import { MalformedError } from './errors.js'
import type { TaskPlan } from './task-plan.js'

export type PointBasis = 'user_requirement' | 'project_convention' | 'external_material'

const POINT_BASES: readonly PointBasis[] = [
  'user_requirement',
  'project_convention',
  'external_material',
]

export type ExceptionStatus = 'assessed' | 'not_applicable' | 'unanalyzed'

const EXCEPTION_STATUSES: readonly ExceptionStatus[] = ['assessed', 'not_applicable', 'unanalyzed']

export interface PointExceptions {
  readonly status: ExceptionStatus
  readonly items: readonly string[]
  readonly reason: string
}

export interface BusinessPoint {
  readonly id: string
  readonly basis: PointBasis
  readonly source: string
  readonly actor: string
  readonly trigger: string
  readonly behavior: string
  readonly rules: readonly string[]
  readonly exceptions: PointExceptions
}

export interface AcceptanceCriterion {
  readonly id: string
  readonly pointIds: readonly string[]
  readonly given: string
  readonly when: string
  readonly then: string
}

export type AssumptionCategory =
  'desirability' | 'usability' | 'feasibility' | 'viability' | 'ethical'

const ASSUMPTION_CATEGORIES: readonly AssumptionCategory[] = [
  'desirability',
  'usability',
  'feasibility',
  'viability',
  'ethical',
]

export interface Assumption {
  readonly id: string
  readonly statement: string
  readonly basis: 'inference' | 'external_material'
  readonly source: string
  readonly impact: string
  readonly needsConfirmation: boolean
  readonly category?: AssumptionCategory | undefined
  readonly testMethod: string
  readonly successThreshold: string
}

export interface CommitmentConflict {
  readonly existingReqId: string
  readonly commitment: string
  readonly conflict: string
  readonly options: readonly string[]
  readonly decisionNeeded: string
}

export type ReferenceKind = 'project_doc' | 'external_source' | 'library_entry' | 'owner_decision'

const REFERENCE_KINDS: readonly ReferenceKind[] = [
  'project_doc',
  'external_source',
  'library_entry',
  'owner_decision',
]

export interface EvidenceReference {
  readonly id: string
  readonly kind: ReferenceKind
  readonly locator: string
  readonly version: string
  readonly excerpt: string
  readonly pointIds: readonly string[]
  readonly acceptanceIds: readonly string[]
}

export interface UiMapEntry {
  readonly id: string
  readonly entry: string
  readonly path: string
  readonly feedback: string
  readonly states: readonly string[]
  readonly pointIds: readonly string[]
  readonly acceptanceIds: readonly string[]
  readonly prototypeRef: string
  readonly prototypeVersion: string
}

export type SampleKind = 'normal' | 'counter_example'

const SAMPLE_KINDS: readonly SampleKind[] = ['normal', 'counter_example']

export interface AcceptanceSample {
  readonly id: string
  readonly kind: SampleKind
  readonly acceptanceIds: readonly string[]
  readonly data: string
  readonly precondition: string
  readonly steps: readonly string[]
  readonly expected: string
  readonly observeAt: string
}

export type QualityKind =
  | 'performance'
  | 'security'
  | 'usability'
  | 'availability'
  | 'compatibility'
  | 'observability'
  | 'compliance'

const QUALITY_KINDS: readonly QualityKind[] = [
  'performance',
  'security',
  'usability',
  'availability',
  'compatibility',
  'observability',
  'compliance',
]

export interface QualityAttribute {
  readonly id: string
  readonly kind: QualityKind
  readonly metric: string
  readonly target: string
  readonly measure: string
  readonly pointIds: readonly string[]
  readonly acceptanceIds: readonly string[]
}

export interface DataField {
  readonly name: string
  readonly type: string
  readonly constraints: string
}

export interface DataRequirement {
  readonly id: string
  readonly entity: string
  readonly fields: readonly DataField[]
  readonly retention: string
  readonly pii: boolean
  readonly pointIds: readonly string[]
  readonly acceptanceIds: readonly string[]
}

export interface AnalysisSpec {
  readonly points: readonly BusinessPoint[]
  readonly acceptance: readonly AcceptanceCriterion[]
  readonly assumptions: readonly Assumption[]
  readonly conflicts: readonly CommitmentConflict[]
  readonly references: readonly EvidenceReference[]
  readonly uiMap: readonly UiMapEntry[]
  readonly samples: readonly AcceptanceSample[]
  readonly quality: readonly QualityAttribute[]
  readonly data: readonly DataRequirement[]
}

/** 校验入口接受的规格：历史记录与调用方可能还没有本轮新增的产物。 */
export type SpecInput = Omit<
  AnalysisSpec,
  'references' | 'uiMap' | 'samples' | 'quality' | 'data'
> & {
  readonly references?: readonly EvidenceReference[] | undefined
  readonly uiMap?: readonly UiMapEntry[] | undefined
  readonly samples?: readonly AcceptanceSample[] | undefined
  readonly quality?: readonly QualityAttribute[] | undefined
  readonly data?: readonly DataRequirement[] | undefined
}

/** 只需规格字段的分析投影；避免 domain/requirement 与 domain/spec 形成循环依赖。 */
export interface SpecBearingAnalysis {
  readonly businessPoints?: readonly BusinessPoint[] | undefined
  readonly acceptanceItems?: readonly AcceptanceCriterion[] | undefined
  readonly assumptions?: readonly Assumption[] | undefined
  readonly conflicts?: readonly CommitmentConflict[] | undefined
  readonly references?: readonly EvidenceReference[] | undefined
  readonly uiMap?: readonly UiMapEntry[] | undefined
  readonly samples?: readonly AcceptanceSample[] | undefined
  readonly quality?: readonly QualityAttribute[] | undefined
  readonly data?: readonly DataRequirement[] | undefined
  readonly clarifications?: readonly string[] | undefined
}

export interface ParsedSpecFields extends AnalysisSpec {
  readonly acceptanceCriteria: readonly string[]
}

const POINT_ID = /^BP-(\d+)$/
const ACCEPTANCE_ID = /^AC-(\d+)$/
const ASSUMPTION_ID = /^AS-(\d+)$/
const REFERENCE_ID = /^REF-(\d+)$/
const UI_MAP_ID = /^UI-(\d+)$/
const SAMPLE_ID = /^SMP-(\d+)$/
const QUALITY_ID = /^QA-(\d+)$/
const DATA_ID = /^DATA-(\d+)$/

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
  const needsConfirmation = data.needs_confirmation ?? data.needsConfirmation
  if (typeof needsConfirmation !== 'boolean') {
    throw new MalformedError(`分析字段 ${field}.needs_confirmation 必须是布尔值`)
  }
  const rawCategory = data.category
  let category: AssumptionCategory | undefined
  if (typeof rawCategory === 'string' && rawCategory.trim()) {
    const found = ASSUMPTION_CATEGORIES.find((candidate) => candidate === rawCategory)
    if (!found) {
      throw new MalformedError(
        `分析字段 ${field}.category 必须是 desirability、usability、feasibility、viability 或 ethical`,
      )
    }
    category = found
  }
  const testMethod = typeof data.test_method === 'string' ? data.test_method.trim() : ''
  const successThreshold =
    typeof data.success_threshold === 'string' ? data.success_threshold.trim() : ''
  if (testMethod && !successThreshold) {
    throw new MalformedError(`${field} 给出验证方法时必须同时给出通过阈值`)
  }
  if (successThreshold && !testMethod) {
    throw new MalformedError(`${field} 给出通过阈值时必须同时给出验证方法`)
  }
  return {
    id: nonEmpty(data.id, `${field}.id`),
    statement: nonEmpty(data.statement, `${field}.statement`),
    basis,
    source: nonEmpty(data.source, `${field}.source`),
    impact: nonEmpty(data.impact, `${field}.impact`),
    needsConfirmation,
    category,
    testMethod,
    successThreshold,
  }
}

export function renderAcceptanceCriterion(item: AcceptanceCriterion): string {
  return `${item.id}：给定 ${item.given}；当 ${item.when}；则 ${item.then}`
}

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

function parseReferences(raw: unknown): EvidenceReference[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new MalformedError('分析字段 references 必须是数组')
  return raw.map((item, index) => {
    const field = `references[${index}]`
    const data = objectAt(item, field)
    const kind = REFERENCE_KINDS.find((candidate) => candidate === data.kind)
    if (!kind) {
      throw new MalformedError(
        `分析字段 ${field}.kind 必须是 project_doc、external_source、library_entry 或 owner_decision`,
      )
    }
    return {
      id: nonEmpty(data.id, `${field}.id`),
      kind,
      locator: nonEmpty(data.locator, `${field}.locator`),
      version: nonEmpty(data.version, `${field}.version`),
      excerpt: nonEmpty(data.excerpt, `${field}.excerpt`),
      pointIds: stringList(data.point_ids ?? data.pointIds, `${field}.point_ids`),
      acceptanceIds: stringList(
        data.acceptance_ids ?? data.acceptanceIds,
        `${field}.acceptance_ids`,
      ),
    } satisfies EvidenceReference
  })
}

function parseUiMap(raw: unknown): UiMapEntry[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new MalformedError('分析字段 ui_map 必须是数组')
  return raw.map((item, index) => {
    const field = `ui_map[${index}]`
    const data = objectAt(item, field)
    const prototypeRef = typeof data.prototype_ref === 'string' ? data.prototype_ref.trim() : ''
    const prototypeVersion =
      typeof data.prototype_version === 'string' ? data.prototype_version.trim() : ''
    if (prototypeVersion && !prototypeRef) {
      throw new MalformedError(`${field} 给出原型版本时必须同时给出原型引用`)
    }
    return {
      id: nonEmpty(data.id, `${field}.id`),
      entry: nonEmpty(data.entry, `${field}.entry`),
      path: nonEmpty(data.path, `${field}.path`),
      feedback: nonEmpty(data.feedback, `${field}.feedback`),
      states: stringList(data.states, `${field}.states`),
      pointIds: stringList(data.point_ids ?? data.pointIds, `${field}.point_ids`),
      acceptanceIds: stringList(
        data.acceptance_ids ?? data.acceptanceIds,
        `${field}.acceptance_ids`,
      ),
      prototypeRef,
      prototypeVersion,
    } satisfies UiMapEntry
  })
}

function parseSamples(raw: unknown): AcceptanceSample[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new MalformedError('分析字段 samples 必须是数组')
  return raw.map((item, index) => {
    const field = `samples[${index}]`
    const data = objectAt(item, field)
    const kind = SAMPLE_KINDS.find((candidate) => candidate === data.kind)
    if (!kind) {
      throw new MalformedError(`分析字段 ${field}.kind 必须是 normal 或 counter_example`)
    }
    const steps = stringList(data.steps, `${field}.steps`)
    if (steps.length === 0) {
      throw new MalformedError(`${field}.steps 必须给出至少一步操作`)
    }
    return {
      id: nonEmpty(data.id, `${field}.id`),
      kind,
      acceptanceIds: stringList(
        data.acceptance_ids ?? data.acceptanceIds,
        `${field}.acceptance_ids`,
      ),
      data: nonEmpty(data.data, `${field}.data`),
      precondition: nonEmpty(data.precondition, `${field}.precondition`),
      steps,
      expected: nonEmpty(data.expected, `${field}.expected`),
      observeAt: nonEmpty(data.observe_at ?? data.observeAt, `${field}.observe_at`),
    } satisfies AcceptanceSample
  })
}

function parseQuality(raw: unknown): QualityAttribute[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new MalformedError('分析字段 quality_attributes 必须是数组')
  return raw.map((item, index) => {
    const field = `quality_attributes[${index}]`
    const data = objectAt(item, field)
    const kind = QUALITY_KINDS.find((candidate) => candidate === data.kind)
    if (!kind) {
      throw new MalformedError(
        `分析字段 ${field}.kind 必须是 performance、security、usability、availability、compatibility、observability 或 compliance`,
      )
    }
    return {
      id: nonEmpty(data.id, `${field}.id`),
      kind,
      metric: nonEmpty(data.metric, `${field}.metric`),
      target: nonEmpty(data.target, `${field}.target`),
      measure: nonEmpty(data.measure, `${field}.measure`),
      pointIds: stringList(data.point_ids ?? data.pointIds, `${field}.point_ids`),
      acceptanceIds: stringList(
        data.acceptance_ids ?? data.acceptanceIds,
        `${field}.acceptance_ids`,
      ),
    } satisfies QualityAttribute
  })
}

function parseDataField(value: unknown, field: string): DataField {
  const data = objectAt(value, field)
  return {
    name: nonEmpty(data.name, `${field}.name`),
    type: nonEmpty(data.type, `${field}.type`),
    constraints: typeof data.constraints === 'string' ? data.constraints.trim() : '',
  }
}

function parseDataRequirements(raw: unknown): DataRequirement[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new MalformedError('分析字段 data_requirements 必须是数组')
  return raw.map((item, index) => {
    const field = `data_requirements[${index}]`
    const data = objectAt(item, field)
    if (!Array.isArray(data.fields) || data.fields.length === 0) {
      throw new MalformedError(`${field}.fields 必须给出至少一个字段`)
    }
    const pii = data.pii
    if (typeof pii !== 'boolean') {
      throw new MalformedError(`分析字段 ${field}.pii 必须是布尔值`)
    }
    const retention = typeof data.retention === 'string' ? data.retention.trim() : ''
    if (pii && !retention) {
      throw new MalformedError(`${field} 标记为个人信息时必须给出保留期与处置方式`)
    }
    return {
      id: nonEmpty(data.id, `${field}.id`),
      entity: nonEmpty(data.entity, `${field}.entity`),
      fields: data.fields.map((entry, position) =>
        parseDataField(entry, `${field}.fields[${position}]`),
      ),
      retention,
      pii,
      pointIds: stringList(data.point_ids ?? data.pointIds, `${field}.point_ids`),
      acceptanceIds: stringList(
        data.acceptance_ids ?? data.acceptanceIds,
        `${field}.acceptance_ids`,
      ),
    } satisfies DataRequirement
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
  const references = parseReferences(data.references)
  const uiMap = parseUiMap(data.ui_map)
  const samples = parseSamples(data.samples)
  const quality = parseQuality(data.quality_attributes)
  const dataRequirements = parseDataRequirements(data.data_requirements)
  return {
    points,
    acceptance,
    assumptions,
    conflicts,
    references,
    uiMap,
    samples,
    quality,
    data: dataRequirements,
    acceptanceCriteria,
  }
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
  readonly spec: SpecInput
  readonly complete: boolean
  readonly inputKind: 'requirement' | 'problem'
  readonly previous?: AnalysisSpec | null | undefined
  readonly requirementTexts?: readonly string[] | undefined
  readonly projectDocExists?: ((relative: string) => boolean) | undefined
  readonly knownRequirementIds?: readonly string[] | undefined
  readonly currentReqId?: string | undefined
  readonly historicalIds?: readonly string[] | undefined
}

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
  validateArtifactIds(spec.references, REFERENCE_ID, '查证依据', 'REF')
  validateArtifactIds(spec.uiMap, UI_MAP_ID, '功能地图', 'UI')
  validateArtifactIds(spec.samples, SAMPLE_ID, '验收样例', 'SMP')
  validateArtifactIds(spec.quality, QUALITY_ID, '质量属性', 'QA')
  validateArtifactIds(spec.data, DATA_ID, '数据要求', 'DATA')
}

function validateArtifactIds(
  items: readonly { readonly id: string }[],
  pattern: RegExp,
  label: string,
  prefix: string,
): void {
  uniqueIds(items, label)
  for (const item of items) {
    if (!pattern.test(item.id)) {
      throw new MalformedError(`${label}编号必须形如 ${prefix}-1，实际 ${item.id}`)
    }
  }
}

function requireMappedIds(
  item: {
    readonly id: string
    readonly pointIds: readonly string[]
    readonly acceptanceIds: readonly string[]
  },
  label: string,
  known: { readonly points: ReadonlySet<string>; readonly acceptance: ReadonlySet<string> },
): void {
  if (item.pointIds.length === 0 && item.acceptanceIds.length === 0) {
    throw new MalformedError(`${label} ${item.id} 必须至少关联一个业务要点或验收项`)
  }
  for (const pointId of item.pointIds) {
    if (!known.points.has(pointId)) {
      throw new MalformedError(`${label} ${item.id} 关联了不存在的业务要点 ${pointId}`)
    }
  }
  for (const acceptanceId of item.acceptanceIds) {
    if (!known.acceptance.has(acceptanceId)) {
      throw new MalformedError(`${label} ${item.id} 关联了不存在的验收项 ${acceptanceId}`)
    }
  }
}

function validateReferenceLocator(
  reference: EvidenceReference,
  projectDocExists: ((relative: string) => boolean) | undefined,
): void {
  const locator = reference.locator.split('#')[0]?.trim() ?? ''
  if (reference.kind === 'project_doc' && (!locator || !projectDocExists?.(locator))) {
    throw new MalformedError(
      `查证依据 ${reference.id} 引用的项目文档不存在或不可读：${reference.locator}`,
    )
  }
  if (reference.kind === 'external_source' && !/^https?:\/\/\S+$/u.test(reference.locator)) {
    throw new MalformedError(
      `查证依据 ${reference.id} 的外部资料必须是 http(s) 地址：${reference.locator}`,
    )
  }
}

function validateQuality(
  attribute: QualityAttribute,
  known: { readonly points: ReadonlySet<string>; readonly acceptance: ReadonlySet<string> },
): void {
  requireMappedIds(attribute, '质量属性', known)
  if (!/\d/u.test(attribute.target)) {
    throw new MalformedError(
      `质量属性 ${attribute.id} 的目标必须可度量（数值与单位）：${attribute.target}`,
    )
  }
}

function validateDataRequirement(
  item: DataRequirement,
  known: { readonly points: ReadonlySet<string>; readonly acceptance: ReadonlySet<string> },
): void {
  requireMappedIds(item, '数据要求', known)
  if (item.fields.length === 0) {
    throw new MalformedError(`数据要求 ${item.id} 必须给出至少一个字段`)
  }
  for (const field of item.fields) {
    if (!field.name.trim() || !field.type.trim()) {
      throw new MalformedError(`数据要求 ${item.id} 的字段必须有名称与类型`)
    }
  }
  if (item.pii && !item.retention.trim()) {
    throw new MalformedError(`数据要求 ${item.id} 标记为个人信息时必须给出保留期与处置方式`)
  }
}

function validateArtifacts(spec: AnalysisSpec, input: SpecValidationInput): void {
  const known = {
    points: new Set(spec.points.map((point) => point.id)),
    acceptance: new Set(spec.acceptance.map((item) => item.id)),
  }
  for (const reference of spec.references) {
    requireMappedIds(reference, '查证依据', known)
    validateReferenceLocator(reference, input.projectDocExists)
  }
  for (const entry of spec.uiMap) requireMappedIds(entry, '功能地图', known)
  for (const attribute of spec.quality) validateQuality(attribute, known)
  for (const item of spec.data) validateDataRequirement(item, known)
  for (const sample of spec.samples) {
    if (sample.acceptanceIds.length === 0) {
      throw new MalformedError(`验收样例 ${sample.id} 必须关联至少一个验收项`)
    }
    requireMappedIds(
      { id: sample.id, pointIds: [], acceptanceIds: sample.acceptanceIds },
      '验收样例',
      known,
    )
  }
  const coveredByReference = new Set(spec.references.flatMap((item) => item.pointIds))
  for (const point of spec.points) {
    if (point.basis !== 'user_requirement' && !coveredByReference.has(point.id)) {
      throw new MalformedError(
        `业务要点 ${point.id} 的依据是 ${point.basis}；必须在 references 中给出可回查的摘录、适用版本与关联`,
      )
    }
  }
}

export type StageGapCode =
  | 'samples'
  | 'sample_coverage'
  | 'counter_example'
  | 'references'
  | 'quality_attributes'
  | 'data_requirements'
  | 'assumption_tests'

export interface StageGap {
  readonly code: StageGapCode
  readonly detail: string
}

const QUALITY_HINTS = [
  '性能',
  '并发',
  '延迟',
  '吞吐',
  '安全',
  '权限',
  '加密',
  '合规',
  '可用性',
  '稳定性',
  '兼容',
  '响应时间',
]

const DATA_HINTS = ['数据', '字段', '表结构', '保留', '导出', '隐私', '个人信息', '审计日志']

function mentions(texts: readonly string[], hints: readonly string[]): boolean {
  return texts.some((text) => hints.some((hint) => text.includes(hint)))
}

export function requirementStageGaps(
  spec: AnalysisSpec,
  requirementTexts: readonly string[] = [],
): StageGap[] {
  const gaps: StageGap[] = []
  const references = spec.references
  const samples = spec.samples
  const uiMap = spec.uiMap
  const covered = new Set(references.flatMap((reference) => reference.pointIds))
  for (const point of spec.points) {
    if (point.basis !== 'user_requirement' && !covered.has(point.id)) {
      gaps.push({
        code: 'references',
        detail: `业务要点 ${point.id} 缺少带适用版本与摘录的查证依据`,
      })
    }
  }
  if (spec.points.length > 0 && samples.length === 0) {
    gaps.push({ code: 'samples', detail: '尚未提供固定数据、操作与独立预期的验收样例' })
  }
  const sampled = new Set(samples.flatMap((sample) => sample.acceptanceIds))
  const unsampled = spec.acceptance.filter((item) => !sampled.has(item.id)).map((item) => item.id)
  if (unsampled.length > 0) {
    gaps.push({
      code: 'sample_coverage',
      detail: `验收项缺少固定样例：${unsampled.join('、')}`,
    })
  }
  if (uiMap.length > 0 && !samples.some((sample) => sample.kind === 'counter_example')) {
    gaps.push({ code: 'counter_example', detail: '界面变化的需求尚未提供能暴露错误行为的反例' })
  }
  const texts = [
    ...requirementTexts,
    ...spec.points.flatMap((point) => [point.behavior, ...point.rules]),
  ]
  if (spec.quality.length === 0 && mentions(texts, QUALITY_HINTS)) {
    gaps.push({
      code: 'quality_attributes',
      detail: '需求提到性能、安全或可用性约束，但尚无带指标、目标与测量方式的质量属性',
    })
  }
  if (spec.data.length === 0 && mentions(texts, DATA_HINTS)) {
    gaps.push({
      code: 'data_requirements',
      detail: '需求涉及数据或个人信息，但尚无字段、约束与保留期的数据要求',
    })
  }
  const untested = spec.assumptions
    .filter((assumption) => !assumption.testMethod || !assumption.successThreshold)
    .map((assumption) => assumption.id)
  if (untested.length > 0) {
    gaps.push({
      code: 'assumption_tests',
      detail: `假设缺少验证方法与通过阈值：${untested.join('、')}`,
    })
  }
  return gaps
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

function rejectProblemArtifacts(spec: AnalysisSpec): void {
  const counts = [
    spec.points.length,
    spec.acceptance.length,
    spec.assumptions.length,
    spec.conflicts.length,
    spec.references.length,
    spec.uiMap.length,
    spec.samples.length,
    spec.quality.length,
    spec.data.length,
  ]
  if (counts.some((count) => count > 0)) {
    throw new MalformedError('问题输入不做业务要点拆解；只给现象与可检查的修复判据')
  }
}

export function validateSpec(input: SpecValidationInput): void {
  const { complete, inputKind, previous } = input
  const spec: AnalysisSpec = {
    ...input.spec,
    references: input.spec.references ?? [],
    uiMap: input.spec.uiMap ?? [],
    samples: input.spec.samples ?? [],
    quality: input.spec.quality ?? [],
    data: input.spec.data ?? [],
  }
  if (inputKind === 'problem') {
    rejectProblemArtifacts(spec)
    return
  }
  validateIds(spec, previous, input.historicalIds ?? [])
  validateReferences(spec)
  for (const point of spec.points) validatePointSource(point, input)
  validateArtifacts(spec, input)
  validateConflicts(spec, input)
  if (complete) validateComplete(spec)
}

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
    references: analysis.references ?? [],
    uiMap: analysis.uiMap ?? [],
    samples: analysis.samples ?? [],
    quality: analysis.quality ?? [],
    data: analysis.data ?? [],
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

export function specChanges(
  previous: SpecBearingAnalysis | null,
  latest: SpecBearingAnalysis | null,
): SpecChanges {
  const emptySpec = (): AnalysisSpec => ({
    points: [],
    acceptance: [],
    assumptions: [],
    conflicts: [],
    references: [],
    uiMap: [],
    samples: [],
    quality: [],
    data: [],
  })
  const before = previous ? analysisSpecOf(previous) : emptySpec()
  const after = latest ? analysisSpecOf(latest) : emptySpec()
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
export type SpecChangeKind = 'none' | 'invalid'

export interface SpecChangeImpact {
  readonly kind: SpecChangeKind
  readonly changed: readonly string[]
}

function changeGroups(spec: AnalysisSpec): Array<[string, readonly { readonly id: string }[]]> {
  return [
    ['BP', spec.points],
    ['AC', spec.acceptance],
    ['AS', spec.assumptions],
    ['REF', spec.references],
    ['UI', spec.uiMap],
    ['SMP', spec.samples],
    ['QA', spec.quality],
    ['DATA', spec.data],
  ]
}

function asSpec(value: SpecBearingAnalysis | AnalysisSpec): AnalysisSpec {
  return 'points' in value ? value : analysisSpecOf(value)
}

export function classifySpecChange(
  previous: SpecBearingAnalysis | AnalysisSpec | null,
  latest: SpecBearingAnalysis | AnalysisSpec | null,
): SpecChangeImpact {
  if (!latest) return { kind: 'none', changed: [] }
  const after = changeGroups(asSpec(latest))
  if (!previous) {
    return { kind: 'invalid', changed: after.flatMap(([, items]) => items.map((item) => item.id)) }
  }
  const before = new Map(changeGroups(asSpec(previous)))
  const changed: string[] = []
  for (const [prefix, items] of after) {
    const prior = new Map((before.get(prefix) ?? []).map((item) => [item.id, JSON.stringify(item)]))
    for (const item of items) {
      if (prior.get(item.id) !== JSON.stringify(item)) changed.push(item.id)
    }
    const current = new Set(items.map((item) => item.id))
    for (const id of prior.keys()) {
      if (!current.has(id)) changed.push(id)
    }
  }
  const unique = [...new Set(changed)]
  return { kind: unique.length > 0 ? 'invalid' : 'none', changed: unique }
}

export interface PlanCoverageIssue {
  readonly code: 'unknown_point' | 'missing_point'
  readonly detail: string
}

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
