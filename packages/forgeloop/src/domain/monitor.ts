/**
 * 主动监控报告的纯规则：报告状态、问题身份、严重度与诊断字段。
 *
 * 模型只描述观察到的问题；程序决定是否成为事件、能否自动处置。
 * 这里不读文件、不执行命令、不调用模型。
 */

import { asRecord } from './json.js'
import { MalformedError } from './errors.js'
import { parseJsonLoose } from './requirement.js'
import {
  OPS_SEVERITIES,
  parseOpsDiagnosisFields,
  type OpsDiagnosis,
  type OpsSeverity,
} from './ops.js'

export const MONITOR_STATUSES = ['healthy', 'degraded', 'critical'] as const
export type MonitorStatus = (typeof MONITOR_STATUSES)[number]

/** 问题身份用于跨扫描归并：同一资源下同一 key 视为同一问题。 */
export const MONITOR_KEY_PATTERN = /^[a-z][a-z0-9-]{1,40}$/

export const MONITOR_MAX_ISSUES = 10
export const MONITOR_MAX_SUMMARY = 1000
export const MONITOR_MAX_IMPACT = 1000
export const MONITOR_MAX_TITLE = 200
export const MONITOR_MAX_FACTS = 20

export interface MonitorIssue extends OpsDiagnosis {
  /** 稳定的短身份，只用于同一资源下的问题归并。 */
  readonly key: string
  readonly resourceId: string
  readonly severity: OpsSeverity
  readonly title: string
  /** 新事件是否发送外部告警；未给出时严重与重要默认发送，一般默认不发送。 */
  readonly alert: boolean
}

export interface MonitorReport {
  readonly status: MonitorStatus
  readonly summary: string
  readonly issues: readonly MonitorIssue[]
}

function requiredText(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MalformedError(`${what}必须是非空字符串`)
  }
  return value.trim()
}

function boundedText(value: unknown, what: string, max: number): string {
  const text = requiredText(value, what)
  if (text.length > max) throw new MalformedError(`${what}超过 ${max} 字符上限`)
  return text
}

function parseStatus(value: unknown): MonitorStatus {
  if (value === 'healthy' || value === 'degraded' || value === 'critical') return value
  throw new MalformedError(
    `主动监控报告的 status 必须是 ${MONITOR_STATUSES.join('/')}，实际 ${JSON.stringify(value)}`,
  )
}

function parseSeverity(value: unknown, what: string): OpsSeverity {
  if (value === 'critical' || value === 'major' || value === 'minor') return value
  throw new MalformedError(`${what}的 severity 必须是 ${OPS_SEVERITIES.join('/')}`)
}

function parseKey(value: unknown, what: string): string {
  const key = requiredText(value, what)
  if (!MONITOR_KEY_PATTERN.test(key)) {
    throw new MalformedError(
      `${what}只能是小写字母开头的 2–41 位小写字母、数字或连字符，实际 ${JSON.stringify(key)}`,
    )
  }
  return key
}

function parseIssue(value: unknown, index: number): MonitorIssue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedError(`主动监控报告的问题[${index}]必须是对象`)
  }
  const data = asRecord(value) ?? {}
  const diagnosis = parseOpsDiagnosisFields(data)
  if (diagnosis.impact.length > MONITOR_MAX_IMPACT) {
    throw new MalformedError(`主动监控报告的问题[${index}]影响超过 ${MONITOR_MAX_IMPACT} 字符上限`)
  }
  if (diagnosis.facts.length > MONITOR_MAX_FACTS) {
    throw new MalformedError(`主动监控报告的问题[${index}]事实超过 ${MONITOR_MAX_FACTS} 条`)
  }
  const severity = parseSeverity(data.severity, `主动监控报告的问题[${index}]`)
  let alert = severity !== 'minor'
  if (data.alert !== undefined) {
    if (typeof data.alert !== 'boolean') {
      throw new MalformedError(`主动监控报告的问题[${index}] alert 必须是布尔值`)
    }
    alert = data.alert
  }
  return {
    ...diagnosis,
    key: parseKey(data.key, `主动监控报告的问题[${index}] key`),
    resourceId: requiredText(data.resource_id, `主动监控报告的问题[${index}] resource_id`),
    severity,
    title: boundedText(data.title, `主动监控报告的问题[${index}]标题`, MONITOR_MAX_TITLE),
    alert,
  }
}

/**
 * 解析运维 Agent 的主动监控报告。状态与问题必须自洽：
 * 健康不能带问题，非健康至少要有一条问题，严重状态至少要有一条严重问题。
 */
export function parseMonitorReport(text: string): MonitorReport {
  const payload = parseJsonLoose(text, '主动监控报告')
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new MalformedError('主动监控报告必须是 JSON 对象')
  }
  const data = asRecord(payload) ?? {}
  const status = parseStatus(data.status)
  const summary = boundedText(data.summary, '主动监控报告的摘要', MONITOR_MAX_SUMMARY)
  if (!Array.isArray(data.issues)) throw new MalformedError('主动监控报告的 issues 必须是数组')
  const issues = data.issues.map((item, index) => parseIssue(item, index))
  if (issues.length > MONITOR_MAX_ISSUES) {
    throw new MalformedError(`主动监控报告的问题超过 ${MONITOR_MAX_ISSUES} 条`)
  }
  if (status === 'healthy' && issues.length > 0) {
    throw new MalformedError('主动监控报告为 healthy 时不能带问题')
  }
  if (status !== 'healthy' && issues.length === 0) {
    throw new MalformedError(`主动监控报告为 ${status} 时至少需要一条问题`)
  }
  const critical = issues.filter((issue) => issue.severity === 'critical').length
  if (status === 'degraded' && critical > 0) {
    throw new MalformedError('主动监控报告为 degraded 时不能包含严重问题；请改为 critical')
  }
  if (status === 'critical' && critical === 0) {
    throw new MalformedError('主动监控报告为 critical 时至少要有一条严重问题')
  }
  return { status, summary, issues }
}

/** 同一资源、同一问题 key 的稳定签名；不把标题或摘要拼进身份，避免措辞变化产生新事件。 */
export function monitorSignatureOf(resourceId: string, key: string): string {
  return `monitor/${resourceId}/${key}`
}
