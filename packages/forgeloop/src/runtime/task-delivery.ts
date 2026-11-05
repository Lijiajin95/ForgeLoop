import { join } from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { ForgeLoopConfig } from '../config.js'
import { evidenceDir, reviewDir, workspaceDir } from '../config.js'
import type { Requirement } from '../domain/requirement.js'
import { ancestorTaskIds, type PlannedTask, type TaskPlan } from '../domain/task-plan.js'
import {
  FAILURE_FORMAL_TEST,
  FAILURE_IMPLEMENTATION_REVIEW,
  GrantLedger,
} from '../domain/counting.js'
import { AGENT_VERIFY } from '../domain/agents.js'
import { attemptAllowed } from '../domain/limits.js'
import type { TaskRunState } from '../domain/status.js'
import {
  EXECUTING,
  TASK_RUN_BLOCKED,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
  TASK_RUN_RUNNING,
} from '../domain/status.js'
import { errorMessage } from '../domain/errors.js'
import { sha256OfText } from '../domain/delivery.js'
import { summarizeActivity } from './service-helpers.js'
import { captureCandidate, prepareSnapshotWorkspace, runCommand } from './workspace.js'
import { devPrompt, parseReviewVerdict, reviewPrompt } from './prompts.js'
import type { AgentRunner } from './agent-runner.js'
import type { Repository } from '../records/repository.js'
import type { runFormalTest } from './formal-test.js'

export interface TaskDeliveryDeps {
  config: ForgeLoopConfig
  repo: Repository
  now: () => string
  charge: (reqId: string, started: number) => void
  runner: { run: AgentRunner['run'] }
  formalTest: typeof runFormalTest
  ctx: NonNullable<Parameters<typeof runFormalTest>[0]['ctx']>
  recordRun: (
    reqId: string,
    plan: TaskPlan,
    task: PlannedTask,
    outcome: { state: TaskRunState; reason: string },
  ) => void
  previousTaskFailure: (reqId: string, planVersion: number, taskId: string) => string
  applyDiffFile: (
    dir: string,
    diffPath: string,
    label: string,
    suffix: string,
  ) => { ok: boolean; detail: string }
}

export interface DeliverInput {
  requirement: Requirement
  plan: TaskPlan
  taskId: string
  baseline: string
  authorizationSource: string
  signal: AbortSignal
  requestId: string
}

export interface DeliverOutcome {
  state: 'delivered' | 'awaiting_user' | 'failed' | 'blocked'
  reason: string
  requirementStatus: string
  interrupted?: boolean
}

export class TaskDelivery {
  constructor(private readonly deps: TaskDeliveryDeps) {}

