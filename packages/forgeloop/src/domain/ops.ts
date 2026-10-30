/**
 * 运维事件的纯规则：已登记的检查与处置动作目录、失败签名、事件状态、
 * 诊断结果结构、自动处置授权与恢复判定、统计口径。
 *
 * 这里只做确定性判定，不读写数据库、不执行命令、不调用模型。
 * 动作只能来自预先登记的目录；模型不能自行创造命令或参数。
 */

import { createHash } from 'node:crypto'
import { MalformedError, RuleViolationError } from './errors.js'
import { parseJsonLoose } from './requirement.js'

export const OPS_SEVERITIES = ['critical', 'major', 'minor'] as const
export type OpsSeverity = (typeof OPS_SEVERITIES)[number]

export const OPS_RESOURCE_KINDS = ['app', 'database', 'cache', 'queue', 'host', 'other'] as const
export type OpsResourceKind = (typeof OPS_RESOURCE_KINDS)[number]

/** 事件生命周期：观测到失败后先开放，诊断与处置各自留档。 */
export const OPS_OPEN = 'open'
export const OPS_DIAGNOSED = 'diagnosed'
export const OPS_AWAITING_DECISION = 'awaiting_decision'
export const OPS_RECOVERING = 'recovering'
export const OPS_RECOVERED = 'recovered'
export const OPS_UNRESOLVED = 'unresolved'
export const OPS_CLOSED = 'closed'

export type OpsEventState =
  | typeof OPS_OPEN
  | typeof OPS_DIAGNOSED
  | typeof OPS_AWAITING_DECISION
  | typeof OPS_RECOVERING
  | typeof OPS_RECOVERED
  | typeof OPS_UNRESOLVED
  | typeof OPS_CLOSED

/**
 * 处置动作尝试的状态：只记录可判定的事实，不保留“结果未知”。
 * `interrupted` 表示宿主在动作结束前退出、没有退出码；事实是“没有结果记录”，
 * 不是一种业务状态。事件按未解决收口，再由运维 Agent 分析根因并上报。
 */
export const OPS_ATTEMPT_RUNNING = 'running'
export const OPS_ATTEMPT_SUCCEEDED = 'succeeded'
export const OPS_ATTEMPT_FAILED = 'failed'
export const OPS_ATTEMPT_INTERRUPTED = 'interrupted'

export type OpsAttemptState =
  | typeof OPS_ATTEMPT_RUNNING
  | typeof OPS_ATTEMPT_SUCCEEDED
  | typeof OPS_ATTEMPT_FAILED
  | typeof OPS_ATTEMPT_INTERRUPTED

/** 仍在处理中的事件：同一失败只归并到这些事件，不重复计数。 */
export const OPS_ACTIVE_STATES: ReadonlySet<string> = new Set([
  OPS_OPEN,
  OPS_DIAGNOSED,
  OPS_AWAITING_DECISION,
  OPS_RECOVERING,
  OPS_UNRESOLVED,
])

export function isOpsActive(state: string): boolean {
  return OPS_ACTIVE_STATES.has(state)
}

export interface OpsResource {
  readonly id: string
  readonly kind: OpsResourceKind
  readonly label: string
}

export interface OpsCheck {
  readonly id: string
  readonly resourceId: string
  /** 只读检查的 argv；不接受 Shell 字符串。 */
  readonly command: readonly string[]
  readonly timeoutSeconds: number
  readonly severity: OpsSeverity
}

export interface OpsActionParam {
  readonly name: string
  /** 参数只允许登记过的取值，模型与页面都不能提交目录外的值。 */
  readonly values: readonly string[]
}

export interface OpsAction {
  readonly id: string
  readonly resourceId: string
  /** 已登记的 argv 模板，可包含 `{参数名}` 占位符。 */
  readonly command: readonly string[]
  readonly params: readonly OpsActionParam[]
  readonly timeoutSeconds: number
  /** 目录预先授权该动作在自身参数范围内自动执行；未标记的必须人工决定。 */
  readonly auto: boolean
  /** 恢复复核所用的检查；必须与动作属于同一资源。 */
  readonly verifyCheckId: string
}

