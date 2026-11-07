import { describe, expect, it } from 'vitest'
import {
  judgeVerificationResult,
  needsExecutionPreparation,
  parsePlanReview,
  parseRequirementVerificationPlan,
  parseVerificationCheckPreparation,
  parseVerificationReport,
  validateExceptionMarkers,
  validatePlanModuleDependencies,
  validateRequirementVerificationPlan,
  validateScenarioEvidence,
  type VerificationCheckPlan,
  type VerificationPlan,
  type VerificationPlanScenario,
} from '../src/domain/verification.js'

/**
 * 验证方案的设计、执行准备与判定分支：只通过导出的解析/校验入口观察结果，
 * 覆盖畸形输入、结构化引用、模块依赖、异常标记与错误对照判定。
 */

const scenario = {
  scenario: '完成改动',
  acceptance_criterion: '改动可见',
  method: '检查文件',
  required: true,
}

function planText(scenarios: unknown[]): string {
  return JSON.stringify({ scenarios })
}

function scenarioOf(checks?: VerificationCheckPlan[]): VerificationPlanScenario {
  return {
    scenario: '完成改动',
    acceptanceCriterion: '改动可见',
    method: '检查文件',
    required: true,
    ...(checks ? { checks } : {}),
  }
}

const check = (overrides: Partial<VerificationCheckPlan> = {}): VerificationCheckPlan => ({
  label: 'check-1',
  argv: ['node', '-e', 'process.exit(0)'],
  expectedOutput: '',
  expectFailure: false,
  ...overrides,
})

const artifact = { requirementVersion: 1, candidateSha256: 'a'.repeat(64), workspace: '/tmp/ws' }
const environment = {
  platform: 'linux',
  nodeVersion: 'v24',
  startedAt: '2026-11-04T00:00:00.000Z',
}

describe('requirement verification plan design parsing', () => {
  it('rejects malformed scenario flags and check options', () => {
    expect(() =>
      parseRequirementVerificationPlan(planText([{ ...scenario, required: 'yes' }])),
    ).toThrow('scenarios[0].required 必须是布尔值')
    expect(() => parseRequirementVerificationPlan(planText([{ ...scenario, checks: {} }]))).toThrow(
      'scenarios[0].checks 必须是数组',
    )
    expect(() =>
      parseRequirementVerificationPlan(
        planText([{ ...scenario, checks: [{ label: 'a', argv: ['node'], category: 'smoke' }] }]),
      ),
    ).toThrow('category 必须是 acceptance、regression、integration 或 artifact')
    expect(() =>
      parseRequirementVerificationPlan(
        planText([
          { ...scenario, checks: [{ label: 'a', argv: ['node'], expect_failure: 'yes' }] },
        ]),
      ),
    ).toThrow('expect_failure 必须是布尔值')
  })

  it('keeps design scenarios without checks and accepts camelCase criteria', () => {
    const parsed = parseRequirementVerificationPlan(
      planText([
        {
          scenario: '完成改动',
          acceptanceCriterion: '改动可见',
          method: '检查文件',
          required: true,
        },
      ]),
    )
    expect(parsed.scenarios[0]?.acceptanceCriterion).toBe('改动可见')
    expect(parsed.scenarios[0]?.checks).toEqual([])
    // snake_case 与 camelCase 都指向同一验收标准，旧方案解析结果保持原样。
    expect(
      parseRequirementVerificationPlan(
        planText([{ ...scenario, checks: [], acceptanceCriterion: '另一标准' }]),
      ).scenarios[0]?.acceptanceCriterion,
    ).toBe('改动可见')
  })

  it('keeps more than ten checks parseable and rejects duplicate scenario names', () => {
    const many = Array.from({ length: 11 }, (_value, index) => ({
      label: `check-${index}`,
      argv: ['node', '-e', '0'],
    }))
    // 设计阶段先允许列出全部计划命令，执行准备阶段再按执行顺序合并。
    expect(
      parseRequirementVerificationPlan(planText([{ ...scenario, checks: many }])).scenarios[0]
        ?.checks,
    ).toHaveLength(11)
    expect(() =>
      parseRequirementVerificationPlan(
        planText([
          { ...scenario, checks: [] },
          { ...scenario, checks: [] },
        ]),
      ),
    ).toThrow('验证方案的场景不能重复')
  })
})

