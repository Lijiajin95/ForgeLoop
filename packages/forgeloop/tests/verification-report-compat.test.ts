import { describe, expect, it } from 'vitest'
import { parseVerificationReport } from '../src/domain/verification.js'

/** 旧版本写下的报告：只有 verdict / scenarios / blocking，没有后来新增的字段。 */
const legacyPass = JSON.stringify({
  verdict: 'pass',
  summary: '两个必过场景通过',
  scenarios: [
    { scenario: '主路径', status: 'pass', evidence: '检查通过' },
    { scenario: '错误路径', status: 'pass' },
  ],
})

const legacyBlock = JSON.stringify({
  verdict: 'block',
  summary: '主路径失败',
  blocking: ['场景失败：主路径'],
  findings: ['缺少证据'],
  scenarios: [{ scenario: '主路径', status: 'fail', evidence: '实际失败' }],
})

describe('verification report compatibility', () => {
  it('reads a legacy pass report and defaults the optional fields', () => {
    const report = parseVerificationReport(legacyPass)
    expect(report.verdict).toBe('pass')
    expect(report.blocking).toEqual([])
    expect(report.findings).toEqual([])
    expect(report.scenarios).toHaveLength(2)
    expect(report.scenarios[0]).toMatchObject({ scenario: '主路径', status: 'pass' })
    expect(report.scenarios[0]?.commands).toEqual([])
  })

  it('reads a legacy block report with its reasons', () => {
    const report = parseVerificationReport(legacyBlock)
    expect(report.verdict).toBe('block')
    expect(report.blocking).toEqual(['场景失败：主路径'])
    expect(report.findings).toEqual(['缺少证据'])
  })

  it('ignores fields a newer writer added instead of rejecting the report', () => {
    const newer = JSON.stringify({
      verdict: 'pass',
      summary: '主路径通过',
      scenarios: [{ scenario: '主路径', status: 'pass', controls: ['c1'], attemptId: 'a-1' }],
      attemptId: 'a-1',
      candidateSha256: 'k'.repeat(64),
    })
    const report = parseVerificationReport(newer)
    expect(report.verdict).toBe('pass')
    expect(report.scenarios[0]?.scenario).toBe('主路径')
  })

  it('still rejects a contradictory legacy report', () => {
    expect(() =>
      parseVerificationReport(
        JSON.stringify({ verdict: 'pass', summary: 's', blocking: ['不应出现'], scenarios: [] }),
      ),
    ).toThrow()
    expect(() =>
      parseVerificationReport(JSON.stringify({ verdict: 'block', summary: 's', scenarios: [] })),
    ).toThrow()
  })
})
