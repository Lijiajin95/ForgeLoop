import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { LegacyVerification } from '../src/runtime/legacy-verification.js'
import { VerificationCheckRegistry } from '../src/runtime/verification-checks.js'
import { runFormalTest } from '../src/runtime/formal-test.js'
import {
  verificationAttemptDir,
  verificationPlanDir,
  resolveConfig,
  type ForgeLoopConfig,
} from '../src/config.js'
import {
  VerificationPipeline,
  type VerificationPipelineDeps,
} from '../src/runtime/verification-pipeline.js'
import { applyDiffFile } from '../src/runtime/diff-apply.js'
import { Repository } from '../src/records/repository.js'
import { Database } from '../src/records/db.js'
import { candidateIdentityOf, sha256OfText } from '../src/domain/delivery.js'
import type { VerificationPlan } from '../src/domain/verification.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import type { OperationResult } from '../src/runtime/operation-result.js'
import type { PlannedTask, TaskPlan } from '../src/domain/task-plan.js'

/**
 * 验证链路缺口测试：只通过 LegacyVerification / VerificationPipeline 的公开方法、
 * 仓库记录与真实子进程命令观察结论。重点覆盖验证方案解析与覆盖校验、命令超时与失败、
 * 证据核对、候选固定与工作区摘要、未授权与终态守卫、失败轮次与回修问题单。
 */

const NOW = '2026-11-06T00:00:00.000Z'
const SCENARIO = '候选可用'
const CRITERION = '输出证明候选可用'
const MARKER = 'verified marker ok'
const CONTROL_FAILURE = 'target rule broken'

/** 读 README 的验证命令：正常候选打印标记；受控错误补丁下按目标规则失败。 */
const README_CHECK = [
  "const fs = require('node:fs')",
  "const text = fs.readFileSync('README.md', 'utf8')",
  `if (!text.includes('fixture')) { console.error('${CONTROL_FAILURE}'); process.exit(1) }`,
  `console.log('${MARKER}')`,
].join(';')

const CONTROL_PATCH = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-fixture',
  '+broken',
  '',
].join('\n')

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

interface FixtureProject {
  dir: string
  /** 研发工作开始前的基线提交；验证工作区从它固定。 */
  baseline: string
  /** 基线到研发提交之间的真实 diff。 */
  diffPath: string
}

function makeProject(): FixtureProject {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-gap-deep-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, '.gitignore'), '.forgeloop/\n')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  const baseline = git(dir, ['rev-parse', 'HEAD'])
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs', 'a.md'), 'doc a\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'work'])
  const diff = execFileSync('git', ['diff', `${baseline}..HEAD`, '--binary'], {
    cwd: dir,
    encoding: 'utf8',
  })
  const diffPath = join(dir, '.forgeloop', 'diffs', 'candidate.diff')
  mkdirSync(dirname(diffPath), { recursive: true })
  writeFileSync(diffPath, diff, 'utf8')
  return { dir, baseline, diffPath }
}

function removeProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// LegacyVerification：同一验证会话里的方案、命令执行与业务验收
// ---------------------------------------------------------------------------

const LEGACY_REQ = 'req-gap-legacy'
const LEGACY_CANDIDATE = 'c'.repeat(64)

interface LegacyFixture {
  project: FixtureProject
  config: ForgeLoopConfig
  charges: number[]
  verifications: Array<Record<string, unknown>>
  failureRounds: Array<Record<string, unknown>>
  businessReviews: Array<Record<string, unknown>>
  sent: string[]
  recordsRoot: string
  dir: string
  workspace: string
  closedCount: () => number
  verify: () => Promise<{
    state: 'pass' | 'block'
    detail: string
    blocking: string[]
    verification: { reportPath: string; reportJson: string; reportSha256: string } | null
    failureKind?: string
    repairRecommended?: boolean
  }>
}

interface LegacyOptions {
  plan?: VerificationPlan
  /** controls 缺省为不写敏感性对照文件。 */
  controls?: 'valid' | 'malformed'
  business?:
    | { status: 'aborted' | 'timeout' | 'error' | 'completed'; text?: string; reason?: string }
    | undefined
  phase?: { status: 'aborted' | 'timeout' | 'error'; reason: string }
  skipCommands?: boolean
  formalTestTimeoutSeconds?: number
  signal?: AbortSignal
  diffPath?: string
  snapshotCommit?: string
}

function defaultLegacyPlan(): VerificationPlan {
  return {
    scenarios: [
      {
        scenario: SCENARIO,
        acceptanceCriterion: CRITERION,
        method: '执行 node 命令并核对输出',
        required: true,
        checks: [
          { label: 'ok', argv: [process.execPath, '-e', README_CHECK], expectedOutput: MARKER },
        ],
      },
    ],
  }
}

function legacyAnalysis() {
  return {
    reqId: LEGACY_REQ,
    analysisVersion: 1,
    requirementVersion: 1,
    goal: '交付文档',
    scenarios: [SCENARIO],
    acceptanceCriteria: [CRITERION],
    businessRules: [],
    exceptions: [],
    nonGoals: [],
    clarifications: [],
    businessPoints: [],
    acceptanceItems: [],
    model: 'fake',
    promptVersion: 'v1',
    transcriptPath: '',
    toolCalls: [],
    createdAt: NOW,
  }
}

function legacyRequirement() {
  return {
    reqId: LEGACY_REQ,
    project: 'demo',
    status: 'executing',
    versions: [
      { version: 1, text: '交付文档', createdAt: NOW, revisedBy: 'owner', source: 'test' },
    ],
  }
}

function legacyTaskPlan(): TaskPlan {
  return {
    taskPlanId: 'plan-gap-legacy',
    requirementId: LEGACY_REQ,
    project: 'demo',
    planVersion: 1,
    requirementVersion: 1,
    tasks: [],
    createdAt: NOW,
  }
}

