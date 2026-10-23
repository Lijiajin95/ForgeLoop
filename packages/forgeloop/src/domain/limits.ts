/**
 * 执行时间限额（迁移自旧 `domain/limits.py`）：
 * 默认两小时；用户等待不计入，只累计真实执行段；超限停止启动新动作；
 * 新的失败授权不自动延长工时，延长必须显式决定。
 */

import { RuleViolationError } from './errors.js'

export const DEFAULT_LIMIT_SECONDS = 7200

export class ExecutionBudget {
  private limit: number
  private consumed: number

  constructor(limitSeconds: number, consumedSeconds = 0) {
    if (!Number.isFinite(limitSeconds) || limitSeconds <= 0) {
      throw new RuleViolationError('执行限额必须为正数')
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

  get remainingSeconds(): number {
    return Math.max(0, this.limit - this.consumed)
  }

  get exhausted(): boolean {
    return this.consumed >= this.limit
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

  /** 超时后的显式决定：延长限额；消耗不清零。 */
  extend(newLimitSeconds: number): void {
    if (newLimitSeconds <= this.consumed) {
      throw new RuleViolationError('延长后的限额必须大于已经消耗的时间')
    }
    this.limit = newLimitSeconds
  }
}