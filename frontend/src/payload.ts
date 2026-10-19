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
export type RequirementAction = "approve" | "advance" | "accept" | "stop" | "cancel";

/** 单需求动作的写端点。 */
export function requirementActionUrl(reqId: string, action: RequirementAction): string {
  return `${REQUIREMENTS_URL}/${encodeURIComponent(reqId)}/${action}`;
}

/**
 * 写请求体：`by` 必填；理由只有人工决定（批准/验收/停止/终止会话/决定/删除项目）必填。
 *
 * 这是页面所有写入口的并集——既有五类操作与面板的会话/人工决定/项目档案字段放在同一
 * 个形状里，因为它们走同一道令牌 + 同源 + 请求体上限闸门；服务端按路径逐项校验，
 * 用不到的字段不会被读取。
 */
export interface OperationBody {
  readonly by: string;
  readonly reason?: string;
  readonly project?: string;
  readonly text?: string;
  /** 提交类：客户端幂等键（方案 §4.2 的 UUID），同键同内容不重复建需求。 */
  readonly key?: string;
  /** 面板：会话标题。 */
  readonly title?: string;
  /** 面板：人工决定 approve／reject。 */
  readonly decision?: string;
  /** 面板：项目名与档案字段。 */
  readonly name?: string;
  readonly path?: string;
  readonly description?: string;
  readonly pi_command?: readonly string[];
  readonly pi_home?: string;
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
  /** 面板写入口的说明文本（例如「会话已终止」「已受理，一轮执行在进行」）。 */
  readonly detail?: string;
  readonly session_id?: string;
  readonly name?: string;
}

/** 写操作失败响应：稳定的机器标签 + 可直接展示的原因。 */
export interface OperationError {
  readonly error: string;
  readonly detail: string;
}

/* ---------------------------------------------------------------------------
 * 会话面板（`forgeloop serve`）：项目、运行时、会话与待人工决定。
 *
 * 字段与服务端 `cli/panel.py` 组装的文档一致；页面只声明真正读取的字段，
 * 不读取的部分不在这里建模（避免把没读过的东西伪装成契约）。
 * ------------------------------------------------------------------------- */

/** 面板读模型与写入口根路径。 */
export const PANEL_URL = "/api/panel";
export const PANEL_SESSIONS_URL = "/api/panel/sessions";
export const PANEL_PROJECTS_URL = "/api/panel/projects";

/** 会话身份在 URL 里始终转义，避免拼接出别的路径。 */
function encodeId(value: string): string {
  return encodeURIComponent(value);
}

export function panelSessionUrl(sessionId: string): string {
  return `${PANEL_SESSIONS_URL}/${encodeId(sessionId)}`;
}

export function panelMessageUrl(sessionId: string): string {
  return `${panelSessionUrl(sessionId)}/messages`;
}

export function panelTerminateUrl(sessionId: string): string {
  return `${panelSessionUrl(sessionId)}/terminate`;
}

export function panelDecisionUrl(sessionId: string, decisionId: string): string {
  return `${panelSessionUrl(sessionId)}/decisions/${encodeId(decisionId)}`;
}

export function panelProjectUpdateUrl(name: string): string {
  return `${PANEL_PROJECTS_URL}/${encodeId(name)}/update`;
}

export function panelProjectRemoveUrl(name: string): string {
  return `${PANEL_PROJECTS_URL}/${encodeId(name)}/remove`;
}

/** 会话状态：可对话、等待人工决定、已终止（没有单独的失败态）。 */
type PanelSessionStatus = "active" | "awaiting_human" | "terminated";

/** 一个项目在运行时维度的就绪情况。 */
interface PanelRuntime {
  readonly ready: boolean;
  readonly problems: readonly string[];
  readonly pi_command: readonly string[];
  readonly pi_home: string;
  readonly running_turns: number;
}

/** 项目档案条目：`source` 说明它由页面还是手写配置管理。 */
export interface PanelProjectEntry {
  readonly name: string;
  readonly path: string;
  readonly description: string;
  readonly source: string;
  readonly editable: boolean;
  readonly is_git_repo: boolean;
  readonly problems: readonly string[];
  readonly live_sessions: number;
  readonly runtime: PanelRuntime;
}

/** 运行时占用总览。 */
export interface PanelRuntimeSummary {
  readonly concurrency: number;
  readonly turn_timeout_seconds: number;
  readonly running_turns: number;
  readonly queued_turns: number;
  /** 工具审批策略：`off` 不审、`write` 审写文件与执行、`all` 审全部工具。 */
  readonly tool_approval: string;
  /** 常驻会话进程数（服务端多轮上下文的现场占用）。 */
  readonly live_sessions: number;
}

/** 会话摘要（列表与详情共用同一形状）。 */
export interface PanelSessionSummary {
  readonly session_id: string;
  readonly project: string;
  readonly title: string;
  readonly status: PanelSessionStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly turn_count: number;
  readonly last_error: string;
  readonly terminated_by: string;
  readonly terminate_reason: string;
  readonly message_count: number;
  readonly pending_decisions: number;
  /** PI 的自动压缩次数（上下文编辑事件）：本会话流水不受影响，只计数。 */
  readonly compaction_count: number;
  readonly running: boolean;
}

/**
 * 一条会话消息：人工、Agent 或系统（失败与状态说明）。
 *
 * `state` 为 `streaming` 时表示这一条正在增量写入（同一行会被反复更新）；
 * `context_mode` 只对人工消息有意义：`cold` = 这一轮回放了历史（新进程），
 * `warm` = 发给仍在运行的同一进程（上下文在它手里）。
 */
export interface PanelMessage {
  readonly message_id: number;
  readonly role: string;
  readonly content: string;
  readonly state: string;
  readonly created_at: string;
  readonly author: string;
  readonly context_mode: string;
}

/** 一次工具调用的事实：名字、参数与结果摘要、风险、状态与审批状态。 */
export interface PanelToolCall {
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly args_excerpt: string;
  readonly result_excerpt: string;
  readonly risk: string;
  readonly status: string;
  readonly duration_ms: number;
  readonly requires_approval: boolean;
  readonly approval_status: string;
  readonly started_at: string;
  readonly ended_at: string | null;
}

/** 一条待人工决定。 */
export interface PanelDecision {
  readonly decision_id: string;
  readonly kind: string;
  readonly question: string;
  readonly status: string;
  readonly created_at: string;
  readonly decided_by: string;
  readonly reason: string;
}

/** `GET /api/panel`：项目（含运行时就绪）、运行时占用与会话清单。 */
export interface PanelDocument {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly projects: readonly PanelProjectEntry[];
  readonly runtime: PanelRuntimeSummary;
  readonly sessions: readonly PanelSessionSummary[];
}

/** `GET /api/panel/sessions/<id>`：单会话详情。 */
export interface PanelSessionDetail {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly session: PanelSessionSummary;
  readonly messages: readonly PanelMessage[];
  readonly decisions: readonly PanelDecision[];
  readonly tool_calls: readonly PanelToolCall[];
}