function businessReviewText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: 'pass',
    summary: '业务通过',
    findings: [],
    blocking: [],
    scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: MARKER, commands: ['ok'] }],
    acceptance: [{ criterion: CRITERION, status: 'pass', evidence: MARKER, commands: ['ok'] }],
    ...overrides,
  })
}

function makeLegacy(options: LegacyOptions = {}): LegacyFixture {
  const project = makeProject()
  // 记录根必须在被验证仓库之外：敏感性对照在复制目录里执行 git apply，
  // 位于仓库子目录时 git 会静默忽略仓库根相对路径，无法证明对照有效。
  const recordsRoot = mkdtempSync(join(tmpdir(), 'forgeloop-gap-records-'))
  const plan = options.plan ?? defaultLegacyPlan()
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: project.dir,
      recordsRoot,
      owner: 'owner',
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 10 },
      formalTestTimeoutSeconds: options.formalTestTimeoutSeconds ?? 10,
    },
    project.dir,
  )
  const dir = verificationAttemptDir(config, {
    reqId: LEGACY_REQ,
    planVersion: 1,
    candidateSha256: LEGACY_CANDIDATE,
    attemptNumber: 1,
  })
  const workspace = join(dir, 'workspace')
  const charges: number[] = []
  const verifications: Array<Record<string, unknown>> = []
  const failureRounds: Array<Record<string, unknown>> = []
  const businessReviews: Array<Record<string, unknown>> = []
  const sent: string[] = []
  let closes = 0

  const checks = new VerificationCheckRegistry({
    ctx: {} as never,
    formalTest: runFormalTest,
    now: () => NOW,
  })

  const session = {
    sessionId: 'session-legacy-verify',
    close: async () => {
      closes += 1
    },
    send: async (turn: { prompt: string; transcriptPath: string }) => {
      sent.push(turn.prompt)
      if (turn.prompt.includes('做业务验收')) {
        const business = options.business ?? { status: 'completed' as const }
        return {
          status: business.status,
          text: business.text ?? businessReviewText(),
          sessionId: 'session-legacy-verify',
          reason: business.reason ?? '',
          transcriptPath: turn.transcriptPath,
          durationMs: 1,
          toolCalls: [],
        }
      }
      if (options.phase) {
        return {
          status: options.phase.status,
          text: '',
          sessionId: 'session-legacy-verify',
          reason: options.phase.reason,
          transcriptPath: turn.transcriptPath,
          durationMs: 1,
          toolCalls: [],
        }
      }
      if (options.controls === 'valid') {
        mkdirSync(join(workspace, 'verification', 'controls'), { recursive: true })
        writeFileSync(
          join(workspace, 'verification', 'controls.json'),
          JSON.stringify({
            controls: [
              {
                label: 'ok',
                patch: 'verification/controls/fault.patch',
                expected_failure_output: CONTROL_FAILURE,
              },
            ],
          }),
          'utf8',
        )
        writeFileSync(
          join(workspace, 'verification', 'controls', 'fault.patch'),
          CONTROL_PATCH,
          'utf8',
        )
      } else if (options.controls === 'malformed') {
        mkdirSync(join(workspace, 'verification'), { recursive: true })
        writeFileSync(join(workspace, 'verification', 'controls.json'), '{not json', 'utf8')
      }
      if (!options.skipCommands) {
        for (const scenario of plan.scenarios) {
          for (const check of scenario.checks) {
            await checks.run(LEGACY_REQ, check.label)
          }
        }
      }
      return {
        status: 'completed',
        text: '',
        sessionId: 'session-legacy-verify',
        reason: '',
        transcriptPath: turn.transcriptPath,
        durationMs: 1,
        toolCalls: [],
      }
    },
  }

  const repo = {
    nextVerificationAttempt: () => ({ attemptNumber: 1, previousAttemptId: '' }),
    recordVerification: (value: Record<string, unknown>) => verifications.push(value),
    recordFailureRound: (_reqId: string, value: Record<string, unknown>) =>
      failureRounds.push(value),
    recordBusinessReview: (value: Record<string, unknown>) => businessReviews.push(value),
  }

  const verification = new LegacyVerification({
    config,
    repo: repo as never,
    now: () => NOW,
    charge: (_reqId, started) => charges.push(started),
    openAgent: async () => {
      throw new Error('verifyCandidate 不新开会话')
    },
    checks: checks as never,
  })

  return {
    project,
    recordsRoot,
    config,
    charges,
    verifications,
    failureRounds,
    businessReviews,
    sent,
    dir,
    workspace,
    closedCount: () => closes,
    verify: () =>
      verification.verifyCandidate({
        reqId: LEGACY_REQ,
        requirement: legacyRequirement() as never,
        analysis: legacyAnalysis() as never,
        plan: legacyTaskPlan(),
        candidate: {
          reqId: LEGACY_REQ,
          planVersion: 1,
          candidateVersion: 1,
          candidateSha256: LEGACY_CANDIDATE,
          requirementVersion: 1,
          baselineCommit: project.baseline,
          snapshotCommit: options.snapshotCommit ?? project.baseline,
          diffPath: options.diffPath ?? project.diffPath,
          diffSha256: 'd'.repeat(64),
          createdAt: NOW,
        },
        devWorkspace: project.dir,
        signal: options.signal ?? new AbortController().signal,
        verification: {
          session: session as never,
          sessionId: 'session-legacy-verify',
          plan,
          close: async () => {
            closes += 1
          },
        },
      }),
  }
}

