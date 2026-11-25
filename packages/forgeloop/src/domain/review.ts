import { MalformedError } from './errors.js'
import { asRecord } from './json.js'
import { parseJsonLoose } from './requirement.js'

export const REVIEW_PROMPT_VERSION = 'review-v1'

export const REVIEW_CHECKS = [
  'goal',
  'acceptance',
  'evidence',
  'samples',
  'quality',
  'data',
  'assumptions',
  'discovery',
] as const

export type ReviewCheck = (typeof REVIEW_CHECKS)[number]

const REVIEW_STATUSES = ['pass', 'fail', 'na'] as const

export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

export interface ReviewCheckResult {
  readonly check: ReviewCheck
  readonly status: ReviewStatus
  readonly detail: string
}

export interface ReviewDraft {
  readonly verdict: 'pass' | 'fail'
  readonly summary: string
  readonly checks: readonly ReviewCheckResult[]
}

export function parseReviewDraft(text: string): ReviewDraft {
  const data = asRecord(parseJsonLoose(text, '需求评审'))
  if (!data) throw new MalformedError('需求评审必须是 JSON 对象')
  const verdict = data.verdict
  if (verdict !== 'pass' && verdict !== 'fail') {
    throw new MalformedError('评审 verdict 必须是 pass 或 fail')
  }
  const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
  if (!summary) throw new MalformedError('评审必须给出一句话结论')
  if (!Array.isArray(data.checks)) throw new MalformedError('评审 checks 必须是数组')
  const seen = new Set<ReviewCheck>()
  const checks: ReviewCheckResult[] = data.checks.map((item, index) => {
    const check = asRecord(item)
    if (!check) throw new MalformedError(`评审 checks[${index}] 必须是对象`)
    const name = REVIEW_CHECKS.find((candidate) => candidate === check.check)
    if (!name) {
      throw new MalformedError(
        `评审 checks[${index}].check 必须是 ${REVIEW_CHECKS.join('、')} 之一`,
      )
    }
    if (seen.has(name)) throw new MalformedError(`评审检查项 ${name} 重复`)
    seen.add(name)
    const status = REVIEW_STATUSES.find((candidate) => candidate === check.status)
    if (!status) throw new MalformedError(`评审检查项 ${name} 的状态必须是 pass、fail 或 na`)
    const detail = typeof check.detail === 'string' ? check.detail.trim() : ''
    if (status !== 'pass' && !detail) {
      throw new MalformedError(`评审检查项 ${name} 为 ${status} 时必须说明理由`)
    }
    return { check: name, status, detail }
  })
  const missing = REVIEW_CHECKS.filter((name) => !seen.has(name))
  if (missing.length > 0) {
    throw new MalformedError(`评审缺少检查项：${missing.join('、')}`)
  }
  const failures = checks.filter((item) => item.status === 'fail')
  if (verdict === 'pass' && failures.length > 0) {
    throw new MalformedError('评审结论为 pass 时不能有 fail 检查项')
  }
  if (verdict === 'fail' && failures.length === 0) {
    throw new MalformedError('评审结论为 fail 时必须至少有一个 fail 检查项')
  }
  return { verdict, summary, checks }
}

export interface RequirementReview {
  readonly reqId: string
  readonly reviewVersion: number
  readonly analysisVersion: number
  readonly reviewer: string
  readonly verdict: 'pass' | 'fail'
  readonly summary: string
  readonly checks: readonly ReviewCheckResult[]
  readonly promptVersion: string
  readonly createdAt: string
}
