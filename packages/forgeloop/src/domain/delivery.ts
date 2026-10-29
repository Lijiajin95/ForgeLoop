/** 候选、测试日志与交付材料共用的 SHA-256 计算。 */

import { createHash } from 'node:crypto'

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 一次候选交付的稳定身份：需求版本、任务包版本、基线与按任务顺序排列的候选 diff 摘要。
 * 验证和验收都绑定这个身份；任一材料变化都会得到不同摘要，旧结论自动失效。
 */
export function candidateIdentityOf(input: {
  readonly planVersion: number
  readonly requirementVersion: number
  readonly baselineCommit: string
  readonly candidateHashes: readonly string[]
}): string {
  return sha256OfText(
    JSON.stringify({
      planVersion: input.planVersion,
      requirementVersion: input.requirementVersion,
      baselineCommit: input.baselineCommit,
      candidateHashes: input.candidateHashes,
    }),
  )
}
