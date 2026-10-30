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
  unknownRequests: 0,
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
    expect(retryDecision({ ...OK, delivered: 2 }).reason).toContain('下一步是独立验证')
  })

  it('refuses while unknown, in-flight or running work exists', () => {
    expect(retryDecision({ ...OK, unknownRequests: 1 }).reason).toContain('根因诊断')
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

  it('ignores ordinary failure wording that mentions neither quota nor grants', () => {
    expect(
      retryDecision({ ...OK, blockedReason: '正式测试失败（退出码 1），日志 /tmp/x.log' }).allowed,
    ).toBe(true)
  })
})
