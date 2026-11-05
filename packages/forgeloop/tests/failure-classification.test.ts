import { describe, expect, it } from 'vitest'
import { classifyVerificationFailure } from '../src/domain/failure-classification.js'

const signal = (
  overrides: Partial<Parameters<typeof classifyVerificationFailure>[0]['signals'][number]> = {},
) => ({
  label: 'check',
  exitCode: 1,
  timedOut: false,
  aborted: false,
  expectFailure: false,
  output: '',
  ...overrides,
})

describe('verification failure classification', () => {
  it('classifies a missing executable as environment, not implementation', () => {
    expect(
      classifyVerificationFailure({
        signals: [signal({ exitCode: null })],
        failures: ['验证命令失败：check（退出码 null）'],
      }).kind,
    ).toBe('environment')
  })

  it('classifies missing modules and missing commands from output as environment', () => {
    expect(
      classifyVerificationFailure({
        signals: [signal({ output: "Error: Cannot find module 'vitest'" })],
        failures: ['验证命令失败'],
      }).kind,
    ).toBe('environment')
    expect(
      classifyVerificationFailure({
        signals: [signal({ output: 'tsc: not found' })],
        failures: ['验证命令失败'],
      }).kind,
    ).toBe('environment')
  })

  it('classifies broken verification material as test defect', () => {
    expect(
      classifyVerificationFailure({
        signals: [signal()],
        failures: ['验证方案与命令清单不一致'],
      }).kind,
    ).toBe('test_defect')
  })

  it('classifies missing evidence as evidence gap', () => {
    expect(
      classifyVerificationFailure({
        signals: [signal({ exitCode: 0, output: 'ok' })],
        failures: ['必过场景证据无法在验证输出中核对：S'],
      }).kind,
    ).toBe('evidence_gap')
  })

  it('defaults a real behavior failure to implementation', () => {
    expect(
      classifyVerificationFailure({
        signals: [signal({ output: 'expected 2, got 3' })],
        failures: ['验证命令失败：check（退出码 1）'],
      }).kind,
    ).toBe('implementation')
  })
})
