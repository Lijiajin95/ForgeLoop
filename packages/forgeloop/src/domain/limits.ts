/**
 * 执行时间限额（迁移自旧 `domain/limits.py`）：
 * 默认不限；用户等待不计入，只累计真实执行段；正数限额超限时停止启动新动作。
 * 统一约定：`-1` 表示不限，正数恢复原有限额行为。
 */

import { RuleViolationError } from './errors.js'

/** 统一的“不限”哨兵值；配置、任务包与记录层共用。 */
export const UNLIMITED = -1

export const DEFAULT_LIMIT_SECONDS = UNLIMITED

export function isUnlimited(value: number): boolean {
  return value === UNLIMITED
}

/** 限额只接受 -1（不限）或正数；0 与负数（除 -1）都不是合法限额。 */
export function isLimitSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (value === UNLIMITED || value > 0)
}

export class ExecutionBudget {
  private limit: number
  private consumed: number

  constructor(limitSeconds: number, consumedSeconds = 0) {
    if (!isLimitSeconds(limitSeconds)) {
      throw new RuleViolationError('执行限额必须为正数或 -1（不限）')
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
    return isUnlimited(this.limit)
  }

  get remainingSeconds(): number {
    return this.unlimited ? Number.POSITIVE_INFINITY : Math.max(0, this.limit - this.consumed)
  }

  get exhausted(): boolean {
    return !this.unlimited && this.consumed >= this.limit
  }

  /** 超限后停止启动新动作；已开始的动作自然完成并保存结果。不限时永远可以开始。 */
  canStartAction(): boolean {
    return !this.exhausted
  }

  charge(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new RuleViolationError('计入的执行时长不能为负')
    }
    this.consumed += seconds
  }

  /** 超时后的显式决定：延长限额；消耗不清零。不限本身就是上限，延长不改变结果。 */
  extend(newLimitSeconds: number): void {
    if (this.unlimited) return
    if (!isLimitSeconds(newLimitSeconds)) {
      throw new RuleViolationError('延长后的限额必须为正数或 -1（不限）')
    }
    if (isUnlimited(newLimitSeconds)) {
      this.limit = UNLIMITED
      return
    }
    if (newLimitSeconds <= this.consumed) {
      throw new RuleViolationError('延长后的限额必须大于已经消耗的时间')
    }
    this.limit = newLimitSeconds
  }
}

/** 自动尝试次数是否还允许第 attempt 次（从 1 开始）；-1 表示不限。 */
export function attemptAllowed(attempt: number, maxAttempts: number): boolean {
  return isUnlimited(maxAttempts) || attempt <= maxAttempts
}
