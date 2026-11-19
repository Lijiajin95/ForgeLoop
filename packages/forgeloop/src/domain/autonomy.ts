export interface RateSample {
  readonly numerator: number
  readonly denominator: number
  readonly rate: number | null
}

export interface AutonomyStats {
  readonly requirements: {
    readonly total: number
    readonly humanInvolved: number
    readonly autonomousSuccess: number
    readonly researchCompleted: number
    readonly deploymentCompleted: number
    readonly deploymentFailed: number
    readonly rolledBack: number
    readonly notAutonomous: number
    readonly involvementRate: RateSample
    readonly autonomousSuccessRate: RateSample
  }
  readonly ops: {
    readonly total: number
    readonly humanInvolved: number
    readonly autonomousSuccess: number
    readonly recovered: number
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
  readonly humanRequests: number
  readonly committed: boolean
  readonly verificationPassed: boolean
  readonly deployed: boolean
  readonly humanDeploymentInvolved: boolean
  /** 出现过 failed/verify_failed 部署；旧样本未提供时按 false。 */
  readonly deploymentFailed?: boolean
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
