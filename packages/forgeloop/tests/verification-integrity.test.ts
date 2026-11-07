import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyVerificationFailure } from '../src/domain/verification-failure.js'
import {
  parseVerificationControls,
  validateControlCoverage,
  validateControlPatch,
} from '../src/domain/verification-controls.js'
import { executeVerificationControls } from '../src/runtime/verification-controls.js'
import { verificationMaterialDigest } from '../src/runtime/verification-materials.js'
import { Repository } from '../src/records/repository.js'
import { Database } from '../src/records/db.js'
import type { VerificationCheckRun } from '../src/domain/verification.js'

/**
 * 验证有效性、失败分流与复验留证：通过公开接口观察业务结果。
 * 固定输出的“验证标记”不能证明业务行为；只有受控错误实现会失败，才说明用例有效。
 */

const NOW = '2026-11-05T00:00:00.000Z'

function run(overrides: Partial<VerificationCheckRun> = {}): VerificationCheckRun {
  return {
    label: 'check',
    argv: ['node', 'check.js'],
    exitCode: 0,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    output: 'business ok',
    ...overrides,
  }
}

describe('verification failure classification', () => {
  it('treats a failing business assertion as an implementation defect that may return to development', () => {
    const result = classifyVerificationFailure({
      blocking: ['验证命令失败：check 退出码 1'],
      commandRuns: [
        run({
          exitCode: 1,
          output: 'AssertionError: expected 3 rounds to pause, got 4',
        }),
      ],
    })
    expect(result.kind).toBe('implementation_defect')
    expect(result.requiresCodeChange).toBe(true)
    expect(result.reasons.join('；')).toContain('业务断言失败')
  })

  it('classifies a verification script that mixes CommonJS into an ESM project as a test error', () => {
    const result = classifyVerificationFailure({
      blocking: ['验证命令失败：check 退出码 1'],
      commandRuns: [
        run({
          exitCode: 1,
          output:
            'ReferenceError: require is not defined in ES module scope, you can use import instead',
        }),
      ],
    })
    expect(result.kind).toBe('test_error')
    expect(result.requiresCodeChange).toBe(false)
    expect(result.guidance).toContain('.cjs')
  })

  it('does not turn a bare non-zero exit without assertion evidence into a code-repair instruction', () => {
    const result = classifyVerificationFailure({
      blocking: ['验证命令失败：check 退出码 1'],
      commandRuns: [run({ exitCode: 1, output: 'broken candidate' })],
    })
    expect(result.kind).toBe('undetermined')
    expect(result.requiresCodeChange).toBe(false)
  })

  it('classifies executor and dependency failures as environment errors, not code defects', () => {
    const result = classifyVerificationFailure({
      blocking: ['验证命令未执行'],
      commandRuns: [run({ exitCode: null, output: 'spawn node ENOENT' })],
    })
    expect(result.kind).toBe('environment_error')
    expect(result.requiresCodeChange).toBe(false)
    expect(result.guidance).toContain('恢复环境')
  })

  it('classifies a verification process that changed the candidate as a test error', () => {
    const result = classifyVerificationFailure({
      blocking: ['验证命令修改了固定候选'],
      commandRuns: [run()],
      integrityIssues: ['验证命令修改了固定候选：src/a.ts'],
    })
    expect(result.kind).toBe('test_error')
    expect(result.requiresCodeChange).toBe(false)
  })

  it('classifies missing evidence and ambiguous requirements separately', () => {
    expect(
      classifyVerificationFailure({
        blocking: ['必过场景缺少证据'],
        commandRuns: [run()],
        evidenceIssues: ['必过场景缺少证据：交付'],
      }).kind,
    ).toBe('insufficient_evidence')
    expect(
      classifyVerificationFailure({
        blocking: ['需求歧义：验收标准不清，需客户决定'],
        commandRuns: [run()],
      }).kind,
    ).toBe('requirement_dispute')
  })
})

