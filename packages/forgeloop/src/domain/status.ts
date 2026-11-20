export const DRAFT = 'draft'
export const ANALYSIS_FAILED = 'analysis_failed'
export const AWAITING_CLARIFICATION = 'awaiting_clarification'
export const BLOCKED = 'blocked'
export const SPECIFIED = 'specified'
export const PLAN_PROPOSED = 'plan_proposed'
export const APPROVED = 'approved'
export const DEVELOPING = 'developing'
export const EXECUTING = 'executing'
export const VERIFYING = 'verifying'
export const AWAITING_DEV_SESSION = 'awaiting_dev_session'
export const COMMITTED = 'committed'
export const ACCEPTED = 'accepted'
export const REJECTED = 'rejected'
export const CANCELLED = 'cancelled'

export const AUTO_ADVANCE_STATUSES: ReadonlySet<string> = new Set([
  SPECIFIED,
  DEVELOPING,
  VERIFYING,
  APPROVED,
  EXECUTING,
  AWAITING_DEV_SESSION,
])

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  COMMITTED,
  ACCEPTED,
  REJECTED,
  CANCELLED,
])

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

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

export const REQUEST_FAILED = 'failed'

export const ACTION_ANALYZE = 'analyze'
export const ACTION_PLAN = 'plan'
export const ACTION_ADVANCE = 'advance'
export const ACTION_VERIFY = 'verify'

export const ACTOR_USER = 'user'
export const ACTOR_AGENT = 'agent'

export type Actor = typeof ACTOR_USER | typeof ACTOR_AGENT
