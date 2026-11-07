import { describe, expect, it } from 'vitest'
import {
  parseSelfVerificationReport,
  redGreenIssue,
  selfVerificationSufficient,
  type SelfVerificationReport,
} from '../src/domain/self-verification.js'

/**
 * 覆盖率门禁补充：研发自验证报告的解析与证据充分性边界。
 * 只调用公开的解析与判定函数，断言具体返回值/错误原文；
 * 覆盖澄清字段缺失、非对象载荷、未知风险、红绿灯字段缺失与回退分支。
 */

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    reason: '低风险测试改动',
    ...overrides,
  }
}

function report(overrides: Record<string, unknown> = {}): SelfVerificationReport {
  const parsed = parseSelfVerificationReport(JSON.stringify(payload(overrides)))
  if (!parsed) throw new Error('fixture report should parse')
  return parsed
}

describe('self-verification clarification parsing', () => {
  it('normalizes a clarification question and an optional context', () => {
    const parsed = report({
      needs_clarification: {
        question: ' 需要客户确认范围吗？ ',
        context: ' 需求原文 ',
      },
    })
    expect(parsed.needsClarification).toEqual({
      question: '需要客户确认范围吗？',
      context: '需求原文',
    })

    const noContext = report({
      needs_clarification: { question: '需要确认吗？', context: 42 },
    })
    expect(noContext.needsClarification).toEqual({ question: '需要确认吗？', context: '' })
  })

  it('drops a clarification without a usable question', () => {
    const nonString = report({ needs_clarification: { question: 42, context: '上下文' } })
    expect(nonString.needsClarification).toBeUndefined()

    const blank = report({ needs_clarification: { question: '   ', context: '上下文' } })
    expect(blank.needsClarification).toBeUndefined()
  })

  it('drops a null or non-object clarification instead of inventing a question', () => {
    expect(report({ needs_clarification: null }).needsClarification).toBeUndefined()

    const text = report({ needs_clarification: '需要确认' })
    expect(text.needsClarification).toBeUndefined()
  })
})

describe('self-verification payload guards', () => {
  it('rejects a payload that is not a JSON object', () => {
    expect(parseSelfVerificationReport('[]')).toBeNull()
    expect(parseSelfVerificationReport('"just text"')).toBeNull()
  })

  it('rejects an unknown risk instead of downgrading it', () => {
    expect(parseSelfVerificationReport(JSON.stringify(payload({ risk: 'critical' })))).toBeNull()
    expect(parseSelfVerificationReport(JSON.stringify(payload({ risk: 7 })))).toBeNull()
    expect(report({ risk: undefined }).risk).toBe('unknown')
  })

  it('defaults a missing or malformed red/green block and evidence', () => {
    expect(report({ red_green: undefined }).redGreen).toEqual({
      required: false,
      failingBefore: false,
      passingAfter: false,
      evidence: '',
      failingCommand: '',
      baselineIdentity: '',
      failingExitCode: null,
      failingLog: '',
      passingCommand: '',
      fixedIdentity: '',
      passingExitCode: null,
      passingLog: '',
    })
    expect(report({ red_green: 'red' }).redGreen).toEqual({
      required: false,
      failingBefore: false,
      passingAfter: false,
      evidence: '',
      failingCommand: '',
      baselineIdentity: '',
      failingExitCode: null,
      failingLog: '',
      passingCommand: '',
      fixedIdentity: '',
      passingExitCode: null,
      passingLog: '',
    })
    expect(
      report({
        red_green: {
          required: true,
          failing_before: true,
          passing_after: true,
          evidence: 42,
        },
      }).redGreen.evidence,
    ).toBe('')
  })

  it('treats non-array and blank check lists as no evidence and normalizes reason', () => {
    const parsed = report({
      white_box: 'npm test 通过',
      black_box: [' ', 42, '手工验证'],
      reason: 42,
    })
    expect(parsed.whiteBox).toEqual([])
    expect(parsed.blackBox).toEqual(['手工验证'])
    expect(parsed.reason).toBe('')
    expect(report({ reason: '  低风险  ' }).reason).toBe('低风险')
  })
})