describe('sensitivity controls', () => {
  it('requires at least one passing required scenario with a control', () => {
    const issues = validateControlCoverage({
      requiredScenarios: ['交付'],
      reportScenarios: [{ scenario: '交付', status: 'pass', commands: ['check'] }],
      controls: [],
    })
    expect(issues.join('；')).toContain('没有任何必过场景提供敏感性对照')
    expect(
      validateControlCoverage({
        requiredScenarios: ['交付'],
        reportScenarios: [{ scenario: '交付', status: 'pass', commands: ['check'] }],
        controls: [{ label: 'check' }],
      }),
    ).toEqual([])
  })

  it('rejects controls that only modify test material or escape the workspace', () => {
    const onlyTests =
      'diff --git a/verification/check.js b/verification/check.js\n--- a/verification/check.js\n+++ b/verification/check.js\n'
    expect(validateControlPatch(onlyTests).join('；')).toContain('必须触及业务实现')
    const escape =
      'diff --git a/../outside.ts b/../outside.ts\n--- a/../outside.ts\n+++ b/../outside.ts\n'
    expect(validateControlPatch(escape).join('；')).toContain('越界')
  })

  it('parses only patches under verification/controls with a checkable failure fragment', () => {
    const valid = JSON.stringify({
      controls: [
        {
          label: 'check',
          patch: 'verification/controls/fault.patch',
          expected_failure_output: 'target rule broken',
        },
      ],
    })
    expect(parseVerificationControls(valid)).toHaveLength(1)
    expect(() =>
      parseVerificationControls(
        JSON.stringify({
          controls: [{ label: 'check', patch: 'fault.patch', expected_failure_output: 'broken' }],
        }),
      ),
    ).toThrow('必须位于 verification/controls/')
  })
})

describe('controlled faulty copy', () => {
  let root = ''

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function workspace(): string {
    root = mkdtempSync(join(tmpdir(), 'forgeloop-controls-'))
    const ws = join(root, 'workspace')
    mkdirSync(join(ws, 'verification', 'controls'), { recursive: true })
    writeFileSync(join(ws, 'business.txt'), 'ok\n', 'utf8')
    writeFileSync(
      join(ws, 'verification', 'controls', 'fault.patch'),
      'diff --git a/business.txt b/business.txt\n--- a/business.txt\n+++ b/business.txt\n@@ -1 +1 @@\n-ok\n+broken\n',
      'utf8',
    )
    return ws
  }

  const control = {
    label: 'check',
    patch: 'verification/controls/fault.patch',
    expectedFailureOutput: 'target rule broken',
  }

  it('passes only when the same test fails on the controlled faulty implementation', async () => {
    const ws = workspace()
    const outcome = await executeVerificationControls({
      workspace: ws,
      dir: join(root, 'attempt-1'),
      commands: [{ label: 'check', argv: ['node', 'unused'] }],
      controls: [control],
      run: async ({ cwd }) => {
        const broken = readFileSync(join(cwd, 'business.txt'), 'utf8') !== 'ok\n'
        return broken
          ? {
              exitCode: 1,
              timedOut: false,
              aborted: false,
              durationMs: 1,
              output: 'target rule broken: expected ok',
              logPath: join(root, 'control.log'),
              logSha256: 'sha',
            }
          : {
              exitCode: 0,
              timedOut: false,
              aborted: false,
              durationMs: 1,
              output: 'business ok',
              logPath: join(root, 'main.log'),
              logSha256: 'sha',
            }
      },
    })
    expect(outcome.issues).toEqual([])
    expect(outcome.results[0]).toMatchObject({ applied: true, exitCode: 1 })
    // 正式候选没有被修改。
    expect(readFileSync(join(ws, 'business.txt'), 'utf8')).toBe('ok\n')
  })

  it('blocks a marker-only command that still succeeds on the faulty copy', async () => {
    const ws = workspace()
    const outcome = await executeVerificationControls({
      workspace: ws,
      dir: join(root, 'attempt-2'),
      commands: [{ label: 'check', argv: ['node', 'unused'] }],
      controls: [control],
      run: async () => ({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        durationMs: 1,
        output: 'verification marker ok',
        logPath: join(root, 'marker.log'),
        logSha256: 'sha',
      }),
    })
    expect(outcome.issues.join('；')).toContain('不能证明它能发现错误行为')
  })

  it('rejects a control when verification material was replaced after the positive run', async () => {
    const ws = workspace()
    writeFileSync(join(ws, 'verification', 'runner.js'), 'positive ok', 'utf8')
    const frozen = verificationMaterialDigest(ws)
    // 模拟先成功、随后替换脚本：旧正向结果不能与新材料拼成敏感性证明。
    writeFileSync(join(ws, 'verification', 'runner.js'), 'always exit 1', 'utf8')
    const outcome = await executeVerificationControls({
      workspace: ws,
      dir: join(root, 'attempt-stale'),
      commands: [{ label: 'check', argv: ['node', 'verification/runner.js'] }],
      controls: [control],
      expectedMaterialsSha256: frozen,
      run: async () => ({
        exitCode: 1,
        timedOut: false,
        aborted: false,
        durationMs: 1,
        output: 'target rule broken',
        logPath: join(root, 'stale.log'),
        logSha256: 'sha',
      }),
    })
    expect(outcome.results).toEqual([])
    expect(outcome.issues.join('；')).toContain('验证材料在正向执行后发生变化')
  })
})

