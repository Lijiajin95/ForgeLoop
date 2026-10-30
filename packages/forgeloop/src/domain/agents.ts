/**
 * Agent 身份词表：只允许四种身份，阶段与函数可以细分，但不能重新引入子角色。
 *
 * 身份只表示职责边界，不等于永久会话；同一身份可以针对不同需求、事件或执行阶段
 * 建立独立会话，但同一需求的研发过程应复用现场与上下文。
 */

export const AGENT_PRODUCT = 'product'
export const AGENT_DEV = 'dev'
export const AGENT_VERIFY = 'verify'
export const AGENT_OPS = 'ops'

export type AgentIdentity =
  | typeof AGENT_PRODUCT
  | typeof AGENT_DEV
  | typeof AGENT_VERIFY
  | typeof AGENT_OPS

export const AGENT_IDENTITIES: readonly AgentIdentity[] = [
  AGENT_PRODUCT,
  AGENT_DEV,
  AGENT_VERIFY,
  AGENT_OPS,
]

const LABELS: Readonly<Record<AgentIdentity, string>> = {
  [AGENT_PRODUCT]: '产品 Agent',
  [AGENT_DEV]: '研发 Agent',
  [AGENT_VERIFY]: '验证 Agent',
  [AGENT_OPS]: '运维 Agent',
}

export function isAgentIdentity(value: string): value is AgentIdentity {
  return (AGENT_IDENTITIES as readonly string[]).includes(value)
}

export function agentLabel(identity: AgentIdentity): string {
  return LABELS[identity]
}

/** 阶段只用于提示词与展示，不是新的 Agent 身份。 */
export const PHASE_CLARIFY = 'clarify'
export const PHASE_PLAN = 'plan'
export const PHASE_IMPLEMENT = 'implement'
export const PHASE_SELF_CHECK = 'self_check'
export const PHASE_REPAIR = 'repair'
export const PHASE_VERIFY = 'verify'
export const PHASE_BUSINESS_ACCEPTANCE = 'business_acceptance'

export type AgentPhase =
  | typeof PHASE_CLARIFY
  | typeof PHASE_PLAN
  | typeof PHASE_IMPLEMENT
  | typeof PHASE_SELF_CHECK
  | typeof PHASE_REPAIR
  | typeof PHASE_VERIFY
  | typeof PHASE_BUSINESS_ACCEPTANCE
