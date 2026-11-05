import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { evidenceDir, resolveConfig, type ForgeLoopConfig, type RawConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { ExecutionDev, type ExecutionDevDeps } from '../src/runtime/execution-dev.js'
import { integrateCandidate } from '../src/runtime/integration.js'
import { sha256OfText } from '../src/domain/delivery.js'
import type { AgentRunResult, AgentSession, AgentTurnRequest } from '../src/runtime/agent-runner.js'
import type { Requirement } from '../src/domain/requirement.js'
import type { PlannedTask, TaskPlan } from '../src/domain/task-plan.js'
import type { TestRunRequest, TestRunResult } from '../src/runtime/formal-test.js'

const NOW = '2026-11-05T10:00:00.000Z'
const REQ_ID = 'req-exec-integration-gap'

const dirs: string[] = []
const repos: Repository[] = []

const requirement: Requirement = {
  reqId: REQ_ID,
  project: 'demo',
  status: 'developing',
  blockedReason: '',
  versions: [
    {
      version: 1,
      text: '实现一个可通过自验的改动',
      createdAt: NOW,
      revisedBy: 'owner',
      source: 'test',
    },
  ],
  submittedBy: 'owner',
  source: 'test',
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function newRepo(dir: string): Repository {
  const repo = new Repository(Database.open(join(dir, 'records.sqlite')))
  repos.push(repo)
  return repo
}

afterEach(() => {
  for (const repo of repos.splice(0)) repo.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function gitOutput(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  return git(dir, ['rev-parse', 'HEAD'])
}

function makeProject(): { dir: string; baseline: string } {
  const dir = tempDir('forgeloop-gap-project-')
  const baseline = initRepo(dir, {
    'README.md': 'base\n',
    '.gitignore': 'node_modules/\nignored/\n',
  })
  return { dir, baseline }
}

function configFor(root: string, projectPath: string, raw: RawConfig = {}): ForgeLoopConfig {
  return resolveConfig(
    { project: 'demo', projectPath, recordsRoot: join(root, 'records'), ...raw },
    root,
  )
}

function executionDev(
  config: ForgeLoopConfig,
  repo: Repository,
  overrides: Partial<ExecutionDevDeps> = {},
): ExecutionDev {
  return new ExecutionDev({
    config,
    repo,
    now: () => NOW,
    recordRun: (reqId, plan, task, outcome) => {
      repo.recordTaskRun({
        requirementId: reqId,
        planVersion: plan.planVersion,
        taskId: task.taskId,
        state: outcome.state,
        reason: outcome.reason,
        executedSeconds: 0,
        updatedAt: NOW,
      })
    },
    previousTaskFailure: () => '',
    formalTest: () => {
      throw new Error('formal test must not run in this case')
    },
    existingPackages: () => [],
    ctx: {},
    authorizedPlan: (plan) => plan,
    applyDiffFile: () => ({ ok: true, detail: '' }),
    ...overrides,
  })
}

function makeTask(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    taskId: 't1',
    goal: '实现任务目标',
    files: ['src/a.ts'],
    acceptance: '文件存在且自验通过',
    testCommand: ['node', '-e', 'process.exit(0)'],
    dependsOn: [],
    limits: { limitSeconds: 60, maxFailureRounds: 1 },
    authorizationSource: '',
    ...overrides,
  }
}

function makePlan(tasks: readonly PlannedTask[], planVersion = 1): TaskPlan {
  return {
    taskPlanId: `plan-${REQ_ID}-${planVersion}`,
    requirementId: REQ_ID,
    project: 'demo',
    planVersion,
    requirementVersion: 1,
    tasks,
    createdAt: NOW,
  }
}

/** 在独立克隆里构造相对项目基线的候选 diff；不依赖网络或远端仓库。 */
function candidateFor(
  project: string,
  files: Record<string, string> = { 'docs/a.md': 'change\n' },
): {
  diffPath: string
  baseline: string
  diffSha256: string
} {
  const baseline = git(project, ['rev-parse', 'HEAD'])
  const work = tempDir('forgeloop-gap-candidate-')
  execFileSync('git', ['clone', '-q', project, '.'], { cwd: work, encoding: 'utf8' })
  git(work, ['config', 'user.email', 'test@example.com'])
  git(work, ['config', 'user.name', 'Test'])
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, name)), { recursive: true })
    writeFileSync(join(work, name), content)
  }
  git(work, ['add', '-A'])
  git(work, ['commit', '-qm', 'candidate'])
  const diff = gitOutput(work, ['diff', `${baseline}..HEAD`, '--binary'])
  const diffPath = join(tempDir('forgeloop-gap-artifacts-'), 'candidate.diff')
  writeFileSync(diffPath, diff)
  return { diffPath, baseline, diffSha256: sha256OfText(diff) }
}

