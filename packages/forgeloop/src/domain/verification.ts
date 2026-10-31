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

/**
 * 分析原文是否被验证计划引用：原文必须逐字出现在计划字段里，
 * 允许计划补充可检查的细节或归一化空白，但不接受改写或概括。
 * 这样既保留“必须覆盖每一条”的强制，又不把合法补充判成缺项。
 */
function referencesText(field: string, source: string): boolean {
  // 原文可能被换行或缩进重排：按“去掉全部空白”比较，标点与字词仍须逐字一致。
  const strip = (text: string): string => text.replace(/\s+/g, '')
  return strip(field).includes(strip(source))
}

/** 验证计划必须逐项覆盖分析中的业务场景与验收标准；文本按原文核对。 */
export function validatePlanCoverage(
  analysis: { readonly scenarios: readonly string[]; readonly acceptanceCriteria: readonly string[] },
  review: PlanReview,
): string[] {
  const issues: string[] = []
  for (const scenario of analysis.scenarios) {
    if (!review.verificationPlan.some((item) => referencesText(item.scenario, scenario))) {
      issues.push(`验证计划缺少业务场景：${scenario}`)
    }
  }
  for (const criterion of analysis.acceptanceCriteria) {
    if (!review.verificationPlan.some((item) => referencesText(item.acceptanceCriterion, criterion))) {
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

/** 程序实际执行的一条验证命令及其结果；只由运行时按执行记录产生。 */
export interface VerificationCommandRun {
  readonly label: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly output: string
}

const MIN_EVIDENCE_CHARS = 8

function normalizeEvidence(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 证据必须是命令输出中的原文片段（归一化空白后至少 8 个字符）。 */
export function matchesCommandOutput(output: string, evidence: string): boolean {
  const needle = normalizeEvidence(evidence)
  return needle.length >= MIN_EVIDENCE_CHARS && normalizeEvidence(output).includes(needle)
}

/**
 * 场景证据必须能落到本次实际执行的命令上：label 存在、命令成功、证据是输出原文。
 * 非空字符串、模型填写 pass 或无关命令退出 0 都不能替代。
 */
export function validateScenarioEvidence(
  plan: readonly VerificationScenarioPlan[],
  report: VerificationReport,
  runs: readonly VerificationCommandRun[],
): string[] {
  const issues: string[] = []
  const byLabel = new Map(runs.map((run) => [run.label, run]))
  for (const result of report.scenarios) {
    if (result.status !== 'pass') continue
    for (const label of result.commands) {
      if (!byLabel.has(label)) issues.push(`场景 ${result.scenario} 引用了未执行的验证命令：${label}`)
    }
  }
  for (const item of plan.filter((scenario) => scenario.required)) {
    const result = report.scenarios.find((scenario) => scenario.scenario === item.scenario)
    if (!result || result.status !== 'pass') continue
    if (result.commands.length === 0) {
      issues.push(`必过场景没有关联验证命令：${item.scenario}`)
      continue
    }
    const referenced = result.commands
      .map((label) => byLabel.get(label))
      .filter((run): run is VerificationCommandRun => run !== undefined)
    if (referenced.length === 0) continue
    const executed = referenced.filter((run) => !run.timedOut && !run.aborted && run.exitCode === 0)
    if (executed.length === 0) {
      issues.push(`必过场景关联的验证命令没有成功执行：${item.scenario}`)
      continue
    }
    if (!executed.some((run) => matchesCommandOutput(run.output, result.evidence))) {
      issues.push(`必过场景证据无法在验证命令输出中核对：${item.scenario}`)
    }
  }
  return issues
}

// ---------------------------------------------------------------- 需求验证方案

/**
 * 由需求说明生成的验证方案：每个业务场景都落到可执行命令与判定口径。
 * 与实现前评审的 verification_plan 不同，它不依赖任务包或候选，只依据需求说明。
 */
export interface VerificationCheckPlan {
  readonly label: string
  readonly argv: readonly string[]
  /** 期望在命令输出中逐字出现的片段；空字符串表示只看退出码。 */
  readonly expectedOutput: string
}

export interface VerificationPlanScenario extends VerificationScenarioPlan {
  readonly checks: readonly VerificationCheckPlan[]
}

export interface VerificationPlan {
  readonly scenarios: readonly VerificationPlanScenario[]
}

/**
 * 解析验证 Agent 产出的方案。结构不合法时 fail-closed：
 * 缺场景、缺命令、label 重复、没有必过场景都按畸形拒绝，不静默补全。
 */
export function parseRequirementVerificationPlan(raw: string): VerificationPlan {
  const data = asRecord(parseJsonLoose(raw, '验证方案'), '验证方案')
  if (!Array.isArray(data.scenarios) || data.scenarios.length === 0) {
    throw new MalformedError('验证方案必须给出至少一个业务场景')
  }
  if (data.scenarios.length > 20) throw new MalformedError('验证方案的场景一次最多 20 个')
  const labels = new Set<string>()
  let totalChecks = 0
  const scenarios = data.scenarios.map((item, index) => {
    const scenario = asRecord(item, `scenarios[${index}]`)
    if (typeof scenario.required !== 'boolean') {
      throw new MalformedError(`scenarios[${index}].required 必须是布尔值`)
    }
    if (!Array.isArray(scenario.checks) || scenario.checks.length === 0) {
      throw new MalformedError(`scenarios[${index}].checks 必须给出至少一条可执行命令`)
    }
    const checks = scenario.checks.map((rawCheck, checkIndex) => {
      const check = asRecord(rawCheck, `scenarios[${index}].checks[${checkIndex}]`)
      const label = nonEmpty(check.label, `scenarios[${index}].checks[${checkIndex}].label`)
      if (labels.has(label)) throw new MalformedError(`验证方案的命令 label 不能重复：${label}`)
      labels.add(label)
      totalChecks += 1
      const expected = check.expected_output ?? check.expectedOutput
      if (expected !== undefined && typeof expected !== 'string') {
        throw new MalformedError(`scenarios[${index}].checks[${checkIndex}].expected_output 必须是字符串`)
      }
      return {
        label,
        argv: stringList(check.argv, `scenarios[${index}].checks[${checkIndex}].argv`, false),
        expectedOutput: typeof expected === 'string' ? expected.trim() : '',
      } satisfies VerificationCheckPlan
    })
    return {
      scenario: nonEmpty(scenario.scenario, `scenarios[${index}].scenario`),
      acceptanceCriterion: nonEmpty(
        scenario.acceptance_criterion ?? scenario.acceptanceCriterion,
        `scenarios[${index}].acceptance_criterion`,
      ),
      method: nonEmpty(scenario.method, `scenarios[${index}].method`),
      required: scenario.required,
      checks,
    } satisfies VerificationPlanScenario
  })
  if (totalChecks > 10) throw new MalformedError('验证方案的命令一次最多 10 条')
  if (new Set(scenarios.map((scenario) => scenario.scenario)).size !== scenarios.length) {
    throw new MalformedError('验证方案的场景不能重复')
  }
  if (!scenarios.some((scenario) => scenario.required)) {
    throw new MalformedError('验证方案至少要有一个必过场景')
  }
  return { scenarios }
}

/** 验证方案必须逐字覆盖需求说明中的全部业务场景与验收标准。 */
export function validateRequirementVerificationPlan(
  analysis: { readonly scenarios: readonly string[]; readonly acceptanceCriteria: readonly string[] },
  plan: VerificationPlan,
): string[] {
  return validatePlanCoverage(analysis, {
    verdict: 'pass',
    blocking: [],
    findings: [],
    summary: '',
    verificationPlan: plan.scenarios,
  })
}

// ---------------------------------------------------------------- 验证执行结果

/** 程序实际执行的一条验证命令；由执行器记录，模型不能伪造。 */
export interface VerificationCheckRun {
  readonly label: string
  readonly argv: readonly string[]
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly durationMs: number
  readonly output: string
}

/** 研发 Agent 自验证后交给验证 Agent 的产物身份与独立工作区。 */
export interface VerificationArtifact {
  readonly requirementVersion: number
  readonly candidateSha256: string
  readonly workspace: string
}

export interface VerificationEnvironment {
  readonly platform: string
  readonly nodeVersion: string
  readonly startedAt: string
}

export interface VerificationScenarioRun {
  readonly scenario: string
  readonly acceptanceCriterion: string
  readonly status: 'pass' | 'fail'
  readonly evidence: string
  readonly checks: readonly VerificationCheckRun[]
}

export interface VerificationResult {
  readonly verdict: 'passed' | 'failed'
  readonly summary: string
  readonly artifact: VerificationArtifact
  readonly scenarios: readonly VerificationScenarioRun[]
  readonly checks: readonly VerificationCheckRun[]
  readonly failures: readonly string[]
  readonly environment: VerificationEnvironment
  readonly finishedAt: string
}

function outputContains(output: string, expected: string): boolean {
  const needle = normalizeEvidence(expected)
  if (!needle) return true
  return normalizeEvidence(output).includes(needle)
}

/**
 * 纯判定：所有必过场景与命令都实际执行、退出码为 0、未超时/中止，
 * 且命令输出包含方案要求的预期片段，才判定 passed；任何报错或问题都 failed。
 */
export function judgeVerificationResult(input: {
  readonly plan: VerificationPlan
  readonly artifact: VerificationArtifact
  readonly checks: readonly VerificationCheckRun[]
  readonly environment: VerificationEnvironment
  readonly finishedAt: string
}): VerificationResult {
  const byLabel = new Map(input.checks.map((run) => [run.label, run]))
  const failures: string[] = []
  const scenarios: VerificationScenarioRun[] = []
  for (const planned of input.plan.scenarios) {
    let failed = false
    const runs: VerificationCheckRun[] = []
    if (planned.checks.length === 0) {
      failures.push(`验证场景没有可执行命令：${planned.scenario}`)
      failed = true
    }
    for (const check of planned.checks) {
      const run = byLabel.get(check.label)
      if (!run) {
        failures.push(`缺少验证命令执行结果：${check.label}`)
        failed = true
        continue
      }
      runs.push(run)
      if (run.aborted) {
        failures.push(`验证命令被中止：${check.label}`)
        failed = true
        continue
      }
      if (run.timedOut) {
        failures.push(`验证命令超时：${check.label}`)
        failed = true
        continue
      }
      if (run.exitCode !== 0) {
        failures.push(`验证命令失败：${check.label}（退出码 ${run.exitCode === null ? 'null' : run.exitCode}）`)
        failed = true
        continue
      }
      if (!outputContains(run.output, check.expectedOutput)) {
        failures.push(`验证命令输出缺少预期片段：${check.label}（预期 ${check.expectedOutput}）`)
        failed = true
      }
    }
    scenarios.push({
      scenario: planned.scenario,
      acceptanceCriterion: planned.acceptanceCriterion,
      status: failed ? 'fail' : 'pass',
      evidence: runs[0] ? normalizeEvidence(runs[0].output).slice(0, 200) : '',
      checks: runs,
    })
  }
  const verdict: VerificationResult['verdict'] = failures.length === 0 ? 'passed' : 'failed'
  return {
    verdict,
    summary:
      verdict === 'passed'
        ? `验证通过：${scenarios.length} 个业务场景、${input.checks.length} 条命令均无报错`
        : `验证失败：${failures[0]}${failures.length > 1 ? ` 等 ${failures.length} 项问题` : ''}`,
    artifact: input.artifact,
    scenarios,
    checks: input.checks,
    failures,
    environment: input.environment,
    finishedAt: input.finishedAt,
  }
}

