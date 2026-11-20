export const AGENT_PRODUCT = 'product'
export const AGENT_ORCHESTRATOR = 'orchestrator'
export const AGENT_DEV = 'dev'
export const AGENT_VERIFY = 'verify'
export const AGENT_OPS = 'ops'

export type AgentIdentity =
  | typeof AGENT_PRODUCT
  | typeof AGENT_ORCHESTRATOR
  | typeof AGENT_DEV
  | typeof AGENT_VERIFY
  | typeof AGENT_OPS

export const AGENT_IDENTITIES: readonly AgentIdentity[] = [
  AGENT_PRODUCT,
  AGENT_ORCHESTRATOR,
  AGENT_DEV,
  AGENT_VERIFY,
  AGENT_OPS,
]

const LABELS: Readonly<Record<AgentIdentity, string>> = {
  [AGENT_PRODUCT]: '产品 Agent',
  [AGENT_ORCHESTRATOR]: '主控 Agent',
  [AGENT_DEV]: '研发 Agent',
  [AGENT_VERIFY]: '测试 Agent',
  [AGENT_OPS]: '运维 Agent',
}

export function isAgentIdentity(value: string): value is AgentIdentity {
  return AGENT_IDENTITIES.some((identity) => identity === value)
}

export function agentLabel(identity: AgentIdentity): string {
  return LABELS[identity]
}

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