describe('LegacyVerification plan opening', () => {
  let project: FixtureProject
  let config: ForgeLoopConfig

  beforeEach(() => {
    project = makeProject()
    config = resolveConfig(
      {
        project: 'demo',
        projectPath: project.dir,
        recordsRoot: join(project.dir, '.forgeloop'),
        owner: 'owner',
        pollSeconds: 1,
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 10 },
        formalTestTimeoutSeconds: 10,
      },
      project.dir,
    )
  })

  afterEach(() => removeProject(project.dir))

  function openHarness(planText: string) {
    const charges: number[] = []
    let closes = 0
    let sends = 0
    const verification = new LegacyVerification({
      config,
      repo: {} as never,
      now: () => NOW,
      charge: (_reqId, started) => charges.push(started),
      openAgent: async () =>
        ({
          sessionId: 'session-plan',
          close: async () => {
            closes += 1
          },
          send: async (turn: { transcriptPath: string }) => {
            sends += 1
            return {
              status: 'completed',
              text: planText,
              sessionId: 'session-plan',
              reason: '',
              transcriptPath: turn.transcriptPath,
              durationMs: 1,
              toolCalls: [],
            }
          },
        }) as never,
      checks: {} as never,
    })
    return {
      verification,
      charges,
      closes: () => closes,
      sends: () => sends,
    }
  }

  it('fails closed when the proposed plan does not cover the analysis text', async () => {
    const harness = openHarness(
      JSON.stringify({
        scenarios: [
          {
            scenario: '别的业务场景',
            acceptance_criterion: '别的验收标准',
            method: '执行其它命令',
            required: true,
            checks: [{ label: 'ok', argv: [process.execPath, '-e', "console.log('x')"] }],
          },
        ],
      }),
    )
    const opened = await harness.verification.openVerification({
      reqId: LEGACY_REQ,
      requirement: legacyRequirement() as never,
      analysis: legacyAnalysis() as never,
      plan: legacyTaskPlan(),
      signal: new AbortController().signal,
    })
    expect(opened.ok).toBe(false)
    if (opened.ok) throw new Error('unreachable')
    expect(opened.result.state).toBe('block')
    expect(opened.result.verification).toBeNull()
    expect(opened.result.detail).toContain('验证方案未取得可用结果')
    expect(opened.result.detail).toContain('验证计划缺少业务场景：候选可用')
    expect(opened.result.detail).toContain('验证计划缺少验收标准：输出证明候选可用')
    // 方案修复重试有上限：三次不合格后 fail-closed，且关闭会话、照常计工时。
    expect(harness.sends()).toBe(3)
    expect(harness.closes()).toBe(1)
    expect(harness.charges).toHaveLength(1)
    expect(
      existsSync(join(verificationPlanDir(config, LEGACY_REQ, 1), 'verification-plan.json')),
    ).toBe(false)
  })

  it('opens a session and persists the parsed plan when coverage holds', async () => {
    const planText = JSON.stringify({
      scenarios: [
        {
          scenario: `${SCENARIO}（独立副本）`,
          acceptance_criterion: `${CRITERION}：命令退出 0 且输出标记`,
          method: `验证：场景 ${SCENARIO}；标准 ${CRITERION}`,
          required: true,
          checks: [{ label: 'ok', argv: [process.execPath, '-e', README_CHECK] }],
        },
      ],
    })
    const harness = openHarness(planText)
    const opened = await harness.verification.openVerification({
      reqId: LEGACY_REQ,
      requirement: legacyRequirement() as never,
      analysis: legacyAnalysis() as never,
      plan: legacyTaskPlan(),
      signal: new AbortController().signal,
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error('unreachable')
    expect(opened.value.sessionId).toBe('session-plan')
    expect(opened.value.plan.scenarios).toHaveLength(1)
    expect(opened.value.plan.scenarios[0]?.checks[0]?.label).toBe('ok')
    const planPath = join(verificationPlanDir(config, LEGACY_REQ, 1), 'verification-plan.json')
    expect(existsSync(planPath)).toBe(true)
    expect(JSON.parse(readFileSync(planPath, 'utf8'))).toEqual(opened.value.plan)
    expect(harness.charges).toHaveLength(1)
  })
})

describe('LegacyVerification candidate fixing and execution', () => {
  let fixture: LegacyFixture | null = null

  afterEach(() => {
    if (fixture) {
      removeProject(fixture.project.dir)
      rmSync(fixture.recordsRoot, { recursive: true, force: true })
    }
    fixture = null
  })

  function legacy(options: LegacyOptions = {}): LegacyFixture {
    fixture = makeLegacy(options)
    return fixture
  }

  it('blocks when the independent worktree cannot be created from the snapshot', async () => {
    const built = legacy({ snapshotCommit: 'd'.repeat(40) })
    const outcome = await built.verify()
    expect(outcome.state).toBe('block')
    expect(outcome.verification).toBeNull()
    expect(outcome.blocking).toEqual(['独立验证工作区创建失败'])
    expect(outcome.detail).toContain('无法从研发现场创建独立验证工作区')
    expect(built.failureRounds).toHaveLength(0)
  })

  it('blocks when the candidate diff cannot be applied to the fixed worktree', async () => {
    const brokenDir = mkdtempSync(join(tmpdir(), 'forgeloop-gap-broken-'))
    try {
      const broken = join(brokenDir, 'broken.diff')
      writeFileSync(broken, 'this is not a diff\n', 'utf8')
      const built = legacy({ diffPath: broken })
      const outcome = await built.verify()
      expect(outcome.state).toBe('block')
      expect(outcome.verification).toBeNull()
      expect(outcome.blocking).toEqual(['候选 diff 无法应用'])
      expect(outcome.detail).toContain('候选 diff 无法应用到独立验证工作区')
    } finally {
      rmSync(brokenDir, { recursive: true, force: true })
    }
  })

  it('stops before judgement when the verification turn does not complete', async () => {
    const built = legacy({ phase: { status: 'timeout', reason: 'host timeout' } })
    const outcome = await built.verify()
    expect(outcome).toMatchObject({
      state: 'block',
      detail: '验证执行未取得结论：host timeout',
      blocking: ['验证执行未取得结论：host timeout'],
      verification: null,
    })
    expect(built.charges).toHaveLength(1)
    expect(built.failureRounds).toHaveLength(0)
  })

  it('blocks when the agent skipped a planned command instead of inventing output', async () => {
    const built = legacy({ skipCommands: true })
    const outcome = await built.verify()
    expect(outcome.state).toBe('block')
    expect(outcome.verification).toBeNull()
    expect(outcome.detail).toBe('验证 Agent 没有通过工具执行方案中的命令：ok')
    expect(built.verifications).toHaveLength(0)
  })

  it('blocks a stopped validation command before any business verdict', async () => {
    const controller = new AbortController()
    controller.abort()
    const built = legacy({ signal: controller.signal })
    const outcome = await built.verify()
    expect(outcome.state).toBe('block')
    expect(outcome.verification).toBeNull()
    expect(outcome.blocking).toEqual(['独立验证命令被停止'])
    expect(outcome.detail).toBe('独立验证命令被停止；验证工作区可丢弃，可重新验证')
  })

  it('classifies a timed-out command as undetermined and never asks for a code repair', async () => {
    const built = legacy({
      formalTestTimeoutSeconds: 1,
      plan: {
        scenarios: [
          {
            scenario: SCENARIO,
            acceptanceCriterion: CRITERION,
            method: '执行会挂起的命令',
            required: true,
            checks: [
              {
                label: 'slow',
                argv: [process.execPath, '-e', 'setTimeout(function () {}, 5000)'],
                expectedOutput: '',
              },
            ],
          },
        ],
      },
    })
    const started = Date.now()
    const outcome = await built.verify()
    expect(Date.now() - started).toBeLessThan(4000)
    expect(outcome.state).toBe('block')
    expect(outcome.failureKind).toBe('undetermined')
    expect(outcome.repairRecommended).toBe(false)
    expect(outcome.detail).toContain('验证命令超时：slow')
    const record = built.verifications[0] as Record<string, unknown>
    expect(record.verdict).toBe('block')
    expect(record.failureKind).toBe('undetermined')
    const report = JSON.parse(readFileSync(String(record.reportPath), 'utf8'))
    expect(report.commands[0]).toMatchObject({ label: 'slow', timedOut: true })
    expect(report.failureReasons.join('；')).toContain('验证命令超时：slow')
    expect(built.failureRounds).toHaveLength(1)
    expect(built.failureRounds[0]?.stage).toBe('verification')
  })

  it('classifies an assertion failure as an implementation defect with repair guidance', async () => {
    const built = legacy({
      plan: {
        scenarios: [
          {
            scenario: SCENARIO,
            acceptanceCriterion: CRITERION,
            method: '执行断言命令',
            required: true,
            checks: [
              {
                label: 'smoke',
                argv: [
                  process.execPath,
                  '-e',
                  "console.error('AssertionError: expected fixture, got broken'); process.exit(1)",
                ],
                expectedOutput: '',
              },
            ],
          },
        ],
      },
    })
    const outcome = await built.verify()
    expect(outcome.state).toBe('block')
    expect(outcome.failureKind).toBe('implementation_defect')
    expect(outcome.repairRecommended).toBe(true)
    expect(outcome.detail).toContain('独立验证阻断（implementation_defect）')
    expect(outcome.detail).toContain('验证命令失败：smoke（退出码 1）')
    const record = built.verifications[0] as Record<string, unknown>
    expect(record.failureKind).toBe('implementation_defect')
    expect(built.failureRounds).toHaveLength(1)
    expect(String(built.failureRounds[0]?.summary)).toContain(
      '独立验证阻断（implementation_defect）',
    )
  })

  it('detects a command that modified the pinned candidate outside verification/', async () => {
    const built = legacy({
      plan: {
        scenarios: [
          {
            scenario: SCENARIO,
            acceptanceCriterion: CRITERION,
            method: '执行会写业务文件的命令',
            required: true,
            checks: [
              {
                label: 'mutate',
                argv: [
                  process.execPath,
                  '-e',
                  [
                    "require('node:fs').writeFileSync('docs/extra.md', 'tampered\\n')",
                    `console.log('mutated candidate output')`,
                  ].join('; '),
                ],
                expectedOutput: '',
              },
            ],
          },
        ],
      },
    })
    const outcome = await built.verify()
    expect(outcome.state).toBe('block')
    expect(outcome.failureKind).toBe('test_error')
    expect(outcome.repairRecommended).toBe(false)
    expect(outcome.detail).toContain('验证命令修改了固定候选：docs/extra.md')
    const record = built.verifications[0] as Record<string, unknown>
    const report = JSON.parse(readFileSync(String(record.reportPath), 'utf8'))
    expect(report.candidateIntegrity.changes).toContain('docs/extra.md')
    expect(report.candidateIntegrity.allowedPaths).toEqual(['verification/'])
    expect(built.failureRounds).toHaveLength(1)
  })

  it('passes with a proven sensitivity control and records pinned workspace evidence', async () => {
    const built = legacy({ controls: 'valid' })
    const outcome = await built.verify()
    expect(outcome.state, outcome.detail).toBe('pass')
    expect(outcome.detail).toContain(
      `候选 ${LEGACY_CANDIDATE.slice(0, 16)}… 通过独立验证与业务验收（1 条命令）`,
    )

    const record = built.verifications[0] as Record<string, unknown>
    const report = JSON.parse(readFileSync(String(record.reportPath), 'utf8'))
    const workspaceTree = git(built.workspace, ['rev-parse', 'HEAD^{tree}'])
    expect(report.workspaceSha256).toBe(workspaceTree)
    expect(report.candidateSha256).toBe(LEGACY_CANDIDATE)
    expect(report.snapshotCommit).toBe(built.project.baseline)
    expect(report.controls).toHaveLength(1)
    expect(report.controls[0]).toMatchObject({ label: 'ok', applied: true, exitCode: 1, issue: '' })
    expect(report.verificationPlan.scenarios[0].scenario).toBe(SCENARIO)

    // 候选身份与工作区摘要同时落在 candidate.json 与 verification.json，二者必须一致。
    const candidate = JSON.parse(readFileSync(join(built.dir, 'candidate.json'), 'utf8'))
    expect(candidate.candidateSha256).toBe(LEGACY_CANDIDATE)
    expect(candidate.snapshotCommit).toBe(built.project.baseline)
    expect(candidate.workspaceSha256).toBe(workspaceTree)
    expect(report.workspaceSha256).toBe(candidate.workspaceSha256)

    expect(built.businessReviews).toHaveLength(1)
    const business = built.businessReviews[0] as Record<string, unknown>
    expect(business.verdict).toBe('pass')
    expect(business.verificationSha256).toBe(record.reportSha256)
    expect(existsSync(String(business.reportPath))).toBe(true)
    const businessReport = JSON.parse(readFileSync(String(business.reportPath), 'utf8'))
    expect(businessReport.candidateSha256).toBe(LEGACY_CANDIDATE)
    expect(businessReport.scenarios[0]).toMatchObject({ text: SCENARIO, status: 'pass' })
    expect(built.failureRounds).toHaveLength(0)
  })

  it('passes without controls but records that no sensitivity was proven', async () => {
    const built = legacy()
    const outcome = await built.verify()
    expect(outcome.state, outcome.detail).toBe('pass')
    const record = built.verifications[0] as Record<string, unknown>
    const report = JSON.parse(readFileSync(String(record.reportPath), 'utf8'))
    expect(report.verdict).toBe('pass')
    expect(report.controls).toEqual([])
    expect(report.blocking).toEqual([])
    expect(built.businessReviews).toHaveLength(1)
  })

  it('records a business-review failure round when the review turn does not finish', async () => {
    const built = legacy({
      business: { status: 'aborted', reason: 'business stopped' },
    })
    const outcome = await built.verify()
    expect(outcome.state).toBe('block')
    expect(outcome.verification).not.toBeNull()
    expect(outcome.detail).toBe('业务验收未取得结论：business stopped')
    expect(outcome.blocking).toEqual(['business stopped'])
    expect(built.verifications).toHaveLength(1)
    expect(built.businessReviews).toHaveLength(0)
    expect(built.failureRounds).toHaveLength(1)
    expect(built.failureRounds[0]?.stage).toBe('business_review')
    expect(String(built.failureRounds[0]?.summary)).toContain(
      '业务验收未取得结论：business stopped',
    )
  })

  it('fails closed and records a failure round for a malformed business review', async () => {
    const built = legacy({ business: { status: 'completed', text: 'not json' } })
    const outcome = await built.verify()
    expect(outcome.state).toBe('block')
    expect(outcome.detail).toContain('业务验收材料畸形：')
    expect(outcome.blocking[0]).toBe(outcome.detail)
    expect(built.businessReviews).toHaveLength(0)
    expect(built.failureRounds).toHaveLength(1)
    expect(built.failureRounds[0]?.stage).toBe('business_review')
    expect(String(built.failureRounds[0]?.summary)).toContain('业务验收材料畸形：')
  })
})

// ---------------------------------------------------------------------------
// VerificationPipeline：候选固定、命令重放、证据核对与问题单生成
// ---------------------------------------------------------------------------

const PIPE_REQ = 'req-gap-pipeline'
const LABEL = 'smoke'
const OUTPUT = MARKER

let pipelineProjectDir = ''
let pipelineRecordsDir = ''
let repo: Repository

interface PipelineOptions {
  analysisRequirementVersion?: number
  clarifications?: string[]
  authorize?: () => { ok: true; value: { plan: TaskPlan } } | { ok: false; result: OperationResult }
  commands?: Array<{ label: string; argv: string[] }>
  report?: Record<string, unknown>
  controls?: boolean
  formalTestTimeoutSeconds?: number
}

function pipelineConfig(options: PipelineOptions = {}): ForgeLoopConfig {
  return resolveConfig(
    {
      project: 'demo',
      projectPath: pipelineProjectDir,
      recordsRoot: pipelineRecordsDir,
      owner: 'owner',
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: options.formalTestTimeoutSeconds ?? 30,
      maxTaskAttempts: 2,
      failureRoundsPerGrant: 2,
    },
    pipelineProjectDir,
  )
}

function pipelineTask(taskId = 'a'): PlannedTask {
  return {
    taskId,
    goal: `写 ${taskId}`,
    files: [`docs/${taskId}.md`],
    acceptance: `${taskId} 存在`,
    testCommand: [process.execPath, '-e', 'process.exit(0)'],
    dependsOn: [],
    limits: { limitSeconds: -1, maxFailureRounds: 2 },
    authorizationSource: 'plan-approval:owner',
  }
}

function pipelinePlan(): TaskPlan {
  return {
    taskPlanId: `plan-${PIPE_REQ}-v1`,
    requirementId: PIPE_REQ,
    project: 'demo',
    planVersion: 1,
    requirementVersion: 1,
    tasks: [pipelineTask()],
    createdAt: NOW,
  }
}

function planReviewJson(verdict: 'pass' | 'block' = 'pass'): string {
  return JSON.stringify({
    kind: 'plan-review',
    reqId: PIPE_REQ,
    planVersion: 1,
    requirementVersion: 1,
    planSha256: 'x',
    verdict,
    blocking: verdict === 'block' ? ['任务包缺少正式测试证据'] : [],
    findings: [],
    summary: verdict === 'pass' ? '任务包可进入实现' : '任务包阻断',
    verification_plan: [
      {
        scenario: SCENARIO,
        acceptance_criterion: CRITERION,
        method: '在独立候选上执行验证命令',
        required: true,
      },
    ],
    sessionId: 'session-plan-review',
    at: NOW,
  })
}

function pipelineReport(
  overrides: { scenario?: string; status?: string; evidence?: string; commands?: string[] } = {},
): Record<string, unknown> {
  return {
    verdict: 'pass',
    summary: '候选通过独立验证',
    findings: [],
    blocking: [],
    scenarios: [
      {
        scenario: overrides.scenario ?? SCENARIO,
        status: overrides.status ?? 'pass',
        evidence: overrides.evidence ?? OUTPUT,
        commands: overrides.commands ?? [LABEL],
      },
    ],
  }
}

function defaultCommands(): Array<{ label: string; argv: string[] }> {
  return [{ label: LABEL, argv: [process.execPath, '-e', `console.log('${OUTPUT}')`] }]
}

function pipelineAgentResult(
  request: AgentRunRequest,
  text: string,
  status: AgentRunResult['status'] = 'completed',
  reason = '',
): AgentRunResult {
  return {
    status,
    text,
    sessionId: `session-fake-${request.role}`,
    reason,
    transcriptPath: request.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  }
}

function identityOf(plan: TaskPlan, artifacts: ReturnType<Repository['taskArtifacts']>): string {
  const ordered = plan.tasks.map((task) => {
    const artifact = artifacts.find((candidate) => candidate.taskId === task.taskId)
    if (!artifact) throw new Error(`任务 ${task.taskId} 缺少交付产物`)
    return artifact
  })
  return candidateIdentityOf({
    planVersion: plan.planVersion,
    requirementVersion: plan.requirementVersion,
    baselineCommit: ordered[0]?.baselineCommit ?? '',
    candidateHashes: ordered.map((artifact) => artifact.candidateSha256),
  })
}

function setupPipeline(options: PipelineOptions = {}) {
  const config = pipelineConfig(options)
  const plan = pipelinePlan()

  repo.submit({
    reqId: PIPE_REQ,
    project: 'demo',
    text: '交付文档 a',
    submittedBy: 'owner',
    source: 'test',
    now: NOW,
  })
  if ((options.analysisRequirementVersion ?? 1) > 1) {
    repo.appendVersion({
      reqId: PIPE_REQ,
      text: '修订后的需求',
      revisedBy: 'owner',
      source: 'test',
      now: NOW,
    })
  }
  repo.recordAnalysis({
    reqId: PIPE_REQ,
    analysisVersion: 1,
    requirementVersion: options.analysisRequirementVersion ?? 1,
    goal: '交付文档 a',
    scenarios: [SCENARIO],
    businessRules: [],
    exceptions: [],
    nonGoals: [],
    acceptanceCriteria: [CRITERION],
    clarifications: options.clarifications ?? [],
    model: 'fake',
    promptVersion: 'v1',
    transcriptPath: '',
    toolCalls: [],
    createdAt: NOW,
  })

  repo.recordTaskArtifact({
    requirementId: PIPE_REQ,
    planVersion: 1,
    taskId: 'a',
    candidateSha256: 'candidate-a',
    testEvidenceSha256: 'test-a',
    reviewSha256: 'review-a',
    acceptance: 'a 存在',
    authorizationSource: 'plan-approval:owner',
    recordedAt: NOW,
    baselineCommit: 'base',
  })
  const reviewJson = planReviewJson()
  const reviewPath = join(pipelineRecordsDir, 'reviews', PIPE_REQ, 'plan-review.json')
  mkdirSync(dirname(reviewPath), { recursive: true })
  writeFileSync(reviewPath, reviewJson, 'utf8')
  repo.recordPlanReview({
    requirementId: PIPE_REQ,
    planVersion: 1,
    requirementVersion: 1,
    planSha256: sha256OfText(reviewJson),
    verdict: 'pass',
    reportJson: reviewJson,
    reportPath: reviewPath,
    reportSha256: sha256OfText(reviewJson),
    sessionId: 'session-plan-review',
    reviewedAt: NOW,
  })

  const candidatePath = join(pipelineProjectDir, '.forgeloop', 'diffs', 'a.diff')
  mkdirSync(dirname(candidatePath), { recursive: true })
  writeFileSync(candidatePath, '', 'utf8')
  repo.recordEvidence({
    requirementId: PIPE_REQ,
    planVersion: 1,
    taskId: 'a',
    baselineCommit: 'base',
    workspacePath: '/tmp/nowhere',
    candidatePath,
    testLogPath: '/tmp/nowhere.log',
    reviewPath: '/tmp/nowhere.json',
    devSession: 'dev-session',
    reviewSession: 'review-session',
    recordedAt: NOW,
  })

  const charges: number[] = []
  const reopened: Array<{ reqId: string; identity: string; reason: string; plan: TaskPlan }> = []
  const verifyPrompts: string[] = []
  let testCalls = 0

  const runner = {
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      if (request.prompt.includes('独立验证 Agent')) {
        verifyPrompts.push(request.prompt)
        const verification = join(request.cwd, 'verification')
        mkdirSync(verification, { recursive: true })
        writeFileSync(
          join(verification, 'commands.json'),
          JSON.stringify({ commands: options.commands ?? defaultCommands() }),
          'utf8',
        )
        writeFileSync(
          join(verification, 'report.json'),
          JSON.stringify(options.report ?? pipelineReport()),
          'utf8',
        )
        if (options.controls) {
          mkdirSync(join(verification, 'controls'), { recursive: true })
          writeFileSync(
            join(verification, 'controls.json'),
            JSON.stringify({
              controls: [
                {
                  label: LABEL,
                  patch: 'verification/controls/fault.patch',
                  expected_failure_output: CONTROL_FAILURE,
                },
              ],
            }),
            'utf8',
          )
          writeFileSync(join(verification, 'controls', 'fault.patch'), CONTROL_PATCH, 'utf8')
        }
        return pipelineAgentResult(request, '{}')
      }
      return pipelineAgentResult(
        request,
        JSON.stringify({
          verdict: 'pass',
          summary: '业务终审通过',
          findings: [],
          blocking: [],
          scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: OUTPUT, commands: [LABEL] }],
          acceptance: [
            { criterion: CRITERION, status: 'pass', evidence: OUTPUT, commands: [LABEL] },
          ],
        }),
      )
    },
  }

  const deps: VerificationPipelineDeps = {
    config,
    repo,
    now: () => NOW,
    charge: (_reqId, started) => charges.push(started),
    runner,
    formalTest: (async (request) => {
      testCalls += 1
      return runFormalTest(request)
    }) as unknown as typeof runFormalTest,
    ctx: {} as never,
    openAgent: async () => {
      throw new Error('验证流水线不应打开多轮会话')
    },
    candidateIdentity: identityOf,
    requireAuthorizedPlan: options.authorize ?? (() => ({ ok: true, value: { plan } }) as const),
    applyDiffFile,
    reopenDeliveredTasks: (input) => {
      reopened.push(input)
      return [{ taskId: 'a', attempt: 1, archivedPath: '/tmp/archived' }]
    },
    verificationBaseline: () => planReviewJson() as never,
    remainingFailureRounds: () => 2,
  }

  return {
    pipeline: new VerificationPipeline(deps),
    config,
    plan,
    charges,
    reopened,
    verifyPrompts,
    testCalls: () => testCalls,
    identity: () => identityOf(plan, repo.taskArtifacts(PIPE_REQ, 1)),
  }
}

