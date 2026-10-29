/**
 * 验证 Agent 的结构化输入与输出。
 *
 * 实现前评审把需求场景、验收标准与技术方案映射成可执行的验证计划；
 * 独立验证对固定候选逐项执行，提交结论、命令与证据。模型自述不构成通过，
 * 运行时只接受可解析的结构，并由程序实际执行命令。
 */

import { MalformedError } from './errors.js'
import { parseJsonLoose } from './requirement.js'

export interface VerificationScenarioPlan {
  readonly scenario: string
  readonly acceptanceCriterion: string
  readonly method: string
  readonly required: boolean
}

export interface PlanReview {
  readonly verdict: 'pass' | 'block'
  readonly blocking: readonly string[]
  readonly findings: readonly string[]
  readonly summary: string
  readonly verificationPlan: readonly VerificationScenarioPlan[]
}

export interface VerificationCommand {
  readonly label: string
  readonly argv: readonly string[]
}

export type VerificationScenarioStatus = 'pass' | 'fail' | 'not_verified'

export interface VerificationScenarioResult {
  readonly scenario: string
  readonly status: VerificationScenarioStatus
  readonly evidence: string
  readonly commands: readonly string[]
}

export interface VerificationReport {
  readonly verdict: 'pass' | 'block'
  readonly summary: string
  readonly findings: readonly string[]
  readonly blocking: readonly string[]
  readonly scenarios: readonly VerificationScenarioResult[]
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

function verdictOf(value: unknown, what: string): 'pass' | 'block' {
  if (value !== 'pass' && value !== 'block') {
    throw new MalformedError(`${what}结论必须是 pass 或 block，实际 ${JSON.stringify(value)}`)
  }
  return value
}

function parseVerificationPlan(value: unknown, required: boolean): VerificationScenarioPlan[] {
  if (value === undefined) {
    if (required) throw new MalformedError('实现前评审通过时必须给出验证计划')
    return []
  }
  if (!Array.isArray(value)) throw new MalformedError('verification_plan 必须是数组')
  const plan = value.map((item, index) => {
    const data = asRecord(item, `verification_plan[${index}]`)
    const requiredFlag = data.required
    if (typeof requiredFlag !== 'boolean') {
      throw new MalformedError(`verification_plan[${index}].required 必须是布尔值`)
    }
    return {
      scenario: nonEmpty(data.scenario, `verification_plan[${index}].scenario`),
      acceptanceCriterion: nonEmpty(
        data.acceptance_criterion ?? data.acceptanceCriterion,
        `verification_plan[${index}].acceptance_criterion`,
      ),
      method: nonEmpty(data.method, `verification_plan[${index}].method`),
      required: requiredFlag,
    }
  })
  if (required && plan.length === 0) {
    throw new MalformedError('实现前评审通过时验证计划不能为空')
  }
  if (required && !plan.some((item) => item.required)) {
    throw new MalformedError('验证计划至少要有一种必过场景')
  }
  if (new Set(plan.map((item) => item.scenario)).size !== plan.length) {
    throw new MalformedError('验证计划的场景不能重复')
  }
  return plan
}

export function parsePlanReview(raw: string): PlanReview {
  const data = asRecord(parseJsonLoose(raw, '实现前评审结果'), '实现前评审结果')
  const verdict = verdictOf(data.verdict, '实现前评审')
  const blocking = stringList(data.blocking, 'blocking', true)
  const findings = stringList(data.findings, 'findings', true)
  if (verdict === 'pass' && blocking.length > 0) {
    throw new MalformedError('实现前评审结论为 pass 时 blocking 必须为空')
  }
  if (verdict === 'block' && blocking.length === 0) {
    throw new MalformedError('实现前评审结论为 block 时必须给出至少一条阻断原因')
  }
  return {
    verdict,
    blocking,
    findings,
    summary: nonEmpty(data.summary, 'summary'),
    verificationPlan: parseVerificationPlan(data.verification_plan, verdict === 'pass'),
  }
}

export function parseVerificationCommands(raw: string): VerificationCommand[] {
  const parsed = parseJsonLoose(raw, '验证命令清单')
  const data = Array.isArray(parsed) ? { commands: parsed } : asRecord(parsed, '验证命令清单')
  if (!Array.isArray(data.commands) || data.commands.length === 0) {
    throw new MalformedError('验证命令清单必须给出至少一条命令')
  }
  if (data.commands.length > 10) throw new MalformedError('验证命令一次最多 10 条')
  const commands = data.commands.map((item, index) => {
    const command = asRecord(item, `commands[${index}]`)
    const argv = stringList(command.argv, `commands[${index}].argv`, false)
    return {
      label: nonEmpty(command.label, `commands[${index}].label`),
      argv,
    }
  })
  if (new Set(commands.map((command) => command.label)).size !== commands.length) {
    throw new MalformedError('验证命令的 label 不能重复')
  }
  return commands
}

export function parseVerificationReport(raw: string): VerificationReport {
  const data = asRecord(parseJsonLoose(raw, '独立验证报告'), '独立验证报告')
  const verdict = verdictOf(data.verdict, '独立验证')
  const blocking = stringList(data.blocking, 'blocking', true)
  const findings = stringList(data.findings, 'findings', true)
  if (verdict === 'pass' && blocking.length > 0) {
    throw new MalformedError('独立验证结论为 pass 时 blocking 必须为空')
  }
  if (verdict === 'block' && blocking.length === 0) {
    throw new MalformedError('独立验证结论为 block 时必须给出至少一条阻断原因')
  }
  if (!Array.isArray(data.scenarios)) throw new MalformedError('独立验证报告必须给出 scenarios 数组')
  const scenarios = data.scenarios.map((item, index) => {
    const scenario = asRecord(item, `scenarios[${index}]`)
    const status = scenario.status
    if (status !== 'pass' && status !== 'fail' && status !== 'not_verified') {
      throw new MalformedError(`scenarios[${index}].status 必须是 pass、fail 或 not_verified`)
    }
    return {
      scenario: nonEmpty(scenario.scenario, `scenarios[${index}].scenario`),
      status,
      evidence: typeof scenario.evidence === 'string' ? scenario.evidence.trim() : '',
      commands: stringList(scenario.commands, `scenarios[${index}].commands`, true),
    } satisfies VerificationScenarioResult
  })
  if (new Set(scenarios.map((scenario) => scenario.scenario)).size !== scenarios.length) {
    throw new MalformedError('独立验证报告的场景不能重复')
  }
  return {
    verdict,
    summary: nonEmpty(data.summary, 'summary'),
    findings,
    blocking,
    scenarios,
  }
}

/** 验证计划必须逐项覆盖分析中的业务场景与验收标准；文本按原文核对。 */
export function validatePlanCoverage(
  analysis: { readonly scenarios: readonly string[]; readonly acceptanceCriteria: readonly string[] },
  review: PlanReview,
): string[] {
  const issues: string[] = []
  for (const scenario of analysis.scenarios) {
    if (!review.verificationPlan.some((item) => item.scenario === scenario)) {
      issues.push(`验证计划缺少业务场景：${scenario}`)
    }
  }
  for (const criterion of analysis.acceptanceCriteria) {
    if (!review.verificationPlan.some((item) => item.acceptanceCriterion === criterion)) {
      issues.push(`验证计划缺少验收标准：${criterion}`)
    }
  }
  return issues
}

/** 必过场景必须在报告里以 pass 出现并给出证据；否则不得通过。 */
export function validateVerificationCoverage(
  plan: readonly VerificationScenarioPlan[],
  report: VerificationReport,
): string[] {
  const issues: string[] = []
  for (const item of plan.filter((scenario) => scenario.required)) {
    const result = report.scenarios.find((scenario) => scenario.scenario === item.scenario)
    if (!result) {
      issues.push(`缺少必过场景的验证结果：${item.scenario}`)
      continue
    }
    if (result.status !== 'pass') {
      issues.push(`必过场景未通过：${item.scenario}（${result.status}）`)
      continue
    }
    if (!result.evidence) issues.push(`必过场景缺少证据：${item.scenario}`)
  }
  return issues
}
