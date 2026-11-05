/**
 * 产品 Agent 分析的版本与重试口径：
 * - 提示词版本写入每条分析记录，便于回答“这版结论由哪版提示词产生”。
 * - 自动重试有固定上限；手动重试是独立入口，不受自动次数限制。
 * - 业务背景单独存放在项目文档中，提示词与工具共用同一个路径。
 * - 澄清问题有稳定身份；回答按轮次保留，重新分析必须携带问题原文与已有结论。
 */

/** 分析提示词的版本号；提示词语义变化时必须递增并同步测试。 */
export const ANALYSIS_PROMPT_VERSION = 'analysis-v4'

/** 自动重试上限：首次失败后最多再自动尝试 3 次。 */
export const MAX_AUTO_ANALYSIS_RETRIES = 3

/** 行业与业务背景的项目文档路径（相对项目根目录）。 */
export const BUSINESS_CONTEXT_DOC = 'docs/forgeloop/business-context.md'

/**
 * 产品 Agent 可用的工具白名单；此外不挂载任何编码工具。
 * 联网工具走 DeepSeek Search & Fetch（`runtime/web-tools.ts`），不在本地起浏览器或抓取器。
 */
export const PRODUCT_TOOL_ALLOWLIST: readonly string[] = [
  'forgeloop_read_project_doc',
  'forgeloop_write_project_doc',
  'forgeloop_web_search',
  'forgeloop_web_fetch',
]

/** 一次分析尝试的来源：首次、自动重试或人工重试。 */
export type AnalysisMode = 'initial' | 'auto' | 'manual'

export type AnalysisOutcome = 'done' | 'failed'

/** 一次分析尝试的完整记录；失败尝试没有分析结论，但保留模型、轨迹与工具调用。 */
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
  readonly createdAt: string
}

/** 澄清问题的身份：同一需求内的分析版本与序号，重新分析时原样引用。 */
export function clarificationQuestionId(analysisVersion: number, index: number): string {
  return `Q${analysisVersion}-${index + 1}`
}

/** 一次分析提出的一个澄清问题及其当前状态。 */
export interface ClarificationQuestion {
  readonly reqId: string
  /** 首次提出该问题的分析版本。 */
  readonly analysisVersion: number
  /** 在分析 clarifications 数组中的位置，从 1 起。 */
  readonly questionIndex: number
  /** `Q<analysisVersion>-<questionIndex>`。 */
  readonly questionId: string
  readonly text: string
  readonly status: 'open' | 'resolved'
  /** 已解决时记录所有者回答支持的结论；未解决时为空。 */
  readonly resolution: string
  readonly resolvedAnalysisVersion: number | null
  readonly resolvedRequirementVersion: number | null
  readonly createdAt: string
}

/** 所有者针对某一轮分析的问题给出的回答；按分析版本追加，不覆盖历史。 */
export interface ClarificationAnswer {
  readonly reqId: string
  /** 被回答的分析版本（问题来源）。 */
  readonly analysisVersion: number
  /** 收到回答时的需求版本。 */
  readonly requirementVersion: number
  /** 回答追加后形成的新需求版本。 */
  readonly answeredVersion: number
  /** 本轮回答所针对的开放问题编号；用于把回答关联回原问题。 */
  readonly questionIds: readonly string[]
  readonly answer: string
  readonly source: string
  readonly answeredAt: string
}

/** 模型对上一轮未解决问题作出的逐项处置；程序据此保留未解决项，不依赖模型静默携带。 */
export interface ClarificationUpdate {
  readonly questionId: string
  readonly status: 'resolved' | 'open'
  readonly resolution: string
  readonly reason: string
}