export interface OpsCatalog {
  readonly resources: readonly OpsResource[]
  readonly checks: readonly OpsCheck[]
  readonly actions: readonly OpsAction[]
}

const PLACEHOLDER = /\{([a-zA-Z0-9_-]+)\}/g

function assertId(value: string, what: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new RuleViolationError(`${what}只能使用字母、数字、下划线和连字符：${JSON.stringify(value)}`)
  }
}

function assertArgv(command: readonly string[], what: string): void {
  if (command.length === 0) throw new RuleViolationError(`${what}的命令不能为空`)
  for (const token of command) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new RuleViolationError(`${what}的命令参数必须是非空字符串`)
    }
  }
}

function assertPositive(value: number, what: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RuleViolationError(`${what}必须是正数`)
}

/**
 * 装载期校验：目录必须自洽，非法配置直接失败，不做静默回落。
 * 资源、检查、动作只登记一次；动作只能引用同资源的检查作为恢复复核。
 */
export function validateOpsCatalog(catalog: OpsCatalog): void {
  const resources = new Map<string, OpsResource>()
  for (const resource of catalog.resources) {
    assertId(resource.id, '资源身份')
    if (!OPS_RESOURCE_KINDS.includes(resource.kind)) {
      throw new RuleViolationError(`资源 ${resource.id} 的类型不受支持：${resource.kind}`)
    }
    if (!resource.label.trim()) throw new RuleViolationError(`资源 ${resource.id} 缺少展示名称`)
    if (resources.has(resource.id)) throw new RuleViolationError(`重复的资源身份：${resource.id}`)
    resources.set(resource.id, resource)
  }

  const checks = new Map<string, OpsCheck>()
  for (const check of catalog.checks) {
    assertId(check.id, '检查身份')
    if (!resources.has(check.resourceId)) {
      throw new RuleViolationError(`检查 ${check.id} 引用了未登记的资源：${check.resourceId}`)
    }
    if (checks.has(check.id)) throw new RuleViolationError(`重复的检查身份：${check.id}`)
    assertArgv(check.command, `检查 ${check.id}`)
    assertPositive(check.timeoutSeconds, `检查 ${check.id} 的超时`)
    if (!OPS_SEVERITIES.includes(check.severity)) {
      throw new RuleViolationError(`检查 ${check.id} 的严重度不受支持：${check.severity}`)
    }
    checks.set(check.id, check)
  }

  const actions = new Map<string, OpsAction>()
  for (const action of catalog.actions) {
    assertId(action.id, '动作身份')
    if (!resources.has(action.resourceId)) {
      throw new RuleViolationError(`动作 ${action.id} 引用了未登记的资源：${action.resourceId}`)
    }
    if (actions.has(action.id)) throw new RuleViolationError(`重复的动作身份：${action.id}`)
    assertArgv(action.command, `动作 ${action.id}`)
    assertPositive(action.timeoutSeconds, `动作 ${action.id} 的超时`)

    const verify = checks.get(action.verifyCheckId)
    if (!verify) {
      throw new RuleViolationError(`动作 ${action.id} 的恢复校验检查未登记：${action.verifyCheckId}`)
    }
    if (verify.resourceId !== action.resourceId) {
      throw new RuleViolationError(
        `动作 ${action.id} 的恢复校验检查 ${verify.id} 属于另一资源 ${verify.resourceId}`,
      )
    }

    const declared = new Set<string>()
    for (const param of action.params) {
      assertId(param.name, `动作 ${action.id} 的参数名`)
      if (declared.has(param.name)) {
        throw new RuleViolationError(`动作 ${action.id} 重复声明参数：${param.name}`)
      }
      declared.add(param.name)
      if (param.values.length === 0) {
        throw new RuleViolationError(`动作 ${action.id} 的参数 ${param.name} 缺少允许值`)
      }
      for (const value of param.values) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new RuleViolationError(`动作 ${action.id} 的参数 ${param.name} 允许值必须是非空字符串`)
        }
      }
      if (new Set(param.values).size !== param.values.length) {
        throw new RuleViolationError(`动作 ${action.id} 的参数 ${param.name} 存在重复的允许值`)
      }
    }

    const used = new Set<string>()
    for (const token of action.command) {
      for (const match of token.matchAll(PLACEHOLDER)) {
        const name = match[1]!
        if (!declared.has(name)) {
          throw new RuleViolationError(`动作 ${action.id} 的命令引用了未声明的参数 {${name}}`)
        }
        used.add(name)
      }
    }
    for (const name of declared) {
      if (!used.has(name)) {
        throw new RuleViolationError(`动作 ${action.id} 的参数 ${name} 未在命令中使用`)
      }
    }
  }
}

