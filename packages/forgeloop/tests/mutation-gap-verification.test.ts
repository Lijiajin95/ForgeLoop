import { describe, expect, it } from 'vitest'
import {
  judgeVerificationResult,
  matchesCommandOutput,
  parsePlanReview,
  parseRequirementVerificationPlan,
  parseVerificationCommands,
  parseVerificationReport,
  validatePlanCoverage,
  validateRequirementVerificationPlan,
  validateScenarioEvidence,
  validateVerificationCoverage,
  type PlanReview,
  type VerificationCommandRun,
  type VerificationPlan,
  type VerificationReport,
} from '../src/domain/verification.js'

const scenario = {
  scenario: '用户登录成功',
  acceptance_criterion: '登录后进入首页',
  method: '运行登录冒烟',
  required: true,
}

function planReview(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: 'pass',
    blocking: [],
    findings: [],
    summary: '计划可执行',
    verification_plan: [scenario],
    ...overrides,
  })
}

function report(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: 'pass',
    summary: '验证通过',
    findings: [],
    blocking: [],
    scenarios: [
      {
        scenario: '用户登录成功',
        status: 'pass',
        evidence: 'login ok',
        commands: ['smoke'],
      },
    ],
    ...overrides,
  })
}

function parsedPlan(): VerificationPlan {
  return {
    scenarios: [
      {
        scenario: '用户登录成功',
        acceptanceCriterion: '登录后进入首页',
        method: '运行登录冒烟',
        required: true,
        pointIds: [],
        acceptanceIds: [],
        checks: [{ label: 'smoke', argv: ['node', '-e', 'exit 0'], expectedOutput: 'login ok' }],
      },
    ],
  }
}

function run(overrides: Partial<VerificationCommandRun> = {}): VerificationCommandRun {
  return {
    label: 'smoke',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    output: 'prefix login ok suffix',
    ...overrides,
  }
}

const artifact = { requirementVersion: 1, candidateSha256: 'a'.repeat(64), workspace: '/tmp/ws' }
const environment = { platform: 'linux', nodeVersion: 'v24', startedAt: '2026-11-04T00:00:00.000Z' }

describe('plan review parsing', () => {
  it('parses a valid passing review and normalizes fields', () => {
    const parsed = parsePlanReview(planReview())
    expect(parsed).toEqual({
      verdict: 'pass',
      blocking: [],
      findings: [],
      summary: '计划可执行',
      verificationPlan: [
        {
          scenario: '用户登录成功',
          acceptanceCriterion: '登录后进入首页',
          method: '运行登录冒烟',
          required: true,
        },
      ],
    })
  })

  it('rejects malformed verdict, lists, summary and blocking consistency', () => {
    expect(() => parsePlanReview(planReview({ verdict: 'ok' }))).toThrow(
      '实现前评审结论必须是 pass 或 block',
    )
    expect(() => parsePlanReview(planReview({ blocking: 'x' }))).toThrow(
      'blocking 必须是字符串数组',
    )
    expect(() => parsePlanReview(planReview({ findings: [1] }))).toThrow(
      'findings 必须是非空字符串',
    )
    expect(() => parsePlanReview(planReview({ summary: '  ' }))).toThrow('summary 必须是非空字符串')
    expect(() => parsePlanReview(planReview({ verdict: 'pass', blocking: ['x'] }))).toThrow(
      '实现前评审结论为 pass 时 blocking 必须为空',
    )
    expect(() => parsePlanReview(planReview({ verdict: 'block', blocking: [] }))).toThrow(
      '实现前评审结论为 block 时必须给出至少一条阻断原因',
    )
    expect(() => parsePlanReview('not json')).toThrow('实现前评审结果不是可解析的 JSON')
    expect(() => parsePlanReview('[]')).toThrow('实现前评审结果必须是 JSON 对象')
  })

  it('validates the verification plan attached to the review', () => {
    expect(() => parsePlanReview(planReview({ verification_plan: undefined }))).toThrow(
      '实现前评审通过时必须给出验证计划',
    )
    expect(() => parsePlanReview(planReview({ verification_plan: {} }))).toThrow(
      'verification_plan 必须是数组',
    )
    expect(() => parsePlanReview(planReview({ verification_plan: [null] }))).toThrow(
      'verification_plan[0]必须是 JSON 对象',
    )
    expect(() =>
      parsePlanReview(planReview({ verification_plan: [{ ...scenario, required: 'yes' }] })),
    ).toThrow('verification_plan[0].required 必须是布尔值')
    expect(() =>
      parsePlanReview(planReview({ verification_plan: [{ ...scenario, scenario: '  ' }] })),
    ).toThrow('verification_plan[0].scenario 必须是非空字符串')
    expect(() =>
      parsePlanReview(planReview({ verification_plan: [{ ...scenario, method: '' }] })),
    ).toThrow('verification_plan[0].method 必须是非空字符串')
    expect(() => parsePlanReview(planReview({ verification_plan: [] }))).toThrow(
      '实现前评审通过时验证计划不能为空',
    )
    expect(() =>
      parsePlanReview(planReview({ verification_plan: [{ ...scenario, required: false }] })),
    ).toThrow('验证计划至少要有一种必过场景')
    expect(() => parsePlanReview(planReview({ verification_plan: [scenario, scenario] }))).toThrow(
      '验证计划的场景不能重复',
    )
    expect(
      parsePlanReview(planReview({ verdict: 'block', blocking: ['原因'], verification_plan: [] }))
        .verificationPlan,
    ).toEqual([])
  })

  it('accepts camelCase alternative fields', () => {
    expect(
      parsePlanReview(
        planReview({
          verification_plan: [
            { ...scenario, acceptance_criterion: undefined, acceptanceCriterion: 'camel' },
          ],
        }),
      ).verificationPlan[0]?.acceptanceCriterion,
    ).toBe('camel')
  })
})