  async deliver(input: {
    requirement: Requirement
    plan: TaskPlan
    taskId: string
    baseline: string
    authorizationSource: string
    signal: AbortSignal
    /** 推进请求身份：失败轮次 ID 带上它，跨请求重试时同一尝试序号不会互相吞掉。 */
    requestId: string
  }): Promise<{
    state: 'delivered' | 'awaiting_user' | 'failed' | 'blocked'
    reason: string
    requirementStatus: string
    /** 这次尝试是否因停止/超时/宿主中断而未完成；用于计一轮中断失败。 */
    interrupted?: boolean
  }> {
    const { requirement, plan, taskId, baseline, authorizationSource, signal, requestId } = input
    const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
    if (!task)
      return {
        state: 'blocked',
        reason: `任务包内没有任务 ${taskId}`,
        requirementStatus: 'blocked',
      }
    const taskDir = evidenceDir(this.deps.config, requirement.reqId, plan.planVersion, taskId)
    const worktree = workspaceDir(this.deps.config, requirement.reqId, plan.planVersion, taskId)
    mkdirSync(taskDir, { recursive: true })

    // 人工重试是新的一次 advance；把上一次失败原因和测试日志尾部重新交给实现者，
    // 不要求它从零猜测，也不因此跳过失败轮次或文件边界。
    let feedback = this.deps.previousTaskFailure(requirement.reqId, plan.planVersion, taskId)
    let attempt = 0
    // 失败轮次 ID 绑定本次推进请求：跨请求重试时 attempt 从 1 重新开始，
    // 不能因为与上一次请求的 a1 同名而被当成重复计数。
    const roundIdFor = (attemptNumber: number): string => `${taskId}-${requestId}-a${attemptNumber}`
    const ledger = new GrantLedger(
      this.deps.repo.grantCount(requirement.reqId),
      this.deps.repo.failureRounds(requirement.reqId),
      this.deps.config.failureRoundsPerGrant,
    )
    while (attemptAllowed(attempt + 1, this.deps.config.maxTaskAttempts)) {
      attempt += 1
      if (signal.aborted) {
        return {
          state: 'blocked',
          reason: '停止请求：任务未交付，一次性工作副本会在下次执行时重建；可重新执行',
          requirementStatus: 'blocked',
          interrupted: true,
        }
      }
      const attemptPrep = this.prepareDeliveryAttempt({
        reqId: requirement.reqId,
        plan,
        taskId,
        baseline,
        signal,
        taskDir,
        worktree,
      })
      if (!attemptPrep.ok) return attemptPrep.result
      this.deps.recordRun(requirement.reqId, plan, task, {
        state: TASK_RUN_RUNNING,
        reason: '启动开发 Agent',
      })

      const devAttempt = await this.stepDevelopment({
        requirement,
        plan,
        task,
        taskDir,
        worktree,
        signal,
        feedback,
      })
      if ('continue' in devAttempt) {
        feedback = devAttempt.feedback
        continue
      }
      if ('result' in devAttempt) return devAttempt.result
      const { capture, devSession } = devAttempt
      const reviewed = await this.runIndependentReview({
        requirement,
        plan,
        task,
        taskDir,
        signal,
        capture,
        feedback,
        ledger,
        attempt,
        roundIdFor,
      })
      if ('continue' in reviewed) {
        feedback = reviewed.feedback
        continue
      }
      if ('result' in reviewed) return reviewed.result
      const { reviewPath, reviewSession } = reviewed
      const finished = await this.finishDeliveredTask({
        requirement,
        plan,
        task,
        taskDir,
        worktree,
        signal,
        baseline,
        authorizationSource,
        capture,
        reviewPath,
        reviewSession,
        devSession,
        ledger,
        attempt,
        roundIdFor,
        feedback,
      })
      if ('continue' in finished) {
        feedback = finished.feedback
        continue
      }
      return finished.result
    }
    return {
      state: 'awaiting_user',
      reason: `任务 ${taskId} 已尝试 ${attempt} 次仍未通过；等待人工决定`,
      requirementStatus: 'blocked',
    }
  }

  /**
   * 上一次失败留下的可复用上下文：运行原因、最近失败轮次与正式测试日志尾部。
   * 只在任务最近一次运行确为失败/阻塞/待决定时返回；交付或运行中不产生反馈。
   */
  private async stepDevelopment(input: {
    requirement: Requirement
    plan: TaskPlan
    task: PlannedTask
    taskDir: string
    worktree: string
    signal: AbortSignal
    feedback: string
  }): Promise<
    | { continue: true; feedback: string }
    | {
        result: {
          state: 'delivered' | 'awaiting_user' | 'failed' | 'blocked'
          reason: string
          requirementStatus: string
          interrupted?: boolean
        }
      }
    | { ok: true; capture: ReturnType<typeof captureCandidate>; devSession: string }
  > {
    const { requirement, plan, task, taskDir, worktree, signal } = input
    let feedback = input.feedback
    const devStarted = Date.now()
    const dev = await this.deps.runner.run({
      role: 'dev',
      cwd: worktree,
      prompt: devPrompt({ requirement, plan, task, workdir: worktree }) + feedback,
      // 研发执行只允许在隔离工作副本内改动；默认工具仍可用，越界写入由宿主沙箱拒绝。
      permission: 'workspace-write',
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
      transcriptPath: join(taskDir, 'dev.jsonl'),
      signal,
      onActivity: (events) => {
        this.deps.repo.heartbeatTaskRun({
          requirementId: requirement.reqId,
          planVersion: plan.planVersion,
          taskId: task.taskId,
          reason: summarizeActivity(events),
          updatedAt: this.deps.now(),
        })
      },
    })
    this.deps.charge(requirement.reqId, devStarted)
    if (dev.status === 'aborted' || dev.status === 'timeout') {
      const reason = `开发回合${
        dev.status === 'aborted' ? '被停止' : `超时（${dev.reason || '未给出原因'}）`
      }：任务未交付，一次性工作副本可丢弃；可重新执行`
      // 运行记录必须收口为 blocked：否则任务会永远显示“执行中”，
      // 心跳也停在中断那一刻，看板无法区分“还在跑”和“已经中断”。
      this.deps.recordRun(requirement.reqId, plan, task, {
        state: TASK_RUN_BLOCKED,
        reason: reason,
      })
      return {
        result: { state: 'blocked', reason, requirementStatus: 'blocked', interrupted: true },
      }
    }
    if (dev.status !== 'completed') {
      this.deps.recordRun(requirement.reqId, plan, task, {
        state: TASK_RUN_FAILED,
        reason: dev.reason,
      })
      feedback = `\n\n上一次实现回合失败：${dev.reason}。请重新完成。`
      return { continue: true, feedback }
    }

    // 执行角色的范围是整个工作区：计划里的 files 只是预期说明，不是硬边界。
    // 候选 diff 仍记录全部实际改动，供独立审查、验证和审计回查。
    const capture = captureCandidate({
      worktreePath: worktree,
      diffPath: join(taskDir, 'candidate.diff'),
    })
    if (capture.changedFiles.length === 0) {
      this.deps.recordRun(requirement.reqId, plan, task, {
        state: TASK_RUN_FAILED,
        reason: '开发回合没有产生任何文件改动',
      })
      feedback = '\n\n上一次实现没有产生任何文件改动。请真正修改允许清单内的文件。'
      return { continue: true, feedback }
    }
    return { ok: true, capture, devSession: dev.sessionId }
  }