/**
 * 把已校验的参数代入登记过的 argv。
 * 缺参、未知参数或目录外取值一律拒绝，不把模型输出拼进命令。
 */
export function actionArgv(action: OpsAction, params: Readonly<Record<string, string>>): string[] {
  const declared = new Map(action.params.map((param) => [param.name, param]))
  for (const [name, value] of Object.entries(params)) {
    const param = declared.get(name)
    if (!param) throw new RuleViolationError(`动作 ${action.id} 未登记参数：${name}`)
    if (!param.values.includes(value)) {
      throw new RuleViolationError(
        `动作 ${action.id} 的参数 ${name} 取值 ${JSON.stringify(value)} 不在允许值内`,
      )
    }
  }
  for (const param of action.params) {
    if (!(param.name in params)) {
      throw new RuleViolationError(`动作 ${action.id} 缺少参数：${param.name}`)
    }
  }
  return action.command.map((token) =>
    token.replace(PLACEHOLDER, (_match, name: string) => params[name] as string),
  )
}

function normalizedLine(output: string): string {
  const line = output
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  return line ? line.replace(/\s+/g, ' ').slice(0, 400) : 'no-output'
}

/**
 * 一次失败的稳定签名：资源＋检查＋退出码＋首条输出摘要。
 * 同一故障的重复告警归并到同一事件；输出变化（不同首行）形成新签名。
 */
export function opsSignatureOf(input: {
  readonly resourceId: string
  readonly checkId: string
  readonly exitCode: number
  readonly output: string
}): string {
  const digest = createHash('sha256').update(normalizedLine(input.output), 'utf8').digest('hex').slice(0, 12)
  return `${input.resourceId}/${input.checkId}/${input.exitCode}/${digest}`
}

/** 恢复复核只认程序退出码；超时即使退出码为 0 也不算通过。 */
export function recoveryPassed(input: { readonly code: number; readonly timedOut: boolean }): boolean {
  return input.code === 0 && !input.timedOut
}

export type OpsConfidence = 'low' | 'medium' | 'high'

export interface OpsHypothesis {
  readonly statement: string
  readonly confidence: OpsConfidence
}

export interface OpsProposedAction {
  readonly actionId: string
  readonly params: Readonly<Record<string, string>>
}

export interface OpsDiagnosis {
  /** 面向业务用户的影响说明，不能只写技术报错。 */
  readonly impact: string
  /** 已观察到的事实；与推断分开保存。 */
  readonly facts: readonly string[]
  /** 未证实的推断；不能当作事实或授权依据。 */
  readonly hypotheses: readonly OpsHypothesis[]
  readonly proposedAction: OpsProposedAction | null
  /** 模型认为需要人工决定时为 true；运行时仍按目录授权判定，模型不能自行放宽。 */
  readonly decisionRequired: boolean
  /** 即使恢复服务也需要代码修复时置 true，用于生成关联修复需求。 */
  readonly fixRequired: boolean
  readonly summary: string
}

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new MalformedError(`${what}必须是非空字符串`)
  return value.trim()
}

function stringArray(value: unknown, what: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new MalformedError(`${what}必须是数组`)
  return value.map((item, index) => nonEmptyString(item, `${what}[${index}]`))
}

/**
 * 解析运维 Agent 的诊断 JSON。结构畸形直接失败，不把部分字段当成结论。
 * 这里不校验动作是否登记；调用方必须再用目录校验动作与参数。
 */
