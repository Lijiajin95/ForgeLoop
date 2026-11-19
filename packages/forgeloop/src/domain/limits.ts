import { RuleViolationError } from './errors.js'

export const DEFAULT_LIMIT_SECONDS = -1

export function unlimitedLimit(limitSeconds: number): boolean {
  return limitSeconds < 0
}

export function attemptAllowed(attempt: number, maxAttempts: number): boolean {
  return maxAttempts < 0 || attempt <= maxAttempts
}

export class ExecutionBudget {
  private limit: number
  private consumed: number

  constructor(limitSeconds: number, consumedSeconds = 0) {
    if (!Number.isFinite(limitSeconds) || (limitSeconds !== -1 && limitSeconds <= 0)) {
      throw new RuleViolationError('执行限额必须是 -1 或正数（-1 表示不限）')
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

  get exhausted(): boolean {
    return !this.unlimited && this.consumed >= this.limit
  }

  canStartAction(): boolean {
    return !this.exhausted
  }

  charge(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new RuleViolationError('计入的执行时长不能为负')
    }
    this.consumed += seconds
  }

  extend(newLimitSeconds: number): void {
    if (newLimitSeconds === -1) return
    if (
      !Number.isFinite(newLimitSeconds) ||
      newLimitSeconds <= 0 ||
      newLimitSeconds <= this.consumed
    ) {
      throw new RuleViolationError('延长后的限额必须大于已经消耗的时间且大于 0')
    }
    this.limit = newLimitSeconds
  }
}