function pipelineStatus(): string {
  return repo.getRequirement(PIPE_REQ)?.status ?? ''
}

function pipelineBlockedReason(): string {
  return repo.getRequirement(PIPE_REQ)?.blockedReason ?? ''
}

/** 最新一次尝试的分类保存在尝试历史里；最新结果投影不包含 failure_kind。 */
function latestPipelineAttempt(identity: string) {
  return repo.verificationAttemptsForCandidate(PIPE_REQ, 1, identity).at(-1)
}

describe('VerificationPipeline gates and fixed candidate', () => {
  beforeEach(() => {
    pipelineProjectDir = makeProject().dir
    // 验证证据目录放在被验证仓库之外，敏感性对照的 git apply 才能触及业务文件。
    pipelineRecordsDir = mkdtempSync(join(tmpdir(), 'forgeloop-gap-pipeline-records-'))
    repo = new Repository(Database.open(join(pipelineRecordsDir, 'records.sqlite')))
  })

  afterEach(() => {
    repo.close()
    removeProject(pipelineProjectDir)
    rmSync(pipelineRecordsDir, { recursive: true, force: true })
  })

  it('refuses verification without an authorized plan', async () => {
    const built = setupPipeline({
      authorize: () => ({
        ok: false,
        result: { ok: false, code: 'blocked', message: '任务包尚未批准' },
      }),
    })
    const outcome = await built.pipeline.executeVerification(PIPE_REQ, new AbortController().signal)
    expect(outcome).toEqual({ state: 'failed', detail: '任务包尚未批准' })
    expect(built.testCalls()).toBe(0)
  })

  it('refuses verification when the analysis binds a different requirement version', async () => {
    const built = setupPipeline({ analysisRequirementVersion: 2 })
    const outcome = await built.pipeline.executeVerification(PIPE_REQ, new AbortController().signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '最新分析依据需求 v2，任务包依据 v1；版本不一致，不能开始独立验证',
    })
    expect(built.testCalls()).toBe(0)
  })

  it('refuses verification while clarifications remain open', async () => {
    const built = setupPipeline({ clarifications: ['待确认计数口径'] })
    const outcome = await built.pipeline.executeVerification(PIPE_REQ, new AbortController().signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '需求仍有待澄清项；不能开始独立验证',
    })
    expect(built.testCalls()).toBe(0)
  })

  it('treats a timed-out command as undetermined and keeps the failure round', async () => {
    const built = setupPipeline({
      formalTestTimeoutSeconds: 1,
      commands: [
        { label: 'slow', argv: [process.execPath, '-e', 'setTimeout(function () {}, 5000)'] },
      ],
      report: pipelineReport({ commands: ['slow'], evidence: 'slow command evidence' }),
    })
    const started = Date.now()
    const outcome = await built.pipeline.executeVerification(PIPE_REQ, new AbortController().signal)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('验证命令失败：slow 超时')
    expect(outcome.detail).toContain('独立验证阻断（undetermined）')
    expect(built.reopened).toEqual([])
    const record = repo.verification(PIPE_REQ, 1)
    expect(record?.verdict).toBe('block')
    expect(latestPipelineAttempt(built.identity())?.failureKind).toBe('undetermined')
    const report = JSON.parse(record!.reportJson)
    expect(report.commands[0]).toMatchObject({ label: 'slow', timedOut: true })
    expect(report.failureReasons.join('；')).toContain('验证命令超时：slow')
    expect(repo.failureRounds(PIPE_REQ)).toHaveLength(1)
    expect(repo.failureRounds(PIPE_REQ)[0]?.stage).toBe('verification')
    expect(pipelineStatus()).toBe('blocked')
  })

  it('returns an assertion failure to development with a concrete repair problem', async () => {
    const built = setupPipeline({
      controls: true,
      commands: [
        {
          label: LABEL,
          argv: [
            process.execPath,
            '-e',
            [
              "const fs = require('node:fs')",
              "const text = fs.readFileSync('README.md', 'utf8')",
              `if (!text.includes('fixture')) { console.error('${CONTROL_FAILURE}'); process.exit(1) }`,
              "console.error('AssertionError: expected fixture, got broken candidate')",
              'process.exit(1)',
            ].join(';'),
          ],
        },
      ],
      report: pipelineReport(),
    })
    const outcome = await built.pipeline.executeVerification(PIPE_REQ, new AbortController().signal)
    expect(outcome.state).toBe('repair')
    expect(outcome.detail).toContain('已返回研发修复，任务包 v1 不变')
    expect(outcome.detail).toContain('独立验证阻断（实现缺陷）')
    expect(built.reopened).toHaveLength(1)
    const problem = built.reopened[0]!
    expect(problem.identity).toBe(built.identity())
    expect(problem.reason).toContain('实现缺陷')
    expect(problem.reason).toContain('业务断言失败：smoke')
    expect(problem.reason).toContain('预期与用例：候选可用（在独立候选上执行验证命令）')
    expect(problem.reason).toContain('日志：smoke:')
    expect(latestPipelineAttempt(built.identity())?.failureKind).toBe('implementation_defect')
    expect(repo.failureRounds(PIPE_REQ)).toHaveLength(1)
    expect(pipelineStatus()).toBe('blocked')
    expect(pipelineBlockedReason()).toContain('已返回研发修复')
    expect(pipelineBlockedReason()).toContain('剩余 2')
  })

  it('classifies a command without an exit code as an environment error and does not reopen tasks', async () => {
    const built = setupPipeline({
      // 缺失必过场景时不做敏感性覆盖校验，才能观察“无退出码”优先归为环境问题。
      commands: [{ label: LABEL, argv: ['forgeloop-missing-binary-zzz'] }],
      report: pipelineReport({ scenario: '别的场景', evidence: OUTPUT }),
    })
    const outcome = await built.pipeline.executeVerification(PIPE_REQ, new AbortController().signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('独立验证阻断（environment_error）')
    expect(outcome.detail).toContain('恢复环境后按同一方案复验')
    expect(built.reopened).toEqual([])
    const record = repo.verification(PIPE_REQ, 1)
    expect(latestPipelineAttempt(built.identity())?.failureKind).toBe('environment_error')
    expect(JSON.parse(record!.reportJson).commands[0].exitCode).toBeNull()
    expect(repo.failureRounds(PIPE_REQ)).toHaveLength(1)
    expect(pipelineStatus()).toBe('blocked')
  })

  it('blocks when a required scenario has no verification result', async () => {
    const built = setupPipeline({
      report: pipelineReport({ scenario: '别的场景', evidence: OUTPUT }),
    })
    const outcome = await built.pipeline.executeVerification(PIPE_REQ, new AbortController().signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('缺少必过场景的验证结果：候选可用')
    expect(latestPipelineAttempt(built.identity())?.failureKind).toBe('insufficient_evidence')
    expect(built.reopened).toEqual([])
  })

  it('blocks when scenario evidence cannot be matched to the executed output', async () => {
    const built = setupPipeline({
      controls: true,
      commands: [{ label: LABEL, argv: [process.execPath, '-e', README_CHECK] }],
      report: pipelineReport({ evidence: 'unverifiable evidence text' }),
    })
    const outcome = await built.pipeline.executeVerification(PIPE_REQ, new AbortController().signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('必过场景证据无法在验证命令输出中核对：候选可用')
    const record = repo.verification(PIPE_REQ, 1)
    expect(latestPipelineAttempt(built.identity())?.failureKind).toBe('insufficient_evidence')
    const report = JSON.parse(record!.reportJson)
    expect(report.controls[0]).toMatchObject({ label: LABEL, applied: true, exitCode: 1 })
    expect(built.reopened).toEqual([])
  })

  it('blocks when a command changes the pinned candidate outside verification/', async () => {
    const built = setupPipeline({
      controls: true,
      commands: [
        {
          label: LABEL,
          argv: [
            process.execPath,
            '-e',
            [
              "const fs = require('node:fs')",
              "const text = fs.readFileSync('README.md', 'utf8')",
              `if (!text.includes('fixture')) { console.error('${CONTROL_FAILURE}'); process.exit(1) }`,
              "fs.writeFileSync('docs/extra.md', 'tampered\\n')",
              `console.log('${OUTPUT}')`,
            ].join(';'),
          ],
        },
      ],
      report: pipelineReport(),
    })
    const outcome = await built.pipeline.executeVerification(PIPE_REQ, new AbortController().signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('验证命令修改了固定候选：docs/extra.md')
    expect(outcome.detail).toContain('独立验证阻断（test_error）')
    expect(built.reopened).toEqual([])
    const record = repo.verification(PIPE_REQ, 1)
    expect(latestPipelineAttempt(built.identity())?.failureKind).toBe('test_error')
    const report = JSON.parse(record!.reportJson)
    expect(report.candidateIntegrity.allowedPaths).toEqual(['verification/'])
    expect(report.candidateIntegrity.changes).toContain('docs/extra.md')
    expect(repo.failureRounds(PIPE_REQ)).toHaveLength(1)
  })

  it('stops retrying a candidate after the same-candidate attempt limit', async () => {
    const built = setupPipeline()
    const identity = built.identity()
    const blockReport = JSON.stringify({
      verdict: 'block',
      summary: '环境异常',
      findings: [],
      blocking: ['环境异常'],
      scenarios: [],
    })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const dir = verificationAttemptDir(built.config, {
        reqId: PIPE_REQ,
        planVersion: 1,
        candidateSha256: identity,
        attemptNumber: attempt,
      })
      mkdirSync(dir, { recursive: true })
      const reportPath = join(dir, 'verification.json')
      writeFileSync(reportPath, blockReport, 'utf8')
      repo.recordVerification({
        requirementId: PIPE_REQ,
        planVersion: 1,
        candidateSha256: identity,
        requirementVersion: 1,
        workspaceSha256: 'tree',
        verdict: 'block',
        failureKind: 'environment_error',
        blocking: ['环境异常'],
        reportJson: blockReport,
        reportPath,
        reportSha256: sha256OfText(blockReport),
        evidenceDir: dir,
        sessionId: 'session',
        verifiedAt: NOW,
        attemptNumber: attempt,
      })
    }
    const outcome = await built.pipeline.executeVerification(PIPE_REQ, new AbortController().signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: `候选 ${identity.slice(0, 16)}… 的独立验证已阻断（尝试 3，environment_error）：环境异常；需修复后产生新候选再验证`,
    })
    expect(built.testCalls()).toBe(0)
    expect(built.verifyPrompts).toHaveLength(0)
  })
})
