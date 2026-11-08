import { describe, expect, it } from 'vitest'
import { judgeVerificationResult } from '../src/domain/verification.js'
import type {
  VerificationArtifact,
  VerificationCheckPlan,
  VerificationCheckRun,
  VerificationEnvironment,
  VerificationPlan,
} from '../src/domain/verification.js'

const artifact: VerificationArtifact = {
  snapshotCommit: 'c'.repeat(40),
  workspaceSha256: 'w'.repeat(64),
  candidateSha256: 'k'.repeat(64),
  requirementVersion: 1,
  planVersion: 1,
}

const environment: VerificationEnvironment = {
  project: 'demo',
  node: 'v24',
  platform: 'linux',
  cwd: '/tmp/demo',
}

function positive(label: string, expectedOutput = 'ok'): VerificationCheckPlan {
  return { label, argv: ['node', '-e', '0'], expectedOutput, expectFailure: false, required: true }
}

function negative(label: string, expectedOutput = ''): VerificationCheckPlan {
  return { label, argv: ['node', '-e', '1'], expectedOutput, expectFailure: true, required: true }
}

function run(overrides: Partial<VerificationCheckRun> & { label: string }): VerificationCheckRun {
  return { exitCode: 0, timedOut: false, aborted: false, output: 'ok', durationMs: 1, ...overrides }
}

function plan(checks: VerificationCheckPlan[]): VerificationPlan {
  return {
    scenarios: [
      { scenario: '主路径', acceptanceCriterion: '可见', method: '命令', required: true, checks },
    ],
  }
}

function judge(checks: VerificationCheckPlan[], runs: VerificationCheckRun[]) {
  return judgeVerificationResult({
    plan: plan(checks),
    artifact,
    checks: runs,
    environment,
    finishedAt: '2026-11-08T04:00:00.000Z',
  })
}

describe('negative control judgement', () => {
  it('accepts a negative control whose failure matches the declared output', () => {
    const result = judge(
      [positive('pos'), negative('neg', 'business rule broken')],
      [
        run({ label: 'pos' }),
        run({ label: 'neg', exitCode: 1, output: 'AssertionError: business rule broken' }),
      ],
    )
    expect(result.verdict).toBe('passed')
  })

  it('rejects a negative control whose failure misses the declared output', () => {
    const result = judge(
      [positive('pos'), negative('neg', 'business rule broken')],
      [
        run({ label: 'pos' }),
        run({ label: 'neg', exitCode: 1, output: 'SyntaxError: unexpected token' }),
      ],
    )
    expect(result.verdict).toBe('failed')
    expect(result.failures.join('；')).toContain('错误对照的失败输出缺少预期片段：neg')
  })

  it('rejects an unrelated script error as proof of the target business error', () => {
    const result = judge(
      [positive('pos'), negative('neg')],
      [
        run({ label: 'pos' }),
        run({ label: 'neg', exitCode: 1, output: "Error: Cannot find module 'left-pad'" }),
      ],
    )
    expect(result.verdict).toBe('failed')
    expect(result.failures.join('；')).toContain('错误对照的失败不是目标业务断言：neg')
  })

  it('keeps abort, timeout and missing exit code as failures', () => {
    for (const [override, expected] of [
      [{ aborted: true, exitCode: null }, '被中止'],
      [{ timedOut: true, exitCode: null }, '超时'],
      [{ exitCode: null }, '没有真实退出码'],
    ] as const) {
      const result = judge(
        [positive('pos'), negative('neg')],
        [run({ label: 'pos' }), run({ label: 'neg', ...override })],
      )
      expect(result.verdict).toBe('failed')
      expect(result.failures.join('；')).toContain(expected)
    }
  })
})
