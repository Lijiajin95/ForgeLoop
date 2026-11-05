/**
 * 业务终审：验证 Agent 在新会话中按原始需求复核关键业务场景与验收标准。
 *
 * 终审不是复述验证报告：每条业务场景与验收标准都要给出实际结果，并且证据必须能在
 * 独立验证实际执行的命令输出中逐字核对。系统只接受可核对的结构化结论；模型自述
 * “通过”不构成通过，所有者验收仍由真实决定入口单独记录。
 */

import { asRecord as recordOf } from './json.js'
import { MalformedError } from './errors.js'
import { parseJsonLoose } from './requirement.js'
import { matchesCommandOutput } from './verification.js'

export type BusinessReviewStatus = 'pass' | 'fail' | 'not_verified'

export interface BusinessReviewItem {
  readonly text: string
  /** 结构化验收项的稳定编号；旧报告没有该字段。 */
  readonly id?: string
  readonly status: BusinessReviewStatus
  readonly evidence: string
  readonly commands: readonly string[]
}

export interface BusinessReview {
  readonly verdict: 'pass' | 'block'
  readonly summary: string
  readonly findings: readonly string[]
  readonly blocking: readonly string[]
  readonly scenarios: readonly BusinessReviewItem[]
  readonly acceptance: readonly BusinessReviewItem[]
  /** 逐条业务规则的实际结果；旧报告缺少该字段时按空数组兼容。 */
  readonly businessRules: readonly BusinessReviewItem[]
  /** 逐条异常与边界的实际结果；旧报告缺少该字段时按空数组兼容。 */
  readonly exceptions: readonly BusinessReviewItem[]
  /** 结构化业务要点的逐条实际结果；旧报告缺少该字段时按空数组兼容。 */
  readonly points: readonly BusinessReviewItem[]
}

export interface BusinessReviewCommandRun {
  readonly label: string
  readonly output: string
  /** 命令退出码；静默成功的命令没有 stdout，只能以退出码作为可核对证据。 */
  readonly exitCode?: number | null
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedError(`${what}必须是 JSON 对象`)
  }
  return recordOf(value) ?? {}
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MalformedError(`${field} 必须是非空字符串`)
  }
  return value.trim()
}

function stringList(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (value === undefined && allowEmpty) return []
  if (!Array.isArray(value)) throw new MalformedError(`${field} 必须是字符串数组`)
  const items = value.map((item) => nonEmpty(item, field))
  if (!allowEmpty && items.length === 0) throw new MalformedError(`${field} 不能为空`)
  return items
}

function statusOf(value: unknown, field: string): BusinessReviewStatus {
  if (value !== 'pass' && value !== 'fail' && value !== 'not_verified') {
    throw new MalformedError(`${field} 必须是 pass、fail 或 not_verified`)
  }
  return value
}

function itemOf(
  value: unknown,
  key: 'scenario' | 'criterion' | 'rule' | 'exception' | 'id',
  what: string,
): BusinessReviewItem {
  const data = asRecord(value, what)
  const id = typeof data.id === 'string' ? data.id.trim() : ''
  return {
    text: nonEmpty(data[key], `${what}.${key}`),
    ...(id ? { id } : {}),
    status: statusOf(data.status, `${what}.status`),
    evidence: typeof data.evidence === 'string' ? data.evidence.trim() : '',
    commands: stringList(data.commands, `${what}.commands`, true),
  }
}

function itemList(
  value: unknown,
  key: 'scenario' | 'criterion' | 'rule' | 'exception' | 'id',
  field: string,
): BusinessReviewItem[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new MalformedError(`${field} 必须是数组`)
  return value.map((item, index) => itemOf(item, key, `${field}[${index}]`))
}

export function parseBusinessReview(raw: string): BusinessReview {
  const data = asRecord(parseJsonLoose(raw, '业务终审结果'), '业务终审结果')
  const verdict = data.verdict
  if (verdict !== 'pass' && verdict !== 'block') {
    throw new MalformedError(`业务终审结论必须是 pass 或 block，实际 ${JSON.stringify(verdict)}`)
  }
  const blocking = stringList(data.blocking, 'blocking', true)
  if (verdict === 'pass' && blocking.length > 0) {
    throw new MalformedError('业务终审结论为 pass 时 blocking 必须为空')
  }
  if (verdict === 'block' && blocking.length === 0) {
    throw new MalformedError('业务终审结论为 block 时必须给出至少一条阻断原因')
  }
  if (!Array.isArray(data.scenarios)) throw new MalformedError('业务终审必须给出 scenarios 数组')
  if (!Array.isArray(data.acceptance)) throw new MalformedError('业务终审必须给出 acceptance 数组')
  const scenarios = itemList(data.scenarios, 'scenario', 'scenarios')
  const acceptance = itemList(data.acceptance, 'criterion', 'acceptance')
  const businessRules = itemList(data.business_rules, 'rule', 'business_rules')
  const exceptions = itemList(data.exceptions, 'exception', 'exceptions')
  const points = itemList(data.points, 'id', 'points')
  return {
    verdict,
    summary: nonEmpty(data.summary, 'summary'),
    findings: stringList(data.findings, 'findings', true),
    blocking,
    scenarios,
    acceptance,
    businessRules,
    exceptions,
    points,
  }
}

