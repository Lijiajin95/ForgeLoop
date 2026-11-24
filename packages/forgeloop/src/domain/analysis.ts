/** 分析提示词的版本号；提示词语义变化时必须递增并同步测试。 */
export const ANALYSIS_PROMPT_VERSION = 'analysis-v8'

export const MAX_AUTO_ANALYSIS_RETRIES = 3

export const BUSINESS_CONTEXT_DOC = 'docs/product/business-context.md'

export const PRODUCT_TOOL_ALLOWLIST: readonly string[] = [
  'forgeloop_read_library_entry',
  'forgeloop_read_project_doc',
  'forgeloop_write_project_doc',
  'forgeloop_web_search',
  'forgeloop_web_fetch',
]

export type AnalysisMode = 'initial' | 'auto' | 'manual'

export type AnalysisOutcome = 'done' | 'failed' | 'stale'

export interface AnalysisInvalidation {
  readonly reqId: string
  readonly analysisVersion: number
  readonly fromRequirementVersion: number
  readonly toRequirementVersion: number
  readonly reason: string
  readonly createdAt: string
}

export interface AnalysisAttempt {
  readonly reqId: string
  readonly requirementVersion: number
  readonly attempt: number
  readonly kind: AnalysisMode
  readonly outcome: AnalysisOutcome
  readonly detail: string
  readonly model: string
  readonly promptVersion: string
  readonly transcriptPath: string
  readonly toolCalls: readonly string[]
  readonly libraryDigest?: string
  readonly libraryReview?: string
  readonly libraryWarnings?: readonly string[]
  readonly createdAt: string
}

export function clarificationQuestionId(analysisVersion: number, index: number): string {
  return `Q${analysisVersion}-${index + 1}`
}

export interface ClarificationQuestion {
  readonly reqId: string
  readonly analysisVersion: number
  readonly questionIndex: number
  readonly questionId: string
  readonly text: string
  readonly status: 'open' | 'resolved'
  readonly resolution: string
  readonly resolvedAnalysisVersion: number | null
  readonly resolvedRequirementVersion: number | null
  readonly createdAt: string
}

export interface ClarificationAnswer {
  readonly reqId: string
  readonly analysisVersion: number
  readonly requirementVersion: number
  readonly answeredVersion: number
  readonly questionId: string
  readonly answerSeq: number
  readonly answer: string
  readonly source: string
  readonly answeredAt: string
}

export interface ClarificationUpdate {
  readonly questionId: string
  readonly status: 'resolved' | 'open'
  readonly resolution: string
  readonly reason: string
}
