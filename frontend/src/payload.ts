/**
 * `/api/progress` 的读模型类型与端点常量。
 *
 * 只声明页面真正读取的字段：服务端文档还有更多键（方案、证据、依赖等），
 * 页面不读就不在这里建模，避免把「没读过的东西」伪装成契约。字段名与
 * `contracts/cli-contract.json` 的 `web_progress_document` 一致。
 */

/** 只读进展接口路径（服务端路由 `cli/web.py` 的 `_route`）。 */
export const PROGRESS_URL = "/api/progress";

/** 下一步动作：动作文案与主体（`user` 表示需要人工）。 */
export interface NextStep {
  readonly action: string;
  readonly actor: string;
}

/** 需求任务包的最小信息（页面只显示版本号）。 */
interface RequirementPlan {
  readonly plan_version: number;
}

/** 需求内单个任务的推进状态（`delivered` 表示已交付）。 */
export interface RequirementTaskEntry {
  readonly state: string;
}

/** 需求条目（`requirement status --json` 文档的子集）。 */
export interface RequirementEntry {
  readonly req_id: string;
  readonly project: string;
  readonly requirement_status: string;
  readonly plan: RequirementPlan | null;
  readonly tasks: readonly RequirementTaskEntry[];
  readonly next_step: NextStep | null;
  readonly blocked_reason: string;
  readonly blocked_reason_text: string;
}

/** 失败轮次账目摘要。 */
export interface FailureSummary {
  readonly cumulative: number;
  readonly remaining_in_current_grant: number;
  readonly awaiting_grant_decision: boolean;
}

/** 执行工时刻度。 */
export interface BudgetSummary {
  readonly consumed_seconds: number;
  readonly limit_seconds: number;
}

/** 任务条目（`status --json` 文档的子集）。 */
export interface TaskEntry {
  readonly task_id: string;
  readonly project: string;
  readonly status: string;
  readonly next_action: NextStep | null;
  readonly failures: FailureSummary;
  readonly budget: BudgetSummary;
  readonly blocked_reason_text: string;
}

/** 待人工处理的问题项。 */
export interface IssueEntry {
  readonly kind: string;
  readonly ref_id: string;
  readonly summary: string;
  readonly detail: string;
}

/** 三段计数。 */
interface ProgressCounts {
  readonly requirements: number;
  readonly tasks: number;
  readonly issues: number;
}

/** 一次进展快照：信封 + 需求 / 任务 / 问题三段。 */
export interface ProgressDocument {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly records_root: string;
  readonly refresh_seconds: number;
  readonly refresh_source: string;
  readonly counts: ProgressCounts;
  readonly requirements: readonly RequirementEntry[];
  readonly tasks: readonly TaskEntry[];
  readonly issues: readonly IssueEntry[];
}

/** 只读进展接口之外的写入口：提交需求与单需求动作（服务端 `cli/serve.py`）。 */
export const REQUIREMENTS_URL = "/api/requirements";

/** 页面令牌：服务端注入 `<meta name="forgeloop-token">`，写请求放在请求头里。 */
export const TOKEN_META_NAME = "forgeloop-token";
export const TOKEN_HEADER = "X-Forgeloop-Token";

/**
 * 未经注入的令牌占位：`forgeloop web`（只读服务）不下发令牌，页面据此隐藏操作面板，
 * 而不是拿着占位串去发一个必然被拒的请求。
 */
export const TOKEN_PLACEHOLDER = "__FORGELOOP_TOKEN__";

/** 提交键在会话存储里的键名：刷新页面后仍复用同一个键，避免「刷新即重复提交」。 */
export const SUBMIT_KEY_STORAGE = "forgeloop:submit-key";

/** 单需求可做的四类人工动作（与服务端路由一致）。 */
export type RequirementAction = "approve" | "advance" | "accept" | "stop";

/** 单需求动作的写端点。 */
export function requirementActionUrl(reqId: string, action: RequirementAction): string {
  return `${REQUIREMENTS_URL}/${encodeURIComponent(reqId)}/${action}`;
}

/** 写请求体：`by` 必填；理由只有人工决定（批准/验收/停止）必填。 */
export interface OperationBody {
  readonly by: string;
  readonly reason?: string;
  readonly project?: string;
  readonly text?: string;
  /** 提交类：客户端幂等键（方案 §4.2 的 UUID），同键同内容不重复建需求。 */
  readonly key?: string;
}

/** 写操作成功响应（服务端返回的字段子集）。 */
export interface OperationResult {
  readonly ok?: boolean;
  readonly operation?: string;
  readonly req_id?: string;
  readonly task_id?: string;
  readonly output?: string;
  /** 推进请求的受理标记：202 排队，执行落在常驻心跳（方案 §4.2）。 */
  readonly queued?: boolean;
}

/** 写操作失败响应：稳定的机器标签 + 可直接展示的原因。 */
export interface OperationError {
  readonly error: string;
  readonly detail: string;
}