export function parseOpsDiagnosis(text: string): OpsDiagnosis {
  const payload = parseJsonLoose(text, '运维诊断')
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new MalformedError('运维诊断必须是 JSON 对象')
  }
  const data = payload as Record<string, unknown>
  const impact = nonEmptyString(data.impact, '运维诊断的业务影响')
  const facts = stringArray(data.facts, '运维诊断的事实')
  if (data.hypotheses !== undefined && !Array.isArray(data.hypotheses)) {
    throw new MalformedError('运维诊断的推断必须是数组')
  }
  const hypotheses: OpsHypothesis[] = (data.hypotheses ?? []).map((item: unknown, index: number) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new MalformedError(`运维诊断的推断[${index}]必须是对象`)
    }
    const hypothesis = item as Record<string, unknown>
    const confidence = hypothesis.confidence
    if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') {
      throw new MalformedError(`运维诊断的推断[${index}]置信度必须是 low/medium/high`)
    }
    return {
      statement: nonEmptyString(hypothesis.statement, `运维诊断的推断[${index}]`),
      confidence,
    }
  })

  let proposedAction: OpsProposedAction | null = null
  const rawAction = data.proposed_action
  if (rawAction !== undefined && rawAction !== null) {
    if (typeof rawAction !== 'object' || Array.isArray(rawAction)) {
      throw new MalformedError('运维诊断的 proposed_action 必须是对象或 null')
    }
    const action = rawAction as Record<string, unknown>
    const actionId = nonEmptyString(action.action_id, '运维诊断的 proposed_action.action_id')
    const rawParams = action.params ?? {}
    if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
      throw new MalformedError('运维诊断的 proposed_action.params 必须是对象')
    }
    const params: Record<string, string> = {}
    for (const [name, value] of Object.entries(rawParams as Record<string, unknown>)) {
      params[name] = nonEmptyString(value, `运维诊断的 proposed_action.params.${name}`)
    }
    proposedAction = { actionId, params }
  }

  if (typeof data.decision_required !== 'boolean') {
    throw new MalformedError('运维诊断缺少 decision_required 布尔值')
  }
  const fixRequired = data.fix_required === undefined ? false : data.fix_required
  if (typeof fixRequired !== 'boolean') throw new MalformedError('运维诊断的 fix_required 必须是布尔值')

  return {
    impact,
    facts,
    hypotheses,
    proposedAction,
    decisionRequired: data.decision_required,
    fixRequired,
    summary: nonEmptyString(data.summary, '运维诊断的摘要'),
  }
}

/** 以模型输入格式保存诊断：读回时复用同一解析器，避免两套字段名。 */
export function serializeOpsDiagnosis(diagnosis: OpsDiagnosis): string {
  return JSON.stringify({
    impact: diagnosis.impact,
    facts: diagnosis.facts,
    hypotheses: diagnosis.hypotheses,
    proposed_action: diagnosis.proposedAction
      ? { action_id: diagnosis.proposedAction.actionId, params: diagnosis.proposedAction.params }
      : null,
    decision_required: diagnosis.decisionRequired,
    fix_required: diagnosis.fixRequired,
    summary: diagnosis.summary,
  })
}

export interface OpsAuthorization {
  readonly auto: boolean
  /** 自动执行时的授权来源，写入动作记录；人工决定时由调用方给出 owner 来源。 */
  readonly source: string
  readonly reason: string
}

/**
 * 自动处置判定：只有目录预先标记 auto、动作属于同一资源、且模型未要求人工决定时才成立。
 * 模型不能把未登记或未授权的动作变成自动执行。
 */
export function authorizeOpsAction(input: {
  readonly event: { readonly resourceId: string; readonly severity: OpsSeverity; readonly state: string }
  readonly action: OpsAction
  readonly diagnosis: OpsDiagnosis
}): OpsAuthorization {
  if (input.action.resourceId !== input.event.resourceId) {
    return { auto: false, source: '', reason: `动作 ${input.action.id} 不属于事件资源 ${input.event.resourceId}` }
  }
  if (input.diagnosis.proposedAction?.actionId !== input.action.id) {
    return { auto: false, source: '', reason: '诊断提出的动作与待执行动作不一致' }
  }
  if (input.diagnosis.decisionRequired) {
    return { auto: false, source: '', reason: '诊断要求人工决定' }
  }
  if (!input.action.auto) {
    return { auto: false, source: '', reason: `动作 ${input.action.id} 未获目录自动授权` }
  }
  return { auto: true, source: `ops-action:auto:${input.action.id}`, reason: '' }
}

