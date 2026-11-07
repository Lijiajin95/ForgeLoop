import { describe, expect, it } from 'vitest'
import { classifyVerificationFailure } from '../src/domain/verification-failure.js'
import type { VerificationCheckRun } from '../src/domain/verification-failure.js'

function run(overrides: Partial<VerificationCheckRun> = {}): VerificationCheckRun {
  return {
    label: 'check-1',
    exitCode: 0,
    aborted: false,
    timedOut: false,
    output: '',
    ...overrides,
  }
}

describe('pre-business failure classification', () => {
  it('treats environment issues as environment errors before anything else', () => {
    const result = classifyVerificationFailure({
      blocking: ['缺少依赖'],
      commandRuns: [run({ exitCode: 1, output: 'AssertionError: expected 1 to be 2' })],
      environmentIssues: ['npm 不可用', ' npm 不可用 '],
    })
    expect(result).toMatchObject({
      kind: 'environment_error',
      requiresCodeChange: false,
      // 环境问题单独成类：blocking 原文会保留在记录里，但归类原因只列环境依据。
      reasons: ['npm 不可用'],
      evidence: ['npm 不可用'],
    })
    expect(result.guidance).toContain('按环境依据复验同一候选')
  })

  it('classifies aborted runs as undetermined with per-run evidence', () => {
    const result = classifyVerificationFailure({
      blocking: [],
      commandRuns: [run({ aborted: true, exitCode: null })],
    })
    expect(result).toMatchObject({
      kind: 'undetermined',
      requiresCodeChange: false,
      reasons: ['测试命令被中止：check-1'],
      evidence: ['check-1（被中止）'],
    })
    expect(result.guidance).toContain('核对现场与副作用')
  })

  it('classifies timeouts before integrity and control issues', () => {
    const result = classifyVerificationFailure({
      blocking: ['场景未通过'],
      commandRuns: [run({ timedOut: true, exitCode: null })],
      integrityIssues: ['候选被改动'],
      controlIssues: ['对照缺失'],
    })
    expect(result).toMatchObject({
      kind: 'undetermined',
      reasons: ['场景未通过', '测试命令超时：check-1'],
      evidence: ['check-1（超时）'],
    })
    expect(result.guidance).toContain('不要求研发改代码')
  })

  it('reports the no-exit-code evidence text for runs without a code', () => {
    const result = classifyVerificationFailure({
      blocking: [],
      commandRuns: [run({ timedOut: true, exitCode: null })],
    })
    expect(result.evidence).toEqual(['check-1（超时）'])
  })

  it('classifies candidate integrity issues as test errors', () => {
    const result = classifyVerificationFailure({
      blocking: ['测试未通过'],
      commandRuns: [run()],
      integrityIssues: ['验证过程修改了候选'],
    })
    expect(result).toMatchObject({
      kind: 'test_error',
      reasons: ['测试未通过', '验证过程修改了候选'],
      evidence: ['验证过程修改了候选'],
    })
    expect(result.guidance).toContain('修正测试材料后在同一候选复验')
  })

  it('classifies missing sensitivity controls as test errors', () => {
    const result = classifyVerificationFailure({
      blocking: [],
      commandRuns: [run()],
      controlIssues: ['必过用例没有对照'],
    })
    expect(result).toMatchObject({
      kind: 'test_error',
      reasons: ['必过用例没有对照'],
      evidence: ['必过用例没有对照'],
    })
    expect(result.guidance).toContain('敏感性对照')
  })

  it('classifies a CommonJS script executed as ESM as a test error', () => {
    const result = classifyVerificationFailure({
      blocking: [],
      commandRuns: [
        run({ exitCode: 1, output: 'ReferenceError: require is not defined in ES module scope' }),
      ],
    })
    expect(result).toMatchObject({
      kind: 'test_error',
      reasons: ['验证脚本自身报错：check-1'],
      evidence: ['check-1（退出码 1）'],
    })
    expect(result.guidance).toContain('把脚本改成工程一致的模块形式')
  })

  it('classifies runs without an exit code as environment errors', () => {
    const result = classifyVerificationFailure({
      blocking: [],
      commandRuns: [run({ exitCode: null, output: 'spawn ENOENT' })],
    })
    expect(result).toMatchObject({
      kind: 'environment_error',
      reasons: ['测试命令未取得退出码：check-1'],
      evidence: ['check-1: spawn ENOENT'],
    })
    expect(result.guidance).toContain('命令无法启动或执行器异常')
  })
})

