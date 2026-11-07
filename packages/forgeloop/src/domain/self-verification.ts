/**
 * 研发自验证结果：研发 Agent 在完成白盒/黑盒自验后，根据代码 diff 风险决定
 * 本次候选是否需要独立测试。独立测试是后续阶段，本结构只记录研发侧的判断与证据，
 * 不描述测试 Agent 将如何验证。
 */

import { asRecord } from './json.js'
import { parseJsonLoose } from './requirement.js'

export type VerificationMode = 'independent' | 'self'

export type SelfVerificationRisk = 'low' | 'medium' | 'high' | 'unknown'

export interface SelfVerificationRedGreen {
  /** 本次改动是否属于 BUG 修复或关键业务行为，按风险要求红灯/绿灯证据。 */
  readonly required: boolean
  readonly failingBefore: boolean
  readonly passingAfter: boolean
  readonly evidence: string
  /** 红灯：修复前实际执行的命令、代码身份、退出码与日志。 */
  readonly failingCommand: string
  readonly baselineIdentity: string
  readonly failingExitCode: number | null
  readonly failingLog: string
  /** 绿灯：修复后实际执行的命令、代码身份、退出码与日志。 */
  readonly passingCommand: string
  readonly fixedIdentity: string
  readonly passingExitCode: number | null
  readonly passingLog: string
}

export interface SelfVerificationReport {
  readonly mode: VerificationMode
  readonly risk: SelfVerificationRisk
  readonly whiteBox: readonly string[]
  readonly blackBox: readonly string[]
  readonly redGreen: SelfVerificationRedGreen
  readonly reason: string
  readonly needsClarification?: {
    readonly question: string
    readonly context: string
  }
}

const MODES: readonly VerificationMode[] = ['independent', 'self']
const MODE_SET: ReadonlySet<string> = new Set(MODES)
const RISKS: readonly SelfVerificationRisk[] = ['low', 'medium', 'high', 'unknown']
const RISK_SET: ReadonlySet<string> = new Set(RISKS)

function isMode(value: unknown): value is VerificationMode {
  return typeof value === 'string' && MODE_SET.has(value)
}

