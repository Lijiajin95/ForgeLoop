import { describe, expect, it } from 'vitest'
import { buildTaskFailureAdvice } from '../src/domain/failure-advice.js'

/**
 * 失败建议：把已经记录的任务失败原因与证据整理成“发生了什么、下一步做什么”。
 * 只做确定性归因，不调用模型；没有依据时如实说明，不编造修复方案。
 */

describe('task failure advice', () => {
  it('turns a missing architecture-contract registration into a concrete scope fix', () => {
    const advice = buildTaskFailureAdvice({
      state: 'failed',
      reason: '正式测试失败（退出码 1），日志 evidence/formal-test.log',
      files: ['packages/forgeloop/src/domain/requirement-queue.ts'],
      remainingRounds: 2,
      testLogTail:
        ' ❯ tests/architecture-contract.test.ts (6 tests | 1 failed)\n' +
        '   × accepts the current TypeScript plugin without retired product paths\n' +
        '     → [contracts] FAIL 活动源码未登记在契约 modules：packages/forgeloop/src/domain/requirement-queue.ts\n',
    })

    expect(advice).not.toBeNull()
    expect(advice!.cause).toContain('requirement-queue.ts')
    expect(advice!.scope).toContain('packages/forgeloop/src/domain/requirement-queue.ts')
    const actions = advice!.actions.join('\n')
    expect(actions).toContain('contracts/architecture.json')
    expect(actions).toContain('重新规划')
    expect(actions).toContain('重试')
  })

  it('explains an out-of-scope change without suggesting a retry can bypass the boundary', () => {
    const advice = buildTaskFailureAdvice({
      state: 'blocked',
      reason: '任务 queue-core 的改动越出批准文件清单：docs/extra.md；需人工决定',
      files: ['packages/forgeloop/src/domain/requirement-queue.ts'],
      remainingRounds: 2,
    })

    expect(advice).not.toBeNull()
    expect(advice!.scope).toEqual(['docs/extra.md'])
    const actions = advice!.actions.join('\n')
    expect(actions).toContain('重新规划')
    expect(actions).toContain('文件边界')
    expect(actions).not.toContain('直接重试即可')
  })

  it('surfaces the blocking findings of an independent review', () => {
    const advice = buildTaskFailureAdvice({
      state: 'failed',
      reason: '独立审查阻断：测试没有覆盖失败分支',
      files: ['packages/forgeloop/tests/queue.test.ts'],
      remainingRounds: 2,
      review: { verdict: 'block', blocking: ['测试没有覆盖失败分支', '错误码未断言'] },
    })

    const actions = advice!.actions.join('\n')
    expect(actions).toContain('测试没有覆盖失败分支')
    expect(actions).toContain('错误码未断言')
  })

  it('names the failing test files from the formal-test log', () => {
    const advice = buildTaskFailureAdvice({
      state: 'failed',
      reason: '正式测试失败（退出码 1）',
      files: ['packages/forgeloop/src/runtime/service.ts'],
      remainingRounds: 2,
      testLogTail:
        ' ❯ tests/queue.test.ts (3 tests | 1 failed)\n' +
        ' ❯ tests/service.test.ts (12 tests | 1 failed)\n',
    })

    const actions = advice!.actions.join('\n')
    expect(actions).toContain('tests/queue.test.ts')
    expect(actions).toContain('tests/service.test.ts')
    expect(actions).toContain('正式测试日志')
  })

  it('requires an explicit grant or re-plan when the failure budget is exhausted', () => {
    const advice = buildTaskFailureAdvice({
      state: 'awaiting_user',
      reason: '任务 queue-core 已尝试 2 次仍未通过；等待人工决定',
      files: ['packages/forgeloop/src/domain/requirement-queue.ts'],
      remainingRounds: 0,
    })

    const actions = advice!.actions.join('\n')
    expect(actions).toContain('追加授权')
    expect(actions).toContain('重试不能绕过额度')
  })

  it('does not invent advice for running or delivered tasks', () => {
    const base = {
      reason: '正式测试失败',
      files: ['docs/a.md'],
      remainingRounds: 2,
    }
    expect(buildTaskFailureAdvice({ ...base, state: 'running' })).toBeNull()
    expect(buildTaskFailureAdvice({ ...base, state: 'delivered' })).toBeNull()
    expect(buildTaskFailureAdvice({ ...base, state: 'pending' })).toBeNull()
  })

  it('states that the cause is unknown instead of guessing when no reason was recorded', () => {
    const advice = buildTaskFailureAdvice({
      state: 'failed',
      reason: '',
      files: ['docs/a.md'],
      remainingRounds: 2,
    })
    expect(advice!.cause).toContain('未记录失败原因')
    expect(advice!.actions.length).toBeGreaterThan(0)
  })

  it('collects multiple unregistered contract modules from one log', () => {
    const advice = buildTaskFailureAdvice({
      state: 'failed',
      reason: '正式测试失败（退出码 1）',
      files: ['docs/a.md'],
      remainingRounds: 1,
      testLogTail:
        '[contracts] FAIL 活动源码未登记在契约 modules：packages/forgeloop/src/domain/a.ts、packages/forgeloop/src/domain/b.ts\n',
    })
    expect(advice!.scope).toEqual([
      'packages/forgeloop/src/domain/a.ts',
      'packages/forgeloop/src/domain/b.ts',
    ])
    expect(advice!.actions[0]).toContain('a.ts')
  })

  it('recognises FAIL-prefixed test files and explains a no-change implementation', () => {
    const withFail = buildTaskFailureAdvice({
      state: 'failed',
      reason: '正式测试失败（退出码 1）',
      files: ['docs/a.md'],
      remainingRounds: 1,
      testLogTail: 'FAIL  tests/queue.test.ts > refuses empty input\n',
    })
    expect(withFail!.actions.join('\n')).toContain('tests/queue.test.ts')

    const noChanges = buildTaskFailureAdvice({
      state: 'failed',
      reason: '开发回合没有产生任何文件改动',
      files: ['packages/forgeloop/src/runtime/queue.ts'],
      remainingRounds: 1,
    })
    expect(noChanges!.cause).toContain('没有产生任何文件改动')
    expect(noChanges!.actions.join('\n')).toContain('queue.ts')
  })

  it('does not explain a formal-test failure with a stale review block', () => {
    const advice = buildTaskFailureAdvice({
      state: 'failed',
      reason: '正式测试失败（退出码 1）',
      files: ['docs/a.md'],
      remainingRounds: 1,
      review: { verdict: 'block', blocking: ['上一次尝试的旧审查结论'] },
    })
    expect(advice!.actions.join('\n')).not.toContain('上一次尝试的旧审查结论')
    expect(advice!.actions.join('\n')).toContain('正式测试日志')
  })

  it('treats a non-blocking review as a generic failure and asks for on-site verification after a stop', () => {
    const generic = buildTaskFailureAdvice({
      state: 'failed',
      reason: '模型回合异常结束',
      files: ['docs/a.md'],
      remainingRounds: 1,
      review: { verdict: 'pass', blocking: ['ignored when verdict is pass'] },
    })
    expect(generic!.actions.join('\n')).not.toContain('ignored when verdict is pass')
    expect(generic!.actions.join('\n')).toContain('定位失败原因')

    const stopped = buildTaskFailureAdvice({
      state: 'blocked',
      reason: '开发回合被停止：工作副本可能有未收口改动，需核对；不会盲目重放',
      files: ['docs/a.md'],
      remainingRounds: 1,
    })
    expect(stopped!.actions.join('\n')).toContain('核对工作副本')
    expect(stopped!.actions.join('\n')).toContain('不得盲目重放')
  })
})
