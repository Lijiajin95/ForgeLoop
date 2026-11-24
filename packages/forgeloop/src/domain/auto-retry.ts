import {
  FAILURE_BUSINESS_REVIEW,
  FAILURE_FORMAL_TEST,
  FAILURE_IMPLEMENTATION_REVIEW,
  FAILURE_INTERRUPTED,
  FAILURE_PLANNING,
  FAILURE_VERIFICATION,
} from './counting.js'

export const MAX_AUTO_RETRIES = 20

export const AUTO_RETRY_SOURCE = 'system:auto-retry'

const BASE_DELAY_MS = 30_000

const MAX_DELAY_MS = 30 * 60_000

const RETRYABLE_STAGES: ReadonlySet<string> = new Set<string>([
  FAILURE_FORMAL_TEST,
  FAILURE_PLANNING,
  FAILURE_IMPLEMENTATION_REVIEW,
  FAILURE_INTERRUPTED,
  FAILURE_VERIFICATION,
  FAILURE_BUSINESS_REVIEW,
])

export function autoRetrySource(attempt: number): string {
  return `${AUTO_RETRY_SOURCE}:${attempt}`
}

export function autoRetryAttempt(source: string): number | null {
  const prefix = `${AUTO_RETRY_SOURCE}:`
  if (!source.startsWith(prefix)) return null
  const attempt = Number(source.slice(prefix.length))
  return Number.isInteger(attempt) && attempt > 0 ? attempt : null
}

export function retryableFailureStage(stage: string): boolean {
  return RETRYABLE_STAGES.has(stage)
}

const HUMAN_REASON_PATTERNS: readonly RegExp[] = [
  /需求争议/,
  /requirement_dispute/,
  /澄清/,
  /承诺/,
  /冲突/,
  /部署/,
  /授权/,
  /取消/,
]

export function humanBlockedReason(reason: string): boolean {
  return HUMAN_REASON_PATTERNS.some((pattern) => pattern.test(reason))
}

export function autoRetryDelayMs(attempts: number): number {
  if (attempts <= 0) return BASE_DELAY_MS
  return Math.min(BASE_DELAY_MS * 2 ** Math.min(attempts, 6), MAX_DELAY_MS)
}
