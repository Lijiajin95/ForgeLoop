/**
 * 执行时间限额（迁移自旧 `domain/limits.py`）：
 * 默认不限；用户等待不计入，只累计真实执行段；限额 > 0 时超限停止启动新动作，
 * 新的失败授权不自动延长工时，延长必须显式决定。
 */

import { RuleViolationError } from './errors.js'

/** 0 表示不限；保留常量是为了让“不限”在配置与记录里只有一个口径。 */
export const DEFAULT_LIMIT_SECONDS = 0

/** 限额是否为“不限”。 */
export function unlimitedLimit(limitSeconds: number): boolean {
  return limitSeconds <= 0
}

/** 尝试次数是否还在允许范围内：上限 0 表示不限。 */
export function attemptAllowed(attempt: number, maxAttempts: number): boolean {
  return maxAttempts <= 0 || attempt <= maxAttempts
}

export class ExecutionBudget {
  private limit: number
  private consumed: number

  constructor(limitSeconds: number, consumedSeconds = 0) {
    if (!Number.isFinite(limitSeconds) || limitSeconds < 0) {
      throw new RuleViolationError('执行限额不能为负数（0 表示不限）')
    }
    if (!Number.isFinite(consumedSeconds) || consumedSeconds < 0) {
      throw new RuleViolationError('已消耗时间不能为负')
    }
    this.limit = limitSeconds
    this.consumed = consumedSeconds
  }

  get limitSeconds(): number {
    return this.limit
  }

  get consumedSeconds(): number {
    return this.consumed
  }

  get unlimited(): boolean {
    return unlimitedLimit(this.limit)
  }

  get remainingSeconds(): number {
    if (this.unlimited) return Number.POSITIVE_INFINITY
    return Math.max(0, this.limit - this.consumed)
  }

  /** 不限时永远不算用尽；限额 > 0 时消耗达到限额才算用尽。 */
  get exhausted(): boolean {
    return !this.unlimited && this.consumed >= this.limit
  }

  /** 超限后停止启动新动作；已开始的动作自然完成并保存结果。 */
  canStartAction(): boolean {
    return !this.exhausted
  }

  charge(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new RuleViolationError('计入的执行时长不能为负')
    }
    this.consumed += seconds
  }

  /** 显式延长限额；消耗不清零。不限额时延长没有意义，直接忽略。 */
  extend(newLimitSeconds: number): void {
    if (unlimitedLimit(newLimitSeconds)) return
    if (newLimitSeconds <= this.consumed) {
      throw new RuleViolationError('延长后的限额必须大于已经消耗的时间')
    }
    this.limit = newLimitSeconds
  }
}
