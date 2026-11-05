/**
 * 需求详情的只读补充：历次分析、澄清问答与本次规格变化。
 *
 * 页面从同一份权威分析记录生成需求说明；这里只做投影与确定性差异，
 * 不另维护 PRD，也不写业务状态。
 */

import type { Repository } from '../records/repository.js'
import type { ClarificationAnswer, ClarificationQuestion } from '../domain/analysis.js'
import { specChanges, type SpecChanges } from '../domain/spec.js'

export interface RequirementDetailExtras {
  readonly analysisHistory: ReturnType<Repository['analyses']>
  readonly clarificationHistory: {
    readonly questions: readonly ClarificationQuestion[]
    readonly answers: readonly ClarificationAnswer[]
  }
  readonly specChanges: SpecChanges
}

export function requirementDetailExtras(
  repository: Repository,
  reqId: string,
): RequirementDetailExtras {
  const analyses = repository.analyses(reqId)
  const latest = analyses.at(-1) ?? null
  const previous = analyses.length > 1 ? (analyses.at(-2) ?? null) : null
  return {
    analysisHistory: analyses,
    clarificationHistory: {
      questions: repository.clarificationQuestions(reqId),
      answers: repository.clarificationAnswers(reqId),
    },
    specChanges: specChanges(previous, latest),
  }
}
