/**
 * 失败轮次与追加授权（迁移自旧 `domain/counting.py`）：
 * - 正式转测后，测试或验收失败计一个失败轮次；转测前失败不计。
 * - 同一轮重复反馈不重复加数（round_id 幂等）。
 * - 失败轮次默认不限：逐轮记录，但默认不因次数停止自动推进。
 * - 显式配置每次授权的轮次上限（> 0）时，额度用尽才等待追加授权。
 */

import { GrantExhaustedError, RuleViolationError } from './errors.js'
import { unlimitedLimit } from './limits.js'

/** 显式配置每次授权轮次上限时的默认值。 */
export const MAX_ROUNDS_PER_GRANT = 3

export const FAILURE_FORMAL_TEST = 'formal_test'
export const FAILURE_PLANNING = 'planning'
/** 实现后独立审查判定 block：同样消耗失败轮次，不能无限返工。 */
export const FAILURE_IMPLEMENTATION_REVIEW = 'implementation_review'
/** 执行回合超时/被停止：同样消耗一轮额度，避免自动重试无限循环。 */
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
    if (!Number.isInteger(roundsPerGrant) || roundsPerGrant < 0) {
      throw new RuleViolationError('每次授权的失败轮次上限必须是非负整数（0 表示不限）')
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

  /** 额度用尽：自动推进停止，等待追加授权或停止决定；不限时永不触发。 */
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

  /** 明确追加一次授权：额度按每份配置增加，累计失败与历史保留，不清零。 */
  appendGrant(): void {
    this.grants += 1
  }
}