describe('failed command classification', () => {
  it('treats assertion-shaped failures as implementation defects', () => {
    const result = classifyVerificationFailure({
      blocking: ['测试未通过'],
      commandRuns: [run({ exitCode: 1, output: 'AssertionError: expected 2 to be 3' })],
    })
    expect(result).toMatchObject({ kind: 'implementation_defect', requiresCodeChange: true })
    expect(result.reasons).toEqual(['测试未通过', '业务断言失败：check-1'])
    expect(result.evidence[0]).toContain('check-1（退出码 1）')
    expect(result.guidance).toContain('交回研发定向修复')
  })

  it('keeps non-assertion non-zero exits as undetermined', () => {
    const result = classifyVerificationFailure({
      blocking: [],
      commandRuns: [run({ exitCode: 2, output: 'segment fault' })],
    })
    expect(result).toMatchObject({ kind: 'undetermined', requiresCodeChange: false })
    expect(result.reasons).toEqual(['测试命令非零退出：check-1'])
    expect(result.guidance).toContain('先诊断失败来源')
  })
})

describe('post-business classification', () => {
  it('classifies missing evidence as insufficient evidence', () => {
    const result = classifyVerificationFailure({
      blocking: ['测试未通过'],
      commandRuns: [run()],
      materialIssues: ['缺少测试材料'],
      coverageIssues: ['必过场景未覆盖'],
      evidenceIssues: ['证据无法核对'],
    })
    expect(result).toMatchObject({ kind: 'insufficient_evidence' })
    expect(result.reasons).toEqual(['测试未通过', '缺少测试材料', '必过场景未覆盖', '证据无法核对'])
    expect(result.evidence).toEqual(['缺少测试材料', '必过场景未覆盖', '证据无法核对'])
  })

  it('asks for observations when scenarios failed without command evidence', () => {
    const result = classifyVerificationFailure({
      blocking: [],
      commandRuns: [run()],
      failedScenarios: ['主路径', '异常路径'],
    })
    expect(result).toMatchObject({ kind: 'insufficient_evidence' })
    expect(result.reasons).toEqual(['场景未通过：主路径', '场景未通过：异常路径'])
    expect(result.evidence).toEqual(['主路径', '异常路径'])
    expect(result.guidance).toContain('先补齐观测')
  })

  it('routes requirement disputes to the business review rule', () => {
    for (const text of ['需求歧义：是否允许匿名', '验收标准不清', '目标冲突', '需所有者决定']) {
      const result = classifyVerificationFailure({ blocking: [text], commandRuns: [run()] })
      expect(result).toMatchObject({ kind: 'requirement_dispute', requiresCodeChange: false })
      expect(result.evidence).toEqual([text])
      expect(result.guidance).toContain('Agent 不得自行改写需求')
    }
  })

  it('falls back to undetermined with the blocking reasons', () => {
    const result = classifyVerificationFailure({
      blocking: [' 报告缺少结论 ', '报告缺少结论'],
      commandRuns: [run()],
    })
    expect(result).toMatchObject({ kind: 'undetermined', requiresCodeChange: false })
    expect(result.reasons).toEqual(['报告缺少结论'])
    expect(result.evidence).toEqual(['报告缺少结论'])
    expect(result.guidance).toContain('不以重跑直到通过作为放行依据')
  })
})
