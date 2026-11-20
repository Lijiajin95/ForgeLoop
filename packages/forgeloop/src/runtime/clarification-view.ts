import type { Repository } from '../records/repository.js'
import { AWAITING_CLARIFICATION } from '../domain/status.js'
import { requirementTitle } from './board.js'

export interface PendingClarification {
  readonly reqId: string
  readonly title: string
  readonly requirementVersion: number
  readonly analysisVersion: number
  readonly questions: readonly string[]
  readonly questionIds: readonly string[]
  readonly updatedAt: string
}

export function pendingClarificationsOf(input: {
  repository: Repository
  project: string
  sessionId: string
}): PendingClarification[] {
  const prefix = `dsh-session:${input.sessionId}:`
  const result: PendingClarification[] = []
  for (const requirement of input.repository.listRequirements(input.project)) {
    if (!requirement.source.startsWith(prefix)) continue
    if (requirement.status !== AWAITING_CLARIFICATION) continue
    const analysis = input.repository.latestAnalysis(requirement.reqId)
    if (!analysis) continue
    if (analysis.requirementVersion !== requirement.versions.length) continue
    const open = input.repository.openClarifications(requirement.reqId)
    if (open.length === 0) continue
    const latest = requirement.versions[requirement.versions.length - 1]
    result.push({
      reqId: requirement.reqId,
      title: requirementTitle(requirement),
      requirementVersion: requirement.versions.length,
      analysisVersion: analysis.analysisVersion,
      questions: open.map((question) => question.text),
      questionIds: open.map((question) => question.questionId),
      updatedAt: latest?.createdAt ?? '',
    })
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
