import { describe, expect, it } from 'vitest'
import { retryDecision, type RetryFacts } from '../src/domain/retry-policy.js'

/**
 * 重新执行的判定：自动与手动共用。这里只测判定本身，
 * 覆盖“可以再来一次”和“必须先人工处置”两侧。
 */

const OK: RetryFacts = {
  status: 'blocked',
  blockedReason: '任务 a 失败：正式测试退出码 1',
  remainingRounds: 2,
  activeRequest: false,
  runningTasks: 0,
  awaitingInputTasks: 0,
  planApproved: true,
  delivered: 0,
  total: 2,
}

describe('retry decision', () => {
  it('allows retry for a normally failed requirement', () => {
    expect(retryDecision(OK)).toEqual({ allowed: true, reason: '' })
  })

  it('refuses terminal and non-retryable statuses', () => {
    for (const status of ['accepted', 'rejected', 'cancelled']) {
      expect(retryDecision({ ...OK, status }).allowed).toBe(false)
    }
    expect(retryDecision({ ...OK, status: 'draft' }).reason).toContain('不能重新执行')
    expect(retryDecision({ ...OK, status: 'plan_proposed' }).allowed).toBe(false)
  })

  it('requires an approved plan with at least one task', () => {
    expect(retryDecision({ ...OK, planApproved: false }).reason).toContain('尚未批准')
    expect(retryDecision({ ...OK, total: 0 }).reason).toContain('没有任务')
  })

  it('stops when everything is delivered', () => {
    expect(retryDecision({ ...OK, delivered: 2 }).reason).toContain('下一步是独立测试')
  })

  it('refuses while in-flight or running work exists', () => {
    expect(retryDecision({ ...OK, activeRequest: true }).reason).toContain('在途请求')
    expect(retryDecision({ ...OK, runningTasks: 1 }).reason).toContain('仍有任务在运行')
    expect(retryDecision({ ...OK, awaitingInputTasks: 1 }).reason).toContain('等待人工回答')
  })

  it('refuses when the failure budget is exhausted or the block needs a human', () => {
    expect(retryDecision({ ...OK, remainingRounds: 0 }).reason).toContain('额度已用尽')
    expect(
      retryDecision({ ...OK, blockedReason: '执行工时已用尽；需显式延长或拆分任务' }).reason,
    ).toContain('人工处置')
    expect(retryDecision({ ...OK, blockedReason: '失败轮次额度已用尽' }).allowed).toBe(false)
  })

  it('treats -1 remaining rounds as unlimited', () => {
    expect(retryDecision({ ...OK, remainingRounds: -1 }).allowed).toBe(true)
    expect(
      retryDecision({
        ...OK,
        blockedReason: '执行工时已用尽；需显式延长或拆分任务',
      }).allowed,
    ).toBe(false)
  })

  it('ignores ordinary failure wording that mentions neither quota nor grants', () => {
    expect(
      retryDecision({ ...OK, blockedReason: '正式测试失败（退出码 1），日志 /tmp/x.log' }).allowed,
    ).toBe(true)
  })
})

describe('retry decision reasons (mutation-kill)', () => {
  it('names each terminal status verbatim', () => {
    for (const status of ['accepted', 'rejected', 'cancelled']) {
      expect(retryDecision({ ...OK, status })).toEqual({
        allowed: false,
        reason: `需求已处于终态 ${status}`,
      })
    }
  })

  it('names each non-retryable status verbatim', () => {
    for (const status of ['draft', 'plan_proposed', 'analyzing']) {
      expect(retryDecision({ ...OK, status })).toEqual({
        allowed: false,
        reason: `需求状态 ${status} 不能重新执行`,
      })
    }
  })

  it('reports every blocking fact with the exact reason', () => {
    expect(retryDecision({ ...OK, planApproved: false })).toEqual({
      allowed: false,
      reason: '任务包尚未批准',
    })
    expect(retryDecision({ ...OK, total: 0 })).toEqual({
      allowed: false,
      reason: '任务包没有任务',
    })
    expect(retryDecision({ ...OK, delivered: 2 })).toEqual({
      allowed: false,
      reason: '任务已全部交付，下一步是独立测试',
    })
    expect(retryDecision({ ...OK, activeRequest: true })).toEqual({
      allowed: false,
      reason: '已有在途请求，等待收口',
    })
    expect(retryDecision({ ...OK, runningTasks: 1 })).toEqual({
      allowed: false,
      reason: '仍有任务在运行',
    })
    expect(retryDecision({ ...OK, awaitingInputTasks: 1 })).toEqual({
      allowed: false,
      reason: '仍有任务在等待人工回答',
    })
    expect(retryDecision({ ...OK, remainingRounds: 0 })).toEqual({
      allowed: false,
      reason: '失败轮次额度已用尽；需要追加授权',
    })
  })

  it('treats each hard block as requiring a human decision', () => {
    for (const text of ['额度已用尽', '工时已用尽', '需要追加授权', '终态']) {
      expect(retryDecision({ ...OK, blockedReason: `前置：${text}` })).toEqual({
        allowed: false,
        reason: `当前阻塞需要人工处置：前置：${text}`,
      })
    }
  })
})