describe('verification plan coverage and structured references', () => {
  it('reports unknown point and acceptance references and missing required coverage', () => {
    const plan: VerificationPlan = {
      scenarios: [
        {
          ...scenarioOf([check()]),
          pointIds: ['P9'],
          acceptanceIds: ['A9'],
        },
        {
          scenario: '回归场景',
          acceptanceCriterion: '不回归',
          method: '运行回归',
          required: true,
        },
      ],
    }
    const issues = validateRequirementVerificationPlan(
      {
        scenarios: [],
        acceptanceCriteria: [],
        businessPoints: [{ id: 'P1' }],
        acceptanceItems: [{ id: 'A1' }],
      },
      plan,
    )
    expect(issues).toContain('验证方案引用了不存在的业务要点：P9')
    expect(issues).toContain('验证方案引用了不存在的验收项：A9')
    expect(issues).toContain('验证方案缺少必过场景覆盖业务要点：P1')
    expect(issues).toContain('验证方案缺少必过场景覆盖验收项：A1')
  })

  it('requires acceptance checks for required scenarios that have commands', () => {
    const plan: VerificationPlan = {
      scenarios: [
        scenarioOf([check({ category: 'regression' })]),
        // 设计阶段还没有命令的必过场景不要求 acceptance 检查。
        scenarioOf(),
      ],
    }
    const issues = validateRequirementVerificationPlan(
      { scenarios: ['完成改动'], acceptanceCriteria: ['改动可见'] },
      plan,
    )
    expect(issues).toContain('验证方案缺少本次验收（acceptance）检查')
  })

  it('requires exception markers to be asserted by self-contained commands', () => {
    const exceptions = ['非法输入应输出 `INVALID_INPUT`', '断网时提示 missing-network']
    const selfContained = validateExceptionMarkers(exceptions, {
      scenarios: [
        scenarioOf([
          check({
            label: 'quoted-marker',
            argv: ['node', '-e', 'mkdtempSync("forgeloop-")'],
            expectedOutput: 'INVALID_INPUT',
          }),
          check({
            label: 'output-marker',
            argv: ['node', '-e', 'mktemp -d'],
            expectedOutput: 'missing-network',
          }),
        ]),
      ],
    })
    expect(selfContained).toEqual([])

    const pending = validateExceptionMarkers(exceptions, {
      scenarios: [
        scenarioOf([
          check({ label: 'quoted-marker', expectedOutput: 'INVALID_INPUT' }),
          check({ label: 'output-marker', expectedOutput: 'missing-network' }),
        ]),
      ],
    })
    expect(pending).toEqual([
      '验证方案的异常断言命令必须自建临时输入（不要依赖候选仓库状态）：quoted-marker',
      '验证方案的异常断言命令必须自建临时输入（不要依赖候选仓库状态）：output-marker',
    ])
  })

  it('reports missing exception markers when no command asserts them', () => {
    const issues = validateExceptionMarkers(['断网时输出 missing-network'], {
      scenarios: [
        {
          scenario: '完成改动',
          acceptanceCriterion: '改动可见',
          method: '检查文件',
          required: true,
        },
      ],
    })
    expect(issues).toEqual([
      '验证方案缺少异常标记断言：断网时输出 missing-network（需要一条命令的 expected_output 包含 missing-network）',
    ])
  })

  it('checks module specifiers against builtins, relative paths and installed packages', () => {
    const plan: VerificationPlan = {
      scenarios: [
        scenarioOf([
          check({ label: 'builtin', argv: ['node', '-e', "require('fs')"] }),
          check({ label: 'builtin-node', argv: ['node', '-e', "require('node:fs')"] }),
          check({ label: 'relative', argv: ['node', '-e', "require('./local')"] }),
          check({ label: 'absolute', argv: ['node', '-e', "require('/tmp/local')"] }),
          check({ label: 'installed', argv: ['node', '-e', "require('lodash/fp')"] }),
          check({ label: 'missing', argv: ['node', '-e', "require('chalk')"] }),
          check({ label: 'scoped-installed', argv: ['node', '-e', "require('@scope/pkg/sub')"] }),
          check({ label: 'scoped-missing', argv: ['node', '-e', "require('@scope/missing/sub')"] }),
        ]),
        // 设计阶段还没有命令的场景不参与模块依赖检查。
        scenarioOf(),
      ],
    }
    expect(
      validatePlanModuleDependencies(plan, { dependencies: ['lodash', '@scope/pkg'] }),
    ).toEqual([
      '验证方案命令依赖未安装的模块：chalk（missing）',
      '验证方案命令依赖未安装的模块：@scope/missing（scoped-missing）',
    ])
  })
})

