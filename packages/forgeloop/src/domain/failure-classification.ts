export type FailureClass = 'transient' | 'fatal'

const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\btimeout\b/i,
  /timed out/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ECONNABORTED/,
  /EPIPE/,
  /EAI_AGAIN/,
  /ENETUNREACH/,
  /EHOSTUNREACH/,
  /socket hang up/i,
  /fetch failed/i,
  /connection reset/i,
  /network error/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /too many requests/i,
  /rate limit/i,
  /overloaded/i,
  /\b(?:429|500|502|503|504)\b/,
]

export function classifyFailure(reason: string): FailureClass {
  const text = reason.trim()
  if (text === '') return 'fatal'
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text)) ? 'transient' : 'fatal'
}
