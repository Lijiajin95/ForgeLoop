import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LegacyVerification } from '../src/runtime/legacy-verification.js'
import { resolveConfig } from '../src/config.js'
import type { ForgeLoopConfig } from '../src/config.js'
import type { VerificationPlan } from '../src/domain/verification.js'
import type { VerificationCheckRecord } from '../src/runtime/verification-checks.js'

/**
 * 旧验证链路的执行准备、命令补执行、敏感性对照与业务验收分支。
 * 延续 coverage-legacy-verification.test.ts 的 fixture，但把工作区内容交给
 * runCommand 的 worktree add 步骤生成，从公共入口 verifyCandidate 观察结论。
 */

const state = vi.hoisted(() => ({
  addCode: 0,
  addStdout: '',
  addStderr: '',
  applyCode: 0,
  applyStdout: '',
  applyStderr: '',
  prepareCode: 0,
  tree: 'tree-1',
  heads: ['head-1', 'head-1'],
  headCalls: 0,
  statusOutput: '',
  packageJson: null as string | null,
  controls: null as string | null,
}))

vi.mock('../src/runtime/workspace.js', async () => {
  const { mkdirSync, writeFileSync: write } = await import('node:fs')
  const { join: joinPath } = await import('node:path')
  const seedWorkspace = (workspace: string): void => {
    if (state.packageJson !== null) {
      mkdirSync(workspace, { recursive: true })
      write(joinPath(workspace, 'package.json'), state.packageJson)
    }
    if (state.controls !== null) {
      mkdirSync(joinPath(workspace, 'verification'), { recursive: true })
      write(joinPath(workspace, 'verification', 'controls.json'), state.controls)
    }
  }
  return {
    runCommand: (executable: string, args: readonly string[]) => {
      if (executable === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        seedWorkspace(args[3] ?? '')
        return { code: state.addCode, stdout: state.addStdout, stderr: state.addStderr }
      }
      if (executable === 'git' && args[0] === 'apply') {
        return { code: state.applyCode, stdout: state.applyStdout, stderr: state.applyStderr }
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
  }
})

let root = ''
let config: ForgeLoopConfig
let verification: LegacyVerification
let recorded: unknown[]
let failureRounds: unknown[]
let businessReviews: unknown[]
let snapshot: {
  runs: readonly VerificationCheckRecord[]
  integrityIssues: string[]
  startedAt: string
} | null
let sendStatus: 'completed' | 'aborted' | 'timeout' | 'error'
let attemptNumber = 1
let controlsMode: 'results' | 'null' = 'results'
let responses: Array<{
  status: 'completed' | 'aborted' | 'timeout' | 'error'
  text: string
  reason?: string
}> = []

const check = {
  label: 'check-1',
  argv: ['node', '-e', 'process.exit(0)'],
  expectedOutput: '',
  expectFailure: false,
}

const designWithChecks: VerificationPlan = {
  scenarios: [
    {
      scenario: '完成改动',
      acceptanceCriterion: '改动可见',
      method: '检查文件',
      required: true,
      checks: [check],
    },
  ],
}

const designWithoutChecks: VerificationPlan = {
  scenarios: [
    {
      scenario: '完成改动',
      acceptanceCriterion: '改动可见',
      method: '检查文件',
      required: true,
      checks: [],
    },
  ],
}

// 一个场景已有命令、另一个场景还没有命令：保持设计原样进入执行，
// 用来观察旧方案里省略 checks 的场景在各处按空命令处理。
const designMixed: VerificationPlan = {
  scenarios: [
    {
      scenario: '完成改动',
      acceptanceCriterion: '改动可见',
      method: '检查文件',
      required: true,
      checks: [check],
    },
    {
      scenario: '补充场景',
      acceptanceCriterion: '也可观察',
      method: '稍后再准备命令',
      required: true,
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
    output: 'prepared ok',
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
    recordBusinessReview: (value: unknown) => businessReviews.push(value),
    recordFailureRound: (value: unknown) => failureRounds.push(value),
    nextVerificationAttempt: () => {
      const current = attemptNumber
      attemptNumber += 1
      return {
        attemptNumber: current,
        previousAttemptId: current > 1 ? `verification-v1-${'c'.repeat(12)}-a${current - 1}` : '',
      }
    },
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
      executeControls: async () =>
        controlsMode === 'null'
          ? null
          : {
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
            },
    } as never,
  })
}

function businessReview(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: 'pass',
    summary: '业务通过',
    findings: [],
    blocking: [],
    scenarios: [
      {
        scenario: '完成改动',
        status: 'pass',
        evidence: 'prepared ok',
        commands: ['check-1'],
      },
    ],
    acceptance: [
      {
        criterion: '改动可见',
        status: 'pass',
        evidence: 'prepared ok',
        commands: ['check-1'],
      },
    ],
    ...overrides,
  })
}

