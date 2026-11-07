/**
 * 需求修订后的分析失效登记：旧分析保留可回查，但不能再作为当前版本依据。
 */

import type { RequirementAnalysis } from '../domain/requirement.js'
import type { Repository } from '../records/repository.js'

export function recordRevisionInvalidation(input: {
  repository: Repository
  reqId: string
  invalidated: RequirementAnalysis | null
  toRequirementVersion: number
  now: string
}): void {
  const analysis = input.invalidated
  if (!analysis) return
  input.repository.recordAnalysisInvalidation({
    reqId: input.reqId,
    analysisVersion: analysis.analysisVersion,
    fromRequirementVersion: analysis.requirementVersion,
    toRequirementVersion: input.toRequirementVersion,
    reason: `需求修订：旧分析基于 v${analysis.requirementVersion}`,
    createdAt: input.now,
  })
}
