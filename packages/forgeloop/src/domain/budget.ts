export const UNLIMITED_WORK = 'unlimited' as const

export type WorkLimit = number | typeof UNLIMITED_WORK

export function workLimitOfSeconds(seconds: number): WorkLimit {
  return seconds < 0 ? UNLIMITED_WORK : seconds
}

export function workLimitSeconds(limit: WorkLimit): number {
  return limit === UNLIMITED_WORK ? -1 : limit
}

export function unlimitedWork(limit: WorkLimit): limit is typeof UNLIMITED_WORK {
  return limit === UNLIMITED_WORK
}