describe('append-only verification attempts', () => {
  let root = ''
  let repo: Repository | null = null

  afterEach(() => {
    repo?.close()
    repo = null
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function record(candidate: string, verdict: 'pass' | 'block', failureKind = ''): void {
    repo!.recordVerification({
      requirementId: 'req-1',
      planVersion: 1,
      candidateSha256: candidate,
      requirementVersion: 1,
      workspaceSha256: 'tree',
      verdict,
      failureKind,
      blocking: verdict === 'block' ? ['验证命令失败'] : [],
      reportJson: '{}',
      reportPath: `/tmp/${candidate}-${verdict}-${failureKind || 'pass'}-${NOW}.json`,
      reportSha256: 'sha',
      evidenceDir: `/tmp/${candidate}`,
      sessionId: 'session',
      verifiedAt: NOW,
    })
  }

  it('retains the failed attempt and its original evidence when the same candidate is verified again', () => {
    root = mkdtempSync(join(tmpdir(), 'forgeloop-attempts-'))
    repo = new Repository(Database.open(join(root, 'records.sqlite')))
    record('a', 'block', 'environment_error')
    record('a', 'pass')
    const attempts = repo.verificationAttemptsForCandidate('req-1', 1, 'a')
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2])
    expect(attempts[0]?.verdict).toBe('block')
    expect(attempts[0]?.failureKind).toBe('environment_error')
    expect(attempts[0]?.previousAttemptId).toBe('')
    expect(attempts[1]?.previousAttemptId).toBe(attempts[0]?.attemptId)
    expect(attempts[0]?.reportPath).not.toBe(attempts[1]?.reportPath)
    expect(repo.verification('req-1', 1)?.verdict).toBe('pass')
  })

  it('does not let a new candidate reuse the previous candidate result', () => {
    root = mkdtempSync(join(tmpdir(), 'forgeloop-attempts-'))
    repo = new Repository(Database.open(join(root, 'records.sqlite')))
    record('a', 'pass')
    record('b', 'block', 'implementation_defect')
    expect(repo.verificationForCandidate('req-1', 1, 'a')?.verdict).toBe('pass')
    expect(repo.verificationForCandidate('req-1', 1, 'b')?.verdict).toBe('block')
    expect(repo.verificationAttempts('req-1')).toHaveLength(2)
  })
})
