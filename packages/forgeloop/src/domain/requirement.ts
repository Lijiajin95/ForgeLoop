/**
 * 需求受理的身份与修订规则（迁移自旧 `domain/requirement.py`）：
 * - 首次提交原文占用版本 1，永久保留；修订只追加，不覆盖。
 * - 同一目标的修订不重新分配身份，版本号从 1 起连续。
 * - 未知身份明确失败。
 * - 分析结果必须是结构化对象；有待澄清项时等待回答，不进入实现。
 */

import { randomBytes } from 'node:crypto'
import { MalformedError, NotFoundError, RuleViolationError } from './errors.js'
import { AWAITING_CLARIFICATION, DRAFT } from './status.js'

export interface RequirementVersion {
  readonly version: number
  readonly text: string
  readonly createdAt: string
  readonly revisedBy: string
  readonly source: string
}

export interface Requirement {
  readonly reqId: string
  readonly project: string
  readonly status: string
  readonly blockedReason: string
  readonly versions: readonly RequirementVersion[]
  readonly submittedBy: string
  readonly source: string
}

export function allocateRequirementId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
  return `req-${stamp}-${randomBytes(3).toString('hex')}`
}

export function requireVersionText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) throw new RuleViolationError('需求原文不能为空')
  return trimmed
}

/** 构造并校验一条需求的全部版本：版本号连续、原文非空、绑定项目。 */
export function validateRequirement(input: {
  reqId: string
  project: string
  versions: readonly RequirementVersion[]
}): void {
  if (!input.reqId.trim()) throw new RuleViolationError('需求身份不能为空')
  if (!input.project.trim()) throw new RuleViolationError('需求必须绑定一个项目')
  if (input.versions.length === 0) throw new RuleViolationError('需求至少要有原始输入这一版本')
  input.versions.forEach((version, index) => {
    if (version.version !== index + 1) {
      throw new RuleViolationError('需求版本号必须从 1 起连续递增，历史版本不得覆盖')
    }
    if (!version.text.trim()) throw new RuleViolationError('需求版本原文不能为空')
  })
}

export function latestVersion(requirement: Requirement): RequirementVersion {
  const version = requirement.versions[requirement.versions.length - 1]
  if (!version) throw new RuleViolationError('需求至少要有原始输入这一版本')
  return version
}

export function originalText(requirement: Requirement): string {
  const version = requirement.versions[0]
  if (!version) throw new RuleViolationError('需求至少要有原始输入这一版本')
  return version.text
}

/** 未知身份明确失败（与空结果区分）。 */
export function requireFound<T>(value: T | undefined, reqId: string): T {
  if (value === undefined) throw new NotFoundError(`未找到需求 ${reqId}`)
  return value
}

export interface RequirementAnalysis {
  readonly analysisVersion: number
  readonly requirementVersion: number
  readonly goal: string
  readonly scenarios: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly clarifications: readonly string[]
  readonly createdAt: string
}

export interface AnalysisDraft {
  readonly goal: string
  readonly scenarios: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly clarifications: readonly string[]
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new MalformedError(`分析字段 ${field} 必须是字符串数组`)
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new MalformedError(`分析字段 ${field} 只能包含非空字符串`)
    }
    items.push(item.trim())
  }
  return items
}

/**
 * 解析模型返回的分析载荷。默认容忍 ```json 围栏与前后说明，但字段本身必须合法；
 * 缺字段或类型不符按畸形失败，不静默补空值。
 */
export function parseAnalysisDraft(raw: unknown): AnalysisDraft {
  let payload = raw
  if (typeof payload === 'string') {
    payload = parseJsonLoose(payload, '分析结果')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new MalformedError('分析结果必须是 JSON 对象')
  }
  const data = payload as Record<string, unknown>
  const goal = typeof data.goal === 'string' ? data.goal.trim() : ''
  if (!goal) throw new MalformedError('分析缺少非空目标')
  const scenarios = stringList(data.scenarios ?? [], 'scenarios')
  const acceptanceCriteria = stringList(data.acceptance_criteria ?? [], 'acceptance_criteria')
  const clarifications = stringList(data.clarifications ?? [], 'clarifications')
  if (clarifications.length === 0 && (scenarios.length === 0 || acceptanceCriteria.length === 0)) {
    throw new MalformedError('没有待澄清项时必须给出业务场景与验收标准')
  }
  return { goal, scenarios, acceptanceCriteria, clarifications }
}

export function parseJsonLoose(text: string, what: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1]?.trim() ?? text.trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  const body = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate
  try {
    return JSON.parse(body) as unknown
  } catch (error) {
    throw new MalformedError(`${what}不是可解析的 JSON：${(error as Error).message}`)
  }
}

/** 一次分析完成后的需求状态：有待澄清项时等待回答，否则仍是 draft。 */
export function statusForAnalysis(analysis: Pick<RequirementAnalysis, 'clarifications'>): string {
  return analysis.clarifications.length > 0 ? AWAITING_CLARIFICATION : DRAFT
}

export function validateAnalysis(
  analysis: RequirementAnalysis,
  requirementVersionCount: number,
): void {
  if (analysis.analysisVersion < 1) throw new RuleViolationError('分析版本号必须从 1 开始')
  if (analysis.requirementVersion < 1) throw new RuleViolationError('分析必须绑定一个需求版本')
  if (analysis.requirementVersion > requirementVersionCount) {
    throw new RuleViolationError('分析绑定的需求版本超出实际版本')
  }
  if (!analysis.goal.trim()) throw new MalformedError('分析缺少非空目标')
}