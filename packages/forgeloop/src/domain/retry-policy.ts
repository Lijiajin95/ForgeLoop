export interface RetryFacts {
  readonly status: string
  readonly blockedReason: string
  readonly remainingRounds: number
  readonly activeRequest: boolean
  readonly runningTasks: number
  readonly awaitingInputTasks: number
  readonly authorized: boolean
  readonly delivered: number
  readonly total: number
}

export interface RetryDecision {
  readonly allowed: boolean
  readonly reason: string
}

const RETRYABLE_STATUSES = new Set(['approved', 'executing', 'blocked'])

export function retryDecision(facts: RetryFacts): RetryDecision {
  if (facts.status === 'accepted' || facts.status === 'rejected' || facts.status === 'cancelled') {
    return { allowed: false, reason: `需求已处于终态 ${facts.status}` }
  }
  if (!RETRYABLE_STATUSES.has(facts.status)) {
    return { allowed: false, reason: `需求状态 ${facts.status} 不能重新执行` }
  }
  if (!facts.authorized) return { allowed: false, reason: '任务包尚未获得授权' }
  if (facts.total === 0) return { allowed: false, reason: '任务包没有任务' }
  if (facts.delivered >= facts.total) {
    return { allowed: false, reason: '任务已全部交付，下一步是独立测试' }
  }
  if (facts.activeRequest) return { allowed: false, reason: '已有在途请求，等待收口' }
  if (facts.runningTasks > 0) return { allowed: false, reason: '仍有任务在运行' }
  if (facts.awaitingInputTasks > 0) {
    return { allowed: false, reason: '仍有任务在等待人工回答' }
  }
  return { allowed: true, reason: '' }
}
