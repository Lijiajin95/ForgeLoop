/**
 * 交付材料身份（迁移自旧 `domain/delivery.py`）：
 * 验收批准绑定候选 diff、正式测试证据、独立审查结论与产物校验值；
 * 任一材料变化即令原批准失效，不能沿用旧批准。
 */

import { createHash } from 'node:crypto'
import { RuleViolationError } from './errors.js'

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/

export interface DeliveryBinding {
  readonly candidateSha256: string
  readonly testEvidenceSha256: string
  readonly reviewSha256: string
  readonly artifactSha256: string
  readonly baselineCommit: string
}

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function requireDigest(value: string, field: string): string {
  if (!DIGEST_PATTERN.test(value)) {
    throw new RuleViolationError(`${field} 必须是 64 位小写十六进制 SHA-256，实际 ${JSON.stringify(value)}`)
  }
  return value
}

export function buildBinding(input: {
  candidateSha256: string
  testEvidenceSha256: string
  reviewSha256: string
  artifactSha256?: string
  baselineCommit?: string
}): DeliveryBinding {
  return {
    candidateSha256: requireDigest(input.candidateSha256, '候选 diff'),
    testEvidenceSha256: requireDigest(input.testEvidenceSha256, '正式测试证据'),
    reviewSha256: requireDigest(input.reviewSha256, '独立审查结论'),
    artifactSha256: input.artifactSha256 ? requireDigest(input.artifactSha256, '产物') : '',
    baselineCommit: input.baselineCommit ?? '',
  }
}

export interface BindingDecision {
  readonly valid: boolean
  readonly reason: string
}

/** 比对批准绑定的材料与当前材料；空字段表示该材料未参与绑定。 */
export function verifyBinding(
  approved: DeliveryBinding,
  current: DeliveryBinding,
): BindingDecision {
  const fields: Array<[keyof DeliveryBinding, string]> = [
    ['candidateSha256', '候选 diff'],
    ['testEvidenceSha256', '正式测试证据'],
    ['reviewSha256', '独立审查结论'],
    ['artifactSha256', '产物'],
    ['baselineCommit', '基线提交'],
  ]
  for (const [field, label] of fields) {
    const expected = approved[field]
    if (!expected) continue
    if (approved[field] !== current[field]) {
      return { valid: false, reason: `${label}已变化（批准 ${expected}，当前 ${current[field] || '缺失'}）；原批准失效` }
    }
  }
  return { valid: true, reason: '' }
}