export interface OpsInterruptionReport {
  /** 面向所有者的一句话结论。 */
  readonly summary: string
  /** 基于已记录事实与推断的根因分析。 */
  readonly rootCause: string
  /** Agent 实际使用的事实；不能凭空补造。 */
  readonly evidence: readonly string[]
  /** 建议的人工下一步；不会因此自动执行动作。 */
  readonly nextStep: string
}

const INTERRUPTION_LIMITS = {
  summary: 500,
  rootCause: 4000,
  evidenceItems: 20,
  evidenceItem: 1000,
  nextStep: 2000,
} as const

function boundedString(value: unknown, what: string, max: number): string {
  const text = nonEmptyString(value, what)
  if (text.length > max) throw new MalformedError(`${what}超过 ${max} 字符上限`)
  return text
}

/**
 * 解析“动作被中断、没有结果记录”时的根因报告。
 * 这是上报材料，不是业务状态，也不能作为重新执行动作的授权。
 */
export function parseOpsInterruptionReport(text: string): OpsInterruptionReport {
  const payload = parseJsonLoose(text, '运维中断根因报告')
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new MalformedError('运维中断根因报告必须是 JSON 对象')
  }
  const data = payload as Record<string, unknown>
  const evidence = stringArray(data.evidence, '运维中断根因报告的事实')
  if (evidence.length === 0) throw new MalformedError('运维中断根因报告至少需要一条事实')
  if (evidence.length > INTERRUPTION_LIMITS.evidenceItems) {
    throw new MalformedError(`运维中断根因报告的事实超过 ${INTERRUPTION_LIMITS.evidenceItems} 条`)
  }
  return {
    summary: boundedString(data.summary, '运维中断根因报告的结论', INTERRUPTION_LIMITS.summary),
    rootCause: boundedString(data.root_cause, '运维中断根因报告的根因', INTERRUPTION_LIMITS.rootCause),
    evidence: evidence.map((item, index) =>
      boundedString(item, `运维中断根因报告的事实[${index}]`, INTERRUPTION_LIMITS.evidenceItem),
    ),
    nextStep: boundedString(data.next_step, '运维中断根因报告的下一步', INTERRUPTION_LIMITS.nextStep),
  }
}

export interface OpsEventStat {
  readonly state: string
  readonly humanInvolved: boolean
  readonly openedAt: string
  readonly recoveredAt: string
  readonly fixRequirementId: string
}

export interface OpsStats {
  readonly total: number
  readonly humanInvolved: number
  readonly humanRate: number
  readonly recovered: number
  readonly unresolved: number
  readonly awaitingDecision: number
  readonly active: number
  readonly closed: number
  readonly fixRequirements: number
  readonly averageRecoverySeconds: number | null
}

/**
 * 运维统计口径（产品 §12.2）：一次独立事件计入分母；同一故障的重复告警已在事件层归并。
 * 正常巡检不产生事件，因此不进入分母。人工决定、关闭或要求修复都记为介入。
 */
export function opsStats(events: readonly OpsEventStat[]): OpsStats {
  const total = events.length
  const humanInvolved = events.filter((event) => event.humanInvolved).length
  const recovered = events.filter((event) => event.state === OPS_RECOVERED).length
  const durations: number[] = []
  for (const event of events) {
    if (!event.recoveredAt || !event.openedAt) continue
    const start = Date.parse(event.openedAt)
    const end = Date.parse(event.recoveredAt)
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      durations.push((end - start) / 1000)
    }
  }
  return {
    total,
    humanInvolved,
    humanRate: total === 0 ? 0 : humanInvolved / total,
    recovered,
    unresolved: events.filter((event) => event.state === OPS_UNRESOLVED).length,
    awaitingDecision: events.filter((event) => event.state === OPS_AWAITING_DECISION).length,
    active: events.filter((event) => isOpsActive(event.state)).length,
    closed: events.filter((event) => event.state === OPS_CLOSED).length,
    fixRequirements: events.filter((event) => Boolean(event.fixRequirementId)).length,
    averageRecoverySeconds:
      durations.length === 0 ? null : durations.reduce((sum, value) => sum + value, 0) / durations.length,
  }
}
