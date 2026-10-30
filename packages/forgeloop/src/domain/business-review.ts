/**
 * 业务终审：需求 Agent 在新会话中按原始需求复核关键业务场景与验收标准。
 *
 * 终审不是复述验证报告：每条业务场景与验收标准都要给出实际结果，并且证据必须能在
 * 独立验证实际执行的命令输出中逐字核对。系统只接受可核对的结构化结论；模型自述
 * “通过”不构成通过，所有者验收仍由真实决定入口单独记录。
 */

import { MalformedError } from './errors.js'
import { parseJsonLoose } from './requirement.js'
import { matchesCommandOutput } from './verification.js'

export type BusinessReviewStatus = 'pass' | 'fail' | 'not_verified'

export interface BusinessReviewItem {
  readonly text: string
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
}

export interface BusinessReviewCommandRun {
  readonly label: string
  readonly output: string
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedError(`${what}必须是 JSON 对象`)
  }
  return value as Record<string, unknown>
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

function itemOf(value: unknown, key: 'scenario' | 'criterion', what: string): BusinessReviewItem {
  const data = asRecord(value, what)
  return {
    text: nonEmpty(data[key], `${what}.${key}`),
    status: statusOf(data.status, `${what}.status`),
    evidence: typeof data.evidence === 'string' ? data.evidence.trim() : '',
    commands: stringList(data.commands, `${what}.commands`, true),
  }
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
  const scenarios = data.scenarios.map((item, index) => itemOf(item, 'scenario', `scenarios[${index}]`))
  const acceptance = data.acceptance.map((item, index) => itemOf(item, 'criterion', `acceptance[${index}]`))
  return {
    verdict,
    summary: nonEmpty(data.summary, 'summary'),
    findings: stringList(data.findings, 'findings', true),
    blocking,
    scenarios,
    acceptance,
  }
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
  const referenced = item.commands.map((label) => runs.get(label)).filter((run): run is BusinessReviewCommandRun => run !== undefined)
  if (referenced.length !== item.commands.length) {
    const unreported = item.commands.filter((label) => !runs.has(label))
    issues.push(`${what}引用了未执行的验证命令：${unreported.join('、')}`)
    return issues
  }
  if (!referenced.some((run) => matchesCommandOutput(run.output, item.evidence))) {
    issues.push(`${what}证据无法在验证输出中核对：${text}`)
  }
  return issues
}

/**
 * 终审必须逐项覆盖分析中的业务场景与验收标准，且证据来自独立验证的真实命令输出。
 * 缺项即使模型自报通过也阻断。
 */
export function validateBusinessReview(input: {
  scenarios: readonly string[]
  acceptanceCriteria: readonly string[]
  review: BusinessReview
  runs: readonly BusinessReviewCommandRun[]
}): string[] {
  const issues: string[] = []
  if (input.review.verdict !== 'pass') {
    issues.push(`业务终审结论为 ${input.review.verdict}：${input.review.blocking.join('；') || input.review.summary}`)
    return issues
  }
  const runs = new Map(input.runs.map((run) => [run.label, run]))
  for (const scenario of input.scenarios) {
    const item = input.review.scenarios.find((candidate) => candidate.text === scenario)
    if (!item) {
      issues.push(`业务终审缺少业务场景：${scenario}`)
      continue
    }
    issues.push(...checkItem(item, runs, '业务终审业务场景', scenario))
  }
  for (const criterion of input.acceptanceCriteria) {
    const item = input.review.acceptance.find((candidate) => candidate.text === criterion)
    if (!item) {
      issues.push(`业务终审缺少验收标准：${criterion}`)
      continue
    }
    issues.push(...checkItem(item, runs, '业务终审验收标准', criterion))
  }
  return issues
}
