import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { evidenceDir, sessionsDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import type { PlannedTask, TaskPlan } from '../domain/task-plan.js'
import { executionOrder, parseTaskPlanDraft } from '../domain/task-plan.js'
import { planCoverageIssues } from '../domain/spec.js'
import {
  DEVELOPING,
  TASK_RUN_BLOCKED,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
  TASK_RUN_RUNNING,
} from '../domain/status.js'
import { attemptAllowed } from '../domain/limits.js'
import { sha256OfText } from '../domain/delivery.js'
import { errorMessage } from '../domain/errors.js'
import {
  languageRulesFor,
  languageViolations,
  outsideActiveSource,
  unknownPackages,
} from '../domain/language.js'
import type { Repository } from '../records/repository.js'
import type { AgentSession } from './agent-runner.js'
import { devPlanningPrompt, devPrompt } from './prompts.js'
import { summarizeActivity } from './service-helpers.js'
import {
  captureCandidate,
  git,
  headCommit,
  prepareSnapshotWorkspace,
  requireGit,
  runCommand,
} from './workspace.js'
import type { TaskRunState } from '../domain/status.js'
import { runFormalTest } from './formal-test.js'
import {
  parseSelfVerificationReport,
  selfVerificationSufficient,
  type SelfVerificationReport,
} from '../domain/self-verification.js'

/**
 * 研发回合结束后是否按“没有改动”重试。每个任务都必须产生实际改动；
 * git 查询失败本身也算失败，不能拿空结果当真。
 */
function needsNoChangeRetry(status: { code: number; stdout: string }): boolean {
  return status.code !== 0 || status.stdout.trim() === ''
}

/**
 * 研发回合上限（秒）：`lower` 是任务工时与 agent 回合上限的较大者，`cap` 是长任务硬上限。
 * 两者都可能是 -1（不限）：只有 `lower` 不限时才退化到 `cap`，都无限制时返回 -1，
 * 调用方据此不建定时器；0 不是合法的“不限”取值，不能让它变成立即超时。
 */
export function turnTimeoutSeconds(lower: number, cap: number): number {
  if (lower <= 0) return cap > 0 ? cap : -1
  return cap > 0 ? Math.min(lower, cap) : lower
}

export interface ExecutionDevDeps {
  config: ForgeLoopConfig
  repo: Repository
  now: () => string
  recordRun: (
    reqId: string,
    plan: TaskPlan,
    task: PlannedTask,
    outcome: { state: TaskRunState; reason: string },
  ) => void
  previousTaskFailure: (reqId: string, planVersion: number, taskId: string) => string
  formalTest: typeof runFormalTest
  existingPackages: () => string[]
  ctx: Record<string, unknown>
  authorizedPlan: (plan: TaskPlan, source: string) => TaskPlan
  applyDiffFile: (
    dir: string,
    diffPath: string,
    label: string,
    suffix: string,
  ) => { ok: boolean; detail: string }
}

export class ExecutionDev {
  constructor(private readonly deps: ExecutionDevDeps) {}

  /**
   * 按当前项目基线准备研发会话的固定工作区；路径随会话保留，内容整体刷新。
   * 旧文件全部丢弃，避免把上一个需求的工作副本当成新需求的基线。
   */
  prepareDevWorkspace(workspace: string): {
    workspace: string
    baselineCommit: string
    snapshotCommit: string
  } {
    const baselineCommit = headCommit(this.deps.config.projectPath)
    prepareSnapshotWorkspace({
      projectPath: this.deps.config.projectPath,
      workspacePath: workspace,
      baselineCommit,
    })
    const snapshotCommit = requireGit(workspace, ['rev-parse', 'HEAD']).trim()
    return { workspace, baselineCommit, snapshotCommit }
  }

  /** 复用会话前核对现场：路径存在、Git 工作副本干净，才能安全刷新到新基线。 */
  workspaceStatus(workspace: string): { exists: boolean; clean: boolean; head: string } {
    if (!existsSync(join(workspace, '.git'))) return { exists: false, clean: false, head: '' }
    const status = git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])
    return {
      exists: true,
      clean: status.code === 0 && status.stdout.trim() === '',
      head: requireGit(workspace, ['rev-parse', 'HEAD']).trim(),
    }
  }

  /** 重启后把已交付任务的增量 diff 依次恢复到同一个研发工作区。 */
  restoreDeliveredArtifacts(
    reqId: string,
    plan: TaskPlan,
    workspace: string,
    baselineCommit: string,
  ): { ok: true } | { ok: false; reason: string } {
    for (const taskId of executionOrder(plan)) {
      const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
      if (!task) continue
      const artifact = this.deps.repo.taskArtifact(reqId, plan.planVersion, task.taskId)
      if (!artifact) continue
      if (artifact.baselineCommit !== baselineCommit) {
        return {
          ok: false,
          reason: `任务 ${task.taskId} 的交付基线 ${artifact.baselineCommit.slice(0, 12)} 与当前现场 ${baselineCommit.slice(0, 12)} 不一致；不能自动拼接`,
        }
      }
      const evidence = this.deps.repo.evidence(reqId, plan.planVersion, task.taskId)
      if (!evidence || !existsSync(evidence.candidatePath)) {
        return { ok: false, reason: `任务 ${task.taskId} 缺交付证据，不能恢复现场` }
      }
      const applied = this.deps.applyDiffFile(
        workspace,
        evidence.candidatePath,
        task.taskId,
        task.taskId,
      )
      if (!applied.ok) {
        return { ok: false, reason: `恢复任务 ${task.taskId} 的 diff 失败：${applied.detail}` }
      }
      runCommand('git', ['add', '-A'], workspace)
      runCommand('git', ['commit', '-qm', `forgeloop: restore ${task.taskId}`], workspace)
    }
    return { ok: true }
  }

  /**
   * 在研发会话第一回合完成技术方案与任务拆解：不再单独起规划角色，
   * 规划结果仍由程序校验并落库；技术方案是工作记录，不是批准门禁。
   */
  async planInDevSession(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    session: AgentSession
    authorizationSource: string
    signal: AbortSignal
  }): Promise<{ ok: true; plan: TaskPlan } | { ok: false; code: string; reason: string }> {
    let feedback = ''
    let lastError = ''
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await input.session.send({
        prompt: devPlanningPrompt(input.requirement, input.analysis, { tools: 'read' }) + feedback,
        timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
        transcriptPath: join(
          sessionsDir(this.deps.config),
          `${input.reqId}-plan-a${attempt}.jsonl`,
        ),
        signal: input.signal,
      })
      if (result.status === 'aborted' || result.status === 'timeout') {
        return { ok: false, code: 'interrupted', reason: result.reason }
      }
      if (result.status !== 'completed') {
        lastError = result.reason || '研发 Agent 未正常完成'
        feedback = `\n\n上一次输出未完成：${lastError}。请重新输出完整任务包 JSON。`
        continue
      }
      let plan: TaskPlan
      try {
        plan = parseTaskPlanDraft(result.text, {
          requirementId: input.reqId,
          project: input.requirement.project,
          planVersion: this.deps.repo.nextPlanVersion(input.reqId),
          requirementVersion: input.requirement.versions.length,
          now: this.deps.now(),
        })
      } catch (error) {
        lastError = `任务包不合规：${errorMessage(error)}`
        feedback = `\n\n上一次输出的任务包被程序拒绝：${lastError}。不要输出 <｜｜DSML｜｜> 或工具调用标记；请只输出完整 JSON 文本。`
        continue
      }
      const coverageIssues = planCoverageIssues(input.analysis, plan)
      if (coverageIssues.length > 0) {
        lastError = `任务包未覆盖需求条目：${coverageIssues.map((issue) => issue.detail).join('；')}`
        feedback = `\n\n上一次输出的任务包没有覆盖全部分析条目：${lastError}。请为每个任务补全 covers，并覆盖所有场景、业务规则、异常与边界、验收标准。`
        continue
      }
      const packages = this.deps.existingPackages()
      const violations = [
        ...languageViolations(plan, languageRulesFor(this.deps.config.activeRoots)),
        ...outsideActiveSource(plan, this.deps.config.activeRoots),
        ...unknownPackages(plan, packages),
      ]
      if (violations.length > 0) {
        lastError = `任务包越过 TypeScript 语言/工程边界：${violations
          .map(
            (violation) =>
              `${violation.taskId}.${violation.field}=${violation.value}（${violation.reason}）`,
          )
          .join('；')}`
        feedback = `\n\n上一次输出的任务包越过授权边界：${lastError}。请缩小到当前项目与已登记依赖。`
        continue
      }
      const authorized = this.deps.authorizedPlan(plan, input.authorizationSource)
      this.deps.repo.recordTaskPlan(authorized)
      this.deps.repo.setStatus(
        input.reqId,
        DEVELOPING,
        '系统准入通过，研发 Agent 已形成技术方案与任务拆解',
      )
      return { ok: true, plan: authorized }
    }
    return { ok: false, code: 'plan_failed', reason: lastError || '任务包生成失败' }
  }

  private recordAttemptEvidence(input: {
    attemptDir: string
    taskDir: string
    reqId: string
    planVersion: number
    taskId: string
    attempt: number
    command: readonly string[]
    headBefore: string
    headAfter: string
    test: Awaited<ReturnType<typeof runFormalTest>>
  }): void {
    const record = {
      reqId: input.reqId,
      planVersion: input.planVersion,
      taskId: input.taskId,
      attempt: input.attempt,
      command: input.command,
      headBefore: input.headBefore,
      headAfter: input.headAfter,
      exitCode: input.test.exitCode,
      timedOut: input.test.timedOut,
      aborted: input.test.aborted,
      durationMs: input.test.durationMs,
      logPath: input.test.logPath,
      logSha256: input.test.logSha256,
      recordedAt: this.deps.now(),
    }
    writeFileSync(
      join(input.attemptDir, 'attempt.json'),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    )
    // 兼容旧读取路径：保留当前任务目录的日志副本；逐次历史以 attempts/ 为准。
    writeFileSync(join(input.taskDir, 'formal-test.log'), readFileSync(input.test.logPath))
  }

  private recordAttemptCandidate(input: {
    attemptDir: string
    taskDir: string
    capture: ReturnType<typeof captureCandidate>
  }): void {
    writeFileSync(
      join(input.attemptDir, 'candidate.json'),
      `${JSON.stringify(
        {
          changedFiles: input.capture.changedFiles,
          diffSha256: input.capture.diffSha256,
          diffPath: input.capture.diffPath,
          recordedAt: this.deps.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    writeFileSync(join(input.taskDir, 'candidate.diff'), readFileSync(input.capture.diffPath))
  }

  /** 保存本次尝试的自验证报告，并判断是否足以继续或需要回交澄清。 */
  private persistSelfVerification(input: {
    text: string
    attemptDir: string
    taskDir: string
    inputKind: 'requirement' | 'problem'
    reqId: string
    plan: TaskPlan
    task: PlannedTask
  }):
    | {
        blocked: {
          state: 'blocked'
          reason: string
          selfVerification?: SelfVerificationReport
          clarification?: { question: string; context: string }
        }
      }
    | { blocked?: undefined; selfVerification?: SelfVerificationReport } {
    const parsed = parseSelfVerificationReport(input.text)
    const reportPath = join(input.attemptDir, 'self-verification.json')
    const reportJson = `${JSON.stringify(
      parsed ?? {
        mode: 'independent',
        risk: 'unknown',
        white_box: [],
        black_box: [],
        red_green: {
          required: false,
          failing_before: false,
          passing_after: false,
          evidence: '',
        },
        reason: '研发 Agent 未给出可解析的自验证 JSON；保守要求独立验证',
      },
      null,
      2,
    )}\n`
    writeFileSync(reportPath, reportJson, 'utf8')
    writeFileSync(join(input.taskDir, 'self-verification.json'), reportJson)
    if (parsed?.needsClarification) {
      return {
        blocked: {
          state: 'blocked',
          reason: `研发需要产品澄清：${parsed.needsClarification.question}`,
          selfVerification: parsed,
          clarification: parsed.needsClarification,
        },
      }
    }
    if (parsed) {
      const sufficient = selfVerificationSufficient({
        inputKind: input.inputKind,
        report: parsed,
      })
      if (!sufficient.ok && parsed.mode === 'self') {
        return {
          blocked: {
            state: 'blocked',
            reason: `研发自验证不足：${sufficient.reason}；请补充证据或改为 independent`,
            selfVerification: parsed,
          },
        }
      }
    }
    return { ...(parsed === null ? {} : { selfVerification: parsed }) }
  }

  /** 在同一个研发会话与工作区里完成一个任务；自验失败留在现场继续修，不重建副本。 */
  private recordDeliveredTask(input: {
    reqId: string
    plan: TaskPlan
    task: PlannedTask
    workspace: string
    sessionId: string
    authorizationSource: string
    capture: ReturnType<typeof captureCandidate>
    test: Awaited<ReturnType<typeof runFormalTest>>
    taskDir: string
  }): void {
    const reviewNote = {
      kind: 'self-check',
      taskId: input.task.taskId,
      verdict: 'pass',
      detail: '研发 Agent 自验通过；独立验证由验证 Agent 在固定候选上完成。',
      testLog: input.test.logPath,
      at: this.deps.now(),
    }
    const reviewPath = join(input.taskDir, 'review.json')
    writeFileSync(reviewPath, `${JSON.stringify(reviewNote, null, 2)}\n`, 'utf8')
    this.deps.repo.recordTaskArtifact({
      requirementId: input.reqId,
      planVersion: input.plan.planVersion,
      taskId: input.task.taskId,
      candidateSha256: input.capture.diffSha256,
      testEvidenceSha256: input.test.logSha256,
      reviewSha256: sha256OfText(JSON.stringify(reviewNote)),
      acceptance: input.task.acceptance,
      authorizationSource: input.authorizationSource,
      recordedAt: this.deps.now(),
      baselineCommit: headCommit(this.deps.config.projectPath),
    })
    this.deps.repo.recordEvidence({
      requirementId: input.reqId,
      planVersion: input.plan.planVersion,
      taskId: input.task.taskId,
      baselineCommit: headCommit(this.deps.config.projectPath),
      workspacePath: input.workspace,
      candidatePath: input.capture.diffPath,
      testLogPath: input.test.logPath,
      reviewPath,
      devSession: input.sessionId,
      reviewSession: '',
      recordedAt: this.deps.now(),
    })
  }

  private taskNoChangeFeedback(input: {
    reqId: string
    plan: TaskPlan
    task: PlannedTask
  }): string {
    this.deps.recordRun(input.reqId, input.plan, input.task, {
      state: TASK_RUN_FAILED,
      reason: '研发回合没有产生任何文件改动',
    })
    return '\n\n上一次研发没有产生任何文件改动。请真正实现任务目标。'
  }

  /**
   * 任务包的 limit_seconds 是任务的工时预算，回合上限不能比它更短；
   * 同时受 agent.maxTurnSeconds 硬上限约束。三者都为 -1（默认）时不设回合超时。
   */
  private devTurnTimeoutMs(task: PlannedTask): number {
    const floor = this.deps.config.agent.timeoutSeconds
    const cap = this.deps.config.agent.maxTurnSeconds ?? -1
    const planned = task.limits.limitSeconds
    return turnTimeoutSeconds(Math.max(planned, floor), cap) * 1000
  }

  /**
   * 中断时先把尚未交付的改动落成检查点：工作副本会在下一次执行时重建，
   * 不保存 diff 的话，几十分钟的修改会直接丢失。
   */
  private saveCheckpoint(input: {
    reqId: string
    plan: TaskPlan
    task: PlannedTask
    workspace: string
    attempt: number
    status: 'aborted' | 'timeout' | 'stopped'
    detail: string
  }): string {
    const taskDir = evidenceDir(
      this.deps.config,
      input.reqId,
      input.plan.planVersion,
      input.task.taskId,
    )
    mkdirSync(taskDir, { recursive: true })
    try {
      const capture = captureCandidate({
        worktreePath: input.workspace,
        diffPath: join(taskDir, `checkpoint-a${input.attempt}.diff`),
      })
      if (capture.changedFiles.length === 0) return ''
      writeFileSync(
        join(taskDir, `checkpoint-a${input.attempt}.json`),
        `${JSON.stringify(
          {
            at: this.deps.now(),
            taskId: input.task.taskId,
            attempt: input.attempt,
            status: input.status,
            detail: input.detail,
            changedFiles: capture.changedFiles,
            diffSha256: capture.diffSha256,
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      return capture.diffPath
    } catch {
      // 检查点是尽力保存；采集失败不能覆盖原始中断原因。
      return ''
    }
  }

  private taskStopped(
    input: {
      reqId: string
      plan: TaskPlan
      task: PlannedTask
      workspace: string
    },
    attempt: number,
  ): { state: 'blocked'; reason: string } {
    const checkpoint = this.saveCheckpoint({
      ...input,
      attempt,
      status: 'stopped',
      detail: '停止请求',
    })
    const suffix = checkpoint ? `，未交付改动已保存到 ${checkpoint}` : ''
    const reason = `停止请求：任务未交付，研发现场保留${suffix}，可继续执行`
    this.deps.recordRun(input.reqId, input.plan, input.task, {
      state: TASK_RUN_BLOCKED,
      reason,
    })
    return { state: 'blocked', reason }
  }

  private taskAborted(
    input: {
      reqId: string
      plan: TaskPlan
      task: PlannedTask
      workspace: string
      attempt: number
    },
    status: 'aborted' | 'timeout',
    detail: string,
  ): { state: 'blocked'; reason: string } {
    const checkpoint = this.saveCheckpoint({ ...input, status, detail })
    const suffix = checkpoint ? `，未交付改动已保存到 ${checkpoint}` : ''
    const reason = `研发回合${status === 'aborted' ? '被停止' : '超时'}：${detail}；现场保留${suffix}，可继续修复`
    this.deps.recordRun(input.reqId, input.plan, input.task, {
      state: TASK_RUN_BLOCKED,
      reason: reason,
    })
    return { state: 'blocked', reason }
  }

  // 该方法是任务级编排入口，分支和语句较多；具体证据写入已拆到独立方法。
  // eslint-disable-next-line complexity, max-statements
  async developTaskInSession(input: {
    reqId: string
    requirement: Requirement
    plan: TaskPlan
    task: PlannedTask
    workspace: string
    session: AgentSession
    authorizationSource: string
    inputKind: 'requirement' | 'problem'
    signal: AbortSignal
  }): Promise<{
    state: 'delivered' | 'blocked'
    reason: string
    selfVerification?: SelfVerificationReport
    clarification?: { question: string; context: string }
  }> {
    const taskDir = evidenceDir(
      this.deps.config,
      input.reqId,
      input.plan.planVersion,
      input.task.taskId,
    )
    mkdirSync(taskDir, { recursive: true })
    const turnTimeoutMs = this.devTurnTimeoutMs(input.task)
    let feedback = this.deps.previousTaskFailure(
      input.reqId,
      input.plan.planVersion,
      input.task.taskId,
    )
    for (let attempt = 1; attemptAllowed(attempt, this.deps.config.maxTaskAttempts); attempt += 1) {
      if (input.signal.aborted) {
        return this.taskStopped(input, attempt)
      }
      const attemptDir = join(taskDir, 'attempts', `a${attempt}-${Date.now()}`)
      mkdirSync(attemptDir, { recursive: true })
      let headBefore = ''
      try {
        headBefore = requireGit(input.workspace, ['rev-parse', 'HEAD']).trim()
      } catch {
        // 证据采集失败不阻断研发回合；缺少代码身份会在 attempt.json 中如实为空。
      }
      this.deps.recordRun(input.reqId, input.plan, input.task, {
        state: TASK_RUN_RUNNING,
        reason: '研发 Agent 工作中',
      })
      const result = await input.session.send({
        prompt:
          devPrompt({
            requirement: input.requirement,
            plan: input.plan,
            task: input.task,
            workdir: input.workspace,
          }) + feedback,
        timeoutMs: turnTimeoutMs,
        transcriptPath: join(attemptDir, 'dev.jsonl'),
        signal: input.signal,
        onActivity: (events: readonly Record<string, unknown>[]) => {
          this.deps.repo.heartbeatTaskRun({
            requirementId: input.reqId,
            planVersion: input.plan.planVersion,
            taskId: input.task.taskId,
            reason: summarizeActivity(events),
            updatedAt: this.deps.now(),
          })
        },
      })
      if (result.status === 'aborted' || result.status === 'timeout') {
        return this.taskAborted(
          {
            reqId: input.reqId,
            plan: input.plan,
            task: input.task,
            workspace: input.workspace,
            attempt,
          },
          result.status,
          result.reason,
        )
      }
      if (result.status !== 'completed') {
        this.deps.recordRun(input.reqId, input.plan, input.task, {
          state: TASK_RUN_FAILED,
          reason: result.reason,
        })
        feedback = `\n\n上一次研发回合未完成：${result.reason}。请继续完成同一个任务。`
        continue
      }
      const status = git(input.workspace, ['status', '--porcelain=v1', '--untracked-files=all'])
      // 只读任务本来就不改文件：空改动不是失败信号，直接进入正式测试；
      // 否则在 maxTaskAttempts = -1 下这种任务会永远重试，把模型调用堆到任意大。
      if (needsNoChangeRetry(status)) {
        feedback = this.taskNoChangeFeedback(input)
        continue
      }
      const test = await this.deps.formalTest({
        ctx: this.deps.ctx,
        cwd: input.workspace,
        argv: input.task.testCommand,
        timeoutMs: this.deps.config.formalTestTimeoutSeconds * 1000,
        logPath: join(attemptDir, 'formal-test.log'),
        signal: input.signal,
      })
      let headAfter = ''
      try {
        headAfter = requireGit(input.workspace, ['rev-parse', 'HEAD']).trim()
      } catch {
        // 同上：非 Git 现场的测试替身不阻断自验，身份字段保持为空。
      }
      this.recordAttemptEvidence({
        attemptDir,
        taskDir,
        reqId: input.reqId,
        planVersion: input.plan.planVersion,
        taskId: input.task.taskId,
        attempt,
        command: input.task.testCommand,
        headBefore,
        headAfter,
        test,
      })
      if (test.aborted || test.timedOut) {
        const reason = test.aborted
          ? '研发自验被停止：现场保留，可继续执行'
          : `研发自验超时（${this.deps.config.formalTestTimeoutSeconds} 秒）：现场保留，可继续修复`
        this.deps.recordRun(input.reqId, input.plan, input.task, {
          state: TASK_RUN_BLOCKED,
          reason: reason,
        })
        return { state: 'blocked', reason }
      }
      if (test.exitCode !== 0) {
        this.deps.recordRun(input.reqId, input.plan, input.task, {
          state: TASK_RUN_FAILED,
          reason: `研发自验退出码 ${test.exitCode}，日志 ${test.logPath}`,
        })
        feedback = `\n\n研发自验未通过（退出码 ${test.exitCode}）。日志：${test.logPath}\n${test.output.slice(-4000)}\n请在同一工作区修复后继续。`
        continue
      }
      const capture = captureCandidate({
        worktreePath: input.workspace,
        diffPath: join(attemptDir, 'candidate.diff'),
      })
      if (capture.changedFiles.length === 0) {
        feedback = this.taskNoChangeFeedback(input)
        continue
      }
      this.recordAttemptCandidate({ attemptDir, taskDir, capture })
      runCommand('git', ['commit', '-qm', `forgeloop: task ${input.task.taskId}`], input.workspace)
      const selfCheck = this.persistSelfVerification({
        text: result.text,
        attemptDir,
        taskDir,
        inputKind: input.inputKind,
        reqId: input.reqId,
        plan: input.plan,
        task: input.task,
      })
      if (selfCheck.blocked) {
        this.deps.recordRun(input.reqId, input.plan, input.task, {
          state: TASK_RUN_BLOCKED,
          reason: selfCheck.blocked.reason,
        })
        return selfCheck.blocked
      }
      const selfVerification = selfCheck.selfVerification
      this.recordDeliveredTask({
        reqId: input.reqId,
        plan: input.plan,
        task: input.task,
        workspace: input.workspace,
        sessionId: input.session.sessionId,
        authorizationSource: input.authorizationSource,
        capture,
        test,
        taskDir,
      })
      this.deps.recordRun(input.reqId, input.plan, input.task, {
        state: TASK_RUN_DELIVERED,
        reason: '',
      })
      return { state: 'delivered', reason: '', ...(selfVerification ? { selfVerification } : {}) }
    }
    const reason = `任务 ${input.task.taskId} 已尝试 ${this.deps.config.maxTaskAttempts} 次仍未通过自验；现场保留，等待修复或授权`
    this.deps.recordRun(input.reqId, input.plan, input.task, {
      state: TASK_RUN_BLOCKED,
      reason: reason,
    })
    return { state: 'blocked', reason }
  }

  /** 把研发工作区当前 HEAD 固定为需求级候选；旧候选与报告保留。 */
  /**
   * 隔离故障注入：只在显式设置 FORGELOOP_FAULT_INJECT 的测试宿主生效，
   * 对每个需求/方案只注入一次，并把注入事实写入候选证据目录。生产不设置该变量。
   */
}
