/**
 * 研发自验证结果：研发 Agent 在完成白盒/黑盒自验后，根据代码 diff 风险决定
 * 本次候选是否需要独立验证。独立验证是后续阶段，本结构只记录研发侧的判断与证据，
 * 不描述验证 Agent 将如何验证。
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

/**
 * 解析研发 Agent 的最终 JSON。结构不合法返回 null，由运行时保守地按“需要独立验证”处理；
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
  const red = asRecord(data.red_green) ?? {}
  const evidence = typeof red.evidence === 'string' ? red.evidence.trim() : ''
  const redGreen: SelfVerificationRedGreen = {
    required: boolean(red.required),
    failingBefore: boolean(red.failing_before),
    passingAfter: boolean(red.passing_after),
    evidence,
  }
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

/** BUG 修复或高风险改动的红灯/绿灯证据是否完整；低风险改动不强制。 */
export function redGreenIssue(input: {
  readonly inputKind: 'requirement' | 'problem'
  readonly report: SelfVerificationReport
}): string | null {
  if (!requiresRedGreen(input)) return null
  if (!input.report.redGreen.required) return 'BUG 修复或高风险改动必须声明红灯/绿灯要求'
  if (!input.report.redGreen.failingBefore) return '缺少修复前目标行为失败证据'
  if (!input.report.redGreen.passingAfter) return '缺少修复后通过证据'
  if (!input.report.redGreen.evidence.trim()) return '红灯/绿灯缺少可核对证据说明'
  return null
}

/** 自验证报告是否足以支撑“本次不需要独立验证”。 */
export function selfVerificationSufficient(input: {
  readonly inputKind: 'requirement' | 'problem'
  readonly report: SelfVerificationReport
}): { ok: true } | { ok: false; reason: string } {
  if (input.report.mode !== 'self') return { ok: false, reason: '研发决定本次需要独立验证' }
  if (input.report.whiteBox.length === 0 && input.report.blackBox.length === 0) {
    return { ok: false, reason: '自验证报告没有白盒或黑盒检查证据' }
  }
  if (requiresRedGreen(input) && !input.report.redGreen.required) {
    return { ok: false, reason: 'BUG 修复或高风险改动必须声明红灯/绿灯要求' }
  }
  if (input.report.redGreen.required) {
    if (!input.report.redGreen.failingBefore) {
      return { ok: false, reason: '缺少修复前失败证据' }
    }
    if (!input.report.redGreen.passingAfter) {
      return { ok: false, reason: '缺少修复后通过证据' }
    }
    if (!input.report.redGreen.evidence.trim()) {
      return { ok: false, reason: '红灯/绿灯缺少可核对证据说明' }
    }
  }
  return { ok: true }
}
