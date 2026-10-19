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
export interface RequirementPlan {
  readonly plan_version: number;
}

/**
 * 需求任务包内的一条任务；页面靠这两个身份把它与任务段串起来：
 * `task_id` 是任务包内的身份，`single_task_id` 是任务记录身份
 * （形如 `task-<需求>-v<任务包版本>-<任务>`，未派发时任务段里查不到它）。
 */
export interface RequirementTaskEntry {
  readonly task_id: string;
  readonly single_task_id: string;
  readonly state: string;
}

/** 需求的一次修订版本；页面展示最新一版作为需求原文。 */
export interface RequirementVersion {
  readonly version: number;
  readonly text: string;
}

/** 任务条目的任务包摘要：页面读目标作为任务描述。 */
export interface TaskPlanSummary {
  readonly goal: string;
}

/** 需求条目（`requirement status --json` 文档的子集）。 */
export interface RequirementEntry {
  readonly req_id: string;
  readonly project: string;
  readonly requirement_status: string;
  readonly plan: RequirementPlan | null;
  readonly versions: readonly RequirementVersion[];
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
  readonly plan: TaskPlanSummary | null;
  readonly next_action: NextStep | null;
  readonly failures: FailureSummary;
  readonly budget: BudgetSummary;
  readonly blocked_reason_text: string;
}

/** 已登记项目：页面据此标注条目归属。 */
export interface ProjectEntry {
  readonly project_id: string;
  readonly name: string;
  readonly repo_path: string;
  readonly records_root: string;
  readonly counts: ProgressCounts;
}

/** 待人工处理的问题项。 */
export interface IssueEntry {
  readonly kind: string;
  readonly project: string;
  readonly ref_id: string;
  readonly summary: string;
  readonly detail: string;
}

/** 计数：项目数与前三次段总数（项目级计数在 `ProjectEntry.counts`）。 */
interface ProgressCounts {
  readonly projects: number;
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
  readonly projects: readonly ProjectEntry[];
  readonly counts: ProgressCounts;
  readonly requirements: readonly RequirementEntry[];
  readonly tasks: readonly TaskEntry[];
  readonly issues: readonly IssueEntry[];
}