function preparation(checks: unknown[]): string {
  return JSON.stringify({
    scenarios: [{ scenario: '完成改动', checks }],
  })
}

function verify(planOverride?: VerificationPlan) {
  const diffPath = join(root, 'candidate.diff')
  writeFileSync(diffPath, 'diff --git a/a.ts b/a.ts\n', 'utf8')
  return verification.verifyCandidate({
    reqId: 'req-1',
    requirement: { reqId: 'req-1', versions: [{ version: 1, text: '实现改动' }] } as never,
    analysis: {
      scenarios: ['完成改动'],
      acceptanceCriteria: ['改动可见'],
      businessRules: [],
      exceptions: [],
    } as never,
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
        send: () => {
          const next = responses.shift()
          return Promise.resolve({
            status: next?.status ?? sendStatus,
            text: next?.text ?? '',
            sessionId: 'session-verify',
            reason: next?.reason ?? 'verification stopped',
            transcriptPath: join(root, 'transcript.jsonl'),
            durationMs: 1,
            toolCalls: [],
          })
        },
        close: () => Promise.resolve(),
      },
      sessionId: 'session-verify',
      plan: planOverride ?? designWithChecks,
      close: () => Promise.resolve(),
    },
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-legacy-branches-'))
  state.addCode = 0
  state.addStdout = ''
  state.addStderr = ''
  state.applyCode = 0
  state.applyStdout = ''
  state.applyStderr = ''
  state.prepareCode = 0
  state.tree = 'tree-1'
  state.heads = ['head-1', 'head-1']
  state.headCalls = 0
  state.statusOutput = ''
  state.packageJson = null
  state.controls = null
  recorded = []
  failureRounds = []
  businessReviews = []
  attemptNumber = 1
  controlsMode = 'results'
  responses = []
  snapshot = { runs: [runRecord()], integrityIssues: [], startedAt: '2026-11-03T10:00:00.000Z' }
  sendStatus = 'completed'
  verification = buildVerification()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('legacy verification workspace failures', () => {
  it('surfaces git stdout when worktree add has no stderr', async () => {
    state.addCode = 1
    state.addStdout = 'fatal: worktree locked'
    const outcome = await verify()
    expect(outcome).toMatchObject({ state: 'block', blocking: ['独立测试工作区创建失败'] })
    expect(outcome.detail).toContain('fatal: worktree locked')
  })

  it('surfaces git stdout when the candidate diff cannot be applied', async () => {
    state.applyCode = 1
    state.applyStdout = 'error: patch failed'
    const outcome = await verify()
    expect(outcome).toMatchObject({ state: 'block', blocking: ['候选 diff 无法应用'] })
    expect(outcome.detail).toContain('error: patch failed')
  })

  it('prepares the workspace and continues after the preparation command succeeds', async () => {
    verification = buildVerification(['prepare-workspace'])
    responses = [{ status: 'completed', text: '' }]
    const outcome = await verify()
    // 准备命令成功后继续执行验证；业务终审收到空材料时按畸形阻断，说明已走到终审。
    expect(outcome.state).toBe('block')
    expect(outcome.detail).toContain('业务验收材料畸形')
  })
})

describe('legacy verification execution preparation', () => {
  it('records the attempt when the preparation turn does not complete', async () => {
    responses = [{ status: 'aborted', text: '', reason: 'prep stopped' }]
    const outcome = await verify(designWithoutChecks)
    expect(outcome).toMatchObject({
      state: 'block',
      blocking: ['测试执行准备未完成：prep stopped'],
      failureKind: 'test_error',
    })
    expect(recorded).toHaveLength(1)
    expect(failureRounds).toHaveLength(1)
  })

  it('records the attempt when the preparation material is malformed', async () => {
    responses = [{ status: 'completed', text: 'not json' }]
    const outcome = await verify(designWithoutChecks)
    expect(outcome.state).toBe('block')
    expect(outcome.detail).toContain('测试执行准备材料畸形')
    expect(recorded).toHaveLength(1)
  })

  it('blocks when prepared checks fail the same plan validation', async () => {
    responses = [
      {
        status: 'completed',
        text: preparation([
          { label: 'regression-only', argv: ['node', '-e', '0'], category: 'regression' },
        ]),
      },
    ]
    const outcome = await verify(designWithoutChecks)
    expect(outcome.state).toBe('block')
    expect(outcome.detail).toContain('测试执行准备未通过校验')
    expect(outcome.detail).toContain('测试方案缺少本次验收（acceptance）检查')
  })
})

describe('legacy verification commands and controls', () => {
  it('retries missing commands and records the attempt when the retry does not complete', async () => {
    snapshot = { runs: [], integrityIssues: [], startedAt: '2026-11-03T10:00:00.000Z' }
    responses = [
      { status: 'completed', text: '' },
      { status: 'aborted', text: '', reason: 'retry stopped' },
    ]
    const outcome = await verify()
    expect(outcome).toMatchObject({
      state: 'block',
      blocking: ['测试命令补充执行未完成：retry stopped'],
      failureKind: 'test_error',
    })
    expect(recorded).toHaveLength(1)
  })

  it('treats scenarios without checks as empty when part of the plan already has commands', async () => {
    responses = [{ status: 'completed', text: '' }]
    const outcome = await verify(designMixed)
    expect(outcome.state).toBe('block')
    expect(outcome.detail).toContain('测试场景没有可执行命令：补充场景')
    expect(recorded).toHaveLength(1)
  })

  it('blocks when the sensitivity controls material is malformed', async () => {
    state.controls = 'not json'
    responses = [{ status: 'completed', text: '' }]
    const outcome = await verify()
    expect(outcome.state).toBe('block')
    expect(outcome.detail).toContain('验证敏感性对照材料畸形')
    expect(recorded).toHaveLength(1)
  })

  it('blocks when the sensitivity control outcome was lost before the verdict', async () => {
    controlsMode = 'null'
    responses = [{ status: 'completed', text: '' }]
    const outcome = await verify()
    expect(outcome).toMatchObject({
      state: 'block',
      blocking: ['验证敏感性对照上下文在结论前丢失；无法核对用例有效性'],
      failureKind: 'undetermined',
    })
  })

  it('records an attempt with no command runs when the execution context was lost', async () => {
    snapshot = null
    sendStatus = 'aborted'
    const outcome = await verify()
    expect(outcome).toMatchObject({
      state: 'block',
      blocking: ['测试执行未取得结论：verification stopped'],
      failureKind: 'test_error',
    })
    expect(recorded).toHaveLength(1)
  })

  it('blocks a failing planned command as an independent verification defect', async () => {
    snapshot = {
      runs: [runRecord({ exitCode: 1, output: 'boom' })],
      integrityIssues: [],
      startedAt: '2026-11-03T10:00:00.000Z',
    }
    responses = [{ status: 'completed', text: '' }]
    const outcome = await verify()
    expect(outcome.state).toBe('block')
    expect(outcome.detail).toContain('独立测试阻断')
    expect(outcome.failureKind).toBeTruthy()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ verdict: 'block' })
  })
})

