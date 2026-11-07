import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LegacyVerification } from '../src/runtime/legacy-verification.js'
import { resolveConfig } from '../src/config.js'
import type { ForgeLoopConfig } from '../src/config.js'
import type { VerificationPlan } from '../src/domain/verification.js'
import type { VerificationCheckRecord } from '../src/runtime/verification-checks.js'

const state = vi.hoisted(() => ({
  addCode: 0,
  addStderr: '',
  applyCode: 0,
  applyStderr: '',
  prepareCode: 0,
  tree: 'tree-1',
  heads: ['head-1', 'head-1'],
  headCalls: 0,
  statusOutput: '',
}))

vi.mock('../src/runtime/workspace.js', () => ({
  runCommand: (executable: string, args: readonly string[]) => {
    if (executable === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      return { code: state.addCode, stdout: '', stderr: state.addStderr }
    }
    if (executable === 'git' && args[0] === 'apply') {
      return { code: state.applyCode, stdout: '', stderr: state.applyStderr }
    }
    if (executable === 'git' && args[0] === 'reset') {
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: state.prepareCode, stdout: '', stderr: '' }
  },
  requireGit: (_cwd: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') return `${state.tree}\n`
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      const head = state.heads[Math.min(state.headCalls, state.heads.length - 1)] ?? 'head-1'
      state.headCalls += 1
      return `${head}\n`
    }
    return ''
  },
  git: () => ({ code: 0, stdout: state.statusOutput, stderr: '' }),
}))

let root = ''
let config: ForgeLoopConfig
let verification: LegacyVerification
let recorded: unknown[]
let failureRounds: unknown[]
let snapshot: {
  runs: readonly VerificationCheckRecord[]
  integrityIssues: string[]
  startedAt: string
} | null
let sendStatus: 'completed' | 'aborted' | 'timeout' | 'error'

const plan: VerificationPlan = {
  scenarios: [
    {
      scenario: '完成改动',
      acceptanceCriterion: '改动可见',
      method: '检查文件',
      required: true,
      checks: [{ label: 'check-1', argv: ['node', '-e', 'process.exit(0)'], expectedOutput: '' }],
    },
  ],
}

function runRecord(overrides: Partial<VerificationCheckRecord> = {}): VerificationCheckRecord {
  return {
    label: 'check-1',
    argv: ['node', '-e', 'process.exit(0)'],
    exitCode: 0,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    output: 'ok',
    logPath: join(root, 'check-1.log'),
    logSha256: 'sha',
    ...overrides,
  }
}

function buildVerification(prepareCommand: readonly string[] = []): LegacyVerification {
  config = resolveConfig({
    project: 'demo',
    projectPath: root,
    recordsRoot: join(root, '.forgeloop'),
    agent: { timeoutSeconds: 10 },
    formalTestTimeoutSeconds: 10,
    worktreePrepareCommand: [...prepareCommand],
  })
  const repo = {
    recordVerification: (value: unknown) => recorded.push(value),
    recordFailureRound: (value: unknown) => failureRounds.push(value),
    nextVerificationAttempt: () => ({ attemptNumber: 1, previousAttemptId: '' }),
  }
  return new LegacyVerification({
    config,
    repo: repo as never,
    now: () => '2026-11-03T10:00:00.000Z',
    charge: () => undefined,
    openAgent: () => {
      throw new Error('not used')
    },
    checks: {
      activate: () => ({ token: 'token-1', release: () => undefined }),
      snapshot: () => snapshot,
      executeControls: async () => ({
        results: [
          {
            label: 'check-1',
            patch: 'verification/controls/fault.patch',
            controlDir: join(root, 'control'),
            applied: true,
            exitCode: 1,
            timedOut: false,
            aborted: false,
            durationMs: 1,
            output: 'target rule broken',
            logPath: join(root, 'control.log'),
            logSha256: 'sha',
            issue: '',
          },
        ],
        issues: [],
      }),
    } as never,
  })
}

