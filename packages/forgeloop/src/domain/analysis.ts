/**
 * 产品 Agent 分析的版本与重试口径：
 * - 提示词版本写入每条分析记录，便于回答“这版结论由哪版提示词产生”。
 * - 自动重试有固定上限；手动重试是独立入口，不受自动次数限制。
 * - 业务背景单独存放在项目文档中，提示词与工具共用同一个路径。
 */

/** 分析提示词的版本号；提示词语义变化时必须递增并同步测试。 */
export const ANALYSIS_PROMPT_VERSION = 'analysis-v3'

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