describe('verification command parsing', () => {
  it('parses array and object forms with a bounded number of unique labels', () => {
    expect(parseVerificationCommands(JSON.stringify([{ label: 'a', argv: ['x'] }]))).toEqual([
      { label: 'a', argv: ['x'] },
    ])
    expect(
      parseVerificationCommands(JSON.stringify({ commands: [{ label: 'b', argv: ['y'] }] })),
    ).toEqual([{ label: 'b', argv: ['y'] }])
    expect(() => parseVerificationCommands(JSON.stringify({ commands: [] }))).toThrow(
      '验证命令清单必须给出至少一条命令',
    )
    expect(() =>
      parseVerificationCommands(
        JSON.stringify({
          commands: Array.from({ length: 16 }, (_v, i) => ({ label: `c${i}`, argv: ['x'] })),
        }),
      ),
    ).toThrow('验证命令一次最多 15 条')
    expect(() =>
      parseVerificationCommands(JSON.stringify({ commands: [{ label: '', argv: ['x'] }] })),
    ).toThrow('commands[0].label 必须是非空字符串')
    expect(() =>
      parseVerificationCommands(JSON.stringify({ commands: [{ label: 'a', argv: [] }] })),
    ).toThrow('commands[0].argv 不能为空')
    expect(() =>
      parseVerificationCommands(
        JSON.stringify({
          commands: [
            { label: 'a', argv: ['x'] },
            { label: 'a', argv: ['y'] },
          ],
        }),
      ),
    ).toThrow('验证命令的 label 不能重复')
    expect(() => parseVerificationCommands('nope')).toThrow('验证命令清单不是可解析的 JSON')
  })
})

describe('verification report parsing', () => {
  it('parses a valid report and rejects malformed fields', () => {
    expect(parseVerificationReport(report())).toEqual({
      verdict: 'pass',
      summary: '验证通过',
      findings: [],
      blocking: [],
      scenarios: [
        { scenario: '用户登录成功', status: 'pass', evidence: 'login ok', commands: ['smoke'] },
      ],
    })
    expect(() => parseVerificationReport(report({ verdict: 'x' }))).toThrow(
      '独立验证结论必须是 pass 或 block',
    )
    expect(() => parseVerificationReport(report({ verdict: 'pass', blocking: ['x'] }))).toThrow(
      '独立验证结论为 pass 时 blocking 必须为空',
    )
    expect(() => parseVerificationReport(report({ verdict: 'block', blocking: [] }))).toThrow(
      '独立验证结论为 block 时必须给出至少一条阻断原因',
    )
    expect(() => parseVerificationReport(report({ scenarios: undefined }))).toThrow(
      '独立验证报告必须给出 scenarios 数组',
    )
    expect(() =>
      parseVerificationReport(
        report({ scenarios: [{ scenario: 's', status: 'unknown', evidence: '', commands: [] }] }),
      ),
    ).toThrow('scenarios[0].status 必须是 pass、fail 或 not_verified')
    expect(() =>
      parseVerificationReport(
        report({ scenarios: [{ scenario: '', status: 'pass', evidence: '', commands: [] }] }),
      ),
    ).toThrow('scenarios[0].scenario 必须是非空字符串')
    expect(() =>
      parseVerificationReport(
        report({
          scenarios: [
            { scenario: 's', status: 'pass', evidence: '', commands: [] },
            { scenario: 's', status: 'pass', evidence: '', commands: [] },
          ],
        }),
      ),
    ).toThrow('独立验证报告的场景不能重复')
    expect(() => parseVerificationReport('[]')).toThrow('独立验证报告必须是 JSON 对象')
  })
})

