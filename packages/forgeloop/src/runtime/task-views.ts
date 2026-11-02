import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { evidenceDir } from '../config.js'
import type { Repository } from '../records/repository.js'
import type { PlannedTask, TaskPlan } from '../domain/task-plan.js'
import type { TaskRun } from '../domain/work.js'
import { buildTaskFailureAdvice } from '../domain/failure-advice.js'
import { parseFormalTestHeader, readActivity, readJson } from './service-helpers.js'
import { taskIdOfFailureRound } from './board.js'
import { fail, ok, type OperationResult } from './operation-result.js'
import { TASK_RUN_DELIVERED, TASK_RUN_RUNNING } from '../domain/status.js'
import {
  buildExecutionAttempts,
  buildExecutionStages,
  buildExecutionTest,
  loadExecutionPage,
  sessionRequirementView,
  type SessionRequirementView,
} from './execution-views.js'

export interface TaskViewsDeps {
  config: ForgeLoopConfig
  repo: Repository
  now: () => string
  remainingFailureRounds: (reqId: string) => number
  retryEligibility: (
    reqId: string,
    planVersion: number,
    taskId: string,
  ) =>
    | { ok: true; plan: TaskPlan; task: PlannedTask; run: TaskRun; remainingRounds: number }
    | { ok: false; code: string; message: string }
}

export class TaskViews {
  constructor(private readonly deps: TaskViewsDeps) {}

  sessionSummary(sessionId: string): {
    sessionId: string
    generatedAt: string
    requirements: SessionRequirementView[]
  } {
    const prefix = `dsh-session:${sessionId}:`
    const requirements = this.deps.repo
      .listRequirements(this.deps.config.project)
      .filter((requirement) => requirement.source.startsWith(prefix))
      .map((requirement) => sessionRequirementView(this.deps.repo, requirement))
    return { sessionId, generatedAt: this.deps.now(), requirements }
  }

  /** 单个任务的运行状态、证据与 Agent 活动过程；只读查询。 */
  taskDetail(reqId: string, taskId: string, planVersion?: number): OperationResult {
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    const plan =
      planVersion === undefined
        ? this.deps.repo.latestTaskPlan(reqId)
        : this.deps.repo.taskPlan(reqId, planVersion)
    if (!plan) return fail('plan_missing', `需求 ${reqId} 没有任务包`)
    const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
    if (!task) return fail('task_missing', `任务包内没有任务 ${taskId}`)
    const run =
      this.deps.repo
        .taskRuns(reqId, plan.planVersion)
        .find((candidate) => candidate.taskId === taskId) ?? null
    const artifact = this.deps.repo.taskArtifact(reqId, plan.planVersion, taskId)
    const evidence = this.deps.repo.evidence(reqId, plan.planVersion, taskId)
    const taskDir = evidenceDir(this.deps.config, reqId, plan.planVersion, taskId)
    const activityInfo = readActivity(join(taskDir, 'dev.jsonl'), 120)
    const activity = activityInfo.items
    const review = readJson(join(taskDir, 'review.json'))
    const testLogPath = join(taskDir, 'formal-test.log')
    const testLog = existsSync(testLogPath) ? readFileSync(testLogPath, 'utf8') : ''
    const testLogTail = testLog.slice(-4000)
    const testHeader = parseFormalTestHeader(testLog)
    const rounds = this.deps.repo.failureRounds(reqId)
    const remainingRounds = this.deps.remainingFailureRounds(reqId)
    const advice = buildTaskFailureAdvice({
      state: run?.state ?? (artifact ? TASK_RUN_DELIVERED : 'pending'),
      reason: run?.reason ?? '',
      files: task.files,
      remainingRounds,
      testLogTail,
      review,
    })
    const eligibility = this.deps.retryEligibility(reqId, plan.planVersion, taskId)
    const requests = this.deps.repo.requestsFor(reqId)
    const activeRequests = requests.filter(
      (request) => request.state === 'pending' || request.state === 'claimed',
    ).length
    const waitingForInput =
      run !== null && run.state === TASK_RUN_RUNNING && /ask_user_question/i.test(run.reason)
    const stopRequested = Boolean(this.deps.repo.activeStop(requirement.reqId))
    return ok(`任务 ${taskId} 详情`, {
      reqId,
      planVersion: plan.planVersion,
      generatedAt: this.deps.now(),
      requirement: {
        status: requirement.status,
        blockedReason: requirement.blockedReason,
        stopRequested,
      },
      task: {
        taskId: task.taskId,
        goal: task.goal,
        files: task.files,
        acceptance: task.acceptance,
        testCommand: task.testCommand,
        dependsOn: task.dependsOn,
        verification: task.verification === true,
      },
      run,
      artifact,
      evidence,
      activity,
      activityTotal: activityInfo.total,
      activityTruncated: activityInfo.truncated,
      review,
      reviewPath: join(taskDir, 'review.json'),
      testLogPath,
      testLogBytes: Buffer.byteLength(testLog, 'utf8'),
      testLogTail,
      testLogTruncated: testLog.length > testLogTail.length,
      testExitCode: testHeader.exitCode,
      testStartedAt: testHeader.startedAt,
      testDurationMs: testHeader.durationMs,
      testTimedOut: testHeader.timedOut,
      testAborted: testHeader.aborted,
      failureRounds: rounds.map((round) => ({
        roundId: round.roundId,
        stage: round.stage,
        summary: round.summary,
        occurredAt: round.occurredAt,
      })),
      remainingRounds,
      activeRequests,
      waitingForInput,
      advice,
      retry: eligibility.ok
        ? { allowed: true, reason: '' }
        : { allowed: false, reason: eligibility.message },
    })
  }

