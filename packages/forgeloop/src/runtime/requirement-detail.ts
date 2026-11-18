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
  /** 业务背景变更记录：草稿、已应用版本与依据。 */
  readonly businessContext: ReturnType<Repository['businessContextChanges']>
  /** 需求修订导致旧分析失效的审计记录。 */
  readonly analysisInvalidations: ReturnType<Repository['analysisInvalidations']>
  /** 设计文档快照历史：每个需求版本一条，正文仍以需求版本原文为准。 */
  readonly documents: ReturnType<Repository['documentsOf']>
  /** 最近一次可安装交付；没有记录时为空，页面显示空态而不是推断成功。 */
  readonly installableDelivery: ReturnType<Repository['installableDeliveryStore']['latest']>
  /** 产品阶段：按需求版本与尝试时间排列的分析尝试，含失败的公开原因与已记录工具名。 */
  readonly analysisActivity: readonly AnalysisAttemptView[]
  /** 验证阶段：按候选与尝试排列的验证记录，含结论、失败分类与阻塞原因。 */
  readonly verificationActivity: readonly VerificationAttemptView[]
}

/** 一次阶段活动最多返回最近多少条；页面只需要可读摘要，完整轨迹留在证据目录。 */
export const STAGE_ACTIVITY_LIMIT = 50

export interface AnalysisAttemptView {
  readonly requirementVersion: number
  readonly attempt: number
  readonly kind: string
  readonly outcome: string
  readonly detail: string
  readonly model: string
  readonly toolCalls: readonly string[]
  readonly createdAt: string
}

export interface VerificationAttemptView {
  readonly attemptId: string
  readonly planVersion: number
  readonly candidateSha256: string
  readonly attemptNumber: number
  readonly requirementVersion: number
  readonly verdict: string
  readonly failureKind: string
  readonly blocking: readonly string[]
  readonly reason: string
  readonly sessionId: string
  readonly verifiedAt: string
}

export function requirementDetailExtras(
  repository: Repository,
  reqId: string,
): RequirementDetailExtras {
  const analyses = repository.analyses(reqId)
  const latest = analyses.at(-1) ?? null
  const previous = analyses.length > 1 ? (analyses.at(-2) ?? null) : null
  const analysisAttempts = repository.analysisAttempts(reqId)
  const verificationAttempts = repository.verificationAttempts(reqId)
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
    analysisActivity: analysisAttempts.slice(-STAGE_ACTIVITY_LIMIT).map((attempt) => ({
      requirementVersion: attempt.requirementVersion,
      attempt: attempt.attempt,
      kind: attempt.kind,
      outcome: attempt.outcome,
      detail: attempt.detail,
      model: attempt.model,
      toolCalls: attempt.toolCalls,
      createdAt: attempt.createdAt,
    })),
    verificationActivity: verificationAttempts.slice(-STAGE_ACTIVITY_LIMIT).map((attempt) => ({
      attemptId: attempt.attemptId,
      planVersion: attempt.planVersion,
      candidateSha256: attempt.candidateSha256,
      attemptNumber: attempt.attemptNumber,
      requirementVersion: attempt.requirementVersion,
      verdict: attempt.verdict,
      failureKind: attempt.failureKind,
      blocking: attempt.blocking,
      reason: attempt.reason,
      sessionId: attempt.sessionId,
      verifiedAt: attempt.verifiedAt,
    })),
  }
}
