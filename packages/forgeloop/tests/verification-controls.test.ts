import { describe, expect, it } from 'vitest'
import {
  judgeVerificationResult,
  parseRequirementVerificationPlan,
} from '../src/domain/verification.js'
import { parseBusinessReview, validateBusinessReview } from '../src/domain/business-review.js'

const plan = (checks: unknown[]) =>
  JSON.stringify({
    scenarios: [
      {
        scenario: '提交报销单',
        acceptance_criterion: '保存成功并可查询',
        method: '正常输入通过，空输入必须失败',
        required: true,
        checks,
      },
    ],
  })

const positive = { label: 'ok', argv: ['node', '-e', 'process.exit(0)'], expect_failure: false }
const negative = { label: 'bad', argv: ['node', '-e', 'process.exit(1)'], expect_failure: true }

describe('verification positive/negative controls', () => {
  it('rejects a required scenario without a negative control', () => {
    expect(() => parseRequirementVerificationPlan(plan([positive]))).toThrow('错误对照')
  })

  it('rejects a required scenario without a positive check', () => {
    expect(() => parseRequirementVerificationPlan(plan([negative]))).toThrow('正向检查')
  })

  it('passes only when the positive succeeds and the control fails', () => {
    const parsed = parseRequirementVerificationPlan(plan([positive, negative]))
    const passed = judgeVerificationResult({
      plan: parsed,
      artifact: { requirementVersion: 1, candidateSha256: 'c', workspace: '/tmp' },
      checks: [
        {
          label: 'ok',
          argv: positive.argv,
          expectFailure: false,
          exitCode: 0,
          timedOut: false,
          aborted: false,
          durationMs: 1,
          output: 'ok',
        },
        {
          label: 'bad',
          argv: negative.argv,
          expectFailure: true,
          exitCode: 1,
          timedOut: false,
          aborted: false,
          durationMs: 1,
          output: 'bad',
        },
      ],
      environment: { platform: 'linux', nodeVersion: 'v24', startedAt: 't' },
      finishedAt: 't',
    })
    expect(passed.verdict).toBe('passed')

    const controlPassed = judgeVerificationResult({
      plan: parsed,
      artifact: { requirementVersion: 1, candidateSha256: 'c', workspace: '/tmp' },
      checks: [
        {
          label: 'ok',
          argv: positive.argv,
          expectFailure: false,
          exitCode: 0,
          timedOut: false,
          aborted: false,
          durationMs: 1,
          output: 'ok',
        },
        {
          label: 'bad',
          argv: negative.argv,
          expectFailure: true,
          exitCode: 0,
          timedOut: false,
          aborted: false,
          durationMs: 1,
          output: 'bad',
        },
      ],
      environment: { platform: 'linux', nodeVersion: 'v24', startedAt: 't' },
      finishedAt: 't',
    })
    expect(controlPassed.verdict).toBe('failed')
    expect(controlPassed.failures.join('\n')).toContain('预期失败但命令成功')
  })

  it('does not count a spawn failure as a valid negative control', () => {
    const parsed = parseRequirementVerificationPlan(plan([positive, negative]))
    const result = judgeVerificationResult({
      plan: parsed,
      artifact: { requirementVersion: 1, candidateSha256: 'c', workspace: '/tmp' },
      checks: [
        {
          label: 'ok',
          argv: positive.argv,
          expectFailure: false,
          exitCode: 0,
          timedOut: false,
          aborted: false,
          durationMs: 1,
          output: 'ok',
        },
        {
          label: 'bad',
          argv: negative.argv,
          expectFailure: true,
          exitCode: null,
          timedOut: false,
          aborted: false,
          durationMs: 1,
          output: 'ENOENT',
        },
      ],
      environment: { platform: 'linux', nodeVersion: 'v24', startedAt: 't' },
      finishedAt: 't',
    })
    expect(result.verdict).toBe('failed')
    expect(result.failures.join('\n')).toContain('没有真实退出码')
  })

  it('requires business review items to cite both a positive and a negative command', () => {
    const review = parseBusinessReview(
      JSON.stringify({
        verdict: 'pass',
        summary: 'ok',
        findings: [],
        blocking: [],
        scenarios: [{ scenario: '提交报销单', status: 'pass', evidence: 'ok', commands: ['ok'] }],
        acceptance: [
          {
            criterion: '保存成功并可查询',
            status: 'pass',
            evidence: 'ok',
            commands: ['ok', 'bad'],
          },
        ],
      }),
    )
    const issues = validateBusinessReview({
      scenarios: ['提交报销单'],
      acceptanceCriteria: ['保存成功并可查询'],
      review,
      runs: [
        { label: 'ok', output: 'ok', exitCode: 0, expectFailure: false },
        { label: 'bad', output: 'bad', exitCode: 1, expectFailure: true },
      ],
    })
    expect(issues.join('\n')).toContain('业务终审业务场景没有引用错误对照命令')
    expect(issues.join('\n')).not.toContain('业务终审验收标准没有引用错误对照命令')
  })
})