function isRisk(value: unknown): value is SelfVerificationRisk {
  return typeof value === 'string' && RISK_SET.has(value)
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

function boolean(value: unknown): boolean {
  return value === true
}

function clarification(value: unknown): SelfVerificationReport['needsClarification'] | undefined {
  if (value === undefined || value === null) return undefined
  const record = asRecord(value)
  if (!record) return undefined
  const question = typeof record.question === 'string' ? record.question.trim() : ''
  if (!question) return undefined
  const context = typeof record.context === 'string' ? record.context.trim() : ''
  return { question, context }
}

function parseRedGreen(value: unknown): SelfVerificationRedGreen {
  const red = asRecord(value) ?? {}
  const text = (input: unknown): string => (typeof input === 'string' ? input.trim() : '')
  const exitCode = (input: unknown): number | null =>
    typeof input === 'number' && Number.isInteger(input) ? input : null
  return {
    required: boolean(red.required),
    failingBefore: boolean(red.failing_before),
    passingAfter: boolean(red.passing_after),
    evidence: text(red.evidence),
    failingCommand: text(red.failing_command ?? red.failingCommand),
    baselineIdentity: text(red.baseline_identity ?? red.baselineIdentity),
    failingExitCode: exitCode(red.failing_exit_code ?? red.failingExitCode),
    failingLog: text(red.failing_log ?? red.failingLog),
    passingCommand: text(red.passing_command ?? red.passingCommand),
    fixedIdentity: text(red.fixed_identity ?? red.fixedIdentity),
    passingExitCode: exitCode(red.passing_exit_code ?? red.passingExitCode),
    passingLog: text(red.passing_log ?? red.passingLog),
  }
}

/**
 * 解析研发 Agent 的最终 JSON。结构不合法返回 null，由运行时保守地按“需要独立测试”处理；
 * 不猜测缺失的 mode，也不把模型自由文本当自验证结论。
 */
export function parseSelfVerificationReport(raw: string): SelfVerificationReport | null {
  let payload: unknown
  try {
    payload = parseJsonLoose(raw, '研发自验证结果')
  } catch {
    return null
  }
  const data = asRecord(payload)
  if (!data) return null
  const mode = data.mode
  const risk = data.risk
  if (!isMode(mode)) return null
  if (risk !== undefined && !isRisk(risk)) return null
  const redGreen = parseRedGreen(data.red_green)
  const needsClarification = clarification(data.needs_clarification)
  return {
    mode,
    risk: risk ?? 'unknown',
    whiteBox: strings(data.white_box),
    blackBox: strings(data.black_box),
    redGreen,
    reason: typeof data.reason === 'string' ? data.reason.trim() : '',
    ...(needsClarification === undefined ? {} : { needsClarification }),
  }
}

/** BUG 修复或高风险改动必须有红灯/绿灯；低风险文档改动不强制。 */
export function requiresRedGreen(input: {
  readonly inputKind: 'requirement' | 'problem'
  readonly report: SelfVerificationReport
}): boolean {
  return input.inputKind === 'problem' || input.report.risk === 'high'
}

function redGreenProblems(report: SelfVerificationReport): string | null {
  const red = report.redGreen
  if (!red.failingBefore) return '缺少修复前目标行为失败证据'
  if (!red.passingAfter) return '缺少修复后通过证据'
  if (!red.evidence.trim()) return '红灯/绿灯缺少可核对证据说明'
  if (!red.failingCommand || !red.baselineIdentity || !red.failingLog) {
    return '红灯缺少真实命令、基线代码身份或日志'
  }
  if (red.failingExitCode === null || red.failingExitCode === 0) {
    return '红灯必须记录非零退出码'
  }
  if (!red.passingCommand || !red.fixedIdentity || !red.passingLog) {
    return '绿灯缺少真实命令、修复后代码身份或日志'
  }
  if (red.passingExitCode !== 0) return '绿灯必须记录退出码 0'
  return null
}

/** BUG 修复或高风险改动的红灯/绿灯证据是否完整；低风险改动不强制。 */
export function redGreenIssue(input: {
  readonly inputKind: 'requirement' | 'problem'
  readonly report: SelfVerificationReport
}): string | null {
  if (!requiresRedGreen(input)) return null
  if (!input.report.redGreen.required) return 'BUG 修复或高风险改动必须声明红灯/绿灯要求'
  return redGreenProblems(input.report)
}

/** 自测试报告是否足以支撑“本次不需要独立测试”。 */
export function selfVerificationSufficient(input: {
  readonly inputKind: 'requirement' | 'problem'
  readonly report: SelfVerificationReport
}): { ok: true } | { ok: false; reason: string } {
  if (input.report.mode !== 'self') return { ok: false, reason: '研发决定本次需要独立测试' }
  if (input.report.whiteBox.length === 0 && input.report.blackBox.length === 0) {
    return { ok: false, reason: '自测试报告没有白盒或黑盒检查证据' }
  }
  if (requiresRedGreen(input) && !input.report.redGreen.required) {
    return { ok: false, reason: 'BUG 修复或高风险改动必须声明红灯/绿灯要求' }
  }
  if (input.report.redGreen.required) {
    const problem = redGreenProblems(input.report)
    if (problem) return { ok: false, reason: problem }
  }
  return { ok: true }
}

/** 整份候选的自验证结论：所有已交付任务都必须有 self 报告，缺一即转独立测试。 */
export function candidateSelfVerification(input: {
  readonly inputKind: 'requirement' | 'problem'
  readonly reports: ReadonlyArray<{
    readonly taskId: string
    readonly report: SelfVerificationReport | null
  }>
}): { ok: true } | { ok: false; reason: string } {
  if (input.reports.length === 0) return { ok: false, reason: '没有可核对的任务自测试报告' }
  for (const item of input.reports) {
    if (item.report === null) {
      return { ok: false, reason: `任务 ${item.taskId} 缺少持久化自测试报告` }
    }
    if (item.report.mode !== 'self') {
      return { ok: false, reason: `任务 ${item.taskId} 选择独立测试` }
    }
    const sufficient = selfVerificationSufficient({
      inputKind: input.inputKind,
      report: item.report,
    })
    if (!sufficient.ok) {
      return { ok: false, reason: `任务 ${item.taskId} 自验证不足：${sufficient.reason}` }
    }
  }
  return { ok: true }
}

/** 从候选 diff 中提取受影响路径；用于让 self 决策依据实际改动，而不是模型自述。 */
export function changedPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>()
  for (const line of diff.split('\n')) {
    const match = /^diff --git a\/(.+?) b\//.exec(line)
    if (match?.[1]) paths.add(match[1])
    else if (line.startsWith('+++ b/')) paths.add(line.slice(6).trim())
  }
  return [...paths]
}

/**
 * self 模式的实际改动门禁：仅文档改动可直接 self；改到代码时，
 * 必须每份自测试报告都声明低风险且有白盒或黑盒检查，否则交给独立测试。
 */
export function selfModeAllowedByDiff(input: {
  readonly paths: readonly string[]
  readonly reports: readonly SelfVerificationReport[]
}): { ok: true } | { ok: false; reason: string } {
  const code = input.paths.filter(
    (path) => !path.endsWith('.md') && !path.startsWith('verification/'),
  )
  if (code.length === 0) return { ok: true }
  if (input.reports.length === 0) return { ok: false, reason: '没有自测试报告，不能 self' }
  for (const report of input.reports) {
    if (report.risk !== 'low') {
      return { ok: false, reason: `候选改到代码（${code[0]}），风险不是 low，需要独立测试` }
    }
    if (report.whiteBox.length === 0 && report.blackBox.length === 0) {
      return { ok: false, reason: '候选改到代码但缺少白盒/黑盒检查，需要独立测试' }
    }
  }
  return { ok: true }
}
