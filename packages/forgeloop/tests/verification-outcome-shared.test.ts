import { describe, expect, it } from 'vitest'
import {
  candidateIntegrityFacts,
  decideVerificationOutcome,
} from '../src/domain/verification-outcome.js'
import { verificationVerdict } from '../src/runtime/verification-outcome.js'
import type { VerificationReport } from '../src/domain/verification.js'

/**
 * 两个验证入口（连续推进的 legacy 路径与显式 verify 的任务包路径）必须共用同一份
 * 通过/阻断判定与候选完整性规则。这里直接对比两条入口的适配结果，防止规则漂移。
 */

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    verdict: 'pass',
    summary: '通过',
    findings: [],
    blocking: [],
    scenarios: [{ scenario: '场景', status: 'pass', evidence: '输出', commands: ['smoke'] }],
    ...overrides,
  } as VerificationReport
}

/** legacy 入口的判定输入映射（与 legacy-verification 的 legacyConclusion 一致）。 */
function legacyOutcome(input: {
  reportedPassed: boolean
  blocking?: readonly string[]
  integrityIssues?: readonly string[]
  controlIssues?: readonly string[]
}) {
  return decideVerificationOutcome(input)
}

/** 显式 verify 入口经适配后的判定。 */
function verifyOutcome(input: {
  report: VerificationReport
  failedCommands?: readonly string[]
  coverageIssues?: readonly string[]
  evidenceIssues?: readonly string[]
  integrityIssues?: readonly string[]
  controlIssues?: readonly string[]
}) {
  return verificationVerdict({
    report: input.report,
    failedCommands: input.failedCommands ?? [],
    coverageIssues: input.coverageIssues ?? [],
    evidenceIssues: input.evidenceIssues ?? [],
    integrityIssues: input.integrityIssues ?? [],
    controlIssues: input.controlIssues ?? [],
  })
}

describe('shared verification judgment', () => {
  it('passes only when every input is clean in both entries', () => {
    expect(legacyOutcome({ reportedPassed: true })).toEqual({ verdict: 'pass', blocking: [] })
    expect(verifyOutcome({ report: report() })).toEqual({ verdict: 'pass', blocking: [] })
  })

  it('blocks both entries for the same defects with the same ordering', () => {
    const integrity = '测试命令修改了固定候选：src/a.ts'
    const control = '必过场景缺少自己的错误对照：场景'
    const legacy = legacyOutcome({
      reportedPassed: false,
      blocking: ['场景未通过'],
      integrityIssues: [integrity],
      controlIssues: [control],
    })
    const verify = verifyOutcome({
      report: report({
        verdict: 'block',
        blocking: ['场景未通过'],
        scenarios: [{ scenario: '场景', status: 'fail', evidence: '', commands: ['smoke'] }],
      }),
      integrityIssues: [integrity],
      controlIssues: [control],
    })
    expect(verify.verdict).toBe(legacy.verdict)
    expect(legacy.verdict).toBe('block')
    // 执行层阻断在前，其后是完整性、敏感性对照；场景汇总行只在显式 verify 里出现。
    for (const outcome of [legacy, verify]) {
      expect(outcome.blocking[0]).toBe('场景未通过')
      expect(outcome.blocking.indexOf(integrity)).toBe(1)
      expect(outcome.blocking.indexOf(integrity)).toBeLessThan(outcome.blocking.indexOf(control))
    }
    expect(verify.blocking).toContain('报告存在未通过的测试场景')
    expect(legacy.blocking).not.toContain('报告存在未通过的测试场景')
  })

  it('treats failed commands, coverage, evidence and scenario failures as blocking in both', () => {
    const legacyFailed = legacyOutcome({ reportedPassed: false, blocking: ['命令失败'] })
    const verifyFailed = verifyOutcome({
      report: report({ verdict: 'fail' }),
      failedCommands: ['smoke（退出码 1）'],
    })
    expect(legacyFailed.verdict).toBe('block')
    expect(verifyFailed.verdict).toBe('block')
    expect(verifyFailed.blocking).toContain('测试命令失败：smoke（退出码 1）')

    const verifyScenario = verifyOutcome({
      report: report({
        scenarios: [{ scenario: '场景', status: 'fail', evidence: '', commands: ['smoke'] }],
      }),
    })
    expect(verifyScenario.blocking).toEqual(['报告存在未通过的测试场景'])
    expect(
      verifyOutcome({
        report: report(),
        coverageIssues: ['缺少必过场景的验证结果：场景'],
        evidenceIssues: ['场景 场景 引用了未执行的测试命令：ghost'],
      }).verdict,
    ).toBe('block')
  })
})

describe('shared candidate integrity rule', () => {
  it('flags a moved candidate head and changes outside the allowed prefix', () => {
    expect(
      candidateIntegrityFacts({
        expectedHead: 'aaa',
        actualHead: 'bbb',
        changes: ['verification/commands.json', 'src/a.ts', 'docs/b.md'],
        allowedPrefix: 'verification/',
      }),
    ).toEqual({ headChanged: true, outside: ['src/a.ts', 'docs/b.md'] })
  })

  it('accepts an unchanged head with only verification materials touched', () => {
    expect(
      candidateIntegrityFacts({
        expectedHead: 'aaa',
        actualHead: 'aaa',
        changes: ['verification/report.json'],
        allowedPrefix: 'verification/',
      }),
    ).toEqual({ headChanged: false, outside: [] })
  })
})
