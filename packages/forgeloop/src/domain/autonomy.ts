/**
 * 自主率统计：只依据已落库的事实计算，不猜测“是否人工帮助过”。
 *
 * - 研发：分母是项目内全部需求；分子是已受控提交、独立测试通过且没有人工介入的需求。
 * - 运维：分母是项目内全部运维事件；分子是自动恢复/关闭且未记录人工介入的事件。
 * - 需求或事件为 0 时返回 null 比率，界面显示“无样本”，不能算成 0% 或 100%。
 */

export interface RateSample {
  readonly numerator: number
  readonly denominator: number
  /** 0..1；分母为 0 时为 null。 */
  readonly rate: number | null
}

export interface AutonomyStats {
  readonly requirements: {
    readonly total: number
    readonly humanInvolved: number
    readonly autonomousSuccess: number
    /** 已受控提交（研发完成）。 */
    readonly researchCompleted: number
    /** 当前候选存在 verified 部署（上线完成）。 */
    readonly deploymentCompleted: number
    /** 出现过 failed/verify_failed 部署。 */
    readonly deploymentFailed: number
    /** 出现过回退。 */
    readonly rolledBack: number
    /** 未达到自主交付（含部署失败、回退、人工介入）。 */
    readonly notAutonomous: number
    readonly involvementRate: RateSample
    readonly autonomousSuccessRate: RateSample
  }
  readonly ops: {
    readonly total: number
    readonly humanInvolved: number
    readonly autonomousSuccess: number
    /** 已恢复的事件。 */
    readonly recovered: number
    /** 仍未解决的事件。 */
    readonly unresolved: number
    readonly involvementRate: RateSample
    readonly autonomousSuccessRate: RateSample
  }
}

export interface RequirementAutonomyFacts {
  readonly status: string
  readonly versionCount: number
  readonly grants: number
  readonly budgetExtensions: number
  readonly stopped: boolean
  readonly cancelled: boolean
  /** 由人工入口（web-decision / 所有者）发起的请求数。 */
  readonly humanRequests: number
  readonly committed: boolean
  readonly verificationPassed: boolean
  /** 存在与最新构建制品一致的 verified 部署。 */
  readonly deployed: boolean
  /** 部署批准/核对由非 system 身份执行。 */
  readonly humanDeploymentInvolved: boolean
  /** 出现过 failed/verify_failed 部署；旧样本未提供时按 false。 */
  readonly deploymentFailed?: boolean
  /** 出现过回退；旧样本未提供时按 false。 */
  readonly rolledBack?: boolean
}

export interface OpsAutonomyFacts {
  readonly state: string
  readonly humanInvolved: boolean
}

function rateSample(numerator: number, denominator: number): RateSample {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
  }
}

/** 人工介入：追加授权、延长工时、停止/取消、人工请求、或多版本修订。 */
export function requirementHumanInvolved(facts: RequirementAutonomyFacts): boolean {
  return (
    facts.versionCount > 1 ||
    facts.grants > 1 ||
    facts.budgetExtensions > 0 ||
    facts.stopped ||
    facts.cancelled ||
    facts.humanRequests > 0 ||
    facts.humanDeploymentInvolved
  )
}

/** 自主成功：已提交、测试通过、部署核对完成，且整条链路没有人工介入。 */
export function requirementAutonomousSuccess(facts: RequirementAutonomyFacts): boolean {
  return (
    facts.committed &&
    facts.verificationPassed &&
    facts.deployed &&
    !requirementHumanInvolved(facts)
  )
}

export function opsAutonomousSuccess(facts: OpsAutonomyFacts): boolean {
  return !facts.humanInvolved && (facts.state === 'recovered' || facts.state === 'closed')
}

export function computeAutonomyStats(
  requirements: readonly RequirementAutonomyFacts[],
  opsEvents: readonly OpsAutonomyFacts[],
): AutonomyStats {
  const humanRequirements = requirements.filter(requirementHumanInvolved).length
  const successfulRequirements = requirements.filter(requirementAutonomousSuccess).length
  const humanOps = opsEvents.filter((event) => event.humanInvolved).length
  const successfulOps = opsEvents.filter(opsAutonomousSuccess).length
  return {
    requirements: {
      total: requirements.length,
      humanInvolved: humanRequirements,
      autonomousSuccess: successfulRequirements,
      researchCompleted: requirements.filter((facts) => facts.committed).length,
      deploymentCompleted: requirements.filter((facts) => facts.deployed).length,
      deploymentFailed: requirements.filter((facts) => facts.deploymentFailed === true).length,
      rolledBack: requirements.filter((facts) => facts.rolledBack === true).length,
      notAutonomous: requirements.length - successfulRequirements,
      involvementRate: rateSample(humanRequirements, requirements.length),
      autonomousSuccessRate: rateSample(successfulRequirements, requirements.length),
    },
    ops: {
      total: opsEvents.length,
      humanInvolved: humanOps,
      autonomousSuccess: successfulOps,
      recovered: opsEvents.filter((event) => event.state === 'recovered').length,
      unresolved: opsEvents.filter(
        (event) => event.state !== 'recovered' && event.state !== 'closed',
      ).length,
      involvementRate: rateSample(humanOps, opsEvents.length),
      autonomousSuccessRate: rateSample(successfulOps, opsEvents.length),
    },
  }
}

export const EMPTY_AUTONOMY_STATS = computeAutonomyStats([], [])
