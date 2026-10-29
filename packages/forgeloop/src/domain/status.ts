/** 需求与任务生命周期词表：状态字面量只在这里定义，不在实现里各写一份。 */

export const DRAFT = 'draft'
export const AWAITING_CLARIFICATION = 'awaiting_clarification'
export const BLOCKED = 'blocked'
export const PLAN_PROPOSED = 'plan_proposed'
export const APPROVED = 'approved'
export const EXECUTING = 'executing'
export const ACCEPTED = 'accepted'
export const REJECTED = 'rejected'
export const CANCELLED = 'cancelled'

/** 终态不回退，也不能再排队分析、规划、推进或修订。 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([ACCEPTED, REJECTED, CANCELLED])

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** 任务一次推进的结果：交付、等待人工、失败或阻塞。 */
export const TASK_RUN_RUNNING = 'running'
export const TASK_RUN_DELIVERED = 'delivered'
export const TASK_RUN_AWAITING_USER = 'awaiting_user'
export const TASK_RUN_FAILED = 'failed'
export const TASK_RUN_BLOCKED = 'blocked'

export type TaskRunState =
  | typeof TASK_RUN_RUNNING
  | typeof TASK_RUN_DELIVERED
  | typeof TASK_RUN_AWAITING_USER
  | typeof TASK_RUN_FAILED
  | typeof TASK_RUN_BLOCKED

/** 持久操作请求状态。 */
export const REQUEST_FAILED = 'failed'
/** 受理后宿主中断、无法确认是否已产生外部副作用：先核对，不重放。 */
export const REQUEST_UNKNOWN = 'unknown'

/** 请求动作。 */
export const ACTION_ANALYZE = 'analyze'
export const ACTION_PLAN = 'plan'
export const ACTION_ADVANCE = 'advance'
export const ACTION_VERIFY = 'verify'

/** 需求分析/规划/推进的下一步主体：人还是 Agent。 */
export const ACTOR_USER = 'user'
export const ACTOR_AGENT = 'agent'

export type Actor = typeof ACTOR_USER | typeof ACTOR_AGENT