function applyGitDiff(target: string, diffPath: string): { ok: boolean; detail: string } {
  try {
    execFileSync('git', ['apply', '--binary', diffPath], { cwd: target, encoding: 'utf8' })
    return { ok: true, detail: '' }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function recordArtifact(
  repo: Repository,
  plan: TaskPlan,
  task: PlannedTask,
  candidatePath: string,
  options: { baselineCommit: string; withEvidence: boolean },
): void {
  repo.recordTaskArtifact({
    requirementId: plan.requirementId,
    planVersion: plan.planVersion,
    taskId: task.taskId,
    candidateSha256: existsSync(candidatePath)
      ? sha256OfText(readFileSync(candidatePath, 'utf8'))
      : sha256OfText(candidatePath),
    testEvidenceSha256: sha256OfText('test log'),
    reviewSha256: sha256OfText('review'),
    acceptance: task.acceptance,
    authorizationSource: 'test-grant',
    recordedAt: NOW,
    baselineCommit: options.baselineCommit,
  })
  if (!options.withEvidence) return
  repo.recordEvidence({
    requirementId: plan.requirementId,
    planVersion: plan.planVersion,
    taskId: task.taskId,
    baselineCommit: options.baselineCommit,
    workspacePath: '',
    candidatePath,
    testLogPath: '',
    reviewPath: '',
    devSession: '',
    reviewSession: '',
    recordedAt: NOW,
  })
}

function scriptedSession(
  handler: (turn: AgentTurnRequest, index: number) => AgentRunResult | Promise<AgentRunResult>,
): AgentSession & { calls: AgentTurnRequest[] } {
  const calls: AgentTurnRequest[] = []
  return {
    sessionId: 'session-dev',
    calls,
    async send(turn) {
      calls.push(turn)
      return handler(turn, calls.length - 1)
    },
    async close() {},
  }
}

function completedRun(turn: AgentTurnRequest, text = 'done'): AgentRunResult {
  return {
    status: 'completed',
    text,
    sessionId: 'session-dev',
    reason: '',
    transcriptPath: turn.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  }
}

function abortedRun(turn: AgentTurnRequest, reason: string): AgentRunResult {
  return { ...completedRun(turn), status: 'aborted', reason }
}

function timeoutRun(turn: AgentTurnRequest, reason: string): AgentRunResult {
  return { ...completedRun(turn), status: 'timeout', reason }
}

function failedRun(turn: AgentTurnRequest, reason: string): AgentRunResult {
  return { ...completedRun(turn), status: 'error', reason }
}

/** 可编排的正式测试替身：按调用序号返回预设结果，并留下请求与摘要。 */
function formalTestScript(steps: readonly Partial<TestRunResult>[]): {
  (request: TestRunRequest): Promise<TestRunResult>
  calls: TestRunRequest[]
  results: TestRunResult[]
} {
  const calls: TestRunRequest[] = []
  const results: TestRunResult[] = []
  const run = async (request: TestRunRequest): Promise<TestRunResult> => {
    calls.push(request)
    const step = steps[Math.min(calls.length - 1, steps.length - 1)] ?? {}
    const log = `fake formal test\n${step.output ?? ''}\n`
    mkdirSync(dirname(request.logPath), { recursive: true })
    writeFileSync(request.logPath, log, 'utf8')
    const result: TestRunResult = {
      exitCode: 0,
      timedOut: false,
      aborted: false,
      logPath: request.logPath,
      logSha256: sha256OfText(log),
      durationMs: 5,
      output: '',
      ...step,
    }
    results.push(result)
    return result
  }
  return Object.assign(run, { calls, results })
}

interface DevFixture {
  dir: string
  project: string
  workspace: string
  config: ForgeLoopConfig
  repo: Repository
  dev: ExecutionDev
  task: PlannedTask
  plan: TaskPlan
}

interface DevFixtureOptions {
  task?: Partial<PlannedTask>
  planVersion?: number
  maxTaskAttempts?: number
  formalTestTimeoutSeconds?: number
  formalTest?: ExecutionDevDeps['formalTest']
  previousTaskFailure?: ExecutionDevDeps['previousTaskFailure']
  applyDiffFile?: ExecutionDevDeps['applyDiffFile']
  workspaceFiles?: Record<string, string>
}

function developFixture(options: DevFixtureOptions = {}): DevFixture {
  const dir = tempDir('forgeloop-gap-dev-')
  const project = join(dir, 'project')
  initRepo(project, { 'README.md': 'project\n' })
  const workspace = join(dir, 'workspace')
  initRepo(workspace, options.workspaceFiles ?? { 'README.md': 'workspace\n' })
  const config = configFor(dir, project, {
    maxTaskAttempts: options.maxTaskAttempts ?? -1,
    formalTestTimeoutSeconds: options.formalTestTimeoutSeconds ?? -1,
    agent: { timeoutSeconds: -1, maxTurnSeconds: -1 },
  })
  const repo = newRepo(dir)
  const task = makeTask(options.task)
  const plan = makePlan([task], options.planVersion ?? 1)
  const dev = executionDev(config, repo, {
    ...(options.formalTest === undefined ? {} : { formalTest: options.formalTest }),
    ...(options.previousTaskFailure === undefined
      ? {}
      : { previousTaskFailure: options.previousTaskFailure }),
    ...(options.applyDiffFile === undefined ? {} : { applyDiffFile: options.applyDiffFile }),
  })
  return { dir, project, workspace, config, repo, dev, task, plan }
}

function developTask(
  fixture: DevFixture,
  session: AgentSession,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ state: 'delivered' | 'blocked'; reason: string }> {
  return fixture.dev.developTaskInSession({
    reqId: REQ_ID,
    requirement,
    plan: fixture.plan,
    task: fixture.task,
    workspace: fixture.workspace,
    session,
    authorizationSource: 'test-grant',
    signal,
  })
}

interface CandidateFixture {
  diffPath: string
  baseline: string
  diffSha256: string
}

function integrate(
  projectPath: string,
  candidate: CandidateFixture,
  evidence: string,
  checkCommand: readonly string[],
  commitMessage = 'feat: test candidate',
) {
  return integrateCandidate({
    projectPath,
    candidateDiffPath: candidate.diffPath,
    candidateBaseline: candidate.baseline,
    expectedDiffSha256: candidate.diffSha256,
    checkCommand,
    commitMessage,
    evidenceDir: evidence,
    timeoutMs: 30_000,
  })
}

describe('execution-dev workspace preparation', () => {
  it('copies tracked and untracked project files into a clean baseline snapshot, skipping ignored ones', () => {
    const root = tempDir('forgeloop-gap-prepare-')
    const project = join(root, 'project')
    const baseline = initRepo(project, { 'README.md': 'base\n', '.gitignore': 'ignored/\n' })
    writeFileSync(join(project, 'notes.md'), 'untracked work\n')
    mkdirSync(join(project, 'ignored'), { recursive: true })
    writeFileSync(join(project, 'ignored/secret.txt'), 'ignored\n')
    const repo = newRepo(root)
    const dev = executionDev(configFor(root, project), repo)
    const workspace = join(root, 'workspace')

    const prepared = dev.prepareDevWorkspace(workspace)

    expect(prepared.workspace).toBe(workspace)
    expect(prepared.baselineCommit).toBe(baseline)
    expect(prepared.snapshotCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(prepared.snapshotCommit).not.toBe(baseline)
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(prepared.snapshotCommit)
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('base\n')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('untracked work\n')
    expect(existsSync(join(workspace, 'ignored/secret.txt'))).toBe(false)
    expect(git(workspace, ['log', '--pretty=%s'])).toBe('forgeloop baseline snapshot')
    expect(git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
  })

  it('refreshes the same workspace path onto a newer project baseline and drops stale files', () => {
    const root = tempDir('forgeloop-gap-refresh-')
    const project = join(root, 'project')
    initRepo(project, { 'README.md': 'base\n' })
    const repo = newRepo(root)
    const dev = executionDev(configFor(root, project), repo)
    const workspace = join(root, 'workspace')
    const first = dev.prepareDevWorkspace(workspace)
    writeFileSync(join(workspace, 'stale.txt'), 'old work copy\n')

    writeFileSync(join(project, 'README.md'), 'base v2\n')
    writeFileSync(join(project, 'new.txt'), 'new file\n')
    git(project, ['add', '-A'])
    git(project, ['commit', '-qm', 'second'])
    const secondBaseline = git(project, ['rev-parse', 'HEAD'])

    const second = dev.prepareDevWorkspace(workspace)

    expect(second.workspace).toBe(workspace)
    expect(second.baselineCommit).toBe(secondBaseline)
    expect(second.baselineCommit).not.toBe(first.baselineCommit)
    expect(second.snapshotCommit).not.toBe(first.snapshotCommit)
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('base v2\n')
    expect(readFileSync(join(workspace, 'new.txt'), 'utf8')).toBe('new file\n')
    expect(existsSync(join(workspace, 'stale.txt'))).toBe(false)
    expect(git(workspace, ['rev-list', '--count', 'HEAD'])).toBe('1')
    expect(git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
  })

  it('reports a missing workspace, a clean snapshot, and tracked and untracked dirt', () => {
    const root = tempDir('forgeloop-gap-status-')
    const project = join(root, 'project')
    initRepo(project, { 'README.md': 'base\n' })
    const repo = newRepo(root)
    const dev = executionDev(configFor(root, project), repo)

    expect(dev.workspaceStatus(join(root, 'absent'))).toEqual({
      exists: false,
      clean: false,
      head: '',
    })
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(dev.workspaceStatus(plain)).toEqual({ exists: false, clean: false, head: '' })

    const prepared = dev.prepareDevWorkspace(join(root, 'workspace'))
    const workspace = prepared.workspace
    expect(dev.workspaceStatus(workspace)).toEqual({
      exists: true,
      clean: true,
      head: prepared.snapshotCommit,
    })

    writeFileSync(join(workspace, 'README.md'), 'dirty\n')
    expect(dev.workspaceStatus(workspace)).toEqual({
      exists: true,
      clean: false,
      head: prepared.snapshotCommit,
    })

    git(workspace, ['checkout', '--', 'README.md'])
    mkdirSync(join(workspace, 'nested'), { recursive: true })
    writeFileSync(join(workspace, 'nested/new.txt'), 'new\n')
    expect(dev.workspaceStatus(workspace)).toEqual({
      exists: true,
      clean: false,
      head: prepared.snapshotCommit,
    })
  })
})

describe('execution-dev delivered artifact restore', () => {
  it('applies delivered diffs in dependency order and commits each restored task', () => {
    const root = tempDir('forgeloop-gap-restore-order-')
    const project = join(root, 'project')
    initRepo(project, { 'README.md': 'base\n' })
    const repo = newRepo(root)
    const calls: Array<{ workspace: string; diffPath: string; label: string; suffix: string }> = []
    const dev = executionDev(configFor(root, project), repo, {
      applyDiffFile: (workspace, diffPath, label, suffix) => {
        calls.push({ workspace, diffPath, label, suffix })
        return applyGitDiff(workspace, diffPath)
      },
    })
    const workspace = join(root, 'workspace')
    const prepared = dev.prepareDevWorkspace(workspace)
    const t1 = makeTask({ taskId: 't1', files: ['src/a.ts'], goal: '实现 A' })
    const t2 = makeTask({ taskId: 't2', files: ['src/b.ts'], goal: '实现 B', dependsOn: ['t1'] })
    const plan = makePlan([t2, t1])
    const first = candidateFor(project, { 'src/a.ts': 'one\n' })
    const second = candidateFor(project, { 'src/b.ts': 'two\n' })
    recordArtifact(repo, plan, t1, first.diffPath, {
      baselineCommit: prepared.baselineCommit,
      withEvidence: true,
    })
    recordArtifact(repo, plan, t2, second.diffPath, {
      baselineCommit: prepared.baselineCommit,
      withEvidence: true,
    })

    const restored = dev.restoreDeliveredArtifacts(REQ_ID, plan, workspace, prepared.baselineCommit)

    expect(restored).toEqual({ ok: true })
    expect(calls.map((call) => call.label)).toEqual(['t1', 't2'])
    expect(calls.map((call) => call.suffix)).toEqual(['t1', 't2'])
    expect(calls.map((call) => call.workspace)).toEqual([workspace, workspace])
    expect(readFileSync(join(workspace, 'src/a.ts'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(workspace, 'src/b.ts'), 'utf8')).toBe('two\n')
    expect(git(workspace, ['log', '--reverse', '--pretty=%s'])).toBe(
      ['forgeloop baseline snapshot', 'forgeloop: restore t1', 'forgeloop: restore t2'].join('\n'),
    )
    expect(git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
  })

  it('refuses a foreign baseline or missing evidence instead of splicing artifact files', () => {
    const root = tempDir('forgeloop-gap-restore-evidence-')
    const project = join(root, 'project')
    initRepo(project, { 'README.md': 'base\n' })
    const repo = newRepo(root)
    const calls: string[] = []
    const dev = executionDev(configFor(root, project), repo, {
      applyDiffFile: (workspace, diffPath, label) => {
        calls.push(label)
        return applyGitDiff(workspace, diffPath)
      },
    })
    const workspace = join(root, 'workspace')
    const prepared = dev.prepareDevWorkspace(workspace)
    const task = makeTask()
    const candidate = candidateFor(project, { 'src/a.ts': 'one\n' })

    recordArtifact(repo, makePlan([task], 1), task, candidate.diffPath, {
      baselineCommit: 'f'.repeat(40),
      withEvidence: true,
    })
    const foreign = dev.restoreDeliveredArtifacts(
      REQ_ID,
      makePlan([task], 1),
      workspace,
      prepared.baselineCommit,
    )
    expect(foreign).toEqual({
      ok: false,
      reason: `任务 t1 的交付基线 ${'f'.repeat(12)} 与当前现场 ${prepared.baselineCommit.slice(0, 12)} 不一致；不能自动拼接`,
    })

    // 仓库的工件基线来自证据记录；证据缺失时工件基线为空，这里以空基线命中“缺证据”分支。
    recordArtifact(repo, makePlan([task], 2), task, candidate.diffPath, {
      baselineCommit: '',
      withEvidence: false,
    })
    const noEvidence = dev.restoreDeliveredArtifacts(REQ_ID, makePlan([task], 2), workspace, '')
    expect(noEvidence).toEqual({ ok: false, reason: '任务 t1 缺交付证据，不能恢复现场' })

    recordArtifact(repo, makePlan([task], 3), task, join(root, 'removed.diff'), {
      baselineCommit: prepared.baselineCommit,
      withEvidence: true,
    })
    const missingFile = dev.restoreDeliveredArtifacts(
      REQ_ID,
      makePlan([task], 3),
      workspace,
      prepared.baselineCommit,
    )
    expect(missingFile).toEqual({ ok: false, reason: '任务 t1 缺交付证据，不能恢复现场' })
    expect(calls).toEqual([])
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(prepared.snapshotCommit)
    expect(git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
  })

  it('reports a failed diff application and leaves the workspace untouched', () => {
    const root = tempDir('forgeloop-gap-restore-apply-')
    const project = join(root, 'project')
    initRepo(project, { 'README.md': 'base\n' })
    const repo = newRepo(root)
    const dev = executionDev(configFor(root, project), repo, {
      applyDiffFile: () => ({ ok: false, detail: 'patch does not apply' }),
    })
    const workspace = join(root, 'workspace')
    const prepared = dev.prepareDevWorkspace(workspace)
    const task = makeTask()
    const plan = makePlan([task])
    const candidate = candidateFor(project, { 'src/a.ts': 'one\n' })
    recordArtifact(repo, plan, task, candidate.diffPath, {
      baselineCommit: prepared.baselineCommit,
      withEvidence: true,
    })

    const restored = dev.restoreDeliveredArtifacts(REQ_ID, plan, workspace, prepared.baselineCommit)

    expect(restored).toEqual({
      ok: false,
      reason: '恢复任务 t1 的 diff 失败：patch does not apply',
    })
    expect(existsSync(join(workspace, 'src/a.ts'))).toBe(false)
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(prepared.snapshotCommit)
    expect(git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
  })
})

describe('execution-dev task turns', () => {
  it('stops before the first turn, saves an interrupted checkpoint, and reports a timeout without one', async () => {
    const stopped = developFixture()
    const controller = new AbortController()
    controller.abort()
    const silent = scriptedSession(() => {
      throw new Error('session must not be used after a stop request')
    })
    const stoppedReason = '停止请求：任务未交付，研发现场保留，可继续执行'

    const stoppedOutcome = await developTask(stopped, silent, controller.signal)

    expect(stoppedOutcome).toEqual({ state: 'blocked', reason: stoppedReason })
    expect(silent.calls).toEqual([])
    expect(stopped.repo.taskRuns(REQ_ID, 1)).toEqual([
      expect.objectContaining({ taskId: 't1', state: 'blocked', reason: stoppedReason }),
    ])

    const interrupted = developFixture()
    mkdirSync(join(interrupted.workspace, 'src'), { recursive: true })
    writeFileSync(join(interrupted.workspace, 'src/a.ts'), 'work in progress\n')
    const aborted = scriptedSession((turn) => abortedRun(turn, '宿主停止'))
    const checkpointDir = evidenceDir(interrupted.config, REQ_ID, 1, 't1')
    const checkpointDiff = join(checkpointDir, 'checkpoint-a1.diff')

    const abortedOutcome = await developTask(interrupted, aborted)

    expect(abortedOutcome).toEqual({
      state: 'blocked',
      reason: `研发回合被停止：宿主停止；现场保留，未交付改动已保存到 ${checkpointDiff}，可继续修复`,
    })
    expect(aborted.calls.map((call) => call.transcriptPath)).toEqual([
      join(checkpointDir, 'dev-a1.jsonl'),
    ])
    const checkpoint = JSON.parse(readFileSync(join(checkpointDir, 'checkpoint-a1.json'), 'utf8'))
    expect(checkpoint).toMatchObject({
      taskId: 't1',
      attempt: 1,
      status: 'aborted',
      detail: '宿主停止',
      changedFiles: ['src/a.ts'],
    })
    expect(checkpoint.diffSha256).toBe(sha256OfText(readFileSync(checkpointDiff, 'utf8')))
    expect(interrupted.repo.taskRuns(REQ_ID, 1)[0]).toMatchObject({
      state: 'blocked',
      reason: abortedOutcome.reason,
    })

    const timed = developFixture()
    const timeout = scriptedSession((turn) => timeoutRun(turn, '回合超时'))
    const timeoutReason = '研发回合超时：回合超时；现场保留，可继续修复'

    const timeoutOutcome = await developTask(timed, timeout)

    expect(timeoutOutcome).toEqual({ state: 'blocked', reason: timeoutReason })
    expect(existsSync(join(evidenceDir(timed.config, REQ_ID, 1, 't1'), 'checkpoint-a1.json'))).toBe(
      false,
    )
    expect(timed.repo.taskRuns(REQ_ID, 1)[0]).toMatchObject({
      state: 'blocked',
      reason: timeoutReason,
    })
  })

  it('retries an uncompleted turn with failure feedback and records the delivered artifacts', async () => {
    const formalTest = formalTestScript([{ exitCode: 0 }])
    const fixture = developFixture({
      formalTest,
      formalTestTimeoutSeconds: 25,
      previousTaskFailure: () => '上次失败：缺少依赖',
    })
    const taskDir = evidenceDir(fixture.config, REQ_ID, 1, 't1')
    let turn = 0
    const session = scriptedSession((request) => {
      turn += 1
      if (turn === 1) return failedRun(request, '模型崩溃')
      mkdirSync(join(fixture.workspace, 'src'), { recursive: true })
      writeFileSync(join(fixture.workspace, 'src/a.ts'), 'implemented\n')
      return completedRun(request)
    })

    const outcome = await developTask(fixture, session)

    expect(outcome).toEqual({ state: 'delivered', reason: '' })
    expect(session.calls).toHaveLength(2)
    expect(session.calls[0]?.prompt).toContain('上次失败：缺少依赖')
    expect(session.calls[1]?.prompt).toContain(
      '上一次研发回合未完成：模型崩溃。请继续完成同一个任务。',
    )
    expect(session.calls.map((call) => call.transcriptPath)).toEqual([
      join(taskDir, 'dev-a1.jsonl'),
      join(taskDir, 'dev-a2.jsonl'),
    ])
    expect(session.calls[0]?.timeoutMs).toBe(60_000)
    expect(formalTest.calls).toHaveLength(1)
    expect(formalTest.calls[0]).toMatchObject({
      cwd: fixture.workspace,
      argv: fixture.task.testCommand,
      timeoutMs: 25_000,
      logPath: join(taskDir, 'formal-test.log'),
    })
    expect(fixture.repo.taskRuns(REQ_ID, 1)).toEqual([
      expect.objectContaining({ taskId: 't1', state: 'delivered', reason: '' }),
    ])

    const artifact = fixture.repo.taskArtifact(REQ_ID, 1, 't1')
    const evidence = fixture.repo.evidence(REQ_ID, 1, 't1')
    expect(artifact).not.toBeNull()
    expect(evidence).not.toBeNull()
    if (!artifact || !evidence) throw new Error('delivered task is missing its artifacts')
    const projectHead = git(fixture.project, ['rev-parse', 'HEAD'])
    expect(artifact).toMatchObject({
      taskId: 't1',
      acceptance: '文件存在且自验通过',
      authorizationSource: 'test-grant',
      baselineCommit: projectHead,
    })
    expect(evidence).toMatchObject({ baselineCommit: projectHead, devSession: 'session-dev' })
    expect(artifact.testEvidenceSha256).toBe(formalTest.results[0]?.logSha256)
    expect(existsSync(evidence.candidatePath)).toBe(true)
    expect(artifact.candidateSha256).toBe(
      sha256OfText(readFileSync(evidence.candidatePath, 'utf8')),
    )
    const review = JSON.parse(readFileSync(evidence.reviewPath, 'utf8'))
    expect(review).toMatchObject({
      kind: 'self-check',
      taskId: 't1',
      verdict: 'pass',
      testLog: formalTest.calls[0]?.logPath,
    })
    expect(artifact.reviewSha256).toBe(sha256OfText(JSON.stringify(review)))
    expect(git(fixture.workspace, ['log', '-1', '--pretty=%s'])).toBe('forgeloop: task t1')
    expect(git(fixture.workspace, ['status', '--porcelain', '--untracked-files=all'])).toBe('')
  })

  it('counts completed turns without file changes as failures and blocks when attempts are exhausted', async () => {
    const formalTest = formalTestScript([{ exitCode: 0 }])
    const fixture = developFixture({ maxTaskAttempts: 2, formalTest })
    const session = scriptedSession((request) => completedRun(request))
    const reason = '任务 t1 已尝试 2 次仍未通过自验；现场保留，等待修复或授权'

    const outcome = await developTask(fixture, session)

    expect(outcome).toEqual({ state: 'blocked', reason })
    expect(session.calls).toHaveLength(2)
    expect(session.calls[1]?.prompt).toContain(
      '上一次研发没有产生任何文件改动。请真正实现任务目标。',
    )
    expect(formalTest.calls).toEqual([])
    expect(fixture.repo.taskRuns(REQ_ID, 1)[0]).toMatchObject({ state: 'blocked', reason })
  })

  it('delivers a read-only task with no file changes without creating an empty commit', async () => {
    const formalTest = formalTestScript([{ exitCode: 0 }])
    const fixture = developFixture({
      task: {
        verification: true,
        files: [],
        goal: '核对既有交付',
        acceptance: '只读检查通过',
      },
      formalTest,
    })
    const headBefore = git(fixture.workspace, ['rev-parse', 'HEAD'])
    const session = scriptedSession((request) => completedRun(request))

    const outcome = await developTask(fixture, session)

    expect(outcome).toEqual({ state: 'delivered', reason: '' })
    expect(session.calls).toHaveLength(1)
    expect(formalTest.calls).toHaveLength(1)
    expect(git(fixture.workspace, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(git(fixture.workspace, ['log', '--pretty=%s'])).toBe('base')
    expect(git(fixture.workspace, ['status', '--porcelain', '--untracked-files=all'])).toBe('')

    const artifact = fixture.repo.taskArtifact(REQ_ID, 1, 't1')
    const evidence = fixture.repo.evidence(REQ_ID, 1, 't1')
    expect(artifact).not.toBeNull()
    expect(evidence).not.toBeNull()
    if (!artifact || !evidence) throw new Error('read-only task is missing its artifacts')
    expect(artifact).toMatchObject({
      acceptance: '只读检查通过',
      authorizationSource: 'test-grant',
    })
    expect(artifact.candidateSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(evidence.candidatePath)).toBe(true)
    expect(existsSync(evidence.reviewPath)).toBe(true)
    expect(fixture.repo.taskRuns(REQ_ID, 1)[0]).toMatchObject({ state: 'delivered' })
  })

  it('feeds a failing formal test log back into the same workspace and delivers on retry', async () => {
    const formalTest = formalTestScript([
      { exitCode: 1, output: 'assertion failed: expected 1 got 2' },
      { exitCode: 0, output: 'ok' },
    ])
    const fixture = developFixture({ formalTest, formalTestTimeoutSeconds: 25 })
    let turn = 0
    const session = scriptedSession((request) => {
      turn += 1
      mkdirSync(join(fixture.workspace, 'src'), { recursive: true })
      writeFileSync(join(fixture.workspace, 'src/a.ts'), turn === 1 ? 'broken\n' : 'fixed\n')
      return completedRun(request)
    })

    const outcome = await developTask(fixture, session)

    expect(outcome).toEqual({ state: 'delivered', reason: '' })
    expect(formalTest.calls).toHaveLength(2)
    expect(formalTest.calls[0]).toMatchObject({
      cwd: fixture.workspace,
      argv: fixture.task.testCommand,
      timeoutMs: 25_000,
      logPath: join(evidenceDir(fixture.config, REQ_ID, 1, 't1'), 'formal-test.log'),
    })
    expect(session.calls).toHaveLength(2)
    expect(session.calls[1]?.prompt).toContain('研发自验未通过（退出码 1）')
    expect(session.calls[1]?.prompt).toContain('assertion failed: expected 1 got 2')
    expect(session.calls[1]?.prompt).toContain('请在同一工作区修复后继续。')
    expect(readFileSync(join(fixture.workspace, 'src/a.ts'), 'utf8')).toBe('fixed\n')
    expect(git(fixture.workspace, ['log', '-1', '--pretty=%s'])).toBe('forgeloop: task t1')
  })

  it('retries when the formal test removes the only file change before capture', async () => {
    const script = formalTestScript([{ exitCode: 0 }, { exitCode: 0 }])
    let testRuns = 0
    let workspace = ''
    const formalTest = async (request: TestRunRequest): Promise<TestRunResult> => {
      const result = await script(request)
      testRuns += 1
      // 第一次自验把刚写入的文件清理掉：回合后 git status 曾非空，但采集候选时已无改动。
      if (testRuns === 1) rmSync(join(workspace, 'src/a.ts'), { force: true })
      return result
    }
    const fixture = developFixture({ formalTest })
    workspace = fixture.workspace
    let turn = 0
    const session = scriptedSession((request) => {
      turn += 1
      mkdirSync(join(fixture.workspace, 'src'), { recursive: true })
      writeFileSync(join(fixture.workspace, 'src/a.ts'), `attempt ${turn}\n`)
      return completedRun(request)
    })

    const outcome = await developTask(fixture, session)

    expect(outcome).toEqual({ state: 'delivered', reason: '' })
    expect(testRuns).toBe(2)
    expect(session.calls).toHaveLength(2)
    expect(session.calls[1]?.prompt).toContain(
      '上一次研发没有产生任何文件改动。请真正实现任务目标。',
    )
    expect(readFileSync(join(fixture.workspace, 'src/a.ts'), 'utf8')).toBe('attempt 2\n')
    expect(git(fixture.workspace, ['log', '-1', '--pretty=%s'])).toBe('forgeloop: task t1')
    expect(fixture.repo.taskRuns(REQ_ID, 1)[0]).toMatchObject({ state: 'delivered' })
  })

  it('blocks a task when its formal self-check is aborted or times out', async () => {
    const abortedFixture = developFixture({
      formalTest: formalTestScript([{ aborted: true, exitCode: null }]),
    })
    const abortedSession = scriptedSession((request) => {
      mkdirSync(join(abortedFixture.workspace, 'src'), { recursive: true })
      writeFileSync(join(abortedFixture.workspace, 'src/a.ts'), 'work\n')
      return completedRun(request)
    })

    const abortedOutcome = await developTask(abortedFixture, abortedSession)

    expect(abortedOutcome).toEqual({
      state: 'blocked',
      reason: '研发自验被停止：现场保留，可继续执行',
    })
    expect(abortedFixture.repo.taskRuns(REQ_ID, 1)[0]).toMatchObject({
      state: 'blocked',
      reason: '研发自验被停止：现场保留，可继续执行',
    })
    expect(git(abortedFixture.workspace, ['log', '-1', '--pretty=%s'])).toBe('base')
    expect(git(abortedFixture.workspace, ['status', '--porcelain', '--untracked-files=all'])).toBe(
      '?? src/a.ts',
    )

    const timedFixture = developFixture({
      formalTestTimeoutSeconds: 30,
      formalTest: formalTestScript([{ timedOut: true, exitCode: null }]),
    })
    const timedSession = scriptedSession((request) => {
      mkdirSync(join(timedFixture.workspace, 'src'), { recursive: true })
      writeFileSync(join(timedFixture.workspace, 'src/a.ts'), 'work\n')
      return completedRun(request)
    })
    const timeoutReason = '研发自验超时（30 秒）：现场保留，可继续修复'

    const timedOutcome = await developTask(timedFixture, timedSession)

    expect(timedOutcome).toEqual({ state: 'blocked', reason: timeoutReason })
    expect(timedFixture.repo.taskRuns(REQ_ID, 1)[0]).toMatchObject({
      state: 'blocked',
      reason: timeoutReason,
    })
    expect(git(timedFixture.workspace, ['log', '-1', '--pretty=%s'])).toBe('base')
  })
})

describe('candidate integration failure branches', () => {
  it('commits the candidate when no check command is configured and removes temporary state', () => {
    const project = makeProject()
    const candidate = candidateFor(project.dir)
    const evidence = tempDir('forgeloop-gap-integration-evidence-')

    const result = integrate(project.dir, candidate, evidence, [])

    expect(result.ok).toBe(true)
    expect(result.checkPassed).toBe(true)
    expect(result.files).toEqual(['docs/a.md'])
    expect(result.commitSha).toHaveLength(40)
    expect(result.commitSha).toBe(git(project.dir, ['rev-parse', 'HEAD']))
    expect(result.detail).toBe(`已提交 ${result.commitSha.slice(0, 12)}（1 个文件）`)
    const log = readFileSync(result.checkLogPath, 'utf8')
    expect(log).toBe('未配置提交检查命令；以独立验证结果为质量依据。\n')
    expect(result.checkSha256).toBe(sha256OfText(log))
    expect(git(project.dir, ['show', '--name-only', '--pretty=format:', 'HEAD'])).toBe('docs/a.md')
    expect(git(project.dir, ['status', '--porcelain', '--untracked-files=all'])).toBe('')
    expect(existsSync(join(evidence, 'check-worktree'))).toBe(false)
    expect(existsSync(join(project.dir, '.git', 'forgeloop-commit.lock'))).toBe(false)
  })

  it('reports a failing check with its command, exit code and log digest without committing', () => {
    const project = makeProject()
    const candidate = candidateFor(project.dir)
    const evidence = tempDir('forgeloop-gap-integration-evidence-')
    const check = [process.execPath, '-e', 'process.exit(1)']
    const headBefore = git(project.dir, ['rev-parse', 'HEAD'])

    const result = integrate(project.dir, candidate, evidence, check)

    expect(result.ok).toBe(false)
    expect(result.checkPassed).toBe(false)
    expect(result.commitSha).toBe('')
    expect(result.files).toEqual([])
    expect(result.detail).toBe('提交检查退出码 1')
    expect(result.checkLogPath).toBe(join(evidence, 'commit-check.log'))
    const log = readFileSync(result.checkLogPath, 'utf8')
    expect(log.startsWith(`${JSON.stringify(check)}\nexit_code: 1\n`)).toBe(true)
    expect(result.checkSha256).toBe(sha256OfText(log))
    expect(git(project.dir, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(git(project.dir, ['status', '--porcelain'])).toBe('')
    expect(existsSync(join(evidence, 'check-worktree'))).toBe(false)
    expect(existsSync(join(project.dir, '.git', 'forgeloop-commit.lock'))).toBe(false)
  })

  it('blocks when the project HEAD or worktree changes while the check runs', () => {
    const project = makeProject()
    const candidate = candidateFor(project.dir)
    const evidence = tempDir('forgeloop-gap-integration-evidence-')
    const headScript = `require('node:child_process').execFileSync('git', ['-C', ${JSON.stringify(project.dir)}, 'commit', '--allow-empty', '-m', 'concurrent'], { stdio: 'ignore' })`
    const headBefore = candidate.baseline
    const changedMessage = '检查期间项目工作树、暂存区或 HEAD 发生变化；保留双方现场，未提交'

    const headResult = integrate(project.dir, candidate, evidence, [
      process.execPath,
      '-e',
      headScript,
    ])

    expect(headResult.ok).toBe(false)
    expect(headResult.checkPassed).toBe(true)
    expect(headResult.commitSha).toBe('')
    expect(headResult.files).toEqual([])
    expect(headResult.detail).toBe(changedMessage)
    expect(git(project.dir, ['rev-parse', 'HEAD'])).not.toBe(headBefore)
    expect(existsSync(join(project.dir, 'docs/a.md'))).toBe(false)
    const headLog = readFileSync(headResult.checkLogPath, 'utf8')
    expect(headLog).toContain('exit_code: 0')
    expect(headLog.endsWith('提交前复核失败：工作树/暂存区/HEAD 在检查期间发生变化。\n')).toBe(true)
    expect(headResult.checkSha256).toBe(sha256OfText(headLog))
    expect(existsSync(join(evidence, 'check-worktree'))).toBe(false)
    expect(existsSync(join(project.dir, '.git', 'forgeloop-commit.lock'))).toBe(false)

    const other = makeProject()
    const otherCandidate = candidateFor(other.dir)
    const otherEvidence = tempDir('forgeloop-gap-integration-evidence-')
    const untrackedPath = join(other.dir, 'concurrent.txt')
    const untrackedScript = `require('node:fs').writeFileSync(${JSON.stringify(untrackedPath)}, 'work\\n')`

    const dirtyResult = integrate(other.dir, otherCandidate, otherEvidence, [
      process.execPath,
      '-e',
      untrackedScript,
    ])

    expect(dirtyResult.ok).toBe(false)
    expect(dirtyResult.checkPassed).toBe(true)
    expect(dirtyResult.detail).toBe(changedMessage)
    expect(git(other.dir, ['rev-parse', 'HEAD'])).toBe(otherCandidate.baseline)
    expect(git(other.dir, ['status', '--porcelain', '--untracked-files=all'])).toBe(
      '?? concurrent.txt',
    )
    expect(readFileSync(untrackedPath, 'utf8')).toBe('work\n')
    expect(existsSync(join(other.dir, 'docs/a.md'))).toBe(false)
    expect(existsSync(join(otherEvidence, 'check-worktree'))).toBe(false)
    expect(existsSync(join(other.dir, '.git', 'forgeloop-commit.lock'))).toBe(false)
  })

  it('blocks when the candidate cannot be applied cleanly to the real project', () => {
    const project = makeProject()
    const candidate = candidateFor(project.dir)
    const evidence = tempDir('forgeloop-gap-integration-evidence-')
    writeFileSync(join(project.dir, '.git/info/exclude'), 'docs/a.md\n', { flag: 'a' })
    mkdirSync(join(project.dir, 'docs'), { recursive: true })
    writeFileSync(join(project.dir, 'docs/a.md'), 'other work\n')
    expect(git(project.dir, ['status', '--porcelain', '--untracked-files=all'])).toBe('')

    const result = integrate(project.dir, candidate, evidence, [])

    expect(result.ok).toBe(false)
    expect(result.checkPassed).toBe(true)
    expect(result.commitSha).toBe('')
    expect(result.files).toEqual([])
    expect(result.detail.startsWith('提交前候选无法干净应用：')).toBe(true)
    expect(result.detail).toContain('docs/a.md')
    expect(git(project.dir, ['rev-parse', 'HEAD'])).toBe(candidate.baseline)
    expect(readFileSync(join(project.dir, 'docs/a.md'), 'utf8')).toBe('other work\n')
    expect(result.checkSha256).toBe(sha256OfText(readFileSync(result.checkLogPath, 'utf8')))
    expect(existsSync(join(evidence, 'check-worktree'))).toBe(false)
    expect(existsSync(join(project.dir, '.git', 'forgeloop-commit.lock'))).toBe(false)
  })

  it('resets staging when the staged bytes do not match the approved candidate', () => {
    const project = makeProject()
    const candidate = candidateFor(project.dir)
    const evidence = tempDir('forgeloop-gap-integration-evidence-')
    git(project.dir, ['config', 'diff.noprefix', 'true'])
    const headBefore = git(project.dir, ['rev-parse', 'HEAD'])

    const result = integrate(project.dir, candidate, evidence, [])

    expect(result.ok).toBe(false)
    expect(result.checkPassed).toBe(true)
    expect(result.files).toEqual(['docs/a.md'])
    expect(result.commitSha).toBe('')
    expect(result.detail).toBe('暂存内容与获准候选不一致；已撤销本次暂存，未提交')
    expect(git(project.dir, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(git(project.dir, ['diff', '--cached', '--name-only'])).toBe('')
    expect(readFileSync(join(project.dir, 'docs/a.md'), 'utf8')).toBe('change\n')
    expect(result.checkSha256).toBe(sha256OfText(readFileSync(result.checkLogPath, 'utf8')))
    expect(existsSync(join(project.dir, '.git', 'forgeloop-commit.lock'))).toBe(false)
  })

  it('undoes the staged candidate when commit creation fails and only bypasses a missing pre-commit config', () => {
    const previousAllowNoConfig = process.env.PRE_COMMIT_ALLOW_NO_CONFIG
    delete process.env.PRE_COMMIT_ALLOW_NO_CONFIG
    const project = makeProject()
    const candidate = candidateFor(project.dir)
    const evidence = tempDir('forgeloop-gap-integration-evidence-')
    const envFile = join(tempDir('forgeloop-gap-hook-'), 'env.txt')
    writeFileSync(
      join(project.dir, '.git/hooks/pre-commit'),
      `#!/bin/sh\nprintf '%s' "\${PRE_COMMIT_ALLOW_NO_CONFIG-}" > "${envFile}"\nexit 1\n`,
      { mode: 0o755 },
    )
    const headBefore = git(project.dir, ['rev-parse', 'HEAD'])

    const result = integrate(project.dir, candidate, evidence, [])

    expect(result.ok).toBe(false)
    expect(result.checkPassed).toBe(true)
    expect(result.files).toEqual(['docs/a.md'])
    expect(result.commitSha).toBe('')
    expect(result.detail.startsWith('创建提交失败：')).toBe(true)
    expect(git(project.dir, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(git(project.dir, ['status', '--porcelain', '--untracked-files=all'])).toBe('')
    expect(existsSync(join(project.dir, 'docs/a.md'))).toBe(false)
    expect(result.checkSha256).toBe(sha256OfText(readFileSync(result.checkLogPath, 'utf8')))
    expect(existsSync(join(evidence, 'check-worktree'))).toBe(false)
    expect(existsSync(join(project.dir, '.git', 'forgeloop-commit.lock'))).toBe(false)
    // 仓库没有 .pre-commit-config.yaml 时只允许钩子以该变量自行跳过，钩子确实看到了绕过值。
    expect(readFileSync(envFile, 'utf8')).toBe('1')

    // 有配置时不得传入绕过变量，否则真实钩子会被静默跳过。
    const configuredDir = tempDir('forgeloop-gap-project-config-')
    initRepo(configuredDir, {
      'README.md': 'base\n',
      '.pre-commit-config.yaml': 'repos: []\n',
    })
    const configuredCandidate = candidateFor(configuredDir)
    const configuredEvidence = tempDir('forgeloop-gap-integration-evidence-')
    const configuredEnv = join(tempDir('forgeloop-gap-hook-'), 'env.txt')
    writeFileSync(
      join(configuredDir, '.git/hooks/pre-commit'),
      `#!/bin/sh\nprintf '%s' "\${PRE_COMMIT_ALLOW_NO_CONFIG-}" > "${configuredEnv}"\nexit 0\n`,
      { mode: 0o755 },
    )

    const configured = integrate(configuredDir, configuredCandidate, configuredEvidence, [])

    expect(configured.ok).toBe(true)
    expect(configured.checkPassed).toBe(true)
    expect(readFileSync(configuredEnv, 'utf8')).toBe('')
    expect(git(configuredDir, ['log', '-1', '--pretty=%s'])).toBe('feat: test candidate')
    if (previousAllowNoConfig !== undefined) {
      process.env.PRE_COMMIT_ALLOW_NO_CONFIG = previousAllowNoConfig
    }
  })

  it('refuses a dirty project and a moved baseline with exact messages and releases the lock', () => {
    const project = makeProject()
    const candidate = candidateFor(project.dir)
    const evidence = tempDir('forgeloop-gap-integration-evidence-')
    writeFileSync(join(project.dir, 'README.md'), 'dirty\n')

    const dirty = integrate(project.dir, candidate, evidence, [])

    expect(dirty).toEqual({
      ok: false,
      checkPassed: false,
      commitSha: '',
      files: [],
      checkLogPath: '',
      checkSha256: '',
      detail: '真实项目工作树有未提交改动；不能把本次需求与其他改动混入同一提交',
    })
    expect(existsSync(join(project.dir, '.git', 'forgeloop-commit.lock'))).toBe(false)

    git(project.dir, ['checkout', '--', 'README.md'])
    writeFileSync(join(project.dir, 'extra.txt'), 'extra work\n')
    git(project.dir, ['add', 'extra.txt'])
    git(project.dir, ['commit', '-qm', 'concurrent work'])
    const movedHead = git(project.dir, ['rev-parse', 'HEAD'])

    const moved = integrate(project.dir, candidate, evidence, [])

    expect(moved).toEqual({
      ok: false,
      checkPassed: false,
      commitSha: '',
      files: [],
      checkLogPath: '',
      checkSha256: '',
      detail: `真实项目 HEAD 已从候选基线 ${candidate.baseline.slice(0, 12)} 变为 ${movedHead.slice(0, 12)}；需重新研发`,
    })
    expect(existsSync(join(project.dir, '.git', 'forgeloop-commit.lock'))).toBe(false)
  })
})
