import { describe, expect, it, vi } from 'vitest'
import type { TaskPlan } from '../src/domain/task-plan.js'
import { languageViolations, outsideActiveSource, unknownPackages } from '../src/domain/language.js'
import {
  parseBusinessReview,
  validateBusinessReview,
  type BusinessReview,
} from '../src/domain/business-review.js'
import { buildTaskFailureAdvice } from '../src/domain/failure-advice.js'
import {
  FACTS_TITLE,
  INFERENCE_DISCLAIMER,
  INFERENCE_FAILED_NOTICE,
  INFERENCE_LABEL,
  INFERENCE_NOT_REQUESTED_NOTICE,
  INFERENCE_TITLE,
  explainImpactFacts,
  type ImpactExplainAgent,
} from '../src/domain/impact-explain.js'

function plan(tasks: Array<{ taskId: string; files: string[]; testCommand?: string[] }>): TaskPlan {
  return {
    planVersion: 1,
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      title: task.taskId,
      goal: 'g',
      files: task.files,
      testCommand: task.testCommand ?? ['npm', 'test'],
      acceptance: ['a'],
      dependsOn: [],
    })),
  } as unknown as TaskPlan
}

describe('language boundaries', () => {
  it('rejects Python interpreters, files and legacy venv paths', () => {
    const violations = languageViolations(
      plan([
        {
          taskId: 't1',
          files: [
            'a.py',
            'tests/x.ts',
            'src/forgeloop/x.ts',
            'frontend/src/x.ts',
            'scripts/x.sh',
            '.venv/x',
          ],
          testCommand: ['python3', '-m', 'pytest', '.venv/bin/python', 'x.py', 'forgeloop'],
        },
        { taskId: 't2', files: [], testCommand: ['node', '--test', 'src/forgeloop/x.js'] },
      ]),
    )
    expect(violations.map((v) => [v.taskId, v.field, v.value, v.reason])).toEqual([
      ['t1', 'test_command', 'python3', '正式测试命令不得使用 Python 解释器或旧 .venv'],
      ['t1', 'test_command', '.venv/bin/python', '正式测试命令不得使用 Python 解释器或旧 .venv'],
      ['t1', 'test_command', 'x.py', '正式测试命令不得使用 Python 解释器或旧 .venv'],
      ['t1', 'test_command', 'forgeloop', '正式测试命令不得调用旧 forgeloop CLI'],
      [
        't1',
        'files',
        'a.py',
        '任务不得修改已退役的 Python/旧前端/旧脚本路径；活动实现统一在 TypeScript 工程内',
      ],
      [
        't1',
        'files',
        'tests/x.ts',
        '任务不得修改已退役的 Python/旧前端/旧脚本路径；活动实现统一在 TypeScript 工程内',
      ],
      [
        't1',
        'files',
        'src/forgeloop/x.ts',
        '任务不得修改已退役的 Python/旧前端/旧脚本路径；活动实现统一在 TypeScript 工程内',
      ],
      [
        't1',
        'files',
        'frontend/src/x.ts',
        '任务不得修改已退役的 Python/旧前端/旧脚本路径；活动实现统一在 TypeScript 工程内',
      ],
      [
        't1',
        'files',
        'scripts/x.sh',
        '任务不得修改已退役的 Python/旧前端/旧脚本路径；活动实现统一在 TypeScript 工程内',
      ],
      [
        't1',
        'files',
        '.venv/x',
        '任务不得修改已退役的 Python/旧前端/旧脚本路径；活动实现统一在 TypeScript 工程内',
      ],
      [
        't1',
        'test_command',
        'python3 -m pytest .venv/bin/python x.py forgeloop',
        '正式测试命令不得指向旧 Python 源码或旧虚拟环境',
      ],
      [
        't2',
        'test_command',
        'node --test src/forgeloop/x.js',
        '正式测试命令不得指向旧 Python 源码或旧虚拟环境',
      ],
    ])
  })

  it('accepts compliant plans and checks active source roots', () => {
    const good = plan([
      {
        taskId: 't',
        files: ['packages/forgeloop/src/a.ts', 'Makefile'],
        testCommand: ['npm', 'test'],
      },
    ])
    expect(languageViolations(good)).toEqual([])
    expect(outsideActiveSource(good)).toEqual([])
    const outside = outsideActiveSource(
      plan([
        {
          taskId: 't',
          files: ['src/a.ts', 'python/x.py', 'node_modules/x', 'README.md', 'docs/a.md'],
        },
      ]),
    )
    expect(outside.map((v) => v.value)).toEqual(['src/a.ts', 'python/x.py', 'node_modules/x'])
    expect(outside[0]?.reason).toContain('文件不在当前活动工程范围')
  })

  it('flags packages that are not registered', () => {
    expect(
      unknownPackages(plan([{ taskId: 't', files: ['packages/forgeloop/a.ts'] }]), ['forgeloop']),
    ).toEqual([])
    const violations = unknownPackages(
      plan([{ taskId: 't', files: ['packages/other/a.ts', 'packages/nested/x/y.ts', 'src/a.ts'] }]),
      ['forgeloop'],
    )
    expect(violations.map((v) => [v.value, v.reason])).toEqual([
      ['packages/other/a.ts', '包 packages/other 不存在；活动插件包是 packages/forgeloop'],
      ['packages/nested/x/y.ts', '包 packages/nested 不存在；活动插件包是 packages/forgeloop'],
    ])
  })
})

