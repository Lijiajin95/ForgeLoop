/** 需求与任务生命周期词表：与旧记录共用的契约状态，不在实现里各写一份字面量。 */

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

/** 可以继续接收新决定/推进的非终态。 */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  DRAFT,
  AWAITING_CLARIFICATION,
  BLOCKED,
  PLAN_PROPOSED,
  APPROVED,
  EXECUTING,
])

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** 任务一次推进的结果：交付、等待人工、失败或阻塞。 */
export const TASK_RUN_DELIVERED = 'delivered'
export const TASK_RUN_AWAITING_USER = 'awaiting_user'
export const TASK_RUN_FAILED = 'failed'
export const TASK_RUN_BLOCKED = 'blocked'

export type TaskRunState =
  | typeof TASK_RUN_DELIVERED
  | typeof TASK_RUN_AWAITING_USER
  | typeof TASK_RUN_FAILED
  | typeof TASK_RUN_BLOCKED

/** 动作生命周期：started 未收口 = 结果未知；不得盲目重放其外部副作用。 */
export const ACTION_STARTED = 'started'
export const ACTION_FINISHED = 'finished'
export const ACTION_FAILED = 'failed'
export const ACTION_INTERRUPTED = 'interrupted'
export const ACTION_UNKNOWN = 'unknown'

/** 持久操作请求状态。 */
export const REQUEST_PENDING = 'pending'
export const REQUEST_CLAIMED = 'claimed'
export const REQUEST_DONE = 'done'
export const REQUEST_FAILED = 'failed'
export const REQUEST_DISMISSED = 'dismissed'
/** 受理后宿主中断、无法确认是否已产生外部副作用：先核对，不重放。 */
export const REQUEST_UNKNOWN = 'unknown'

/** 请求动作。 */
export const ACTION_ANALYZE = 'analyze'
export const ACTION_PLAN = 'plan'
export const ACTION_ADVANCE = 'advance'

export const REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  ACTION_ANALYZE,
  ACTION_PLAN,
  ACTION_ADVANCE,
])

/** 需求分析/规划/推进的下一步主体：人还是 Agent。 */
export const ACTOR_USER = 'user'
export const ACTOR_AGENT = 'agent'

export type Actor = typeof ACTOR_USER | typeof ACTOR_AGENT