import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { evidenceDir, sessionsDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import type { PlannedTask, TaskPlan } from '../domain/task-plan.js'
import { executionOrder, parseTaskPlanDraft } from '../domain/task-plan.js'
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
import { languageViolations, outsideActiveSource, unknownPackages } from '../domain/language.js'
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
      const packages = this.deps.existingPackages()
      const violations = [
        ...languageViolations(plan),
        ...outsideActiveSource(plan),
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
   * 同时受 agent.maxTurnSeconds 硬上限约束。三者都为 0（默认）时不设回合超时。
   */
  private devTurnTimeoutMs(task: PlannedTask): number {
    const floor = this.deps.config.agent.timeoutSeconds
    const cap = this.deps.config.agent.maxTurnSeconds ?? 0
    const planned = task.limits.limitSeconds
    const lower = Math.max(planned, floor)
    if (lower <= 0) return cap > 0 ? cap * 1000 : 0
    return (cap > 0 ? Math.min(lower, cap) : lower) * 1000
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

  async developTaskInSession(input: {
    reqId: string
    requirement: Requirement
    plan: TaskPlan
    task: PlannedTask
    workspace: string
    session: AgentSession
    authorizationSource: string
    signal: AbortSignal
  }): Promise<{ state: 'delivered' | 'blocked'; reason: string }> {
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
        transcriptPath: join(taskDir, `dev-a${attempt}.jsonl`),
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
      if (status.code !== 0 || status.stdout.trim() === '') {
        feedback = this.taskNoChangeFeedback(input)
        continue
      }
      const test = await this.deps.formalTest({
        ctx: this.deps.ctx,
        cwd: input.workspace,
        argv: input.task.testCommand,
        timeoutMs: this.deps.config.formalTestTimeoutSeconds * 1000,
        logPath: join(taskDir, 'formal-test.log'),
        signal: input.signal,
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
        diffPath: join(taskDir, 'candidate.diff'),
      })
      if (capture.changedFiles.length === 0) {
        feedback = this.taskNoChangeFeedback(input)
        continue
      }
      runCommand('git', ['commit', '-qm', `forgeloop: task ${input.task.taskId}`], input.workspace)
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
      return { state: 'delivered', reason: '' }
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