describe('coverage validation', () => {
  const parsedReview: PlanReview = {
    verdict: 'pass',
    blocking: [],
    findings: [],
    summary: 's',
    verificationPlan: [
      {
        scenario: '用户登录成功',
        acceptanceCriterion: '登录后进入首页',
        method: 'm',
        required: true,
      },
    ],
  }

  it('requires verbatim scenario and criterion coverage with whitespace normalization', () => {
    expect(
      validatePlanCoverage(
        { scenarios: ['用户 登录成功'], acceptanceCriteria: ['登录后 进入首页'] },
        parsedReview,
      ),
    ).toEqual([])
    expect(
      validatePlanCoverage(
        { scenarios: ['别的场景'], acceptanceCriteria: ['别的标准'] },
        parsedReview,
      ),
    ).toEqual(['验证计划缺少业务场景：别的场景', '验证计划缺少验收标准：别的标准'])
  })

  it('rejects missing required results, non-pass status and empty evidence', () => {
    const plan = parsedReview.verificationPlan
    expect(validateVerificationCoverage(plan, { ...JSON.parse(report()), scenarios: [] })).toEqual([
      '缺少必过场景的验证结果：用户登录成功',
    ])
    expect(
      validateVerificationCoverage(plan, {
        ...JSON.parse(report()),
        scenarios: [{ scenario: '用户登录成功', status: 'fail', evidence: 'x', commands: [] }],
      }),
    ).toEqual(['必过场景未通过：用户登录成功（fail）'])
    expect(
      validateVerificationCoverage(plan, {
        ...JSON.parse(report()),
        scenarios: [{ scenario: '用户登录成功', status: 'pass', evidence: '', commands: [] }],
      }),
    ).toEqual(['必过场景缺少证据：用户登录成功'])
  })

  it('requires evidence to be a real fragment of executed command output', () => {
    expect(matchesCommandOutput('hello world', 'hello')).toBe(false)
    expect(matchesCommandOutput('hello world', 'hello  world')).toBe(true)
    expect(matchesCommandOutput('  hello   world  ', 'hello world')).toBe(true)
    expect(matchesCommandOutput('hello world', '')).toBe(false)
    const plan = parsedReview.verificationPlan
    const ok: VerificationReport = { ...JSON.parse(report()) }
    expect(validateScenarioEvidence(plan, ok, [])).toEqual([
      '场景 用户登录成功 引用了未执行的验证命令：smoke',
    ])
    expect(validateScenarioEvidence(plan, ok, [run({ exitCode: 1 })])).toEqual([
      '必过场景关联的验证命令没有成功执行：用户登录成功',
    ])
    expect(validateScenarioEvidence(plan, ok, [run({ output: 'nothing useful' })])).toEqual([
      '必过场景证据无法在验证命令输出中核对：用户登录成功',
    ])
    expect(
      validateScenarioEvidence(
        plan,
        {
          ...JSON.parse(report()),
          scenarios: [
            { scenario: '用户登录成功', status: 'pass', evidence: 'login ok', commands: [] },
          ],
        },
        [run()],
      ),
    ).toEqual(['必过场景没有关联验证命令：用户登录成功'])
    expect(validateScenarioEvidence(plan, ok, [run()])).toEqual([])
  })
})

