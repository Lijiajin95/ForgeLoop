import { authorizationSourceOf, type TaskPlanApproval } from './task-plan.js'

export type AuthorizationKind = 'owner-approval' | 'system-admission'

export interface RequirementAuthorization {
  readonly kind: AuthorizationKind
  readonly authorizationSource: string
  readonly requirementVersion: number
  readonly planVersion: number
}

export type AuthorizationStatus = 'authorized' | 'missing' | 'stale'

export interface RequirementAuthorizationView {
  readonly status: AuthorizationStatus
  readonly authorization: RequirementAuthorization | null
  readonly reason: string
}

export interface AuthorizationPlan {
  readonly requirementId: string
  readonly planVersion: number
  readonly requirementVersion: number
}

export interface AuthorizationAdmission {
  readonly admissionId: string
  readonly requirementVersion: number
  readonly decision: 'admit' | 'block'
  readonly reason: string
}

export interface AuthorizationFacts {
  readonly requirementVersion: number
  readonly plan: AuthorizationPlan | null
  readonly approval: TaskPlanApproval | null
  readonly admission: AuthorizationAdmission | null
}

const NONE = (status: AuthorizationStatus, reason: string): RequirementAuthorizationView => ({
  status,
  authorization: null,
  reason,
})

function ownerAuthorization(
  plan: AuthorizationPlan,
  approval: TaskPlanApproval,
  requirementVersion: number,
): RequirementAuthorizationView {
  return {
    status: 'authorized',
    authorization: {
      kind: 'owner-approval',
      authorizationSource: authorizationSourceOf(approval),
      requirementVersion,
      planVersion: plan.planVersion,
    },
    reason: '',
  }
}

function admissionAuthorization(
  admission: AuthorizationAdmission,
  plan: AuthorizationPlan | null,
): RequirementAuthorizationView {
  return {
    status: 'authorized',
    authorization: {
      kind: 'system-admission',
      authorizationSource: `system-admission:${admission.admissionId}`,
      requirementVersion: admission.requirementVersion,
      planVersion: plan?.planVersion ?? 0,
    },
    reason: '',
  }
}

/** 人工批准与系统准入是同一授权的两个来源；执行入口只认这里的判定。 */
export function resolveRequirementAuthorization(
  facts: AuthorizationFacts,
): RequirementAuthorizationView {
  const { requirementVersion, approval, admission } = facts
  const plan =
    facts.plan && facts.plan.requirementVersion === requirementVersion ? facts.plan : null
  let ownerIssue = ''
  if (approval) {
    if (!plan) {
      ownerIssue = facts.plan
        ? `任务包依据需求 v${facts.plan.requirementVersion}，当前是 v${requirementVersion}；需要重新规划`
        : '存在任务包批准，但当前没有可执行的任务包'
    } else if (approval.requirementId !== plan.requirementId) {
      ownerIssue = '批准不绑定该需求；不能驱动本任务包'
    } else if (approval.planVersion !== plan.planVersion) {
      ownerIssue = `批准绑定任务包 v${approval.planVersion}，当前任务包 v${plan.planVersion}；旧版本批准不能驱动新任务包`
    } else {
      return ownerAuthorization(plan, approval, requirementVersion)
    }
  }
  if (admission) {
    if (admission.decision !== 'admit') {
      return NONE(
        ownerIssue ? 'stale' : 'missing',
        ownerIssue || `系统准入未通过：${admission.reason}`,
      )
    }
    if (admission.requirementVersion !== requirementVersion) {
      return NONE(
        'stale',
        ownerIssue ||
          `系统准入绑定需求 v${admission.requirementVersion}，当前是 v${requirementVersion}；需要重新分析或批准`,
      )
    }
    return admissionAuthorization(admission, plan)
  }
  if (ownerIssue) return NONE('stale', ownerIssue)
  return NONE('missing', '未获得系统准入或人工批准；不能进入研发')
}
