import { describe, expect, it } from 'vitest'
import {
  candidateSelfVerification,
  parseSelfVerificationReport,
  redGreenIssue,
  selfVerificationSufficient,
} from '../src/domain/self-verification.js'

const report = (overrides: Record<string, unknown> = {}) =>
  parseSelfVerificationReport(
    JSON.stringify({
      mode: 'self',
      risk: 'low',
      white_box: ['npm test 通过'],
      black_box: ['空输入返回明确错误'],
      red_green: {
        required: false,
        failing_before: false,
        passing_after: false,
        evidence: '',
      },
      reason: '文档与低风险测试改动',
      ...overrides,
    }),
  )

describe('dev self-verification', () => {
  it('parses a self mode report with evidence', () => {
    const parsed = report()
    expect(parsed?.mode).toBe('self')
    expect(selfVerificationSufficient({ inputKind: 'requirement', report: parsed! })).toEqual({
      ok: true,
    })
  })

  it('rejects malformed mode and keeps unknown risk conservative', () => {
    expect(parseSelfVerificationReport('{"mode":"maybe"}')).toBeNull()
    expect(parseSelfVerificationReport('not json')).toBeNull()
    expect(report({ risk: undefined })?.risk).toBe('unknown')
  })

  it('requires red/green for problem inputs and high risk', () => {
    const low = report()
    expect(redGreenIssue({ inputKind: 'problem', report: low! })).toBe(
      'BUG 修复或高风险改动必须声明红灯/绿灯要求',
    )
    const high = report({ risk: 'high' })
    expect(redGreenIssue({ inputKind: 'requirement', report: high! })).toBe(
      'BUG 修复或高风险改动必须声明红灯/绿灯要求',
    )
    const green = report({
      risk: 'high',
      red_green: {
        required: true,
        failing_before: true,
        passing_after: true,
        evidence: '修复前测试退出 1，修复后退出 0',
        failing_command: 'npm test',
        baseline_identity: 'baseline-sha',
        failing_exit_code: 1,
        failing_log: '/tmp/red.log',
        passing_command: 'npm test',
        fixed_identity: 'fixed-sha',
        passing_exit_code: 0,
        passing_log: '/tmp/green.log',
      },
    })
    expect(redGreenIssue({ inputKind: 'requirement', report: green! })).toBeNull()
  })

  it('does not allow self mode without any check or with incomplete red/green', () => {
    const empty = report({ white_box: [], black_box: [] })
    expect(selfVerificationSufficient({ inputKind: 'requirement', report: empty! })).toMatchObject({
      ok: false,
    })
    const missingAfter = report({
      red_green: {
        required: true,
        failing_before: true,
        passing_after: false,
        evidence: '只有修复前失败',
      },
    })
    expect(
      selfVerificationSufficient({ inputKind: 'requirement', report: missingAfter! }),
    ).toMatchObject({ ok: false, reason: '缺少修复后通过证据' })
  })

  it('keeps an explicit independent decision out of the self-sufficiency path', () => {
    const independent = report({ mode: 'independent' })
    expect(
      selfVerificationSufficient({ inputKind: 'requirement', report: independent! }),
    ).toMatchObject({ ok: false })
  })

  it('requires every delivered task to have a sufficient self report', () => {
    const self = report()!
    expect(
      candidateSelfVerification({
        inputKind: 'requirement',
        reports: [{ taskId: 'a', report: self }],
      }),
    ).toEqual({ ok: true })
    expect(
      candidateSelfVerification({
        inputKind: 'requirement',
        reports: [
          { taskId: 'a', report: null },
          { taskId: 'b', report: self },
        ],
      }),
    ).toMatchObject({ ok: false, reason: '任务 a 缺少持久化自测试报告' })
    expect(
      candidateSelfVerification({
        inputKind: 'requirement',
        reports: [
          { taskId: 'a', report: report({ mode: 'independent' }) },
          { taskId: 'b', report: self },
        ],
      }),
    ).toMatchObject({ ok: false, reason: '任务 a 选择独立测试' })
  })

  it('rejects red/green without real command, identity, exit code and log', () => {
    const incomplete = report({
      risk: 'high',
      red_green: {
        required: true,
        failing_before: true,
        passing_after: true,
        evidence: '只看文字',
      },
    })
    expect(redGreenIssue({ inputKind: 'requirement', report: incomplete! })).toContain(
      '红灯缺少真实命令',
    )
  })
})
