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

const positive = (label: string): VerificationCheckPlan => ({
  label,
  argv: ['node', '-e', '0'],
  expectedOutput: 'ok',
  expectFailure: false,
  required: true,
})

const negative = (label: string): VerificationCheckPlan => ({
  label,
  argv: ['node', '-e', '1'],
  expectedOutput: '',
  expectFailure: true,
  required: true,
})

function run(label: string, exitCode = 0): VerificationCheckRun {
  return { label, exitCode, timedOut: false, aborted: false, output: 'ok', durationMs: 1 }
}

function judge(plan: VerificationPlan, runs: VerificationCheckRun[]) {
  return judgeVerificationResult({
    plan,
    artifact,
    checks: runs,
    environment,
    finishedAt: '2026-11-08T02:00:00.000Z',
  })
}

describe('per-scenario negative control', () => {
  it('rejects a required scenario whose negative control belongs to another scenario', () => {
    const plan: VerificationPlan = {
      scenarios: [
        {
          scenario: '主路径',
          acceptanceCriterion: '可见',
          method: '命令',
          required: true,
          checks: [positive('pos')],
        },
        {
          scenario: '错误路径',
          acceptanceCriterion: '被拒绝',
          method: '命令',
          required: true,
          checks: [positive('pos-2'), negative('neg-2')],
        },
      ],
    }
    const result = judge(plan, [run('pos'), run('pos-2'), run('neg-2', 1)])
    expect(result.verdict).toBe('failed')
    expect(result.failures.join('；')).toContain('必过场景缺少自己的错误对照：主路径')
  })

  it('accepts when each required scenario pairs a positive check with its own negative control', () => {
    const plan: VerificationPlan = {
      scenarios: [
        {
          scenario: '主路径',
          acceptanceCriterion: '可见',
          method: '命令',
          required: true,
          checks: [positive('pos'), negative('neg')],
        },
      ],
    }
    const result = judge(plan, [run('pos'), run('neg', 1)])
    expect(result.verdict).toBe('passed')
  })

  it('keeps plans without any negative control working', () => {
    const plan: VerificationPlan = {
      scenarios: [
        {
          scenario: '主路径',
          acceptanceCriterion: '可见',
          method: '命令',
          required: true,
          checks: [positive('pos')],
        },
      ],
    }
    const result = judge(plan, [run('pos')])
    expect(result.verdict).toBe('passed')
  })

  it('rejects a required scenario that only proves the faulty copy fails', () => {
    // 只有负例没有正向验收：对照成立也不能证明候选本身满足需求。
    const plan: VerificationPlan = {
      scenarios: [
        {
          scenario: '错误路径',
          acceptanceCriterion: '被拒绝',
          method: '命令',
          required: true,
          checks: [negative('neg')],
        },
      ],
    }
    const result = judge(plan, [{ ...run('neg', 1), output: 'target rule broken' }])
    expect(result.verdict).toBe('failed')
    expect(result.failures.join('；')).toContain('必过场景缺少正向验收检查：错误路径')
  })
})