describe('business review', () => {
  const valid = {
    verdict: 'pass',
    summary: '业务通过',
    findings: [],
    blocking: [],
    scenarios: [{ scenario: '登录', status: 'pass', evidence: 'login ok', commands: ['smoke'] }],
    acceptance: [
      { criterion: '进入首页', status: 'pass', evidence: 'login ok', commands: ['smoke'] },
    ],
    business_rules: [
      { rule: '必须登录', status: 'pass', evidence: 'login ok', commands: ['smoke'] },
    ],
    exceptions: [{ exception: '网络断开', status: 'not_verified', evidence: '', commands: [] }],
  }

  it('parses all four item groups and trims evidence', () => {
    const parsed = parseBusinessReview(JSON.stringify(valid))
    expect(parsed).toMatchObject({
      verdict: 'pass',
      summary: '业务通过',
      findings: [],
      blocking: [],
    })
    expect(parsed.scenarios[0]).toEqual({
      text: '登录',
      status: 'pass',
      evidence: 'login ok',
      commands: ['smoke'],
    })
    expect(parsed.acceptance[0]?.text).toBe('进入首页')
    expect(parsed.businessRules[0]?.text).toBe('必须登录')
    expect(parsed.exceptions[0]?.text).toBe('网络断开')
    expect(
      parseBusinessReview(
        JSON.stringify({ ...valid, business_rules: undefined, exceptions: undefined }),
      ),
    ).toMatchObject({ businessRules: [], exceptions: [] })
  })

  it('rejects malformed review shapes with stable messages', () => {
    expect(() => parseBusinessReview('[]')).toThrow('业务终审结果必须是 JSON 对象')
    expect(() => parseBusinessReview(JSON.stringify({ ...valid, verdict: 'ok' }))).toThrow(
      '业务终审结论必须是 pass 或 block，实际 "ok"',
    )
    expect(() =>
      parseBusinessReview(JSON.stringify({ ...valid, verdict: 'pass', blocking: ['x'] })),
    ).toThrow('业务终审结论为 pass 时 blocking 必须为空')
    expect(() =>
      parseBusinessReview(JSON.stringify({ ...valid, verdict: 'block', blocking: [] })),
    ).toThrow('业务终审结论为 block 时必须给出至少一条阻断原因')
    expect(() => parseBusinessReview(JSON.stringify({ ...valid, scenarios: undefined }))).toThrow(
      '业务终审必须给出 scenarios 数组',
    )
    expect(() => parseBusinessReview(JSON.stringify({ ...valid, acceptance: undefined }))).toThrow(
      '业务终审必须给出 acceptance 数组',
    )
    expect(() => parseBusinessReview(JSON.stringify({ ...valid, summary: ' ' }))).toThrow(
      'summary 必须是非空字符串',
    )
    expect(() => parseBusinessReview(JSON.stringify({ ...valid, findings: 'x' }))).toThrow(
      'findings 必须是字符串数组',
    )
    expect(() =>
      parseBusinessReview(
        JSON.stringify({
          ...valid,
          scenarios: [{ scenario: 'x', status: 'ok', evidence: '', commands: [] }],
        }),
      ),
    ).toThrow('scenarios[0].status 必须是 pass、fail 或 not_verified')
    expect(() =>
      parseBusinessReview(
        JSON.stringify({
          ...valid,
          scenarios: [{ scenario: '', status: 'pass', evidence: '', commands: [] }],
        }),
      ),
    ).toThrow('scenarios[0].scenario 必须是非空字符串')
    expect(() =>
      parseBusinessReview(
        JSON.stringify({
          ...valid,
          scenarios: [{ scenario: 'x', status: 'pass', evidence: '', commands: 'x' }],
        }),
      ),
    ).toThrow('scenarios[0].commands 必须是字符串数组')
    expect(() => parseBusinessReview(JSON.stringify({ ...valid, business_rules: {} }))).toThrow(
      'business_rules 必须是数组',
    )
  })

  it('validates coverage, executability and evidence', () => {
    const review: BusinessReview = parseBusinessReview(JSON.stringify(valid))
    expect(
      validateBusinessReview({
        scenarios: ['登录'],
        acceptanceCriteria: ['进入首页'],
        businessRules: ['必须登录'],
        exceptions: [],
        review,
        runs: [{ label: 'smoke', output: 'prefix login ok' }],
      }),
    ).toEqual([])
    expect(
      validateBusinessReview({
        scenarios: ['登录'],
        acceptanceCriteria: ['进入首页'],
        businessRules: ['未覆盖规则'],
        exceptions: ['未覆盖异常'],
        review,
        runs: [{ label: 'smoke', output: 'login ok' }],
      }),
    ).toEqual(['业务终审缺少业务规则：未覆盖规则', '业务终审缺少异常与边界：未覆盖异常'])
    expect(
      validateBusinessReview({
        scenarios: ['登录'],
        acceptanceCriteria: ['进入首页'],
        businessRules: [],
        exceptions: [],
        review: { ...review, verdict: 'block', blocking: ['业务阻断'] },
        runs: [],
      }),
    ).toEqual(['业务终审结论为 block：业务阻断'])
    expect(
      validateBusinessReview({
        scenarios: ['登录'],
        acceptanceCriteria: [],
        businessRules: [],
        exceptions: [],
        review: {
          ...review,
          scenarios: [{ text: '登录', status: 'fail', evidence: '', commands: [] }],
        },
        runs: [],
      }),
    ).toEqual(['业务终审业务场景未通过：登录（fail）'])
    expect(
      validateBusinessReview({
        scenarios: ['登录'],
        acceptanceCriteria: [],
        businessRules: [],
        exceptions: [],
        review: {
          ...review,
          scenarios: [{ text: '登录', status: 'pass', evidence: '', commands: [] }],
        },
        runs: [],
      }),
    ).toEqual(['业务终审业务场景没有关联测试命令：登录'])
    expect(
      validateBusinessReview({
        scenarios: ['登录'],
        acceptanceCriteria: [],
        businessRules: [],
        exceptions: [],
        review: {
          ...review,
          scenarios: [
            { text: '登录', status: 'pass', evidence: 'login ok', commands: ['nope', 'smoke'] },
          ],
        },
        runs: [{ label: 'smoke', output: 'login ok' }],
      }),
    ).toEqual(['业务终审业务场景引用了未执行的测试命令：nope'])
    expect(
      validateBusinessReview({
        scenarios: ['登录'],
        acceptanceCriteria: [],
        businessRules: [],
        exceptions: [],
        review: {
          ...review,
          scenarios: [{ text: '登录', status: 'pass', evidence: 'different', commands: ['smoke'] }],
        },
        runs: [{ label: 'smoke', output: 'login ok' }],
      }),
    ).toEqual(['业务终审业务场景证据无法在验证输出中核对：登录'])
  })
})

