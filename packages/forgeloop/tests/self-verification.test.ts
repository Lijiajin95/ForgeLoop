import { describe, expect, it } from 'vitest'
import {
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
})