describe('verification execution preparation', () => {
  it('needs preparation only while every scenario still lacks commands', () => {
    expect(needsExecutionPreparation({ scenarios: [scenarioOf()] })).toBe(true)
    expect(needsExecutionPreparation({ scenarios: [scenarioOf([])] })).toBe(true)
    expect(needsExecutionPreparation({ scenarios: [scenarioOf([check()])] })).toBe(false)
  })

  it('merges prepared checks back into the design and keeps references', () => {
    const design: VerificationPlan = {
      scenarios: [
        {
          ...scenarioOf([check({ label: 'stale' })]),
          pointIds: ['P1'],
          acceptanceIds: ['A1'],
        },
        {
          scenario: '回归场景',
          acceptanceCriterion: '不回归',
          method: '运行回归',
          required: true,
        },
      ],
    }
    const prepared = parseVerificationCheckPreparation(
      JSON.stringify({
        scenarios: [
          { scenario: '完成改动', checks: [{ label: 'check-1', argv: ['node', '-e', '0'] }] },
          { scenario: '回归场景' },
        ],
      }),
      design,
    )
    expect(prepared.scenarios[0]).toMatchObject({
      scenario: '完成改动',
      method: '检查文件',
      required: true,
      pointIds: ['P1'],
      acceptanceIds: ['A1'],
      checks: [{ label: 'check-1', argv: ['node', '-e', '0'] }],
    })
    // 执行准备没有为第二个场景给出命令时补空数组，而不是沿用设计阶段的旧值。
    expect(prepared.scenarios[1]?.checks).toEqual([])
  })

  it('rejects preparation that is not an array, repeats scenarios or adds unknown ones', () => {
    const design: VerificationPlan = { scenarios: [scenarioOf()] }
    expect(() => parseVerificationCheckPreparation('{"scenarios":{}}', design)).toThrow(
      '验证执行准备没有可解析的 scenarios JSON',
    )
    expect(() =>
      parseVerificationCheckPreparation(
        JSON.stringify({ scenarios: [{ scenario: '完成改动' }, { scenario: '完成改动' }] }),
        design,
      ),
    ).toThrow('验证执行准备没有可解析的 scenarios JSON')
    expect(() =>
      parseVerificationCheckPreparation(
        JSON.stringify({ scenarios: [{ scenario: '不存在的场景' }] }),
        design,
      ),
    ).toThrow('验证执行准备没有可解析的 scenarios JSON')
    expect(() =>
      parseVerificationCheckPreparation(
        JSON.stringify({ scenarios: [{ scenario: '完成改动', checks: 3 }] }),
        design,
      ),
    ).toThrow('验证执行准备没有可解析的 scenarios JSON')
  })
})

describe('verification judging branches', () => {
  const negativePlan = (): VerificationPlan => ({
    scenarios: [
      scenarioOf([check({ label: 'negative', expectedOutput: '', expectFailure: true })]),
    ],
  })

  const negativeRun = (exitCode: number | null) => ({
    label: 'negative',
    argv: ['node', '-e', 'process.exit(1)'],
    expectFailure: true,
    exitCode,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    output: '',
  })

  it('requires error controls to fail with a real non-zero exit code', () => {
    const missingCode = judgeVerificationResult({
      plan: negativePlan(),
      artifact,
      checks: [negativeRun(null)],
      environment,
      finishedAt: '2026-11-04T00:01:00.000Z',
    })
    expect(missingCode.failures).toEqual(['错误对照没有真实退出码，不能证明其失败：negative'])

    const unexpectedlyGreen = judgeVerificationResult({
      plan: negativePlan(),
      artifact,
      checks: [negativeRun(0)],
      environment,
      finishedAt: '2026-11-04T00:01:00.000Z',
    })
    expect(unexpectedlyGreen.failures).toEqual(['错误对照预期失败但命令成功：negative'])

    const failedAsExpected = judgeVerificationResult({
      plan: negativePlan(),
      artifact,
      checks: [negativeRun(3)],
      environment,
      finishedAt: '2026-11-04T00:01:00.000Z',
    })
    expect(failedAsExpected).toMatchObject({ verdict: 'passed', failures: [] })
  })

  it('fails a scenario that has no executable commands', () => {
    const result = judgeVerificationResult({
      plan: { scenarios: [scenarioOf()] },
      artifact,
      checks: [],
      environment,
      finishedAt: '2026-11-04T00:01:00.000Z',
    })
    expect(result.verdict).toBe('failed')
    expect(result.failures).toEqual(['验证场景没有可执行命令：完成改动'])
    expect(result.scenarios[0]).toMatchObject({
      scenario: '完成改动',
      status: 'fail',
      evidence: '',
    })
  })

  it('ignores non-string evidence and non-passing report scenarios', () => {
    const report = parseVerificationReport(
      JSON.stringify({
        verdict: 'pass',
        summary: '完成',
        scenarios: [{ scenario: '完成改动', status: 'fail', evidence: 7, commands: [] }],
      }),
    )
    expect(report.scenarios[0]?.evidence).toBe('')
    expect(validateScenarioEvidence([], report, [])).toEqual([])
    expect(
      validateScenarioEvidence(
        [],
        {
          ...report,
          scenarios: [{ scenario: '完成改动', status: 'pass', evidence: 'checked', commands: [] }],
        },
        [],
      ),
    ).toEqual([])
  })

  it('defaults missing review lists to empty arrays', () => {
    const review = parsePlanReview(
      JSON.stringify({
        verdict: 'pass',
        summary: '计划可执行',
        verification_plan: [scenario],
      }),
    )
    expect(review.blocking).toEqual([])
    expect(review.findings).toEqual([])
  })
})
