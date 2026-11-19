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
  readonly businessContext: ReturnType<Repository['businessContextChanges']>
  readonly analysisInvalidations: ReturnType<Repository['analysisInvalidations']>
  readonly documents: ReturnType<Repository['documentsOf']>
  readonly installableDelivery: ReturnType<Repository['installableDeliveryStore']['latest']>
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
    businessContext: repository.businessContextChanges(reqId),
    analysisInvalidations: repository.analysisInvalidations(reqId),
    documents: repository.documentsOf(reqId),
    installableDelivery: repository.installableDeliveryStore.latest(reqId),
  }
}