describe('legacy verification public interface facts', () => {
  it('prepares commands from package scripts and a bin map, then passes business review', async () => {
    state.packageJson = JSON.stringify({
      name: 'demo',
      scripts: { test: 'vitest run', build: 'tsc -p .' },
      bin: { demo: 'bin/demo.js' },
    })
    state.controls = JSON.stringify({
      controls: [
        {
          label: 'check-1',
          patch: 'verification/controls/fault.patch',
          expected_failure_output: 'marker-missing',
        },
      ],
    })
    responses = [
      { status: 'completed', text: preparation([check]) },
      { status: 'completed', text: '' },
      { status: 'completed', text: businessReview() },
    ]
    const outcome = await verify(designWithoutChecks)
    expect(outcome.state).toBe('pass')
    expect(outcome.detail).toContain('通过独立测试与业务验收')
    const report = JSON.parse(readFileSync(outcome.verification!.reportPath, 'utf8')) as {
      verificationPlan: { scenarios: Array<{ checks: Array<{ label: string }> }> }
    }
    expect(report.verificationPlan.scenarios[0]?.checks[0]?.label).toBe('check-1')
    expect(businessReviews).toHaveLength(1)
    expect(businessReviews[0]).toMatchObject({ verdict: 'pass' })
  })

  it('accepts a string bin entry as a public interface fact', async () => {
    state.packageJson = JSON.stringify({ name: 'demo', bin: 'bin/demo.js' })
    controlsMode = 'null'
    responses = [
      { status: 'completed', text: preparation([check]) },
      { status: 'completed', text: '' },
    ]
    const outcome = await verify(designWithoutChecks)
    // 准备阶段已读取 package.json（字符串 bin + 缺省 scripts），随后因对照上下文丢失阻断。
    expect(outcome.state).toBe('block')
    expect(outcome.detail).toContain('验证敏感性对照上下文在结论前丢失')
  })

  it('records a business review block with its blocking reasons', async () => {
    state.packageJson = JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } })
    state.controls = JSON.stringify({
      controls: [
        {
          label: 'check-1',
          patch: 'verification/controls/fault.patch',
          expected_failure_output: 'marker-missing',
        },
      ],
    })
    responses = [
      { status: 'completed', text: preparation([check]) },
      { status: 'completed', text: '' },
      {
        status: 'completed',
        text: businessReview({
          verdict: 'block',
          blocking: ['业务不达标'],
          summary: '阻断',
        }),
      },
    ]
    const outcome = await verify(designWithoutChecks)
    expect(outcome.state).toBe('block')
    expect(outcome.detail).toContain('业务验收阻断：业务终审结论为 block：业务不达标')
    expect(failureRounds).toHaveLength(1)
    expect(businessReviews[0]).toMatchObject({ verdict: 'block' })
  })
})