describe('red/green requirement evidence', () => {
  it('does not require red/green for a low-risk requirement change', () => {
    const low = report()
    expect(redGreenIssue({ inputKind: 'requirement', report: low })).toBeNull()
    expect(selfVerificationSufficient({ inputKind: 'requirement', report: low })).toEqual({
      ok: true,
    })
  })

  it('requires a red/green declaration for a problem input even at low risk', () => {
    const low = report()
    expect(redGreenIssue({ inputKind: 'problem', report: low })).toBe(
      'BUG 修复或高风险改动必须声明红灯/绿灯要求',
    )
    expect(selfVerificationSufficient({ inputKind: 'problem', report: low })).toEqual({
      ok: false,
      reason: 'BUG 修复或高风险改动必须声明红灯/绿灯要求',
    })
  })

  it('reports each missing red/green field in order', () => {
    const missingBefore = report({
      red_green: {
        required: true,
        failing_before: false,
        passing_after: true,
        evidence: '修复前测试失败',
      },
    })
    expect(redGreenIssue({ inputKind: 'problem', report: missingBefore })).toBe(
      '缺少修复前目标行为失败证据',
    )

    const missingAfter = report({
      red_green: {
        required: true,
        failing_before: true,
        passing_after: false,
        evidence: '修复前测试失败',
      },
    })
    expect(redGreenIssue({ inputKind: 'problem', report: missingAfter })).toBe('缺少修复后通过证据')

    const missingEvidence = report({
      red_green: {
        required: true,
        failing_before: true,
        passing_after: true,
        evidence: '   ',
      },
    })
    expect(redGreenIssue({ inputKind: 'problem', report: missingEvidence })).toBe(
      '红灯/绿灯缺少可核对证据说明',
    )

    const complete = report({
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
    expect(redGreenIssue({ inputKind: 'problem', report: complete })).toBeNull()
  })
})

describe('self-verification sufficiency', () => {
  it('refuses an independent decision or a report without check evidence', () => {
    expect(
      selfVerificationSufficient({
        inputKind: 'requirement',
        report: report({ mode: 'independent' }),
      }),
    ).toEqual({ ok: false, reason: '研发决定本次需要独立验证' })

    expect(
      selfVerificationSufficient({
        inputKind: 'requirement',
        report: report({ white_box: [], black_box: [] }),
      }),
    ).toEqual({ ok: false, reason: '自验证报告没有白盒或黑盒检查证据' })
  })

  it('refuses a declared high-risk change that forgot the red/green requirement', () => {
    const high = report({ risk: 'high' })
    expect(selfVerificationSufficient({ inputKind: 'requirement', report: high })).toEqual({
      ok: false,
      reason: 'BUG 修复或高风险改动必须声明红灯/绿灯要求',
    })
  })

  it('refuses incomplete red/green evidence even when the report declares self mode', () => {
    expect(
      selfVerificationSufficient({
        inputKind: 'requirement',
        report: report({
          red_green: {
            required: true,
            failing_before: false,
            passing_after: true,
            evidence: '修复前测试失败',
          },
        }),
      }),
    ).toEqual({ ok: false, reason: '缺少修复前目标行为失败证据' })

    expect(
      selfVerificationSufficient({
        inputKind: 'requirement',
        report: report({
          red_green: {
            required: true,
            failing_before: true,
            passing_after: false,
            evidence: '修复前测试失败',
          },
        }),
      }),
    ).toEqual({ ok: false, reason: '缺少修复后通过证据' })

    expect(
      selfVerificationSufficient({
        inputKind: 'requirement',
        report: report({
          red_green: {
            required: true,
            failing_before: true,
            passing_after: true,
            evidence: '  ',
          },
        }),
      }),
    ).toEqual({ ok: false, reason: '红灯/绿灯缺少可核对证据说明' })

    expect(
      selfVerificationSufficient({
        inputKind: 'requirement',
        report: report({
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
        }),
      }),
    ).toEqual({ ok: true })
  })
})
