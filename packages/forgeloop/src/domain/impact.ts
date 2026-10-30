/**
 * 需求修订影响摘要的确定性事实引擎（只读）。
 *
 * 输入权威记录快照，输出可直接展示的事实：需求全部版本、分析/任务包/批准
 * 各自依据的需求版本、当前批准绑定、交付材料与待核对请求。
 *
 * 判定口径：
 * - 已过期（stale）：条目依据的需求版本落后于当前最新需求版本。
 * - 仍待核对（pending）：分析/任务包/批准版本彼此不一致、最新阶段缺口、
 *   任务未交付、交付材料不完整，或存在结果未知的请求。
 *
 * 本模块只读：不导入记录库、不调用模型，也不提供批准、推进或验收等写操作。
 */

import { latestVersion, type Requirement, type RequirementAnalysis } from './requirement.js'
import type { TaskPlan, TaskPlanApproval } from './task-plan.js'
import type { TaskArtifact } from './work.js'

export type ImpactState = 'current' | 'stale' | 'pending' | 'stale_pending'

export interface ImpactReason {
  readonly code: string
  readonly message: string
}

/** 每条事实统一的过期/待核对判定。stale 与 pending 可以同时成立。 */
export interface ImpactCheck {
  readonly state: ImpactState
  readonly stale: boolean
  readonly pending: boolean
  readonly staleReasons: readonly ImpactReason[]
  readonly pendingReasons: readonly ImpactReason[]
  readonly reasons: readonly ImpactReason[]
}

export interface RequirementVersionFact {
  readonly version: number
  readonly createdAt: string
  readonly revisedBy: string
  readonly source: string
  readonly latest: boolean
}

export interface AnalysisImpactFact extends ImpactCheck {
  readonly analysisVersion: number
  readonly requirementVersion: number
  readonly createdAt: string
  readonly goal: string
  readonly latest: boolean
}

export interface PlanTaskImpactFact extends ImpactCheck {
  readonly taskId: string
  readonly goal: string
  readonly dependsOn: readonly string[]
  readonly delivered: boolean
  readonly material: DeliveryMaterialFact | null
}

export interface PlanImpactFact extends ImpactCheck {
  readonly planVersion: number
  readonly taskPlanId: string
  readonly requirementVersion: number
  readonly createdAt: string
  readonly latest: boolean
  readonly tasks: readonly PlanTaskImpactFact[]
}

export interface ApprovalImpactFact extends ImpactCheck {
  readonly planVersion: number
  readonly requirementId: string
  /** 批准本身只绑定任务包版本；依据的需求版本由对应任务包派生。 */
  readonly requirementVersion: number | null
  readonly approvedBy: string
  readonly approvedAt: string
  readonly source: string
  readonly current: boolean
}

export interface DeliveryMaterialFact {
  readonly candidateSha256: string
  readonly testEvidenceSha256: string
  readonly reviewSha256: string
  readonly baselineCommit: string
  readonly authorizationSource: string
  readonly acceptance: string
  readonly recordedAt: string
}

export interface DeliveryImpactFact extends ImpactCheck {
  readonly planVersion: number
  readonly taskId: string
  readonly goal: string
  readonly material: DeliveryMaterialFact
  readonly deliveredAt: string
}

/** 只依赖请求记录中与影响摘要相关的字段，避免领域层反向依赖记录库。 */
export interface ImpactRequest {
  readonly requestId: string
  readonly action: string
  readonly state: string
  readonly planVersion: number
  readonly createdAt?: string
}

export interface RequestImpactFact extends ImpactCheck {
  readonly requestId: string
  readonly action: string
  /** 持久请求自身状态（pending/claimed/done/failed/dismissed），与 ImpactCheck.state 判定分开。 */
  readonly requestState: string
  readonly planVersion: number
  readonly createdAt: string
}

export interface ImpactCoverage {
  readonly analyzed: boolean
  readonly planned: boolean
  readonly approved: boolean
  readonly fullyDelivered: boolean
}

export interface ImpactSummary {
  readonly requirementVersions: number
  readonly analyses: number
  readonly plans: number
  readonly approvals: number
  readonly deliveredTasks: number
  readonly requests: number
  /** 顶层阶段缺口数（缺少分析/任务包/批准、最新任务未交付、未知请求）。 */
  readonly gaps: number
  /** 已过期事实条目数（含任务与交付明细，因此可能重复计数同一次交付）。 */
  readonly staleItems: number
  /** 仍待核对事实条目数（含任务与交付明细，因此可能重复计数同一次交付）。 */
  readonly pendingItems: number
}