describe('requirement verification plan', () => {
  it('parses a valid plan and rejects every malformed shape', () => {
    const valid = JSON.stringify({
      scenarios: [
        {
          scenario: '场景',
          acceptance_criterion: '标准',
          method: '方法',
          required: true,
          checks: [
            { label: 'a', argv: ['node'], expected_output: ' ok ' },
            { label: 'a-negative', argv: ['node'], expect_failure: true },
          ],
        },
      ],
    })
    expect(parseRequirementVerificationPlan(valid).scenarios[0]).toMatchObject({
      scenario: '场景',
      acceptanceCriterion: '标准',
      required: true,
      checks: [
        { label: 'a', argv: ['node'], expectedOutput: 'ok' },
        { label: 'a-negative', argv: ['node'], expectFailure: true },
      ],
    })
    expect(() => parseRequirementVerificationPlan(JSON.stringify({ scenarios: [] }))).toThrow(
      '验证方案必须给出至少一个业务场景',
    )
    expect(() =>
      parseRequirementVerificationPlan(
        JSON.stringify({ scenarios: Array.from({ length: 21 }, () => ({ scenario: 's' })) }),
      ),
    ).toThrow('验证方案的场景一次最多 20 个')
    expect(
      parseRequirementVerificationPlan(
        JSON.stringify({
          scenarios: [
            {
              scenario: '设计场景',
              acceptance_criterion: '可观察',
              method: '稍后准备命令',
              required: true,
              checks: [],
            },
          ],
        }),
      ).scenarios[0]?.checks,
    ).toEqual([])
    expect(() =>
      parseRequirementVerificationPlan(
        JSON.stringify({
          scenarios: [
            { required: true, checks: [{ label: 'a', argv: ['x'], expected_output: 1 }] },
          ],
        }),
      ),
    ).toThrow('scenarios[0].checks[0].expected_output 必须是字符串')
    expect(() =>
      parseRequirementVerificationPlan(
        JSON.stringify({
          scenarios: [
            { required: true, checks: [{ label: 'a', argv: ['x'] }] },
            { required: false, checks: [{ label: 'b', argv: ['y'] }] },
          ],
        }),
      ),
    ).toThrow()
  })

  it('validates missing business rules and exceptions', () => {
    const plan = parsedPlan()
    expect(
      validateRequirementVerificationPlan(
        {
          scenarios: ['用户登录成功'],
          acceptanceCriteria: ['登录后进入首页'],
          businessRules: ['必须登录'],
          exceptions: ['网络断开'],
        },
        plan,
      ),
    ).toEqual(['验证方案缺少业务规则：必须登录', '验证方案缺少异常与边界：网络断开'])
    expect(
      validateRequirementVerificationPlan(
        {
          scenarios: ['用户登录成功'],
          acceptanceCriteria: ['登录后进入首页'],
          businessRules: [],
          exceptions: [],
        },
        plan,
      ),
    ).toEqual([])
  })
})

describe('verification judge', () => {
  it('passes only when every check succeeded and output contains the expected fragment', () => {
    const passed = judgeVerificationResult({
      plan: parsedPlan(),
      artifact,
      checks: [run()],
      environment,
      finishedAt: '2026-11-04T00:01:00.000Z',
    })
    expect(passed).toMatchObject({
      verdict: 'passed',
      summary: '验证通过：1 个业务场景、1 条命令符合正向/错误对照预期',
      failures: [],
      artifact,
      environment,
      finishedAt: '2026-11-04T00:01:00.000Z',
    })
    expect(passed.scenarios[0]).toMatchObject({
      status: 'pass',
      acceptanceCriterion: '登录后进入首页',
      evidence: 'prefix login ok suffix',
    })
    expect(passed.scenarios[0]?.checks[0]?.label).toBe('smoke')
  })

  it('fails on missing, aborted, timed out, failed and mismatched checks', () => {
    const cases: Array<[VerificationCommandRun[], string]> = [
      [[], '缺少验证命令执行结果：smoke'],
      [[run({ aborted: true })], '验证命令被中止：smoke'],
      [[run({ timedOut: true })], '验证命令超时：smoke'],
      [[run({ exitCode: null })], '验证命令失败：smoke（退出码 null）'],
      [[run({ exitCode: 2 })], '验证命令失败：smoke（退出码 2）'],
      [[run({ output: 'other' })], '验证命令输出缺少预期片段：smoke（预期 login ok）'],
    ]
    for (const [checks, message] of cases) {
      const result = judgeVerificationResult({
        plan: parsedPlan(),
        artifact,
        checks,
        environment,
        finishedAt: '2026-11-04T00:01:00.000Z',
      })
      expect(result.verdict).toBe('failed')
      expect(result.failures[0]).toBe(message)
      expect(result.summary).toContain(message)
      expect(result.scenarios[0]?.status).toBe('fail')
    }
  })

  it('reports several failures and treats empty expected output as exit-code only', () => {
    const plan: VerificationPlan = {
      scenarios: [
        {
          scenario: 's',
          acceptanceCriterion: 'c',
          method: 'm',
          required: true,
          checks: [
            { label: 'a', argv: ['x'], expectedOutput: 'alpha' },
            { label: 'b', argv: ['y'], expectedOutput: 'needle' },
          ],
        },
      ],
    }
    const result = judgeVerificationResult({
      plan,
      artifact,
      checks: [run({ label: 'a', output: 'other' }), run({ label: 'b', output: 'other' })],
      environment,
      finishedAt: '2026-11-04T00:01:00.000Z',
    })
    expect(result.verdict).toBe('failed')
    expect(result.failures).toEqual([
      '验证命令输出缺少预期片段：a（预期 alpha）',
      '验证命令输出缺少预期片段：b（预期 needle）',
    ])
    expect(result.summary).toContain('等 2 项问题')
  })
})
