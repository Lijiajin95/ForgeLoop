import type { ClarificationQuestion } from '../domain/analysis.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import { AWAITING_CLARIFICATION } from '../domain/status.js'
import type { Repository } from '../records/repository.js'

export type ClarificationAnswerContext =
  | { readonly ok: false; readonly code: string; readonly message: string }
  | {
      readonly ok: true
      readonly requirement: Requirement
      readonly analysis: RequirementAnalysis
      readonly questions: readonly ClarificationQuestion[]
    }

export function clarificationAnswerTargets(
  open: readonly ClarificationQuestion[],
  questionIds: readonly string[] | undefined,
): { ok: true; questions: readonly ClarificationQuestion[] } | { ok: false; reason: string } {
  if (!questionIds || questionIds.length === 0) return { ok: true, questions: open }
  const wanted = [...new Set(questionIds.map((id) => id.trim()).filter(Boolean))]
  const known = new Map(open.map((question) => [question.questionId, question]))
  const missing = wanted.filter((id) => !known.has(id))
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `问题 ${missing.join('、')} 不是当前开放问题；仍待回答：${[...known.keys()].join('、')}`,
    }
  }
  const questions = wanted
    .map((id) => known.get(id))
    .filter((question): question is ClarificationQuestion => question !== undefined)
  return { ok: true, questions }
}

export function clarificationAnswerContext(input: {
  repository: Repository
  reqId: string
  questionIds?: readonly string[] | undefined
}): ClarificationAnswerContext {
  const requirement = input.repository.getRequirement(input.reqId)
  if (!requirement) {
    return { ok: false, code: 'not_found', message: `未找到需求 ${input.reqId}` }
  }
  if (requirement.status !== AWAITING_CLARIFICATION) {
    return {
      ok: false,
      code: 'no_clarification',
      message: `需求 ${input.reqId} 当前不在待澄清状态`,
    }
  }
  const analysis = input.repository.latestAnalysis(input.reqId)
  const open = input.repository.openClarifications(input.reqId)
  if (
    !analysis ||
    analysis.requirementVersion !== requirement.versions.length ||
    open.length === 0
  ) {
    return {
      ok: false,
      code: 'no_clarification',
      message: `需求 ${input.reqId} 没有与当前版本对应的待澄清项`,
    }
  }
  const targets = clarificationAnswerTargets(open, input.questionIds)
  if (!targets.ok) return { ok: false, code: 'invalid_question', message: targets.reason }
  return { ok: true, requirement, analysis, questions: targets.questions }
}