  private async runIndependentReview(input: {
    requirement: Requirement
    plan: TaskPlan
    task: PlannedTask
    taskDir: string
    signal: AbortSignal
    capture: ReturnType<typeof captureCandidate>
    feedback: string
    ledger: GrantLedger
    attempt: number
    roundIdFor: (attempt: number) => string
  }): Promise<
    | { continue: true; feedback: string }
    | {
        result: {
          state: 'delivered' | 'awaiting_user' | 'failed' | 'blocked'
          reason: string
          requirementStatus: string
          interrupted?: boolean
        }
      }
    | { ok: true; reviewPath: string; reviewSession: string }
  > {
    const { requirement, plan, task, taskDir, signal, capture, ledger, attempt, roundIdFor } = input
    let feedback = input.feedback
    // 独立审查：新会话、只读提示词、独立目录，只针对固定候选 diff。
    const reviewWorkspace = reviewDir(
      this.deps.config,
      requirement.reqId,
      plan.planVersion,
      task.taskId,
    )
    mkdirSync(reviewWorkspace, { recursive: true })
    const reviewStarted = Date.now()
    const reviewRun = await this.deps.runner.run({
      role: AGENT_VERIFY,
      cwd: reviewWorkspace,
      prompt: reviewPrompt({
        requirement,
        plan,
        task,
        diff: capture.diff,
        changedFiles: capture.changedFiles,
        diffPath: capture.diffPath,
      }),
      permission: 'workspace-write',
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
      transcriptPath: join(taskDir, 'review.jsonl'),
      signal,
      tools: 'none',
    })
    this.deps.charge(requirement.reqId, reviewStarted)
    if (reviewRun.status !== 'completed') {
      const reason = `独立审查未取得可用结论：${reviewRun.reason}`
      this.deps.recordRun(requirement.reqId, plan, task, {
        state: TASK_RUN_BLOCKED,
        reason: reason,
      })
      return {
        result: {
          state: 'blocked',
          reason,
          requirementStatus: 'blocked',
          interrupted: reviewRun.status === 'aborted' || reviewRun.status === 'timeout',
        },
      }
    }
    let verdict
    try {
      verdict = parseReviewVerdict(reviewRun.text)
    } catch (error) {
      this.deps.recordRun(requirement.reqId, plan, task, {
        state: TASK_RUN_BLOCKED,
        reason: `审查结果畸形：${errorMessage(error)}`,
      })
      return {
        result: {
          state: 'blocked',
          reason: `审查结果畸形（fail-closed）：${errorMessage(error)}`,
          requirementStatus: 'blocked',
        },
      }
    }
    const reviewPath = join(taskDir, 'review.json')
    writeFileSync(reviewPath, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')
    if (verdict.verdict === 'block') {
      const summary = `独立审查阻断：${verdict.blocking.join('；')}`
      const recorded = ledger.recordFailure({
        roundId: roundIdFor(attempt),
        stage: FAILURE_IMPLEMENTATION_REVIEW,
        summary,
        occurredAt: this.deps.now(),
      })
      if (recorded.recorded) {
        this.deps.repo.recordFailureRound(requirement.reqId, {
          roundId: roundIdFor(attempt),
          stage: FAILURE_IMPLEMENTATION_REVIEW,
          summary,
          occurredAt: this.deps.now(),
        })
      }
      this.deps.recordRun(requirement.reqId, plan, task, {
        state: TASK_RUN_FAILED,
        reason: summary,
      })
      if (!ledger.canRecordFailure) {
        return {
          result: {
            state: 'awaiting_user',
            reason: `独立审查阻断且失败轮次额度已用尽（${ledger.cumulativeFailures}/${ledger.grantCount * ledger.roundsPerGrant}）；等待追加授权或停止`,
            requirementStatus: 'blocked',
          },
        }
      }
      feedback = `\n\n上一次独立审查阻断，必须修复：\n- ${verdict.blocking.join('\n- ')}`
      return { continue: true, feedback }
    }
    return { ok: true, reviewPath, reviewSession: reviewRun.sessionId }
  }

  private async finishDeliveredTask(input: {
    requirement: Requirement
    plan: TaskPlan
    task: PlannedTask
    taskDir: string
    worktree: string
    signal: AbortSignal
    baseline: string
    authorizationSource: string
    capture: ReturnType<typeof captureCandidate>
    reviewPath: string
    reviewSession: string
    devSession: string
    ledger: GrantLedger
    attempt: number
    roundIdFor: (attempt: number) => string
    feedback: string
  }): Promise<
    | { continue: true; feedback: string }
    | {
        result: {
          state: 'delivered' | 'awaiting_user' | 'failed' | 'blocked'
          reason: string
          requirementStatus: string
          interrupted?: boolean
        }
      }
  > {
    const { requirement, plan, task, taskDir, worktree, signal, baseline } = input
    const { authorizationSource, capture, reviewPath, reviewSession, devSession } = input
    const { ledger, attempt, roundIdFor } = input
    let feedback = input.feedback
    const testStarted = Date.now()
    const test = await this.deps.formalTest({
      ctx: this.deps.ctx,
      cwd: worktree,
      argv: task.testCommand,
      timeoutMs: this.deps.config.formalTestTimeoutSeconds * 1000,
      logPath: join(taskDir, 'formal-test.log'),
      signal,
    })
    this.deps.charge(requirement.reqId, testStarted)
    if (test.aborted) {
      const reason = '正式测试被停止：任务未交付，一次性工作副本可丢弃；可重新执行'
      this.deps.recordRun(requirement.reqId, plan, task, {
        state: TASK_RUN_BLOCKED,
        reason: reason,
      })
      return {
        result: {
          state: 'blocked',
          reason,
          requirementStatus: 'blocked',
          interrupted: true,
        },
      }
    }
    if (test.timedOut) {
      const reason = `正式测试超过 ${this.deps.config.formalTestTimeoutSeconds} 秒上限并被终止：任务未交付，可重新执行`
      this.deps.recordRun(requirement.reqId, plan, task, {
        state: TASK_RUN_BLOCKED,
        reason: reason,
      })
      return {
        result: {
          state: 'blocked',
          reason,
          requirementStatus: 'blocked',
          interrupted: true,
        },
      }
    }
    if (test.exitCode !== 0) {
      const recorded = ledger.recordFailure({
        roundId: roundIdFor(attempt),
        stage: FAILURE_FORMAL_TEST,
        summary: `正式测试退出码 ${test.exitCode === null ? 'null' : test.exitCode}`,
        occurredAt: this.deps.now(),
      })
      if (recorded.recorded) {
        this.deps.repo.recordFailureRound(requirement.reqId, {
          roundId: roundIdFor(attempt),
          stage: FAILURE_FORMAL_TEST,
          summary: `正式测试退出码 ${test.exitCode === null ? 'null' : test.exitCode}`,
          occurredAt: this.deps.now(),
        })
      }
      this.deps.recordRun(requirement.reqId, plan, task, {
        state: TASK_RUN_FAILED,
        reason: `正式测试失败（退出码 ${test.exitCode}），日志 ${test.logPath}`,
      })
      if (!ledger.canRecordFailure) {
        return {
          result: {
            state: 'awaiting_user',
            reason: `正式测试失败且失败轮次额度已用尽（${ledger.cumulativeFailures}/${ledger.grantCount * ledger.roundsPerGrant}）；等待追加授权或停止`,
            requirementStatus: 'blocked',
          },
        }
      }
      feedback = `\n\n上一次正式测试失败（退出码 ${test.exitCode}）。日志：${test.logPath}\n${test.output.slice(-4000)}`
      return { continue: true, feedback }
    }

    this.deps.repo.recordTaskArtifact({
      requirementId: requirement.reqId,
      planVersion: plan.planVersion,
      taskId: task.taskId,
      candidateSha256: capture.diffSha256,
      testEvidenceSha256: test.logSha256,
      reviewSha256: sha256OfText(readFileSync(reviewPath, 'utf8')),
      acceptance: task.acceptance,
      authorizationSource,
      recordedAt: this.deps.now(),
      baselineCommit: baseline,
    })
    this.deps.repo.recordEvidence({
      requirementId: requirement.reqId,
      planVersion: plan.planVersion,
      taskId: task.taskId,
      baselineCommit: baseline,
      workspacePath: worktree,
      candidatePath: capture.diffPath,
      testLogPath: test.logPath,
      reviewPath,
      devSession: devSession,
      reviewSession,
      recordedAt: this.deps.now(),
    })
    this.deps.recordRun(requirement.reqId, plan, task, { state: TASK_RUN_DELIVERED, reason: '' })
    rmSync(worktree, { recursive: true, force: true })
    return { result: { state: 'delivered', reason: '', requirementStatus: EXECUTING } }
  }

  private prepareDeliveryAttempt(input: {
    reqId: string
    plan: TaskPlan
    taskId: string
    baseline: string
    signal: AbortSignal
    taskDir: string
    worktree: string
  }):
    | { ok: true }
    | { ok: false; result: { state: 'blocked'; reason: string; requirementStatus: string } } {
    const { plan, taskId, baseline, taskDir, worktree } = input
    const snapshot = prepareSnapshotWorkspace({
      projectPath: this.deps.config.projectPath,
      workspacePath: worktree,
      baselineCommit: baseline,
    })
    // 上游任务已交付的改动必须先进入本任务副本；否则依赖任务会在自己的
    // 文件清单里重写上游实现，范围检查会（正确地）阻断它。
    const upstream = ancestorTaskIds(plan, taskId)
    const appliedUpstream: string[] = []
    for (const ancestor of upstream) {
      const evidence = this.deps.repo.evidence(input.reqId, plan.planVersion, ancestor)
      if (!evidence) {
        return {
          ok: false,
          result: {
            state: 'blocked',
            reason: `任务 ${taskId} 依赖 ${ancestor}，但缺少其交付证据；不能继续`,
            requirementStatus: 'blocked',
          },
        }
      }
      const applied = this.deps.applyDiffFile(worktree, evidence.candidatePath, taskId, ancestor)
      if (!applied.ok) {
        return {
          ok: false,
          result: {
            state: 'blocked',
            reason: `应用上游任务 ${ancestor} 的候选 diff 失败：${applied.detail}`,
            requirementStatus: 'blocked',
          },
        }
      }
      appliedUpstream.push(ancestor)
    }
    if (appliedUpstream.length > 0) {
      runCommand('git', ['add', '-A'], worktree)
      runCommand(
        'git',
        ['commit', '-qm', `forgeloop: upstream artifacts ${appliedUpstream.join(',')}`],
        worktree,
      )
    }
    writeFileSync(join(taskDir, 'baseline.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    if (this.deps.config.worktreePrepareCommand.length > 0) {
      const prepare = runCommand(
        this.deps.config.worktreePrepareCommand[0] ?? '',
        this.deps.config.worktreePrepareCommand.slice(1),
        worktree,
        this.deps.config.formalTestTimeoutSeconds * 1000,
      )
      writeFileSync(
        join(taskDir, 'workspace-prepare.log'),
        `${JSON.stringify(this.deps.config.worktreePrepareCommand)}\nexit_code: ${prepare.code}\n${prepare.stdout}\n${prepare.stderr}\n`,
        'utf8',
      )
      if (prepare.code !== 0) {
        return {
          ok: false,
          result: {
            state: 'blocked',
            reason: `工作副本准备命令失败（退出码 ${prepare.code}）：${this.deps.config.worktreePrepareCommand.join(' ')}`,
            requirementStatus: 'blocked',
          },
        }
      }
      // 准备命令只允许影响被忽略的依赖目录；任何对跟踪文件的改动都还原，
      // 保证候选 diff 只包含开发回合的改动。
      runCommand('git', ['reset', '--hard', 'HEAD'], worktree)
      runCommand('git', ['clean', '-fd'], worktree)
    }
    return { ok: true }
  }
}