  /**
   * 任务 Agent 执行过程：读取该任务当前保存的 dev.jsonl、审查、正式测试与交付记录。
   * 只返回公开消息/工具调用；历史失败轮次没有独立执行文件时明确标记不可用。
   */
  taskExecution(input: {
    reqId: string
    taskId: string
    planVersion?: number | undefined
    offset?: number | undefined
    limit?: number | undefined
  }): OperationResult {
    const requirement = this.deps.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    const plan =
      input.planVersion === undefined
        ? this.deps.repo.latestTaskPlan(input.reqId)
        : this.deps.repo.taskPlan(input.reqId, input.planVersion)
    if (!plan) return fail('plan_missing', `需求 ${input.reqId} 没有任务包`)
    const task = plan.tasks.find((candidate) => candidate.taskId === input.taskId)
    if (!task) return fail('task_missing', `任务包内没有任务 ${input.taskId}`)
    const run =
      this.deps.repo
        .taskRuns(input.reqId, plan.planVersion)
        .find((candidate) => candidate.taskId === input.taskId) ?? null
    const artifact = this.deps.repo.taskArtifact(input.reqId, plan.planVersion, input.taskId)
    const evidence = this.deps.repo.evidence(input.reqId, plan.planVersion, input.taskId)
    const taskDir = evidenceDir(this.deps.config, input.reqId, plan.planVersion, input.taskId)
    const devPath = join(taskDir, 'dev.jsonl')
    const hasDev = existsSync(devPath)
    const page = loadExecutionPage(input, devPath, hasDev)
    const reviewPath = join(taskDir, 'review.json')
    const review = readJson(reviewPath)
    const testLogPath = join(taskDir, 'formal-test.log')
    const testLog = existsSync(testLogPath) ? readFileSync(testLogPath, 'utf8') : ''
    const testLogTail = testLog.slice(-4000)
    const testHeader = parseFormalTestHeader(testLog)
    const sessionId = evidence?.devSession || page.sessionIds[0] || ''
    const reviewSession = evidence?.reviewSession || ''
    const rounds = this.deps.repo
      .failureRounds(input.reqId)
      .filter((round) => taskIdOfFailureRound(plan, round.roundId) === task.taskId)
    const attempts = buildExecutionAttempts({
      plan,
      task,
      run,
      artifact,
      page,
      hasDev,
      sessionId,
      rounds,
    })
    return ok(`任务 ${input.taskId} 执行过程`, {
      reqId: input.reqId,
      planVersion: plan.planVersion,
      generatedAt: this.deps.now(),
      requirement: {
        version: requirement.versions.length,
        status: requirement.status,
        blockedReason: requirement.blockedReason,
      },
      task: {
        taskId: task.taskId,
        goal: task.goal,
        acceptance: task.acceptance,
        files: task.files,
        testCommand: task.testCommand,
        dependsOn: task.dependsOn,
        verification: task.verification === true,
        planVersion: plan.planVersion,
      },
      run,
      artifact,
      evidence,
      session: {
        dev: sessionId,
        review: reviewSession,
        jumpAvailable: false,
        note: '当前 Web 接缝没有可公开的 DSH 原始会话跳转地址；只展示已记录身份与证据。',
      },
      attempts,
      events: page.events,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      truncated: page.truncated,
      stepCount: page.stepCount,
      startedAt: page.startedAt,
      lastActivity: page.lastActivity,
      review,
      reviewPath,
      test: buildExecutionTest({ task, testLog, testLogPath, testHeader, testLogTail }),
      stages: buildExecutionStages({
        run,
        artifact,
        page,
        sessionId,
        review,
        reviewSession,
        evidence,
        reviewPath,
        testLog,
        testLogPath,
        testHeader,
      }),
      reason: hasDev ? '' : '没有找到该任务的执行记录',
    })
  }

  /**
   * 产品 Agent 的分析入口：对已受理需求运行一次结构化分析，落库后返回
   * 目标、场景、验收标准与待澄清项。已有同版本分析时直接复用，避免重复调用模型。
   * 只供可信入口（当前是 ForgeLoop 业务会话的输入接管）调用；不是客户决定入口。
   */
}