/** 静默成功命令没有 stdout；允许以验证报告里的 exit_code: 0 作为证据。 */
function matchesExitCodeEvidence(run: BusinessReviewCommandRun, evidence: string): boolean {
  if (run.exitCode !== 0) return false
  const needle = evidence.replace(/\s+/g, ' ').trim().toLowerCase()
  return needle.length >= 8 && /exit[_ ]?code\s*:\s*0/.test(needle)
}

function checkItem(
  item: BusinessReviewItem,
  runs: ReadonlyMap<string, BusinessReviewCommandRun>,
  what: string,
  text: string,
): string[] {
  const issues: string[] = []
  if (item.status !== 'pass') {
    issues.push(`${what}未通过：${text}（${item.status}）`)
    return issues
  }
  if (item.commands.length === 0) {
    issues.push(`${what}没有关联验证命令：${text}`)
    return issues
  }
  const referenced = item.commands
    .map((label) => runs.get(label))
    .filter((run): run is BusinessReviewCommandRun => run !== undefined)
  if (referenced.length !== item.commands.length) {
    const unreported = item.commands.filter((label) => !runs.has(label))
    issues.push(`${what}引用了未执行的验证命令：${unreported.join('、')}`)
    return issues
  }
  if (
    !referenced.some(
      (run) =>
        matchesCommandOutput(run.output, item.evidence) ||
        matchesExitCodeEvidence(run, item.evidence),
    )
  ) {
    issues.push(`${what}证据无法在验证输出中核对：${text}`)
  }
  return issues
}

/**
 * 终审必须逐项覆盖分析中的业务场景、验收标准、业务规则与异常边界，
 * 且证据来自独立验证的真实命令输出。缺项即使模型自报通过也阻断。
 */
export function validateBusinessReview(input: {
  scenarios: readonly string[]
  acceptanceCriteria: readonly string[]
  businessRules?: readonly string[] | undefined
  exceptions?: readonly string[] | undefined
  businessPoints?: readonly { readonly id: string }[] | undefined
  acceptanceItems?: readonly { readonly id: string }[] | undefined
  review: BusinessReview
  runs: readonly BusinessReviewCommandRun[]
}): string[] {
  const issues: string[] = []
  if (input.review.verdict !== 'pass') {
    issues.push(
      `业务终审结论为 ${input.review.verdict}：${input.review.blocking.join('；') || input.review.summary}`,
    )
    return issues
  }
  const runs = new Map(input.runs.map((run) => [run.label, run]))
  const checkAll = (
    texts: readonly string[],
    items: readonly BusinessReviewItem[],
    what: string,
    missing: string,
  ): void => {
    for (const text of texts) {
      const item = items.find((candidate) => candidate.text === text)
      if (!item) {
        issues.push(`${missing}：${text}`)
        continue
      }
      issues.push(...checkItem(item, runs, what, text))
    }
  }
  // 结构化规格以要点编号覆盖为准；旧报告继续按场景与验收标准原文核对。
  if ((input.businessPoints?.length ?? 0) > 0) {
    checkAll(
      (input.businessPoints ?? []).map((point) => point.id),
      input.review.points,
      '业务终审业务要点',
      '业务终审缺少业务要点',
    )
    for (const item of input.acceptanceItems ?? []) {
      const reviewed = input.review.acceptance.find((entry) => entry.id === item.id)
      if (!reviewed) {
        issues.push(`业务终审缺少验收项：${item.id}`)
        continue
      }
      issues.push(...checkItem(reviewed, runs, '业务终审验收项', item.id))
    }
  } else {
    checkAll(input.scenarios, input.review.scenarios, '业务终审业务场景', '业务终审缺少业务场景')
    checkAll(
      input.acceptanceCriteria,
      input.review.acceptance,
      '业务终审验收标准',
      '业务终审缺少验收标准',
    )
  }
  checkAll(
    input.businessRules ?? [],
    input.review.businessRules,
    '业务终审业务规则',
    '业务终审缺少业务规则',
  )
  checkAll(
    input.exceptions ?? [],
    input.review.exceptions,
    '业务终审异常与边界',
    '业务终审缺少异常与边界',
  )
  return issues
}