describe('task failure advice', () => {
  const base = {
    state: 'failed',
    reason: '',
    files: [],
    remainingRounds: 3,
  }

  it('returns null for non-failure states', () => {
    for (const state of ['delivered', 'running', 'accepted']) {
      expect(buildTaskFailureAdvice({ ...base, state })).toBeNull()
    }
  })

  it('routes contract modules, boundaries, review blocking and test files', () => {
    const modules = buildTaskFailureAdvice({
      ...base,
      reason: '架构契约检查失败',
      testLogTail: '[contracts] 未登记 modules：src/a.ts、src/b.ts, src/c.ts',
    })
    expect(modules).toMatchObject({
      cause: '架构契约未登记新增模块：src/a.ts、src/b.ts、src/c.ts。',
    })
    expect(modules?.scope).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(modules?.actions[0]).toContain('contracts/architecture.json')

    const boundaries = buildTaskFailureAdvice({
      ...base,
      reason: '改动越出批准文件清单：src/a.ts、src/b.ts；其他原因',
    })
    expect(boundaries).toMatchObject({
      cause: '任务改动越出批准文件清单：src/a.ts、src/b.ts。',
      scope: ['src/a.ts', 'src/b.ts'],
    })

    const blocking = buildTaskFailureAdvice({
      ...base,
      reason: '独立审查阻断',
      review: { verdict: 'block', blocking: ['缺少测试', '  ', '越界'] },
    })
    expect(blocking).toMatchObject({ cause: '独立审查阻断：缺少测试；越界。', scope: [] })
    expect(
      buildTaskFailureAdvice({
        ...base,
        reason: '正式测试失败',
        review: { verdict: 'block', blocking: ['旧的审查结论'] },
      })?.cause,
    ).toBe('正式测试失败。')

    const formal = buildTaskFailureAdvice({
      ...base,
      reason: '正式测试失败',
      testLogTail: 'FAIL tests/a.test.ts > x\n❯ tests/b.test.ts:12:3',
    })
    expect(formal?.cause).toBe('正式测试失败。')
    expect(formal?.actions[0]).toBe(
      '失败用例位于：tests/a.test.ts、tests/b.test.ts；查看正式测试日志定位断言，修复后重试。',
    )
    expect(buildTaskFailureAdvice({ ...base, reason: '退出码 1' })?.actions[0]).toBe(
      '查看正式测试日志，定位并修复失败用例后重试。',
    )
  })

  it('routes no-change, interrupted, other and missing reasons', () => {
    expect(
      buildTaskFailureAdvice({
        ...base,
        reason: '开发回合没有产生任何文件改动',
        files: ['src/a.ts'],
      })?.actions[0],
    ).toBe('核对允许文件清单（src/a.ts）与任务目标是否匹配。')
    expect(
      buildTaskFailureAdvice({ ...base, reason: '开发回合没有产生任何文件改动' })?.actions[0],
    ).toBe('核对允许文件清单（空）与任务目标是否匹配。')
    for (const reason of ['任务被停止', '运行超时', '流程中断']) {
      expect(buildTaskFailureAdvice({ ...base, reason })?.cause).toBe(
        '任务运行被停止、超时或中断。',
      )
    }
    expect(buildTaskFailureAdvice({ ...base, reason: '未知原因' })?.cause).toBe(
      '任务运行失败，未归类到已知失败模式。',
    )
    expect(buildTaskFailureAdvice({ ...base, reason: '  ' })?.cause).toBe(
      '任务运行未记录失败原因。',
    )
  })

  it('appends budget and human-decision advice', () => {
    const advice = buildTaskFailureAdvice({
      ...base,
      state: 'awaiting_user',
      reason: '未知',
      remainingRounds: 0,
    })
    expect(advice?.actions.at(-2)).toContain('失败轮次额度已用尽')
    expect(advice?.actions.at(-1)).toContain('自动尝试次数已用尽')
    expect(
      buildTaskFailureAdvice({ ...base, state: 'blocked', reason: '未知', remainingRounds: -1 })
        ?.actions,
    ).toHaveLength(1)
  })
})

