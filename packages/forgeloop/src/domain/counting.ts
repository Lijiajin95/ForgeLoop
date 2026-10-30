/**
 * 失败轮次与追加授权（迁移自旧 `domain/counting.py`）：
 * - 正式转测后，测试或验收失败计一个失败轮次；转测前失败不计。
 * - 同一轮重复反馈不重复加数（round_id 幂等）。
 * - 每次授权最多三个失败轮次；追加授权 +3，累计不清零。
 * - 额度用尽后停止自动推进，等待追加授权或其他决定。
 */

import { GrantExhaustedError, RuleViolationError } from './errors.js'

export const MAX_ROUNDS_PER_GRANT = 3

export const FAILURE_FORMAL_TEST = 'formal_test'
export const FAILURE_PLANNING = 'planning'
/** 执行回合超时/被停止：同样消耗一轮额度，避免自动重试无限循环。 */
export const FAILURE_INTERRUPTED = 'interrupted'
export const FAILURE_VERIFICATION = 'verification'
export const FAILURE_BUSINESS_REVIEW = 'business_review'
export const FAILURE_USER_ACCEPTANCE = 'user_acceptance'
export type FailureStage =
  | typeof FAILURE_FORMAL_TEST
  | typeof FAILURE_PLANNING
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

  constructor(grants = 1, rounds: readonly FailureRound[] = []) {
    if (grants < 1) throw new RuleViolationError('至少需要一次初始授权')
    if (rounds.length > grants * MAX_ROUNDS_PER_GRANT) {
      throw new RuleViolationError('已记录的失败轮次超过授权额度')
    }
    this.grants = grants
    this.rounds = [...rounds]
    this.seen = new Set(rounds.map((round) => round.roundId))
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
    return this.cumulativeFailures - (this.grants - 1) * MAX_ROUNDS_PER_GRANT
  }

  get remainingInCurrentGrant(): number {
    return Math.max(0, this.grants * MAX_ROUNDS_PER_GRANT - this.cumulativeFailures)
  }

  get canRecordFailure(): boolean {
    return this.remainingInCurrentGrant > 0
  }

  /** 额度用尽：自动推进停止，等待追加授权或停止决定。 */
  get awaitingGrantDecision(): boolean {
    return this.remainingInCurrentGrant === 0
  }

  recordFailure(round: FailureRound): RecordOutcome {
    if (this.seen.has(round.roundId)) {
      return { recorded: false, cumulativeFailures: this.cumulativeFailures }
    }
    if (!this.canRecordFailure) {
      throw new GrantExhaustedError('本次授权的三个失败轮次已用尽；追加授权后才能继续记录')
    }
    this.rounds = [...this.rounds, round]
    this.seen.add(round.roundId)
    return { recorded: true, cumulativeFailures: this.cumulativeFailures }
  }

  /** 明确追加一次授权：额度 +3，累计失败与历史保留，不清零。 */
  appendGrant(): void {
    this.grants += 1
  }
}