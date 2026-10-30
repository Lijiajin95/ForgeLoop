/**
 * 重新执行的判定：任务失败后不再让需求永久停住。
 *
 * 只做确定性判断：额度、在途请求、未知请求、计划批准状态、是否还有可执行任务。
 * 自动重试与手动重试共用同一份判定，避免两条入口各自放宽条件。
 */

export interface RetryFacts {
  readonly status: string
  readonly blockedReason: string
  /** 当前授权下剩余失败轮次；0 表示必须先追加授权。 */
  readonly remainingRounds: number
  readonly unknownRequests: number
  readonly activeRequest: boolean
  readonly runningTasks: number
  readonly awaitingInputTasks: number
  readonly planApproved: boolean
  readonly delivered: number
  readonly total: number
}

export interface RetryDecision {
  readonly allowed: boolean
  readonly reason: string
}

const RETRYABLE_STATUSES = new Set(['approved', 'executing', 'blocked'])

/** 这些阻塞原因不是“再来一次”能解决的，必须先处理授权或工时。 */
const HARD_BLOCK_PATTERNS: readonly RegExp[] = [
  /额度已用尽/,
  /工时已用尽/,
  /需要追加授权/,
  /终态/,
]

export function retryDecision(facts: RetryFacts): RetryDecision {
  if (facts.status === 'accepted' || facts.status === 'rejected' || facts.status === 'cancelled') {
    return { allowed: false, reason: `需求已处于终态 ${facts.status}` }
  }
  if (!RETRYABLE_STATUSES.has(facts.status)) {
    return { allowed: false, reason: `需求状态 ${facts.status} 不能重新执行` }
  }
  if (!facts.planApproved) return { allowed: false, reason: '任务包尚未批准' }
  if (facts.total === 0) return { allowed: false, reason: '任务包没有任务' }
  if (facts.delivered >= facts.total) {
    return { allowed: false, reason: '任务已全部交付，下一步是独立验证' }
  }
  if (facts.unknownRequests > 0) {
    return { allowed: false, reason: '存在结果未知的请求；先做根因诊断再重新执行' }
  }
  if (facts.activeRequest) return { allowed: false, reason: '已有在途请求，等待收口' }
  if (facts.runningTasks > 0) return { allowed: false, reason: '仍有任务在运行' }
  if (facts.awaitingInputTasks > 0) {
    return { allowed: false, reason: '仍有任务在等待人工回答' }
  }
  if (facts.remainingRounds === 0) {
    return { allowed: false, reason: '失败轮次额度已用尽；需要追加授权' }
  }
  for (const pattern of HARD_BLOCK_PATTERNS) {
    if (pattern.test(facts.blockedReason)) {
      return { allowed: false, reason: `当前阻塞需要人工处置：${facts.blockedReason}` }
    }
  }
  return { allowed: true, reason: '' }
}