describe('impact explain', () => {
  const facts = { kind: 'facts' as const, reqId: 'req-1', detail: { version: 2 } }

  it('does not call an agent unless explain is literally true', async () => {
    const run = vi.fn()
    for (const explain of [undefined, false, 'true' as unknown as boolean]) {
      const result = await explainImpactFacts(facts, { explain, agent: { run } })
      expect(result.explainRequested).toBe(false)
      expect(result.inference).toBeNull()
      expect(result.sections).toHaveLength(1)
      expect(result.notice).toBe(INFERENCE_NOT_REQUESTED_NOTICE)
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('reports unavailable without an agent', async () => {
    const result = await explainImpactFacts(facts, { explain: true })
    expect(result.inference).toMatchObject({
      status: 'unavailable',
      reason: '未配置可用的推断 Agent；未调用任何模型。',
      sessionId: null,
      toolCalls: [],
    })
    expect(result.notice).toContain('已请求推断但结果不可用（unavailable）')
    expect(result.notice).toContain(INFERENCE_FAILED_NOTICE)
    expect(result.facts).toBe(facts)
  })

  it('captures agent errors, unserializable facts and constraint violations', async () => {
    const agent: ImpactExplainAgent = {
      run: async () => {
        throw new Error('agent down')
      },
    }
    const errored = await explainImpactFacts(facts, { explain: true, agent })
    expect(errored.inference).toMatchObject({
      status: 'error',
      reason: '推断 Agent 调用失败：agent down；事实区不受影响。',
    })
    const cyclic: Record<string, unknown> = { kind: 'facts', reqId: 'req-2' }
    cyclic.self = cyclic
    const serialization = await explainImpactFacts(cyclic as never, {
      explain: true,
      agent: { run: async () => ({ status: 'completed', text: 'x' }) },
    })
    expect(serialization.inference?.status).toBe('error')
    expect(serialization.inference?.reason).toContain('确定性事实无法序列化')
    const toolResult = await explainImpactFacts(facts, {
      explain: true,
      agent: {
        run: async () => ({ status: 'completed', text: 'x', toolCalls: ['forgeloop_show'] }),
      },
    })
    expect(toolResult.inference).toMatchObject({
      status: 'error',
      reason: '推断 Agent 报告了 1 次工具调用，违反无工具约束；推断不可采信。',
      toolCalls: ['forgeloop_show'],
    })
    const empty = await explainImpactFacts(facts, {
      explain: true,
      agent: { run: async () => ({ status: 'completed', text: '   ' }) },
    })
    expect(empty.inference).toMatchObject({
      status: 'error',
      reason: '推断 Agent 未产出可用文本。',
    })
  })

  it('keeps facts and inference in separate sections on success', async () => {
    const calls: unknown[] = []
    const result = await explainImpactFacts(facts, {
      explain: true,
      agent: {
        run: async (request) => {
          calls.push(request)
          return { status: 'completed', text: ' 推断文本 ', sessionId: 's-1' }
        },
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ role: expect.anything(), tools: 'none' })
    expect((calls[0] as { prompt: string }).prompt).toContain('确定性事实 JSON')
    expect((calls[0] as { prompt: string }).prompt).toContain('"reqId":"req-1"')
    expect(result.inference).toMatchObject({
      status: 'completed',
      text: '推断文本',
      sessionId: 's-1',
      label: INFERENCE_LABEL,
      title: INFERENCE_TITLE,
      inference: true,
      disclaimer: INFERENCE_DISCLAIMER,
    })
    expect(result.sections.map((section) => section.kind)).toEqual(['facts', 'inference'])
    expect(result.sections[0]?.title).toBe(FACTS_TITLE)
    expect(result.notice).toContain(INFERENCE_LABEL)
    expect(result.notice).toContain(INFERENCE_DISCLAIMER)
    expect(result.explainRequested).toBe(true)
  })

  it('reports aborted/timeout statuses and punctuates reasons', async () => {
    const aborted = await explainImpactFacts(facts, {
      explain: true,
      agent: { run: async () => ({ status: 'aborted', text: '', reason: '用户取消' }) },
    })
    expect(aborted.inference?.status).toBe('aborted')
    expect(aborted.notice).toContain('（aborted）：用户取消。推断请求未产生可用结果')
    const timeout = await explainImpactFacts(facts, {
      explain: true,
      agent: { run: async () => ({ status: 'timeout', text: '', reason: '已超时。' }) },
    })
    expect(timeout.notice).toContain('（timeout）：已超时。推断请求未产生可用结果')
  })
})