export interface ImpactInput {
  readonly requirement: Requirement
  readonly analyses?: readonly RequirementAnalysis[]
  readonly plans?: readonly TaskPlan[]
  readonly approvals?: readonly TaskPlanApproval[]
  readonly deliveries?: readonly TaskArtifact[]
  readonly requests?: readonly ImpactRequest[]
}

export interface ImpactFacts extends ImpactCheck {
  readonly kind: 'facts'
  readonly reqId: string
  readonly project: string
  readonly status: string
  readonly latestRequirementVersion: number
  readonly requirementVersions: readonly RequirementVersionFact[]
  readonly latestAnalysisVersion: number | null
  readonly latestPlanVersion: number | null
  readonly currentApprovalPlanVersion: number | null
  readonly analyses: readonly AnalysisImpactFact[]
  readonly plans: readonly PlanImpactFact[]
  readonly approvals: readonly ApprovalImpactFact[]
  readonly currentApproval: ApprovalImpactFact | null
  readonly deliveries: readonly DeliveryImpactFact[]
  readonly requests: readonly RequestImpactFact[]
  readonly coverage: ImpactCoverage
  readonly summary: ImpactSummary
}

function reason(code: string, message: string): ImpactReason {
  return { code, message }
}

function dedupeReasons(reasons: readonly ImpactReason[]): ImpactReason[] {
  const seen = new Set<string>()
  const unique: ImpactReason[] = []
  for (const item of reasons) {
    const key = `${item.code}\u0000${item.message}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  return unique
}

function makeCheck(
  staleReasons: readonly ImpactReason[],
  pendingReasons: readonly ImpactReason[],
): ImpactCheck {
  const stale = dedupeReasons(staleReasons)
  const pending = dedupeReasons(pendingReasons)
  const state: ImpactState =
    stale.length > 0 && pending.length > 0
      ? 'stale_pending'
      : stale.length > 0
        ? 'stale'
        : pending.length > 0
          ? 'pending'
          : 'current'
  return {
    state,
    stale: stale.length > 0,
    pending: pending.length > 0,
    staleReasons: stale,
    pendingReasons: pending,
    reasons: [...stale, ...pending],
  }
}

function staleBasisReason(input: {
  code: string
  label: string
  basis: number
  latest: number
}): ImpactReason {
  return reason(
    input.code,
    `${input.label}依据需求 v${input.basis}，落后于最新需求 v${input.latest}；已过期`,
  )
}

function materialOf(artifact: TaskArtifact): DeliveryMaterialFact {
  return {
    candidateSha256: artifact.candidateSha256,
    testEvidenceSha256: artifact.testEvidenceSha256,
    reviewSha256: artifact.reviewSha256,
    baselineCommit: artifact.baselineCommit,
    authorizationSource: artifact.authorizationSource,
    acceptance: artifact.acceptance,
    recordedAt: artifact.recordedAt,
  }
}

function missingMaterial(artifact: TaskArtifact): string[] {
  const missing: string[] = []
  if (!artifact.candidateSha256) missing.push('候选 diff 摘要')
  if (!artifact.testEvidenceSha256) missing.push('正式测试证据摘要')
  if (!artifact.reviewSha256) missing.push('独立审查结论摘要')
  if (!artifact.authorizationSource.trim()) missing.push('任务级授权来源')
  return missing
}

function materialPendingReasons(
  artifact: TaskArtifact,
  label: string,
): ImpactReason[] {
  const missing = missingMaterial(artifact)
  if (missing.length === 0) return []
  return [
    reason(
      'delivery_material_incomplete',
      `${label}的交付材料不完整：缺少${missing.join('、')}；需核对`,
    ),
  ]
}

function planTaskKey(planVersion: number, taskId: string): string {
  return `${planVersion}:${taskId}`
}

/**
 * 汇总一条需求的修订影响事实。纯函数，不写任何记录。
 *
 * “从未规划”仍返回完整事实结构：分析/任务包/批准/交付为空数组，
 * 并在顶层 pendingReasons 与 coverage 中标出缺口。
 */
export function buildImpactFacts(input: ImpactInput): ImpactFacts {
  const { requirement } = input
  const latest = latestVersion(requirement)
  const latestRequirementVersion = latest.version

  const analyses = [...(input.analyses ?? [])].sort(
    (left, right) => left.analysisVersion - right.analysisVersion,
  )
  const plans = [...(input.plans ?? [])].sort(
    (left, right) => left.planVersion - right.planVersion,
  )
  const approvals = [...(input.approvals ?? [])].sort(
    (left, right) => left.planVersion - right.planVersion,
  )
  const deliveries = [...(input.deliveries ?? [])].sort((left, right) => {
    if (left.planVersion !== right.planVersion) return left.planVersion - right.planVersion
    return left.taskId.localeCompare(right.taskId)
  })
  const requests = [...(input.requests ?? [])].sort((left, right) => {
    const leftAt = left.createdAt ?? ''
    const rightAt = right.createdAt ?? ''
    if (leftAt !== rightAt) return leftAt.localeCompare(rightAt)
    return left.requestId.localeCompare(right.requestId)
  })

  const latestAnalysis = analyses.at(-1)
  const latestPlan = plans.at(-1)
  const planByVersion = new Map(plans.map((plan) => [plan.planVersion, plan]))
  const deliveryByKey = new Map(
    deliveries.map((delivery) => [planTaskKey(delivery.planVersion, delivery.taskId), delivery]),
  )
  const currentPlanApproval = latestPlan
    ? approvals.find((approval) => approval.planVersion === latestPlan.planVersion)
    : undefined

  const requirementVersions: RequirementVersionFact[] = requirement.versions.map((version) => ({
    version: version.version,
    createdAt: version.createdAt,
    revisedBy: version.revisedBy,
    source: version.source,
    latest: version.version === latestRequirementVersion,
  }))

  const mismatchReason = (): ImpactReason =>
    reason(
      'analysis_plan_requirement_mismatch',
      `最新分析 v${latestAnalysis?.analysisVersion ?? '?'} 依据需求 v${latestAnalysis?.requirementVersion ?? '?'}，最新任务包 v${latestPlan?.planVersion ?? '?'} 依据需求 v${latestPlan?.requirementVersion ?? '?'}；版本不一致，需核对`,
    )

  const analysisFacts: AnalysisImpactFact[] = analyses.map((analysis, index) => {
    const isLatest = index === analyses.length - 1
    const staleReasons: ImpactReason[] = []
    const pendingReasons: ImpactReason[] = []

    if (analysis.requirementVersion < latestRequirementVersion) {
      staleReasons.push(
        staleBasisReason({
          code: 'analysis_requirement_stale',
          label: `分析 v${analysis.analysisVersion} `,
          basis: analysis.requirementVersion,
          latest: latestRequirementVersion,
        }),
      )
    } else if (analysis.requirementVersion > latestRequirementVersion) {
      pendingReasons.push(
        reason(
          'analysis_requirement_ahead',
          `分析 v${analysis.analysisVersion} 依据需求 v${analysis.requirementVersion}，超出实际最新需求 v${latestRequirementVersion}；记录不一致，需核对`,
        ),
      )
    }

    if (
      isLatest &&
      latestPlan !== undefined &&
      latestPlan.requirementVersion !== analysis.requirementVersion
    ) {
      pendingReasons.push(mismatchReason())
    }

    return {
      analysisVersion: analysis.analysisVersion,
      requirementVersion: analysis.requirementVersion,
      createdAt: analysis.createdAt,
      goal: analysis.goal,
      latest: isLatest,
      ...makeCheck(staleReasons, pendingReasons),
    }
  })

  const planFacts: PlanImpactFact[] = plans.map((plan, index) => {
    const isLatest = index === plans.length - 1
    const staleReasons: ImpactReason[] = []
    const pendingReasons: ImpactReason[] = []

    if (plan.requirementVersion < latestRequirementVersion) {
      staleReasons.push(
        staleBasisReason({
          code: 'plan_requirement_stale',
          label: `任务包 v${plan.planVersion} `,
          basis: plan.requirementVersion,
          latest: latestRequirementVersion,
        }),
      )
    } else if (plan.requirementVersion > latestRequirementVersion) {
      pendingReasons.push(
        reason(
          'plan_requirement_ahead',
          `任务包 v${plan.planVersion} 依据需求 v${plan.requirementVersion}，超出实际最新需求 v${latestRequirementVersion}；记录不一致，需核对`,
        ),
      )
    }

    if (isLatest) {
      if (latestAnalysis === undefined) {
        pendingReasons.push(
          reason(
            'analysis_missing_for_plan',
            `最新任务包 v${plan.planVersion} 尚无分析版本支撑；需补分析后核对`,
          ),
        )
      } else if (latestAnalysis.requirementVersion !== plan.requirementVersion) {
        pendingReasons.push(mismatchReason())
      }
      if (currentPlanApproval === undefined) {
        pendingReasons.push(
          reason(
            'plan_approval_missing',
            `最新任务包 v${plan.planVersion} 尚无批准绑定；需核对批准版本`,
          ),
        )
      }
    }

    const tasks: PlanTaskImpactFact[] = plan.tasks.map((task) => {
      const artifact = deliveryByKey.get(planTaskKey(plan.planVersion, task.taskId))
      const taskStaleReasons: ImpactReason[] = []
      const taskPendingReasons: ImpactReason[] = []

      if (plan.requirementVersion < latestRequirementVersion) {
        taskStaleReasons.push(
          staleBasisReason({
            code: 'task_requirement_stale',
            label: `任务 ${task.taskId}（任务包 v${plan.planVersion}）`,
            basis: plan.requirementVersion,
            latest: latestRequirementVersion,
          }),
        )
      }
      if (artifact === undefined) {
        // 历史任务包已被更新版本取代时，其未交付状态不构成本轮“仍待核对”；
        // 只有最新任务包的未交付任务需要继续核对。
        if (isLatest) {
          taskPendingReasons.push(
            reason(
              'task_not_delivered',
              `任务 ${task.taskId}（任务包 v${plan.planVersion}）尚未交付；需核对`,
            ),
          )
        }
      } else {
        taskPendingReasons.push(
          ...materialPendingReasons(
            artifact,
            `任务 ${task.taskId}（任务包 v${plan.planVersion}）`,
          ),
        )
      }

      return {
        taskId: task.taskId,
        goal: task.goal,
        dependsOn: [...task.dependsOn],
        delivered: artifact !== undefined,
        material: artifact === undefined ? null : materialOf(artifact),
        ...makeCheck(taskStaleReasons, taskPendingReasons),
      }
    })

    return {
      planVersion: plan.planVersion,
      taskPlanId: plan.taskPlanId,
      requirementVersion: plan.requirementVersion,
      createdAt: plan.createdAt,
      latest: isLatest,
      tasks,
      ...makeCheck(staleReasons, pendingReasons),
    }
  })

  const approvalFacts: ApprovalImpactFact[] = approvals.map((approval, index) => {
    const isCurrent = index === approvals.length - 1
    const plan = planByVersion.get(approval.planVersion)
    const staleReasons: ImpactReason[] = []
    const pendingReasons: ImpactReason[] = []

    if (approval.requirementId !== requirement.reqId) {
      pendingReasons.push(
        reason(
          'approval_requirement_mismatch',
          `批准绑定需求 ${approval.requirementId}，当前查询需求 ${requirement.reqId}；记录不一致，需核对`,
        ),
      )
    }
    if (plan === undefined) {
      pendingReasons.push(
        reason(
          'approval_plan_missing',
          `批准绑定任务包 v${approval.planVersion}，但未找到该版本任务包；需核对`,
        ),
      )
    } else if (plan.requirementVersion < latestRequirementVersion) {
      staleReasons.push(
        staleBasisReason({
          code: 'approval_requirement_stale',
          label: `批准（任务包 v${approval.planVersion}）`,
          basis: plan.requirementVersion,
          latest: latestRequirementVersion,
        }),
      )
    } else if (plan.requirementVersion > latestRequirementVersion) {
      pendingReasons.push(
        reason(
          'approval_requirement_ahead',
          `批准绑定的任务包 v${approval.planVersion} 依据需求 v${plan.requirementVersion}，超出实际最新需求 v${latestRequirementVersion}；记录不一致，需核对`,
        ),
      )
    }
    if (isCurrent && latestPlan !== undefined && approval.planVersion !== latestPlan.planVersion) {
      pendingReasons.push(
        reason(
          'approval_plan_version_mismatch',
          `当前批准绑定任务包 v${approval.planVersion}，最新任务包是 v${latestPlan.planVersion}；版本不一致，需核对`,
        ),
      )
    }

    return {
      planVersion: approval.planVersion,
      requirementId: approval.requirementId,
      requirementVersion: plan?.requirementVersion ?? null,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      source: approval.source,
      current: isCurrent,
      ...makeCheck(staleReasons, pendingReasons),
    }
  })

  const deliveryFacts: DeliveryImpactFact[] = deliveries.map((artifact) => {
    const plan = planByVersion.get(artifact.planVersion)
    const task = plan?.tasks.find((candidate) => candidate.taskId === artifact.taskId)
    const staleReasons: ImpactReason[] = []
    const pendingReasons: ImpactReason[] = []

    if (plan !== undefined && plan.requirementVersion < latestRequirementVersion) {
      staleReasons.push(
        staleBasisReason({
          code: 'delivery_requirement_stale',
          label: `任务 ${artifact.taskId} 的交付（任务包 v${artifact.planVersion}）`,
          basis: plan.requirementVersion,
          latest: latestRequirementVersion,
        }),
      )
    }
    if (plan === undefined) {
      pendingReasons.push(
        reason(
          'delivery_plan_missing',
          `交付记录指向任务包 v${artifact.planVersion}，但未找到该版本任务包；需核对`,
        ),
      )
    } else if (task === undefined) {
      pendingReasons.push(
        reason(
          'delivery_task_missing',
          `交付记录指向任务 ${artifact.taskId}，但任务包 v${artifact.planVersion} 中没有该任务；需核对`,
        ),
      )
    }
    pendingReasons.push(
      ...materialPendingReasons(artifact, `任务 ${artifact.taskId}（任务包 v${artifact.planVersion}）`),
    )

    return {
      planVersion: artifact.planVersion,
      taskId: artifact.taskId,
      goal: task?.goal ?? '',
      material: materialOf(artifact),
      deliveredAt: artifact.recordedAt,
      ...makeCheck(staleReasons, pendingReasons),
    }
  })

  const requestFacts: RequestImpactFact[] = requests.map((request) => {
    const pendingReasons: ImpactReason[] = []
    return {
      requestId: request.requestId,
      action: request.action,
      requestState: request.state,
      planVersion: request.planVersion,
      createdAt: request.createdAt ?? '',
      ...makeCheck([], pendingReasons),
    }
  })

  // 顶层缺口：没有分析/任务包/批准，或最新任务包尚未交付齐全。
  const gapReasons: ImpactReason[] = []
  if (analyses.length === 0) {
    gapReasons.push(reason('requirement_analysis_missing', '该需求尚无任何分析版本；需核对'))
  }
  if (plans.length === 0) {
    gapReasons.push(reason('requirement_plan_missing', '该需求尚无任何任务包版本；需核对'))
  }
  if (approvals.length === 0) {
    gapReasons.push(reason('requirement_approval_missing', '该需求尚无任何任务包批准绑定；需核对'))
  } else if (latestPlan !== undefined && currentPlanApproval === undefined) {
    gapReasons.push(
      reason(
        'latest_plan_approval_missing',
        `最新任务包 v${latestPlan.planVersion} 尚无批准绑定；需核对`,
      ),
    )
  }
  if (latestPlan !== undefined) {
    const undelivered = latestPlan.tasks.filter(
      (task) => !deliveryByKey.has(planTaskKey(latestPlan.planVersion, task.taskId)),
    )
    if (undelivered.length > 0) {
      gapReasons.push(
        reason(
          'latest_plan_tasks_undelivered',
          `最新任务包 v${latestPlan.planVersion} 仍有 ${undelivered.length} 个任务未交付：${undelivered
            .map((task) => task.taskId)
            .join('、')}；需核对`,
        ),
      )
    }
  }
  const itemFacts: ImpactCheck[] = [
    ...analysisFacts,
    ...planFacts,
    ...planFacts.flatMap((plan) => plan.tasks),
    ...approvalFacts,
    ...deliveryFacts,
    ...requestFacts,
  ]
  const overall = makeCheck(
    itemFacts.flatMap((fact) => fact.staleReasons),
    [...gapReasons, ...itemFacts.flatMap((fact) => fact.pendingReasons)],
  )

  const currentApproval = approvalFacts.at(-1) ?? null
  const fullyDelivered =
    latestPlan !== undefined &&
    latestPlan.tasks.every((task) => deliveryByKey.has(planTaskKey(latestPlan.planVersion, task.taskId)))

  return {
    kind: 'facts',
    reqId: requirement.reqId,
    project: requirement.project,
    status: requirement.status,
    latestRequirementVersion,
    requirementVersions,
    latestAnalysisVersion: latestAnalysis?.analysisVersion ?? null,
    latestPlanVersion: latestPlan?.planVersion ?? null,
    currentApprovalPlanVersion: currentApproval?.planVersion ?? null,
    analyses: analysisFacts,
    plans: planFacts,
    approvals: approvalFacts,
    currentApproval,
    deliveries: deliveryFacts,
    requests: requestFacts,
    coverage: {
      analyzed: analyses.length > 0,
      planned: plans.length > 0,
      approved: currentPlanApproval !== undefined,
      fullyDelivered,
    },
    summary: {
      requirementVersions: requirementVersions.length,
      analyses: analysisFacts.length,
      plans: planFacts.length,
      approvals: approvalFacts.length,
      deliveredTasks: deliveryFacts.length,
      requests: requestFacts.length,
      gaps: gapReasons.length,
      staleItems: itemFacts.filter((fact) => fact.stale).length,
      pendingItems: itemFacts.filter((fact) => fact.pending).length,
    },
    ...overall,
  }
}