function verify() {
  const diffPath = join(root, 'candidate.diff')
  writeFileSync(diffPath, 'diff --git a/a.ts b/a.ts\n', 'utf8')
  return verification.verifyCandidate({
    reqId: 'req-1',
    requirement: { reqId: 'req-1', versions: [{ version: 1, text: '实现改动' }] } as never,
    analysis: {} as never,
    plan: {
      taskPlanId: 'plan-1',
      requirementId: 'req-1',
      project: 'demo',
      planVersion: 1,
      requirementVersion: 1,
      tasks: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    candidate: {
      reqId: 'req-1',
      planVersion: 1,
      candidateVersion: 1,
      candidateSha256: 'c'.repeat(64),
      requirementVersion: 1,
      baselineCommit: 'b'.repeat(40),
      snapshotCommit: 's'.repeat(40),
      diffPath,
      diffSha256: 'd'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    devWorkspace: join(root, 'dev'),
    signal: new AbortController().signal,
    verification: {
      session: {
        sessionId: 'session-verify',
        send: () =>
          Promise.resolve({
            status: sendStatus,
            text: '',
            sessionId: 'session-verify',
            reason: 'verification stopped',
            transcriptPath: join(root, 'transcript.jsonl'),
            durationMs: 1,
            toolCalls: [],
          }),
        close: () => Promise.resolve(),
      },
      sessionId: 'session-verify',
      plan,
      close: () => Promise.resolve(),
    },
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-legacy-verify-'))
  state.addCode = 0
  state.addStderr = ''
  state.applyCode = 0
  state.applyStderr = ''
  state.prepareCode = 0
  state.tree = 'tree-1'
  state.heads = ['head-1', 'head-1']
  state.headCalls = 0
  state.statusOutput = ''
  recorded = []
  failureRounds = []
  snapshot = { runs: [runRecord()], integrityIssues: [], startedAt: '2026-11-03T10:00:00.000Z' }
  sendStatus = 'completed'
  verification = buildVerification()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('legacy verification failure paths', () => {
  it('blocks when the independent worktree cannot be created', async () => {
    state.addCode = 1
    state.addStderr = 'fatal: cannot add worktree'
    const outcome = await verify()
    expect(outcome).toMatchObject({
      state: 'block',
      blocking: ['独立验证工作区创建失败'],
      verification: null,
    })
    expect(outcome.detail).toContain('cannot add worktree')
  })

  it('blocks when the candidate diff cannot be applied', async () => {
    state.applyCode = 1
    state.applyStderr = 'patch does not apply'
    const outcome = await verify()
    expect(outcome).toMatchObject({
      state: 'block',
      blocking: ['候选 diff 无法应用'],
      verification: null,
    })
    expect(outcome.detail).toContain('patch does not apply')
  })

  it('blocks when the verification workspace preparation command fails', async () => {
    state.prepareCode = 2
    verification = buildVerification(['prepare-workspace'])
    const outcome = await verify()
    expect(outcome).toMatchObject({
      state: 'block',
      blocking: ['验证工作区准备命令失败（退出码 2）'],
      verification: null,
    })
  })

  it('records the attempt when the verification turn does not complete', async () => {
    sendStatus = 'aborted'
    const outcome = await verify()
    expect(outcome).toMatchObject({
      state: 'block',
      blocking: ['验证执行未取得结论：verification stopped'],
      failureKind: 'test_error',
    })
    expect(outcome.verification).not.toBeNull()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      attemptNumber: 1,
      failureKind: 'test_error',
      verdict: 'block',
    })
    expect(failureRounds).toHaveLength(1)
    const report = JSON.parse(readFileSync(outcome.verification!.reportPath, 'utf8')) as {
      attemptId: string
      attemptNumber: number
    }
    expect(report.attemptNumber).toBe(1)
    expect(report.attemptId).toContain('a1')
    expect(existsSync(outcome.verification!.reportPath)).toBe(true)
  })

  it('records the attempt when the verification snapshot was lost', async () => {
    snapshot = null
    const outcome = await verify()
    expect(outcome).toMatchObject({
      state: 'block',
      blocking: ['验证执行上下文在结论前丢失；无法核对命令结果'],
      failureKind: 'undetermined',
    })
    expect(recorded).toHaveLength(1)
    expect(failureRounds).toHaveLength(1)
  })

  it('blocks when the agent skipped a planned command', async () => {
    snapshot = { runs: [], integrityIssues: [], startedAt: '2026-11-03T10:00:00.000Z' }
    const outcome = await verify()
    expect(outcome.state).toBe('block')
    expect(outcome.detail).toContain('没有通过工具执行方案中的命令')
    expect(recorded).toHaveLength(1)
    expect(outcome.verification?.failureKind).toBe('test_error')
  })

  it('blocks when a verification command was aborted', async () => {
    snapshot = {
      runs: [runRecord({ aborted: true, exitCode: null })],
      integrityIssues: [],
      startedAt: '2026-11-03T10:00:00.000Z',
    }
    const outcome = await verify()
    expect(outcome).toMatchObject({
      state: 'block',
      blocking: ['独立验证命令被停止'],
      failureKind: 'test_error',
    })
    expect(recorded).toHaveLength(1)
    const report = JSON.parse(readFileSync(outcome.verification!.reportPath, 'utf8')) as {
      commands: Array<{ label: string; aborted: boolean; logPath: string }>
    }
    expect(report.commands[0]).toMatchObject({ label: 'check-1', aborted: true })
    expect(report.commands[0]?.logPath).toContain('check-1.log')
  })

  it('records a block when the candidate commit changed during verification', async () => {
    state.heads = ['head-1', 'head-2']
    const outcome = await verify()
    expect(outcome.state).toBe('block')
    expect(outcome.blocking.join('；')).toContain('验证期间候选提交发生变化')
    expect(recorded).toHaveLength(1)
    expect(failureRounds).toHaveLength(0)
    // 完整性问题不是实现缺陷，不计入正式失败轮次。
  })

  it('records a block when the verification command changed the candidate workspace', async () => {
    state.statusOutput = ' M extra.ts\0'
    const outcome = await verify()
    expect(outcome.state).toBe('block')
    expect(outcome.blocking.join('；')).toContain('验证命令修改了固定候选：extra.ts')
  })
})
