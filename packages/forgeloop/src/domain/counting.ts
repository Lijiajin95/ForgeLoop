import { GrantExhaustedError, RuleViolationError } from './errors.js'
import { unlimitedLimit } from './limits.js'

export const MAX_ROUNDS_PER_GRANT = 3

export const FAILURE_FORMAL_TEST = 'formal_test'
export const FAILURE_PLANNING = 'planning'
export const FAILURE_IMPLEMENTATION_REVIEW = 'implementation_review'
export const FAILURE_INTERRUPTED = 'interrupted'
export const FAILURE_VERIFICATION = 'verification'
export const FAILURE_BUSINESS_REVIEW = 'business_review'
export const FAILURE_USER_ACCEPTANCE = 'user_acceptance'
export type FailureStage =
  | typeof FAILURE_FORMAL_TEST
  | typeof FAILURE_PLANNING
  | typeof FAILURE_IMPLEMENTATION_REVIEW
  | typeof FAILURE_INTERRUPTED
  | typeof FAILURE_VERIFICATION
  | typeof FAILURE_BUSINESS_REVIEW
  | typeof FAILURE_USER_ACCEPTANCE

export interface FailureRound {
  readonly roundId: string
  readonly stage: FailureStage
  readonly summary: string
  readonly occurredAt: string
}

export interface RecordOutcome {
  readonly recorded: boolean
  readonly cumulativeFailures: number
}

export class GrantLedger {
  private grants: number
  private rounds: FailureRound[]
  private readonly seen: Set<string>
  private readonly perGrant: number

  constructor(
    grants = 1,
    rounds: readonly FailureRound[] = [],
    roundsPerGrant = MAX_ROUNDS_PER_GRANT,
  ) {
    if (grants < 1) throw new RuleViolationError('至少需要一次初始授权')
    if (roundsPerGrant !== -1 && (!Number.isInteger(roundsPerGrant) || roundsPerGrant <= 0)) {
      throw new RuleViolationError('每次授权的失败轮次上限必须为 -1 或正整数（-1 表示不限）')
    }
    if (!unlimitedLimit(roundsPerGrant) && rounds.length > grants * roundsPerGrant) {
      throw new RuleViolationError('已记录的失败轮次超过授权额度')
    }
    this.grants = grants
    this.rounds = [...rounds]
    this.seen = new Set(rounds.map((round) => round.roundId))
    this.perGrant = roundsPerGrant
  }

  get roundsPerGrant(): number {
    return this.perGrant
  }

  get unlimited(): boolean {
    return unlimitedLimit(this.perGrant)
  }

  get grantCount(): number {
    return this.grants
  }

  get cumulativeFailures(): number {
    return this.rounds.length
  }

  get roundList(): readonly FailureRound[] {
    return this.rounds
  }

  get consumedInCurrentGrant(): number {
    if (this.unlimited) return this.cumulativeFailures
    return this.cumulativeFailures - (this.grants - 1) * this.perGrant
  }

  get remainingInCurrentGrant(): number {
    if (this.unlimited) return Number.POSITIVE_INFINITY
    return Math.max(0, this.grants * this.perGrant - this.cumulativeFailures)
  }

  get canRecordFailure(): boolean {
    return this.remainingInCurrentGrant > 0
  }

  get awaitingGrantDecision(): boolean {
    return this.remainingInCurrentGrant === 0
  }

  recordFailure(round: FailureRound): RecordOutcome {
    if (this.seen.has(round.roundId)) {
      return { recorded: false, cumulativeFailures: this.cumulativeFailures }
    }
    if (!this.canRecordFailure) {
      throw new GrantExhaustedError(
        `本次授权的 ${this.perGrant} 个失败轮次已用尽；追加授权后才能继续记录`,
      )
    }
    this.rounds = [...this.rounds, round]
    this.seen.add(round.roundId)
    return { recorded: true, cumulativeFailures: this.cumulativeFailures }
  }

  appendGrant(): void {
    this.grants += 1
  }
}
