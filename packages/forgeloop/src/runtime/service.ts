/**
 * ForgeLoop 业务运行时：把领域规则、权威记录与 DSH Agent 执行接在一起。
 * 命令与工具都是本类的薄包装；这里不依赖任何交互界面。
 */

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { businessReviewDir, candidatesDir, evidenceDir, planReviewDir, projectDir, recordsPath, reviewDir, sessionsDir, verificationDir, workspaceDir } from '../config.js'
import { PLUGIN_VERSION } from './version.js'
import { Database } from '../records/db.js'
import { Repository, type PlanReviewRecord, type ServiceRequestRecord, type VerificationRecord } from '../records/repository.js'
import { RuleViolationError } from '../domain/errors.js'
import {
  parseAnalysisDraft,
  statusForAnalysis,
  type Requirement,
  type RequirementAnalysis,
} from '../domain/requirement.js'
import {
  ancestorTaskIds,
  authorizationSourceOf,
  authorizePlan,
  bindAuthorization,
  executionOrder,
  parseTaskPlanDraft,
  validateTaskPlan,
  type PlannedTask,
  type TaskPlan,
} from '../domain/task-plan.js'
import { GrantLedger, FAILURE_BUSINESS_REVIEW, FAILURE_FORMAL_TEST, FAILURE_VERIFICATION, MAX_ROUNDS_PER_GRANT } from '../domain/counting.js'
import { ExecutionBudget } from '../domain/limits.js'
import { candidateIdentityOf, sha256OfBytes, sha256OfText } from '../domain/delivery.js'
import { retryDecision } from '../domain/retry-policy.js'
import {
  DIAGNOSIS_TEXT_MAX_CHARS,
  parseUnknownDiagnosis,
  renderUnknownFacts,
  replaySafe,
  type UnknownDiagnosis,
  type UnknownFacts,
  type UnknownWorkspaceFact,
} from '../domain/diagnosis.js'
import { ACCEPTED, ACTION_VERIFY, APPROVED, AWAITING_CLARIFICATION, CANCELLED, EXECUTING, PLAN_PROPOSED, isTerminal } from '../domain/status.js'
import {
  TASK_RUN_AWAITING_USER,
  TASK_RUN_BLOCKED,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
  TASK_RUN_RUNNING,
} from '../domain/status.js'
import { parseBusinessReview, validateBusinessReview, type BusinessReview } from '../domain/business-review.js'
import { languageViolations, outsideActiveSource, unknownPackages } from '../domain/language.js'
import { buildTaskFailureAdvice } from '../domain/failure-advice.js'
import {
  parsePlanReview,
  parseVerificationCommands,
  parseVerificationReport,
  validatePlanCoverage,
  validateScenarioEvidence,
  validateVerificationCoverage,
  type PlanReview,
  type VerificationCommand,
  type VerificationReport,
} from '../domain/verification.js'
import type { TaskRun } from '../domain/work.js'
import { buildImpactFacts, type ImpactRequest } from '../domain/impact.js'
import {
  explainImpactFacts,
  type ImpactExplainAgent,
  type ImpactExplainAgentResponse,
} from '../domain/impact-explain.js'
import { AgentRunner } from './agent-runner.js'
import { OpsRuntime } from './ops.js'
import {
  buildProjectFacts,
  buildStatusBoard,
  requirementTitle,
  taskIdOfFailureRound,
  type StatusBoardView,
} from './board.js'
import { runFormalTest } from './formal-test.js'
import { analysisPrompt, businessReviewPrompt, devPlanningPrompt, devPrompt, parseReviewVerdict, planReviewPrompt, reviewPrompt, requirementContext, unknownDiagnosisPrompt, verificationPrompt } from './prompts.js'
import { captureCandidate, git, headCommit, prepareSnapshotWorkspace, runCommand, requireGit } from './workspace.js'
import { parseTaskExecution } from './task-execution.js'

export interface OperationResult {
  readonly ok: boolean
  readonly code: string
  readonly message: string
  readonly data?: unknown
}

function ok(message: string, data?: unknown): OperationResult {
  return { ok: true, code: 'ok', message, data }
}

function fail(code: string, message: string): OperationResult {
  return { ok: false, code, message }
}

export interface AgentLike {
  run(request: Parameters<AgentRunner['run']>[0]): ReturnType<AgentRunner['run']>
}

export interface RuntimeOptions {
  readonly ctx: Record<string, unknown>
  readonly config: ForgeLoopConfig
  readonly now?: () => Date
  /** 测试注入：真实插件使用 AgentRunner；用例可替换为确定性假执行器。 */
  readonly runner?: AgentLike
  readonly formalTest?: typeof runFormalTest
}

function summarizeActivity(events: readonly Record<string, unknown>[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || typeof event.type !== 'string') continue
    const data = event.data as Record<string, unknown> | undefined
    if (event.type === 'tool/call') {
      const name = typeof data?.name === 'string' ? data.name : '工具'
      return `正在调用工具 ${name}`
    }
    if (event.type === 'tool/result') return '工具返回结果'
    if (event.type === 'step/start') return `执行步骤 ${String(data?.step ?? '')}`.trim()
    if (event.type === 'assistant/message') return '模型回复并继续'
    if (event.type === 'turn/start') return '回合开始'
    if (event.type === 'turn/end') return '回合结束'
  }
  return '等待 Agent 活动'
}

function readActivity(
  path: string,
  limit: number,
): { items: Array<{ type: string; at: string; summary: string }>; total: number; truncated: boolean } {
  if (!existsSync(path)) return { items: [], total: 0, truncated: false }
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const selected = lines.slice(-limit)
  const result: Array<{ type: string; at: string; summary: string }> = []
  for (const line of selected) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      const type = typeof event.type === 'string' ? event.type : 'event'
      const data = (event.data ?? {}) as Record<string, unknown>
      const at = typeof event.time === 'number' ? new Date(event.time).toISOString() : ''
      let summary = type
      if (type === 'tool/call') {
        const name = typeof data.name === 'string' ? data.name : '工具'
        const args = typeof data.arguments === 'string' ? data.arguments.replace(/\s+/g, ' ').slice(0, 240) : ''
        summary = `调用 ${name}${args ? `: ${args}` : ''}`
      } else if (type === 'tool/result') {
        summary = '工具返回结果'
      } else if (type === 'assistant/message') {
        const message = data.message as Record<string, unknown> | undefined
        const content = Array.isArray(message?.content) ? message.content : []
        const text = content
          .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => String(block.text))
          .join(' ')
          .replace(/\s+/g, ' ')
          .slice(0, 300)
        summary = text ? `模型回复: ${text}` : '模型回复'
      } else if (type === 'step/start') {
        summary = `步骤 ${String(data.step ?? '')}`.trim()
      } else if (type === 'turn/start' || type === 'turn/end') {
        summary = type === 'turn/start' ? '回合开始' : '回合结束'
      }
      result.push({ type, at, summary })
    } catch {
      // 轨迹中损坏的单行不阻断详情页。
    }
  }
  return { items: result, total: lines.length, truncated: lines.length > limit }
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

function planReviewBlocking(reportJson: string): string {
  try {
    const review = parsePlanReview(reportJson)
    return review.blocking.length > 0 ? review.blocking.join('；') : review.summary
  } catch {
    return reportJson.slice(0, 300)
  }
}

function verificationBlocking(reportJson: string): string {
  try {
    const report = parseVerificationReport(reportJson)
    return report.blocking.length > 0 ? report.blocking.join('；') : report.summary
  } catch {
    return reportJson.slice(0, 300)
  }
}

/** 验证 Agent 的合法材料目录；候选受保护内容不含此目录。 */
const VERIFICATION_MATERIAL_DIR = 'verification/'

/**
 * 列出 Git 可见的工作区变化（含未忽略的新文件）。Git 忽略的构建输出
 * （例如 `packages` 下的 `lib` 目录、`coverage` 目录）不属于候选，也不进入本列表。
 */
function workspaceChanges(workspace: string): string[] {
  // 不能用 requireGit：它会给输出 trim，从而吃掉首条记录状态位前的空格。
  const result = git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (result.code !== 0) {
    throw new RuleViolationError(`git status 失败：${result.stderr.trim() || result.stdout.trim()}`)
  }
  const entries = result.stdout.split('\0')
  const paths: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (!entry) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (status.includes('R') || status.includes('C')) index += 1
    if (path) paths.push(path)
  }
  return [...new Set(paths)].sort()
}

/** 记录验证材料清单与摘要，使报告能绑定实际存在的材料。 */
function verificationMaterials(dir: string): Array<{ path: string; sha256: string; bytes: number }> {
  const root = join(dir, 'workspace', 'verification')
  if (!existsSync(root)) return []
  const files: Array<{ path: string; sha256: string; bytes: number }> = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(relative ? join(root, relative) : root, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const bytes = readFileSync(join(root, path))
      files.push({ path: `verification/${path}`, sha256: sha256OfBytes(bytes), bytes: bytes.length })
    }
  }
  walk('')
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function parseFormalTestHeader(text: string): {
  startedAt: string
  durationMs: number | null
  timedOut: boolean | null
  aborted: boolean | null
  exitCode: number | null
} {
  const value = (key: string): string => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)
    return match?.[1]?.trim() ?? ''
  }
  const numberOrNull = (key: string): number | null => {
    const raw = value(key)
    if (!raw) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  const boolOrNull = (key: string): boolean | null => {
    const raw = value(key)
    return raw === 'true' ? true : raw === 'false' ? false : null
  }
  return {
    startedAt: value('started'),
    durationMs: numberOrNull('duration_ms'),
    timedOut: boolOrNull('timed_out'),
    aborted: boolOrNull('aborted'),
    exitCode: numberOrNull('exit_code'),
  }
}

export class ForgeLoopRuntime {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly runner: AgentLike
  readonly ops: OpsRuntime
  private readonly formalTest: typeof runFormalTest
  private readonly ctx: Record<string, unknown>
  private readonly clock: () => Date

  constructor(options: RuntimeOptions) {
    this.ctx = options.ctx
    this.config = options.config
    this.clock = options.now ?? (() => new Date())
    this.repo = new Repository(Database.open(recordsPath(this.config)))
    this.runner = options.runner ?? new AgentRunner({ ctx: options.ctx, agent: this.config.agent })
    this.ops = new OpsRuntime({
      config: this.config,
      repo: this.repo,
      runner: this.runner,
      now: () => this.clock(),
    })
    this.formalTest = options.formalTest ?? runFormalTest
  }

  close(): void {
    this.repo.close()
  }

  private now(): string {
    return this.clock().toISOString()
  }

  // ------------------------------------------------------------ 受理与修订

  submit(input: { text: string; by: string; source: string; clientKey?: string }): OperationResult {
    const text = input.text.trim()
    if (!text) return fail('empty_text', '需求原文不能为空')
    const reqId = `req-${this.now().replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`
    const { requirement, created } = this.repo.submit({
      reqId,
      project: this.config.project,
      text,
      submittedBy: input.by,
      source: input.source,
      clientKey: input.clientKey ?? '',
      now: this.now(),
    })
    return ok(
      created
        ? `已受理需求 ${requirement.reqId}（版本 1）`
        : `同一客户端幂等键已受理为需求 ${requirement.reqId}，未重复创建`,
      this.requirementView(requirement),
    )
  }

  /**
   * 读取一个业务会话关联的待澄清需求。会话关系来自需求受理 source：
   * `dsh-session:<sessionId>:<messageId>`；只返回当前需求版本已有待澄清分析的需求。
   */
  pendingClarifications(sessionId: string): Array<{
    reqId: string
    title: string
    requirementVersion: number
    analysisVersion: number
    questions: readonly string[]
    updatedAt: string
  }> {
    const prefix = `dsh-session:${sessionId}:`
    const result: Array<{
      reqId: string
      title: string
      requirementVersion: number
      analysisVersion: number
      questions: readonly string[]
      updatedAt: string
    }> = []
    for (const requirement of this.repo.listRequirements(this.config.project)) {
      if (!requirement.source.startsWith(prefix)) continue
      if (requirement.status !== AWAITING_CLARIFICATION) continue
      const analysis = this.repo.latestAnalysis(requirement.reqId)
      if (!analysis) continue
      if (analysis.requirementVersion !== requirement.versions.length) continue
      if (analysis.clarifications.length === 0) continue
      const latest = requirement.versions[requirement.versions.length - 1]
      result.push({
        reqId: requirement.reqId,
        title: requirementTitle(requirement),
        requirementVersion: requirement.versions.length,
        analysisVersion: analysis.analysisVersion,
        questions: analysis.clarifications,
        updatedAt: latest?.createdAt ?? '',
      })
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * 回答一个待澄清需求：追加需求版本（保留原文与历史），再让需求 Agent 重新分析。
   * 只有会话输入接管或未来可信入口调用；模型工具不能调用。
   */
  async answerClarifications(input: {
    reqId: string
    answer: string
    by: string
    source: string
    signal?: AbortSignal
  }): Promise<{
    ok: boolean
    code: string
    message: string
    reqId: string
    requirementVersion?: number
    analysis?: RequirementAnalysis
  }> {
    const answer = input.answer.trim()
    if (!answer) return { ok: false, code: 'empty_answer', message: '澄清回答不能为空', reqId: input.reqId }
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return { ok: false, code: 'not_found', message: `未找到需求 ${input.reqId}`, reqId: input.reqId }
    if (requirement.status !== AWAITING_CLARIFICATION) {
      return {
        ok: false,
        code: 'no_clarification',
        message: `需求 ${input.reqId} 当前不在待澄清状态`,
        reqId: input.reqId,
      }
    }
    const analysis = this.repo.latestAnalysis(input.reqId)
    if (!analysis || analysis.requirementVersion !== requirement.versions.length || analysis.clarifications.length === 0) {
      return {
        ok: false,
        code: 'no_clarification',
        message: `需求 ${input.reqId} 没有与当前版本对应的待澄清项`,
        reqId: input.reqId,
      }
    }
    const latest = requirement.versions[requirement.versions.length - 1]
    if (!latest) return { ok: false, code: 'not_found', message: `需求 ${input.reqId} 没有可修订版本`, reqId: input.reqId }
    const text = `${latest.text}

澄清回答（针对分析 v${analysis.analysisVersion}）：
${answer}`
    const revised = this.revise({ reqId: input.reqId, text, by: input.by, source: input.source })
    if (!revised.ok) return { ...revised, reqId: input.reqId }
    const refreshed = this.repo.getRequirement(input.reqId)
    const next = await this.analyzeRequirement(input.reqId, input.signal)
    if (!next.ok) {
      return {
        ok: false,
        code: next.code,
        message: next.message,
        reqId: input.reqId,
        requirementVersion: refreshed?.versions.length,
      }
    }
    return {
      ok: true,
      code: 'ok',
      message: next.message,
      reqId: input.reqId,
      requirementVersion: refreshed?.versions.length,
      analysis: next.analysis,
    }
  }

  /**
   * 研发 Agent 的技术方案与任务拆解入口：需求 Agent 只产出分析结论，任务由研发 Agent
   * 依据分析全文（目标、场景、验收标准）拆解；校验任务包并落库。规划不等于批准或执行。
   */
  async planDevTasks(
    reqId: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean
    code: string
    message: string
    plan?: TaskPlan
    analysis?: RequirementAnalysis
  }> {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { ok: false, code: 'not_found', message: `未找到需求 ${reqId}` }
    const analysis = this.repo.latestAnalysis(reqId) ?? undefined
    const outcome = await this.executeDevPlanning(reqId, signal ?? new AbortController().signal)
    const plan = this.repo.latestTaskPlan(reqId)
    if (outcome.state !== 'done' || !plan) {
      return { ok: false, code: 'plan_failed', message: outcome.detail || '任务包未生成', analysis }
    }
    return {
      ok: true,
      code: 'ok',
      message: outcome.detail,
      plan,
      analysis,
    }
  }

  /** 一个业务会话已经受理并拆解的需求，用于会话末尾摘要。 */
  sessionSummary(sessionId: string): {
    sessionId: string
    generatedAt: string
    requirements: Array<{
      reqId: string
      title: string
      status: string
      version: number
      updatedAt: string
      goal: string
      scenarios: readonly string[]
      acceptanceCriteria: readonly string[]
      clarifications: readonly string[]
      planVersion: number | null
      approved: boolean
      delivered: number
      taskCount: number
    }>
  } {
    const prefix = `dsh-session:${sessionId}:`
    const requirements = this.repo
      .listRequirements(this.config.project)
      .filter((requirement) => requirement.source.startsWith(prefix))
      .map((requirement) => {
        const latest = requirement.versions[requirement.versions.length - 1]
        const analysis = this.repo.latestAnalysis(requirement.reqId)
        const plan = this.repo.latestTaskPlan(requirement.reqId)
        const approval = plan ? this.repo.planApproval(requirement.reqId, plan.planVersion) : null
        const artifacts = plan ? this.repo.taskArtifacts(requirement.reqId, plan.planVersion) : []
        return {
          reqId: requirement.reqId,
          title: requirementTitle(requirement),
          status: requirement.status,
          version: requirement.versions.length,
          updatedAt: latest?.createdAt ?? '',
          goal: analysis?.goal ?? '',
          scenarios: analysis?.scenarios ?? [],
          acceptanceCriteria: analysis?.acceptanceCriteria ?? [],
          clarifications: analysis?.clarifications ?? [],
          planVersion: plan?.planVersion ?? null,
          approved: approval !== null,
          delivered: artifacts.length,
          taskCount: plan?.tasks.length ?? 0,
        }
      })
    return { sessionId, generatedAt: this.now(), requirements }
  }

  /** 单个任务的运行状态、证据与 Agent 活动过程；只读查询。 */
  taskDetail(reqId: string, taskId: string, planVersion?: number): OperationResult {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    const plan = planVersion === undefined
      ? this.repo.latestTaskPlan(reqId)
      : this.repo.taskPlan(reqId, planVersion)
    if (!plan) return fail('plan_missing', `需求 ${reqId} 没有任务包`)
    const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
    if (!task) return fail('task_missing', `任务包内没有任务 ${taskId}`)
    const run = this.repo.taskRuns(reqId, plan.planVersion).find((candidate) => candidate.taskId === taskId) ?? null
    const artifact = this.repo.taskArtifact(reqId, plan.planVersion, taskId)
    const evidence = this.repo.evidence(reqId, plan.planVersion, taskId)
    const taskDir = evidenceDir(this.config, reqId, plan.planVersion, taskId)
    const activityInfo = readActivity(join(taskDir, 'dev.jsonl'), 120)
    const activity = activityInfo.items
    const review = readJson(join(taskDir, 'review.json'))
    const testLogPath = join(taskDir, 'formal-test.log')
    const testLog = existsSync(testLogPath) ? readFileSync(testLogPath, 'utf8') : ''
    const testLogTail = testLog.slice(-4000)
    const testHeader = parseFormalTestHeader(testLog)
    const rounds = this.repo.failureRounds(reqId)
    const remainingRounds = this.remainingFailureRounds(reqId)
    const advice = buildTaskFailureAdvice({
      state: run?.state ?? (artifact ? TASK_RUN_DELIVERED : 'pending'),
      reason: run?.reason ?? '',
      files: task.files,
      remainingRounds,
      testLogTail,
      review,
    })
    const eligibility = this.retryEligibility(reqId, plan.planVersion, taskId)
    const requests = this.repo.requestsFor(reqId)
    const unknownRequests = requests.filter((request) => request.state === 'unknown').length
    const activeRequests = requests.filter(
      (request) => request.state === 'pending' || request.state === 'claimed',
    ).length
    const waitingForInput =
      run?.state === TASK_RUN_RUNNING && /ask_user_question/i.test(run.reason)
    const stopRequested = requirement.blockedReason.startsWith('停止请求')
    return ok(`任务 ${taskId} 详情`, {
      reqId,
      planVersion: plan.planVersion,
      generatedAt: this.now(),
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
      unknownRequests,
      activeRequests,
      waitingForInput,
      resultUnknown: unknownRequests > 0,
      advice,
      retry: eligibility.ok
        ? { allowed: true, reason: '', requiresRecovery: unknownRequests > 0 }
        : { allowed: false, reason: eligibility.message, requiresRecovery: false },
    })
  }

  /**
   * 任务 Agent 执行过程：读取该任务当前保存的 dev.jsonl、审查、正式测试与交付记录。
   * 只返回公开消息/工具调用；历史失败轮次没有独立执行文件时明确标记不可用。
   */
  taskExecution(input: {
    reqId: string
    taskId: string
    planVersion?: number
    offset?: number
    limit?: number
  }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    const plan = input.planVersion === undefined
      ? this.repo.latestTaskPlan(input.reqId)
      : this.repo.taskPlan(input.reqId, input.planVersion)
    if (!plan) return fail('plan_missing', `需求 ${input.reqId} 没有任务包`)
    const task = plan.tasks.find((candidate) => candidate.taskId === input.taskId)
    if (!task) return fail('task_missing', `任务包内没有任务 ${input.taskId}`)
    const run = this.repo.taskRuns(input.reqId, plan.planVersion).find((candidate) => candidate.taskId === input.taskId) ?? null
    const artifact = this.repo.taskArtifact(input.reqId, plan.planVersion, input.taskId)
    const evidence = this.repo.evidence(input.reqId, plan.planVersion, input.taskId)
    const taskDir = evidenceDir(this.config, input.reqId, plan.planVersion, input.taskId)
    const devPath = join(taskDir, 'dev.jsonl')
    const hasDev = existsSync(devPath)
    const page = hasDev
      ? parseTaskExecution(readFileSync(devPath, 'utf8'), { offset: input.offset, limit: input.limit })
      : { events: [], total: 0, offset: input.offset ?? 0, limit: input.limit ?? 100, truncated: false, stepCount: 0, startedAt: '', lastActivity: '', sessionIds: [] }
    const reviewPath = join(taskDir, 'review.json')
    const review = readJson(reviewPath)
    const testLogPath = join(taskDir, 'formal-test.log')
    const testLog = existsSync(testLogPath) ? readFileSync(testLogPath, 'utf8') : ''
    const testLogTail = testLog.slice(-4000)
    const testHeader = parseFormalTestHeader(testLog)
    const sessionId = evidence?.devSession || page.sessionIds[0] || ''
    const reviewSession = evidence?.reviewSession || ''
    const rounds = this.repo.failureRounds(input.reqId).filter((round) => taskIdOfFailureRound(plan, round.roundId) === task.taskId)
    const attempts = [
      {
        attemptId: sessionId ? `session:${sessionId}` : 'recent-recording',
        label: '最近一次执行记录',
        state: run?.state ?? (artifact ? TASK_RUN_DELIVERED : 'pending'),
        sessionId,
        startedAt: page.startedAt,
        lastActivity: page.lastActivity || run?.updatedAt || '',
        eventTotal: page.total,
        available: hasDev && page.total > 0,
        reason: hasDev
          ? page.total > 0
            ? ''
            : '执行记录文件存在，但没有可公开事件'
          : '没有找到该任务的执行记录文件 dev.jsonl',
      },
      ...rounds.map((round) => ({
        attemptId: `round:${round.roundId}`,
        label: `失败轮次 ${round.roundId}`,
        state: 'failed',
        sessionId: '',
        startedAt: '',
        lastActivity: round.occurredAt,
        eventTotal: 0,
        available: false,
        reason: '历史失败轮次只保留摘要；该次独立执行记录未单独保留，不能伪造会话事件',
        stage: round.stage,
        summary: round.summary,
      })),
    ]
    return ok(`任务 ${input.taskId} 执行过程`, {
      reqId: input.reqId,
      planVersion: plan.planVersion,
      generatedAt: this.now(),
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
      test: {
        command: task.testCommand,
        path: testLogPath,
        available: testLog.length > 0,
        bytes: Buffer.byteLength(testLog, 'utf8'),
        startedAt: testHeader.startedAt,
        durationMs: testHeader.durationMs,
        timedOut: testHeader.timedOut,
        aborted: testHeader.aborted,
        exitCode: testHeader.exitCode,
        tail: testLogTail,
        truncated: testLog.length > testLogTail.length,
      },
      stages: [
        {
          id: 'dev',
          label: '开发执行',
          state: run?.state ?? (artifact ? TASK_RUN_DELIVERED : 'pending'),
          sessionId,
          startedAt: page.startedAt,
          lastActivity: page.lastActivity || run?.updatedAt || '',
          total: page.total,
          stepCount: page.stepCount,
        },
        {
          id: 'review',
          label: '独立审查',
          available: review !== null,
          sessionId: reviewSession,
          recordedAt: evidence?.recordedAt ?? '',
          verdict: review && typeof (review as Record<string, unknown>).verdict === 'string' ? (review as Record<string, unknown>).verdict : '',
          path: reviewPath,
        },
        {
          id: 'formal_test',
          label: '正式测试',
          available: testLog.length > 0,
          startedAt: testHeader.startedAt,
          durationMs: testHeader.durationMs,
          exitCode: testHeader.exitCode,
          path: testLogPath,
          bytes: Buffer.byteLength(testLog, 'utf8'),
        },
        {
          id: 'delivery',
          label: '交付',
          delivered: artifact !== null,
          recordedAt: artifact?.recordedAt ?? '',
          candidateSha256: artifact?.candidateSha256 ?? '',
        },
      ],
      reason: hasDev ? '' : '没有找到该任务的执行记录',
    })
  }

  /**
   * 需求 Agent 的分析入口：对已受理需求运行一次结构化分析，落库后返回
   * 目标、场景、验收标准与待澄清项。已有同版本分析时直接复用，避免重复调用模型。
   * 只供可信入口（当前是 ForgeLoop 业务会话的输入接管）调用；不是客户决定入口。
   */
  async analyzeRequirement(
    reqId: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean
    code: string
    message: string
    requirement?: unknown
    analysis?: RequirementAnalysis
  }> {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${reqId} 已处于终态 ${requirement.status}，不能再分析`)
    }
    const existing = this.repo.latestAnalysis(reqId)
    if (existing && existing.requirementVersion === requirement.versions.length) {
      return {
        ok: true,
        code: 'ok',
        message: `需求 ${reqId} 已有 v${existing.analysisVersion} 分析，未重复调用模型`,
        requirement: this.requirementView(requirement),
        analysis: existing,
      }
    }
    const outcome = await this.executeAnalysis(reqId, signal ?? new AbortController().signal)
    const refreshed = this.repo.getRequirement(reqId)
    const analysis = this.repo.latestAnalysis(reqId)
    if (outcome.state !== 'done' || !analysis) {
      return {
        ...fail('analysis_failed', outcome.detail || '需求分析未完成'),
        requirement: refreshed ? this.requirementView(refreshed) : null,
      }
    }
    return {
      ok: true,
      code: 'ok',
      message: outcome.detail,
      requirement: refreshed ? this.requirementView(refreshed) : null,
      analysis,
    }
  }

  revise(input: { reqId: string; text: string; by: string; source: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${input.reqId} 已处于终态 ${requirement.status}，不能修订`)
    }
    const updated = this.repo.appendVersion({
      reqId: input.reqId,
      text: input.text,
      revisedBy: input.by,
      source: input.source,
      now: this.now(),
    })
    this.repo.dismissPendingFor(input.reqId, '需求修订：旧请求所依据的版本已过期', this.now())
    return ok(
      `已追加需求 ${input.reqId} 版本 ${updated.versions.length}；既有任务包与批准对该版本过期，需重新分析与规划`,
      this.requirementView(updated),
    )
  }

  cancel(input: { reqId: string; by: string; reason: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${input.reqId} 已处于终态 ${requirement.status}`)
    }
    this.repo.dismissPendingFor(input.reqId, '需求已取消', this.now())
    this.repo.recordCancellation({
      reqId: input.reqId,
      cancelledBy: input.by,
      reason: input.reason,
      now: this.now(),
    })
    return ok(`已取消需求 ${input.reqId}；身份、版本、批准与交付记录保留`)
  }

  stop(input: { reqId: string; by: string; reason: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${input.reqId} 已处于终态 ${requirement.status}`)
    }
    this.repo.dismissPendingFor(input.reqId, `停止请求（${input.by}）`, this.now())
    this.repo.setStatus(input.reqId, 'blocked', `停止请求：${input.reason || '未说明'}（${input.by}）`)
    return ok(`已请求停止需求 ${input.reqId}；待执行请求已撤销，在途 Agent 会被取消`)
  }

  /** 排队一个持久操作请求：先落库，再返回受理身份。 */
  requestOperation(input: {
    reqId: string
    action: 'analyze' | 'plan' | 'advance' | 'verify'
    by: string
    source: string
    /** 已批准任务包默认冻结；只有所有者显式许可并说明原因才能重新生成。 */
    confirmPlanChange?: boolean
    reason?: string
  }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${input.reqId} 已处于终态 ${requirement.status}，不能再排队`)
    }
    if (input.action === 'plan') {
      const latestPlan = this.repo.latestTaskPlan(input.reqId)
      const frozen = latestPlan ? this.repo.planApproval(input.reqId, latestPlan.planVersion) : null
      if (frozen) {
        if (input.confirmPlanChange !== true) {
          return fail(
            'plan_frozen',
            `需求 ${input.reqId} 的任务包 v${latestPlan!.planVersion} 已批准并冻结；修改任务包需要所有者显式许可并说明原因`,
          )
        }
        if (!input.reason?.trim()) {
          return fail('reason_required', '修改已批准任务包必须说明原因，便于审计')
        }
      }
    }
    let planVersion = 0
    if (input.action === 'advance' || input.action === ACTION_VERIFY) {
      const authorization = this.requireAuthorizedPlan(input.reqId)
      if (!authorization.ok) return authorization.result
      const plan = authorization.value.plan
      planVersion = plan.planVersion
      // 额度用尽后不再接受新的推进或验证；人工重试同样受此约束。
      if (this.remainingFailureRounds(input.reqId) === 0) {
        return fail(
          'grant_required',
          `需求 ${input.reqId} 的失败轮次额度已用尽；需要追加授权或重新规划后才能继续${input.action === ACTION_VERIFY ? '验证' : '推进'}`,
        )
      }
      if (input.action === ACTION_VERIFY) {
        const artifacts = this.repo.taskArtifacts(input.reqId, plan.planVersion)
        const missing = plan.tasks.filter(
          (task) => !artifacts.some((artifact) => artifact.taskId === task.taskId),
        )
        if (missing.length > 0) {
          return fail(
            'not_delivered',
            `仍有任务未交付，不能开始独立验证：${missing.map((task) => task.taskId).join('、')}`,
          )
        }
        const review = this.repo.planReview(input.reqId, plan.planVersion)
        if (!review) {
          return fail(
            'plan_review_required',
            `任务包 v${plan.planVersion} 尚未通过验证 Agent 的实现前评审；不能开始独立验证`,
          )
        }
        if (review.verdict !== 'pass') {
          return fail(
            'plan_review_blocked',
            `任务包 v${plan.planVersion} 的实现前评审未通过：${review.reportJson.slice(0, 200)}`,
          )
        }
      }
    } else if (input.action === 'plan' && this.repo.latestAnalysis(input.reqId) === null) {
      return fail('analysis_missing', `需求 ${input.reqId} 尚无分析结论`)
    }
    try {
      const source =
        input.action === 'plan' && input.confirmPlanChange === true
          ? `${input.source}:plan-change:${input.reason?.trim()}`
          : input.source
      const { request, created } = this.repo.recordRequest({
        requestId: `rq-${randomUUID()}`,
        reqId: input.reqId,
        project: this.config.project,
        planVersion,
        action: input.action,
        requestedBy: input.by,
        source,
        now: this.now(),
      })
      return ok(
        created
          ? `已受理${input.action}请求 ${request.requestId}（需求 ${input.reqId}）；宿主会持久推进`
          : `需求 ${input.reqId} 已有待执行的 ${request.action} 请求 ${request.requestId}，未重复排队`,
        requestView(request),
      )
    } catch (error) {
      return fail((error as RuleViolationError).code ?? 'rule_violation', (error as Error).message)
    }
  }

  // ------------------------------------------------------------ 决定

  /**
   * 任务重试：只重新排队一次 advance，不新建任务包、不清零失败轮次。
   * 结果未知的请求必须在明确确认后再核对关闭，避免把中断当成可直接重放。
   */
  retryTask(input: {
    reqId: string
    planVersion: number
    taskId: string
    by: string
    source: string
    confirmRecovery?: boolean
  }): OperationResult {
    const eligibility = this.retryEligibility(input.reqId, input.planVersion, input.taskId)
    if (!eligibility.ok) return fail(eligibility.code, eligibility.message)

    const unknown = this.repo.requestsFor(input.reqId).filter((request) => request.state === 'unknown')
    if (unknown.length > 0 && input.confirmRecovery !== true) {
      return fail(
        'recovery_required',
        `需求 ${input.reqId} 有 ${unknown.length} 条结果未知的请求；请先核对工作副本、Git 与证据，再确认重试（不会自动重放 unknown 请求）`,
      )
    }
    let recovered = 0
    if (unknown.length > 0) {
      const recovery = this.recover({ reqId: input.reqId, by: input.by, confirm: true })
      if (!recovery.ok) return recovery
      recovered = unknown.length
    }
    const queued = this.requestOperation({
      reqId: input.reqId,
      action: 'advance',
      by: input.by,
      source: `${input.source}:retry:${input.taskId}${recovered > 0 ? `:recovered-${recovered}` : ''}`,
    })
    if (!queued.ok) return queued
    return ok(`已受理任务 ${input.taskId} 的重试：${queued.message}`, {
      ...(queued.data as Record<string, unknown>),
      taskId: input.taskId,
      recovered,
    })
  }

  /**
   * 需求级重新执行：失败停在 blocked 后，不再要求人工逐个任务重试。
   * 与 retryTask 共用同一份判定（额度、在途、unknown、批准、终态），
   * 只排队一次 advance；不新建任务包、不清零失败轮次。
   */
  requeue(input: { reqId: string; by: string; source: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    const decision = this.retryDecisionFor(input.reqId)
    if (!decision.allowed) return fail('retry_not_allowed', decision.reason)
    const queued = this.requestOperation({
      reqId: input.reqId,
      action: 'advance',
      by: input.by,
      source: `${input.source}:requeue`,
    })
    if (!queued.ok) return queued
    return ok(`已重新排队执行需求 ${input.reqId}：${queued.message}`, queued.data)
  }

  /** 需求级“是否还能再来一次”的只读判定；看板与 requeue 共用。 */
  retryDecisionFor(reqId: string): { allowed: boolean; reason: string } {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { allowed: false, reason: `未找到需求 ${reqId}` }
    const plan = this.repo.latestTaskPlan(reqId)
    const requests = this.repo.requestsFor(reqId)
    const runs = plan ? this.repo.taskRuns(reqId, plan.planVersion) : []
    const delivered = plan ? this.repo.taskArtifacts(reqId, plan.planVersion).length : 0
    return retryDecision({
      status: requirement.status,
      blockedReason: requirement.blockedReason,
      remainingRounds: this.remainingFailureRounds(reqId),
      unknownRequests: requests.filter((request) => request.state === 'unknown').length,
      activeRequest: requests.some((request) => request.state === 'pending' || request.state === 'claimed'),
      runningTasks: runs.filter((run) => run.state === TASK_RUN_RUNNING).length,
      awaitingInputTasks: runs.filter((run) => run.state === TASK_RUN_AWAITING_USER).length,
      planApproved:
        plan !== null && authorizePlan(plan, this.repo.planApproval(reqId, plan.planVersion)).status === 'approved',
      delivered,
      total: plan?.tasks.length ?? 0,
    })
  }

  /**
   * 把已交付任务退回执行角色修复：归档旧产物与材料、清交付标记、记录修复原因。
   * 任务包版本不变；新一次执行会产生新的候选身份。
   */
  private reopenDeliveredTasks(input: {
    reqId: string
    plan: TaskPlan
    identity: string
    reason: string
  }): Array<{ taskId: string; attempt: number; archivedPath: string }> {
    const archived: Array<{ taskId: string; attempt: number; archivedPath: string }> = []
    for (const task of input.plan.tasks) {
      if (task.verification === true) continue
      const artifact = this.repo.taskArtifact(input.reqId, input.plan.planVersion, task.taskId)
      if (!artifact) continue
      const evidence = this.repo.evidence(input.reqId, input.plan.planVersion, task.taskId)
      const taskDir = evidence
        ? dirname(evidence.candidatePath)
        : evidenceDir(this.config, input.reqId, input.plan.planVersion, task.taskId)
      const attempt = this.repo.archivedArtifacts(input.reqId, input.plan.planVersion, task.taskId).length + 1
      const archiveRoot = join(dirname(taskDir), `${task.taskId}.history`)
      const archivedPath = join(archiveRoot, `attempt-${attempt}-${artifact.candidateSha256.slice(0, 12) || 'empty'}`)
      if (existsSync(taskDir)) {
        mkdirSync(archiveRoot, { recursive: true })
        cpSync(taskDir, archivedPath, { recursive: true })
      }
      this.repo.recordArchivedArtifact({
        artifact,
        attempt,
        archivedAt: this.now(),
        archivedPath,
        reason: input.reason,
      })
      this.repo.clearTaskDelivery(input.reqId, input.plan.planVersion, task.taskId)
      this.recordRun(
        input.reqId,
        input.plan,
        task,
        TASK_RUN_BLOCKED,
        `${input.reason}（旧候选 ${artifact.candidateSha256.slice(0, 12)}… 与材料已归档）`,
        0,
      )
      archived.push({ taskId: task.taskId, attempt, archivedPath })
    }
    return archived
  }

  /** 判断一个失败任务能否人工重试；只读，供任务详情与 retryTask 共用。 */
  private retryEligibility(
    reqId: string,
    planVersion: number,
    taskId: string,
  ):
    | { ok: true; plan: TaskPlan; task: PlannedTask; run: TaskRun; remainingRounds: number }
    | { ok: false; code: string; message: string } {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { ok: false, code: 'not_found', message: `未找到需求 ${reqId}` }
    if (isTerminal(requirement.status)) {
      return { ok: false, code: 'terminal', message: `需求 ${reqId} 已处于终态 ${requirement.status}` }
    }
    const plan = this.repo.latestTaskPlan(reqId)
    if (!plan) return { ok: false, code: 'plan_missing', message: `需求 ${reqId} 尚无任务包` }
    if (plan.planVersion !== planVersion) {
      return {
        ok: false,
        code: 'stale_plan',
        message: `任务包 v${planVersion} 不是最新版本（最新 v${plan.planVersion}）；刷新后再重试`,
      }
    }
    if (plan.requirementVersion !== requirement.versions.length) {
      return {
        ok: false,
        code: 'stale_requirement',
        message: `任务包 v${plan.planVersion} 依据需求 v${plan.requirementVersion}，当前是 v${requirement.versions.length}；需重新规划与批准`,
      }
    }
    const authorization = authorizePlan(plan, this.repo.planApproval(reqId, plan.planVersion))
    if (authorization.status !== 'approved') {
      return { ok: false, code: 'plan_not_approved', message: `${authorization.reason}；任务包尚未获得批准` }
    }
    const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
    if (!task) return { ok: false, code: 'task_missing', message: `任务包内没有任务 ${taskId}` }
    if (this.repo.taskArtifact(reqId, plan.planVersion, taskId)) {
      return { ok: false, code: 'already_delivered', message: `任务 ${taskId} 已有交付产物，不能重试` }
    }
    const run = this.repo.taskRuns(reqId, plan.planVersion).find((candidate) => candidate.taskId === taskId)
    if (!run) {
      return { ok: false, code: 'not_failed', message: `任务 ${taskId} 尚未运行，不能重试` }
    }
    if (![TASK_RUN_FAILED, TASK_RUN_BLOCKED, TASK_RUN_AWAITING_USER].includes(run.state)) {
      return { ok: false, code: 'not_failed', message: `任务 ${taskId} 当前状态是 ${run.state}，不是失败状态` }
    }
    const active = this.repo
      .requestsFor(reqId)
      .find((request) => request.state === 'pending' || request.state === 'claimed')
    if (active) {
      return {
        ok: false,
        code: 'busy',
        message: `需求 ${reqId} 已有待执行或执行中的 ${active.action} 请求 ${active.requestId}；等待结束后再重试`,
      }
    }
    const remainingRounds = this.remainingFailureRounds(reqId)
    if (remainingRounds === 0) {
      return {
        ok: false,
        code: 'grant_required',
        message: `需求 ${reqId} 的失败轮次额度已用尽；需要追加授权或重新规划后再重试`,
      }
    }
    const next = executionOrder(plan).find(
      (candidate) => !this.repo.taskArtifact(reqId, plan.planVersion, candidate),
    )
    if (next !== taskId) {
      return {
        ok: false,
        code: 'predecessor_pending',
        message: `任务 ${next ?? '（无）'} 尚未交付，不能重试后续任务 ${taskId}`,
      }
    }
    return { ok: true, plan, task, run, remainingRounds }
  }

  private remainingFailureRounds(reqId: string): number {
    const used = this.repo.failureRounds(reqId).length
    return Math.max(0, this.repo.grantCount(reqId) * MAX_ROUNDS_PER_GRANT - used)
  }

  approvePlan(input: { reqId: string; planVersion: number; by: string; source: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) return fail('terminal', `需求已处于终态 ${requirement.status}`)
    const plan = this.repo.taskPlan(input.reqId, input.planVersion)
    if (!plan) return fail('plan_missing', `需求 ${input.reqId} 没有任务包 v${input.planVersion}`)
    // 存储的旧任务包可能早于当前硬性规则；批准前按现行规则再校验一次，
    // 不能因为“当时能落库”就放行一个现在明确不合规的任务包。
    try {
      validateTaskPlan(plan)
    } catch (error) {
      return fail('plan_invalid', `任务包 v${plan.planVersion} 不满足当前硬性规则：${(error as Error).message}`)
    }
    const boundary = [
      ...languageViolations(plan),
      ...outsideActiveSource(plan),
      ...unknownPackages(plan, this.existingPackages()),
    ]
    if (boundary.length > 0) {
      return fail(
        'plan_out_of_boundary',
        `任务包越过 TypeScript 语言/工程边界，不能批准：${boundary
          .map((violation) => `${violation.taskId}.${violation.field}=${violation.value}`)
          .join('；')}`,
      )
    }
    const latestVersion = requirement.versions.length
    if (plan.requirementVersion !== latestVersion) {
      return fail(
        'stale_requirement',
        `任务包 v${plan.planVersion} 依据需求 v${plan.requirementVersion}，当前需求是 v${latestVersion}；请重新规划后再批准`,
      )
    }
    const review = this.repo.planReview(input.reqId, plan.planVersion)
    if (!review) {
      return fail(
        'plan_review_required',
        `任务包 v${plan.planVersion} 尚未通过验证 Agent 的实现前评审；不能批准进入实现`,
      )
    }
    const planSha = sha256OfText(JSON.stringify(plan))
    if (review.planSha256 !== planSha || review.requirementVersion !== latestVersion) {
      return fail(
        'plan_review_stale',
        `任务包 v${plan.planVersion} 的实现前评审已过期（任务包或需求版本发生变化）；请重新生成任务包并评审`,
      )
    }
    if (
      !existsSync(review.reportPath) ||
      sha256OfText(readFileSync(review.reportPath, 'utf8')) !== review.reportSha256
    ) {
      return fail('plan_review_invalid', '实现前评审证据文件缺失或摘要不一致；不能批准')
    }
    if (review.verdict !== 'pass') {
      return fail(
        'plan_review_blocked',
        `实现前评审阻断：${planReviewBlocking(review.reportJson)}`,
      )
    }
    const approval = {
      requirementId: input.reqId,
      planVersion: input.planVersion,
      approvedBy: input.by,
      approvedAt: this.now(),
      source: input.source,
    }
    // 授权来源由批准行派生；任务包正文不改写，回查时按批准版本判定。
    bindAuthorization(plan, approval)
    this.repo.recordPlanApproval(approval)
    this.repo.setStatus(input.reqId, APPROVED)
    return ok(
      `已记录需求 ${input.reqId} 的任务包 v${input.planVersion} 批准（依据需求 v${plan.requirementVersion}）`,
      { authorizationSource: authorizationSourceOf(approval), tasks: plan.tasks.map((task) => task.taskId) },
    )
  }

  grant(input: { reqId: string; by: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    const count = this.repo.appendGrant(input.reqId, input.by, this.now())
    return ok(`已为需求 ${input.reqId} 追加第 ${count} 次失败轮次授权（累计不清零）`, { grants: count })
  }

  /**
   * 诊断“结果未知”的请求：由 Agent 说清根因与处置，程序校验字段与字节上限，
   * 再用程序采集的工作副本事实判定重放是否安全；安全则关闭未知请求并解除阻塞。
   *
   * 判定权仍在程序：Agent 只提供解释与方案，不能凭自述跳过核对。
   */
  async diagnoseUnknown(input: {
    reqId: string
    by: string
    source: string
    signal?: AbortSignal
  }): Promise<OperationResult> {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    const requests = this.repo.requestsFor(input.reqId).filter((request) => request.state === 'unknown')
    if (requests.length === 0) return fail('nothing_to_recover', `需求 ${input.reqId} 没有待核对的请求`)

    const facts = this.collectUnknownFacts(requirement)
    const safety = replaySafe(facts)
    const factsJson = JSON.stringify(facts)
    const dir = join(projectDir(this.config), 'diagnoses', input.reqId)
    mkdirSync(dir, { recursive: true })
    const diagnosisId = `diag-${randomUUID()}`
    const reportPath = join(dir, `${diagnosisId}.json`)
    const transcriptPath = join(dir, `${diagnosisId}.jsonl`)

    const run = await this.runner.run({
      role: 'diagnosis',
      cwd: this.config.projectPath,
      prompt: unknownDiagnosisPrompt({
        requirement,
        facts: renderUnknownFacts(facts),
        charLimit: DIAGNOSIS_TEXT_MAX_CHARS,
      }),
      permission: 'workspace-write',
      timeoutMs: this.config.agent.timeoutSeconds * 1000,
      transcriptPath,
      signal: input.signal ?? new AbortController().signal,
      tools: 'none',
    })
    if (run.status !== 'completed') {
      return fail('diagnosis_failed', `诊断回合未完成（${run.status}）：${run.reason || '无原因'}；未知请求保持原状`)
    }

    let diagnosis: UnknownDiagnosis
    try {
      diagnosis = parseUnknownDiagnosis(run.text)
    } catch (error) {
      writeFileSync(
        `${reportPath}.rejected`,
        `${JSON.stringify({ raw: run.text, error: (error as Error).message }, null, 2)}\n`,
        'utf8',
      )
      return fail(
        'diagnosis_invalid',
        `诊断材料不合格，未知请求保持原状：${(error as Error).message}`,
      )
    }

    const reportJson = `${JSON.stringify(
      {
        kind: 'unknown-diagnosis',
        reqId: input.reqId,
        diagnosisId,
        rootCause: diagnosis.rootCause,
        solution: diagnosis.solution,
        charLimit: DIAGNOSIS_TEXT_MAX_CHARS,
        replaySafe: safety.safe,
        safeReason: safety.reason,
        facts,
        closedRequests: safety.safe ? requests.length : 0,
        sessionId: run.sessionId,
        at: this.now(),
      },
      null,
      2,
    )}\n`
    writeFileSync(reportPath, reportJson, 'utf8')
    this.repo.recordUnknownDiagnosis({
      reqId: input.reqId,
      diagnosisId,
      rootCause: diagnosis.rootCause,
      solution: diagnosis.solution,
      replaySafe: safety.safe,
      safeReason: safety.reason,
      factsJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      sessionId: run.sessionId,
      closedRequests: safety.safe ? requests.length : 0,
      diagnosedAt: this.now(),
    })

    if (!safety.safe) {
      return fail(
        'replay_unsafe',
        `诊断已记录，但重放不安全：${safety.reason}；未知请求保持原状，需要人工处置`,
      )
    }
    for (const request of requests) {
      this.repo.resolveRequest(
        request.requestId,
        'dismissed',
        `诊断 ${diagnosisId} 判定重放安全并关闭（${this.now()}）`,
        this.now(),
      )
    }
    return ok(
      `已诊断并关闭 ${requests.length} 条未知请求：${diagnosis.rootCause}；处置：${diagnosis.solution}`,
      {
        diagnosisId,
        rootCause: diagnosis.rootCause,
        solution: diagnosis.solution,
        replaySafe: true,
        safeReason: safety.reason,
        closedRequests: requests.length,
        reportPath,
        sessionId: run.sessionId,
      },
    )
  }

  /** 采集未知请求的现场事实：只读，不修改任何工作副本。 */
  private collectUnknownFacts(requirement: Requirement): UnknownFacts {
    const plan = this.repo.latestTaskPlan(requirement.reqId)
    const requests = this.repo.requestsFor(requirement.reqId)
      .filter((request) => request.state === 'unknown')
      .map((request) => ({
        requestId: request.requestId,
        action: request.action,
        planVersion: request.planVersion,
        createdAt: request.createdAt,
      }))
    const workspaces: UnknownWorkspaceFact[] = []
    const taskRuns: Array<{ taskId: string; state: string; reason: string }> = []
    if (plan) {
      for (const run of this.repo.taskRuns(requirement.reqId, plan.planVersion)) {
        taskRuns.push({ taskId: run.taskId, state: run.state, reason: run.reason })
      }
      for (const task of plan.tasks) {
        const run = this.repo.taskRuns(requirement.reqId, plan.planVersion).find((item) => item.taskId === task.taskId)
        // 只检查确实开始过的任务：没跑过的任务没有工作副本，也没有重放风险。
        if (!run) continue
        const workspacePath = workspaceDir(this.config, requirement.reqId, plan.planVersion, task.taskId)
        if (!existsSync(workspacePath)) {
          workspaces.push({
            taskId: task.taskId,
            workspacePath,
            exists: false,
            headIsBaseline: true,
            changedFiles: [],
            untrackedFiles: [],
          })
          continue
        }
        const changed: string[] = []
        const untracked: string[] = []
        try {
          for (const path of workspaceChanges(workspacePath)) {
            // 未知路径一律按“已修改”处理：宁可保守，也不把改动当成不存在。
            changed.push(path)
          }
        } catch {
          changed.push('（git status 不可读）')
        }
        let headIsBaseline = true
        try {
          // 快照由运行时自己建立：出现第二个提交就意味着执行者越界提交。
          const count = requireGit(workspacePath, ['rev-list', '--count', 'HEAD'])
          headIsBaseline = Number(count) <= 1
        } catch {
          headIsBaseline = false
        }
        workspaces.push({
          taskId: task.taskId,
          workspacePath,
          exists: true,
          headIsBaseline,
          changedFiles: changed,
          untrackedFiles: untracked,
        })
      }
    }
    return {
      requests,
      workspaces,
      blockedReason: requirement.blockedReason,
      taskRuns,
    }
  }

  recover(input: { reqId: string; by: string; confirm: boolean }): OperationResult {
    const requests = this.repo.requestsFor(input.reqId).filter((request) => request.state === 'unknown')
    if (requests.length === 0) return fail('nothing_to_recover', `需求 ${input.reqId} 没有待核对的请求`)
    if (!input.confirm) {
      return fail(
        'confirm_required',
        `需求 ${input.reqId} 有 ${requests.length} 条结果未知的请求；核对工作副本与产物后再确认恢复`,
      )
    }
    for (const request of requests) {
      this.repo.resolveRequest(
        request.requestId,
        'dismissed',
        `人工 ${input.by} 已核对并关闭未收口请求（${this.now()}）`,
        this.now(),
      )
    }
    return ok(`已核对并关闭 ${requests.length} 条未收口请求；不会自动重放其外部副作用`)
  }

  /**
   * 候选包：只从“已通过独立验证的那一份工作区”构建，保证安装的就是被验证的候选。
   * 构建前后核对候选内容、产物摘要与包版本，并记录验证绑定。
   */
  buildCandidate(input: { reqId: string; by: string; version?: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    const authorized = this.requireAuthorizedPlan(input.reqId)
    if (!authorized.ok) return authorized.result
    const plan = authorized.value.plan
    const artifacts = this.repo.taskArtifacts(input.reqId, plan.planVersion)
    const missing = plan.tasks.filter((task) => !artifacts.some((artifact) => artifact.taskId === task.taskId))
    if (missing.length > 0) {
      return fail('not_delivered', `仍有任务未交付，不能打包：${missing.map((task) => task.taskId).join('、')}`)
    }
    if (
      this.config.candidateBuildCommand.length === 0 ||
      this.config.candidatePackageCommand.length === 0 ||
      !this.config.candidateArtifactPath
    ) {
      return fail('candidate_not_configured', '未配置 candidateBuildCommand / candidatePackageCommand / candidateArtifactPath')
    }
    if (input.version !== undefined && !/^\d+\.\d+\.\d+$/.test(input.version)) {
      return fail('version_invalid', `候选版本必须是 x.y.z，实际 ${JSON.stringify(input.version)}`)
    }

    if (!this.repo.acceptance(input.reqId).accepted_at) {
      return fail('acceptance_required', `需求 ${input.reqId} 尚未通过整体验收；不能构建可发布候选`)
    }
    const identity = this.candidateIdentity(plan, artifacts)
    const verification = this.repo.verificationForCandidate(input.reqId, plan.planVersion, identity)
    if (!verification || verification.verdict !== 'pass') {
      return fail('verification_required', `候选 ${identity.slice(0, 16)}… 没有通过的独立验证；不能构建可发布候选`)
    }
    if (!this.verificationMaterialValid(verification)) {
      return fail('verification_invalid', '独立验证报告文件缺失或摘要不一致；不能构建可发布候选')
    }
    const review = this.repo.businessReviewForCandidate(input.reqId, plan.planVersion, identity)
    if (!review || review.verdict !== 'pass' || review.verificationSha256 !== verification.reportSha256) {
      return fail('business_review_required', `候选 ${identity.slice(0, 16)}… 没有通过的业务终审；不能构建可发布候选`)
    }
    const source = join(verification.evidenceDir, 'workspace')
    if (!existsSync(source)) {
      return fail('verification_workspace_missing', `独立验证工作区不存在：${source}`)
    }
    // 验证副本必须仍是当时那一份内容：受保护内容摘要与记录一致。
    let protectedDigest = ''
    let recordedDigest = ''
    try {
      protectedDigest = sha256OfText(requireGit(source, ['diff', 'HEAD', '--binary']))
      const canonical = JSON.parse(readFileSync(verification.reportPath, 'utf8')) as {
        candidateIntegrity?: { candidateContentSha256?: unknown }
      }
      recordedDigest =
        typeof canonical.candidateIntegrity?.candidateContentSha256 === 'string'
          ? canonical.candidateIntegrity.candidateContentSha256
          : ''
    } catch {
      return fail('verification_workspace_invalid', '无法核对独立验证工作区的候选内容')
    }
    if (!recordedDigest || protectedDigest !== recordedDigest) {
      return fail('candidate_content_mismatch', '独立验证工作区的受保护内容与验证记录不一致；不能据此构建')
    }
    const dir = candidatesDir(this.config, input.reqId, plan.planVersion)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    cpSync(source, dir, { recursive: true })
    if (input.version !== undefined) {
      const packageJsonPath = join(dir, 'packages/forgeloop/package.json')
      if (!existsSync(packageJsonPath)) {
        return fail('package_missing', `候选副本缺少插件包清单 ${packageJsonPath}`)
      }
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
      packageJson.version = input.version
      writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
    }
    const packageJsonPath = join(dir, 'packages/forgeloop/package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
    const packageVersion = typeof packageJson.version === 'string' ? packageJson.version : ''
    if (!packageVersion) return fail('package_missing', `候选包清单缺少版本号：${packageJsonPath}`)
    const log: string[] = []
    for (const [label, command, timeout] of [
      ['prepare', this.config.worktreePrepareCommand, this.config.formalTestTimeoutSeconds * 1000],
      ['build', this.config.candidateBuildCommand, this.config.formalTestTimeoutSeconds * 1000],
      ['package', this.config.candidatePackageCommand, this.config.formalTestTimeoutSeconds * 1000],
    ] as const) {
      if (command.length === 0) continue
      const result = runCommand(command[0]!, command.slice(1), dir, timeout)
      log.push(`=== ${label} (exit ${result.code})\n$ ${command.join(' ')}\n${result.stdout}\n${result.stderr}`)
      if (result.code !== 0) {
        writeFileSync(join(dir, 'candidate-build.log'), log.join('\n'), 'utf8')
        return fail('candidate_build_failed', `候选包 ${label} 失败（退出码 ${result.code}）；日志 ${join(dir, 'candidate-build.log')}`)
      }
    }
    writeFileSync(join(dir, 'candidate-build.log'), log.join('\n'), 'utf8')
    const artifactPath = join(dir, this.config.candidateArtifactPath)
    if (!existsSync(artifactPath)) {
      return fail('artifact_missing', `打包完成但没有找到产物清单 ${artifactPath}`)
    }
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      sha256?: string
      tarball?: string
      files?: string[]
      gitHead?: string
      builtAt?: string
      version?: string
    }
    if (!artifact.sha256 || !artifact.tarball) {
      return fail('artifact_malformed', `产物清单缺少 sha256/tarball：${artifactPath}`)
    }
    if (artifact.version && artifact.version !== packageVersion) {
      return fail('artifact_version_mismatch', `产物版本 ${artifact.version} 与包清单 ${packageVersion} 不一致`)
    }
    const candidateSha = sha256OfBytes(readFileSync(artifact.tarball))
    if (candidateSha !== artifact.sha256) {
      return fail('artifact_mismatch', `产物摘要与清单不一致：清单 ${artifact.sha256}，实际 ${candidateSha}`)
    }
    const buildDir = join(candidatesDir(this.config, input.reqId, plan.planVersion), 'build')
    mkdirSync(buildDir, { recursive: true })
    const recordPath = join(buildDir, 'candidate-build.json')
    const record = {
      kind: 'candidate-build',
      reqId: input.reqId,
      planVersion: plan.planVersion,
      candidateSha256: identity,
      verificationSha256: verification.reportSha256,
      packageVersion,
      artifactSha256: candidateSha,
      tarball: artifact.tarball,
      files: artifact.files ?? [],
      gitHead: artifact.gitHead ?? '',
      builtAt: artifact.builtAt ?? this.now(),
      candidateContentSha256: protectedDigest,
      sourceWorkspace: source,
      at: this.now(),
    }
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    this.repo.recordCandidate({
      reqId: input.reqId,
      planVersion: plan.planVersion,
      sha256: candidateSha,
      tarball: artifact.tarball,
      files: artifact.files ?? [],
      gitHead: artifact.gitHead ?? '',
      builtAt: record.builtAt,
      evidenceDir: dir,
    })
    this.repo.recordCandidateBuild({
      reqId: input.reqId,
      planVersion: plan.planVersion,
      candidateSha256: identity,
      verificationSha256: verification.reportSha256,
      packageVersion,
      artifactSha256: candidateSha,
      tarball: artifact.tarball,
      files: artifact.files ?? [],
      gitHead: artifact.gitHead ?? '',
      builtAt: record.builtAt,
      evidenceDir: dir,
    })
    return ok(`已从已验证候选构建安装包 ${packageVersion}（sha256 ${candidateSha.slice(0, 16)}…）`, {
      sha256: candidateSha,
      tarball: artifact.tarball,
      files: artifact.files ?? [],
      evidenceDir: dir,
      packageVersion,
      candidateSha256: identity,
      verificationSha256: verification.reportSha256,
      recordPath,
    })
  }

  /**
   * 上线核对：安装由外部受控机制完成，本方法只核对“装进去的、正在跑的”是否就是
   * 被验证并验收的那份候选；任一不一致都保留失败记录，不把安装回执当交付完成。
   */
  verifyDeployment(input: {
    reqId: string
    targetProfile: string
    by: string
    source: string
  }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(input.targetProfile)) {
      return fail('profile_invalid', `目标 profile 只能是安全的 profile 名，实际 ${JSON.stringify(input.targetProfile)}`)
    }
    const plan = this.repo.latestTaskPlan(input.reqId)
    if (!plan) return fail('plan_missing', `需求 ${input.reqId} 没有任务包`)
    const artifacts = this.repo.taskArtifacts(input.reqId, plan.planVersion)
    const missing = plan.tasks.filter((task) => !artifacts.some((artifact) => artifact.taskId === task.taskId))
    if (missing.length > 0) {
      return fail('not_delivered', `仍有任务未交付，不能做上线核对`)
    }
    const identity = this.candidateIdentity(plan, artifacts)
    const build = this.repo.candidateBuild(input.reqId, plan.planVersion)
    if (!build) return fail('candidate_missing', `需求 ${input.reqId} 尚未构建可安装候选`)
    if (build.candidateSha256 !== identity) {
      return fail('candidate_stale', '候选包绑定的候选身份与当前交付材料不一致；需重新验证并构建')
    }
    if (!this.repo.acceptance(input.reqId).accepted_at) {
      return fail('acceptance_required', '需求尚未通过整体验收；不能做上线核对')
    }
    const profileDir = join(this.config.dshProfilesRoot, input.targetProfile)
    const installedRoot = join(profileDir, 'node_modules', 'forgeloop-dsh')
    if (!existsSync(profileDir)) return fail('profile_missing', `目标 profile 不存在：${profileDir}`)
    if (!existsSync(installedRoot)) {
      return fail('not_installed', `目标 profile 尚未安装 forgeloop-dsh：${installedRoot}`)
    }
    const checks: Array<{ id: string; ok: boolean; detail: string }> = []
    const check = (id: string, ok: boolean, detail: string): void => {
      checks.push({ id, ok, detail })
    }

    let installedVersion = ''
    try {
      const installed = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8')) as {
        version?: unknown
      }
      installedVersion = typeof installed.version === 'string' ? installed.version : ''
    } catch {
      installedVersion = ''
    }
    check(
      'installed_version',
      installedVersion === build.packageVersion,
      `安装版本 ${installedVersion || '未知'}，候选包版本 ${build.packageVersion}`,
    )

    let filesOk = true
    const fileIssues: string[] = []
    for (const file of build.files) {
      const installedPath = join(installedRoot, file)
      if (!existsSync(installedPath)) {
        filesOk = false
        fileIssues.push(`缺少 ${file}`)
        continue
      }
      let packed: Buffer | null = null
      // npm pack 的成员带 `package/` 前缀；测试或本地 tar 可能没有，两种都核对。
      for (const member of [`package/${file}`, file]) {
        try {
          packed = execFileSync('tar', ['-xzf', build.tarball, '-O', member], {
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
          })
          break
        } catch {
          packed = null
        }
      }
      if (!packed) {
        filesOk = false
        fileIssues.push(`无法读取包内 ${file}`)
        continue
      }
      if (sha256OfBytes(packed) !== sha256OfBytes(readFileSync(installedPath))) {
        filesOk = false
        fileIssues.push(`内容不一致 ${file}`)
      }
    }
    check('installed_files', filesOk, filesOk ? `${build.files.length} 个文件与包内容一致` : fileIssues.join('；'))

    check(
      'running_version',
      PLUGIN_VERSION === build.packageVersion,
      `实际运行版本 ${PLUGIN_VERSION}，候选包版本 ${build.packageVersion}`,
    )

    const expectedModules = plan.tasks
      .flatMap((task) => task.files)
      .filter((file) => file.startsWith('packages/forgeloop/src/') && file.endsWith('.ts'))
      .map((file) => file.replace('packages/forgeloop/src/', 'lib/').replace(/\.ts$/, '.js'))
    const absentModules = expectedModules.filter((file) => !existsSync(join(installedRoot, file)))
    check(
      'requirement_modules',
      absentModules.length === 0,
      absentModules.length === 0
        ? `本次需求的 ${new Set(expectedModules).size} 个源码模块已随安装包加载`
        : `安装包缺少本次需求的模块：${absentModules.join('、')}`,
    )

    let boardOk = false
    try {
      const board = this.statusBoard(1)
      boardOk = Array.isArray(board.requirements)
    } catch {
      boardOk = false
    }
    check('key_entry', boardOk, boardOk ? '看板与记录查询可用' : '看板与记录查询不可用')

    const acceptance = this.repo.acceptance(input.reqId)
    const review = this.repo.businessReviewForCandidate(input.reqId, plan.planVersion, identity)
    check(
      'business_records',
      Boolean(acceptance.accepted_at) && review?.verdict === 'pass' && review.verificationSha256 === build.verificationSha256,
      `验收 ${acceptance.accepted_at || '缺失'}；业务终审 ${review?.verdict ?? '缺失'}`,
    )

    const dir = join(candidatesDir(this.config, input.reqId, plan.planVersion), 'deployment', input.targetProfile)
    mkdirSync(dir, { recursive: true })
    const state = checks.every((entry) => entry.ok) ? 'verified' : 'failed'
    const report = {
      kind: 'deployment',
      reqId: input.reqId,
      planVersion: plan.planVersion,
      candidateSha256: identity,
      verificationSha256: build.verificationSha256,
      artifactSha256: build.artifactSha256,
      packageVersion: build.packageVersion,
      targetProfile: input.targetProfile,
      profileDir,
      runtimeVersion: PLUGIN_VERSION,
      state,
      checks,
      at: this.now(),
    }
    const reportPath = join(dir, 'deployment.json')
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    this.repo.recordDeployment({
      reqId: input.reqId,
      planVersion: plan.planVersion,
      candidateSha256: identity,
      packageVersion: build.packageVersion,
      targetProfile: input.targetProfile,
      artifactSha256: build.artifactSha256,
      runtimeVersion: PLUGIN_VERSION,
      state,
      checks,
      evidenceDir: dir,
      recordedBy: input.by,
      source: input.source,
      recordedAt: this.now(),
    })
    if (state !== 'verified') {
      const failed = checks.filter((entry) => !entry.ok).map((entry) => `${entry.id}：${entry.detail}`)
      return fail('deployment_check_failed', `上线核对未通过：${failed.join('；')}；证据 ${reportPath}`)
    }
    return ok(`上线核对通过：运行版本 ${PLUGIN_VERSION}，候选 ${identity.slice(0, 16)}…，profile ${input.targetProfile}`, {
      state,
      reportPath,
      runtimeVersion: PLUGIN_VERSION,
      packageVersion: build.packageVersion,
      candidateSha256: identity,
      artifactSha256: build.artifactSha256,
      checks,
    })
  }

  accept(input: { reqId: string; by: string; source: string; artifactSha256?: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    // 结果未知的请求意味着可能有未收口的外部副作用；验收前必须核对并显式收口。
    const unknown = this.repo.requestsFor(input.reqId).filter((request) => request.state === 'unknown')
    if (unknown.length > 0) {
      return fail(
        'recovery_required',
        `需求 ${input.reqId} 有 ${unknown.length} 条结果未知的请求；核对工作副本、产物与证据并关闭后才能验收`,
      )
    }
    const latestPlan = this.repo.latestTaskPlan(input.reqId)
    if (!latestPlan) return fail('plan_missing', `需求 ${input.reqId} 没有任务包`)
    const approval = this.repo.planApproval(input.reqId, latestPlan.planVersion)
    const authorization = authorizePlan(latestPlan, approval)
    if (authorization.status !== 'approved') {
      return fail('plan_not_approved', authorization.reason)
    }
    if (latestPlan.requirementVersion !== requirement.versions.length) {
      return fail('stale_requirement', '任务包所依据的需求版本已过期；需要重新规划并批准')
    }
    const artifacts = this.repo.taskArtifacts(input.reqId, latestPlan.planVersion)
    const missing = latestPlan.tasks.filter(
      (task) => !artifacts.some((artifact) => artifact.taskId === task.taskId),
    )
    if (missing.length > 0) {
      return fail('not_delivered', `仍有任务未交付：${missing.map((task) => task.taskId).join('、')}`)
    }
    const verification = this.repo.verification(input.reqId, latestPlan.planVersion)
    if (!verification) {
      return fail(
        'verification_required',
        `需求 ${input.reqId} 尚未完成验证 Agent 的独立验证；不能验收`,
      )
    }
    const identity = this.candidateIdentity(latestPlan, artifacts)
    if (
      verification.candidateSha256 !== identity ||
      verification.requirementVersion !== requirement.versions.length
    ) {
      return fail(
        'verification_stale',
        '独立验证结论绑定的候选或需求版本与当前材料不一致；必须对当前候选重新验证后再验收',
      )
    }
    if (
      !existsSync(verification.reportPath) ||
      sha256OfText(readFileSync(verification.reportPath, 'utf8')) !== verification.reportSha256
    ) {
      return fail('verification_invalid', '独立验证报告文件缺失或摘要不一致；不能验收')
    }
    if (verification.verdict !== 'pass') {
      return fail(
        'verification_blocked',
        `独立验证未通过：${verificationBlocking(verification.reportJson)}`,
      )
    }
    const businessReview = this.repo.businessReviewForCandidate(
      input.reqId,
      latestPlan.planVersion,
      identity,
    )
    if (!businessReview) {
      return fail(
        'business_review_required',
        `需求 ${input.reqId} 尚未完成需求 Agent 的业务终审；不能验收`,
      )
    }
    if (
      businessReview.verificationSha256 !== verification.reportSha256 ||
      businessReview.requirementVersion !== requirement.versions.length
    ) {
      return fail('business_review_stale', '业务终审绑定的验证或需求版本与当前材料不一致；必须重新终审')
    }
    if (!this.businessReviewMaterialValid(businessReview)) {
      return fail('business_review_invalid', '业务终审报告文件缺失或摘要不一致；不能验收')
    }
    if (businessReview.verdict !== 'pass') {
      return fail(
        'business_review_blocked',
        `业务终审未通过：${verificationBlocking(businessReview.reportJson)}`,
      )
    }
    const candidate = this.repo.candidate(input.reqId, latestPlan.planVersion)
    if (candidate) {
      if (!input.artifactSha256) {
        return fail(
          'artifact_required',
          `需求 ${input.reqId} 已构建候选包 ${candidate.sha256.slice(0, 16)}…；验收必须显式给出产物 SHA256`,
        )
      }
      if (candidate.sha256 !== input.artifactSha256) {
        return fail('artifact_mismatch', '给出的产物摘要与候选包记录不一致；原验收不能绑定另一个产物')
      }
    }
    let binding
    try {
      binding = this.buildAcceptanceBinding(latestPlan, artifacts, verification, businessReview, input.artifactSha256)
    } catch (error) {
      return fail('material_invalid', (error as Error).message)
    }
    const fingerprint = sha256OfText(JSON.stringify(binding))
    this.repo.recordAcceptance({
      reqId: input.reqId,
      acceptedBy: input.by,
      source: input.source,
      fingerprint,
      now: this.now(),
    })
    return ok(`需求 ${input.reqId} 已通过整体验收；材料指纹 ${fingerprint.slice(0, 16)}…`, {
      fingerprint,
      binding,
    })
  }

  private buildAcceptanceBinding(
    plan: TaskPlan,
    artifacts: ReturnType<Repository['taskArtifacts']>,
    verification: VerificationRecord,
    businessReview: ReturnType<Repository['businessReviewForCandidate']> & object,
    artifactSha256?: string,
  ) {
    const ordered = plan.tasks.map((task) => {
      const artifact = artifacts.find((candidate) => candidate.taskId === task.taskId)
      if (!artifact) throw new RuleViolationError(`任务 ${task.taskId} 缺少交付产物`)
      return artifact
    })
    return {
      candidateSha256: this.candidateIdentity(plan, artifacts),
      testEvidenceSha256: sha256OfText(ordered.map((artifact) => artifact.testEvidenceSha256).join(':')),
      reviewSha256: sha256OfText(ordered.map((artifact) => artifact.reviewSha256).join(':')),
      verificationSha256: verification.reportSha256,
      verificationCandidateSha256: verification.candidateSha256,
      businessReviewSha256: businessReview.reportSha256,
      artifactSha256: artifactSha256 ?? '',
      baselineCommit: ordered[0]?.baselineCommit ?? '',
    }
  }

  /** 一次交付的候选身份；验证与验收必须绑定同一摘要。 */
  private candidateIdentity(
    plan: TaskPlan,
    artifacts: ReturnType<Repository['taskArtifacts']>,
  ): string {
    const ordered = plan.tasks.map((task) => {
      const artifact = artifacts.find((candidate) => candidate.taskId === task.taskId)
      if (!artifact) throw new RuleViolationError(`任务 ${task.taskId} 缺少交付产物`)
      return artifact
    })
    return candidateIdentityOf({
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      baselineCommit: ordered[0]?.baselineCommit ?? '',
      candidateHashes: ordered.map((artifact) => artifact.candidateSha256),
    })
  }

  // ------------------------------------------------------------ 查询

  private planReviewView(reqId: string, planVersion: number): unknown {
    const record = this.repo.planReview(reqId, planVersion)
    if (!record) return null
    let review: PlanReview | null = null
    try {
      review = parsePlanReview(record.reportJson)
    } catch {
      review = null
    }
    return {
      verdict: record.verdict,
      summary: review?.summary ?? '',
      blocking: review?.blocking ?? [],
      findings: review?.findings ?? [],
      verificationPlan: review?.verificationPlan ?? [],
      reportPath: record.reportPath,
      reportSha256: record.reportSha256,
      sessionId: record.sessionId,
      reviewedAt: record.reviewedAt,
    }
  }

  private verificationView(
    reqId: string,
    plan: TaskPlan,
    artifacts: ReturnType<Repository['taskArtifacts']>,
  ): unknown {
    const record = this.repo.verification(reqId, plan.planVersion)
    if (!record) return null
    let report: VerificationReport | null = null
    try {
      report = parseVerificationReport(record.reportJson)
    } catch {
      report = null
    }
    const currentIdentity = (() => {
      try {
        return this.candidateIdentity(plan, artifacts)
      } catch {
        return ''
      }
    })()
    return {
      verdict: record.verdict,
      summary: report?.summary ?? '',
      blocking: report?.blocking ?? [],
      findings: report?.findings ?? [],
      scenarios: report?.scenarios ?? [],
      candidateSha256: record.candidateSha256,
      workspaceSha256: record.workspaceSha256,
      reportPath: record.reportPath,
      reportSha256: record.reportSha256,
      sessionId: record.sessionId,
      verifiedAt: record.verifiedAt,
      fresh: currentIdentity !== '' && currentIdentity === record.candidateSha256,
    }
  }

  requirementView(requirement: Requirement): unknown {
    const latestAnalysis = this.repo.latestAnalysis(requirement.reqId)
    const plans = this.repo.taskPlans(requirement.reqId)
    const latestPlan = plans[plans.length - 1]
    const approval = latestPlan ? this.repo.planApproval(requirement.reqId, latestPlan.planVersion) : null
    const artifacts = latestPlan ? this.repo.taskArtifacts(requirement.reqId, latestPlan.planVersion) : []
    const runs = latestPlan ? this.repo.taskRuns(requirement.reqId, latestPlan.planVersion) : []
    const recordedFailures = this.repo.failureRounds(requirement.reqId)
    const grants = this.repo.grantCount(requirement.reqId)
    return {
      reqId: requirement.reqId,
      project: requirement.project,
      status: requirement.status,
      blockedReason: requirement.blockedReason,
      versions: requirement.versions.map((version) => ({
        version: version.version,
        text: version.text,
        createdAt: version.createdAt,
        revisedBy: version.revisedBy,
      })),
      analysis: latestAnalysis,
      plans: plans.map((plan) => ({
        planVersion: plan.planVersion,
        requirementVersion: plan.requirementVersion,
        tasks: plan.tasks.map((task) => task.taskId),
        createdAt: plan.createdAt,
      })),
      approval: approval
        ? { planVersion: approval.planVersion, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt }
        : null,
      planReview: latestPlan ? this.planReviewView(requirement.reqId, latestPlan.planVersion) : null,
      verification: latestPlan ? this.verificationView(requirement.reqId, latestPlan, artifacts) : null,
      candidate: latestPlan ? this.repo.candidate(requirement.reqId, latestPlan.planVersion) : null,
      delivered: artifacts.map((artifact) => artifact.taskId),
      runs: runs.map((run) => ({ taskId: run.taskId, state: run.state, reason: run.reason })),
      failureRounds: recordedFailures.length,
      grants,
      failureRoundDetails: recordedFailures.map((round) => ({
        roundId: round.roundId,
        stage: round.stage,
        summary: round.summary,
        occurredAt: round.occurredAt,
        ...(taskIdOfFailureRound(latestPlan ?? null, round.roundId)
          ? { taskId: taskIdOfFailureRound(latestPlan ?? null, round.roundId) }
          : {}),
      })),
      grantQuota: {
        grants,
        used: recordedFailures.length,
        remaining: Math.max(0, grants * MAX_ROUNDS_PER_GRANT - recordedFailures.length),
      },
      pendingRequests: this.repo
        .requestsFor(requirement.reqId)
        .filter((request) => ['pending', 'claimed', 'unknown'].includes(request.state))
        .map(requestView),
    }
  }

  /**
   * 需求修订影响摘要：命令与模型工具共用同一事实计算链。
   * 默认零模型调用；只有显式 explain 才把事实交给无工具 Agent，推断与事实分区返回。
   * 只读：不写记录，也不提供批准、推进或验收路径。
   */
  async impact(reqId: string, options: { explain?: boolean } = {}): Promise<OperationResult> {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)

    const plans = this.repo.taskPlans(reqId)
    const approvals = plans.flatMap((plan) => {
      const approval = this.repo.planApproval(reqId, plan.planVersion)
      return approval === null ? [] : [approval]
    })
    const deliveries = plans.flatMap((plan) => this.repo.taskArtifacts(reqId, plan.planVersion))
    const requests: ImpactRequest[] = this.repo.requestsFor(reqId).map((request) => ({
      requestId: request.requestId,
      action: request.action,
      state: request.state,
      planVersion: request.planVersion,
      createdAt: request.createdAt,
    }))

    const facts = buildImpactFacts({
      requirement,
      analyses: this.repo.analyses(reqId),
      plans,
      approvals,
      deliveries,
      requests,
    })
    const explain = options.explain === true
    const result = await explainImpactFacts(
      facts,
      explain ? { explain: true, agent: this.impactExplainAgent(reqId) } : {},
    )
    return ok(
      `需求 ${reqId} 影响摘要：${facts.state}（已过期 ${facts.summary.staleItems} 项，待核对 ${facts.summary.pendingItems} 项）；${result.notice}`,
      result,
    )
  }

  /** 仅当显式请求推断时调用；Agent 固定无工具，且只读事实快照。 */
  private impactExplainAgent(reqId: string): ImpactExplainAgent {
    return {
      run: async (request): Promise<ImpactExplainAgentResponse> => {
        const result = await this.runner.run({
          role: 'analyze',
          cwd: this.config.projectPath,
          prompt: request.prompt,
          permission: 'workspace-write',
          timeoutMs: this.config.agent.timeoutSeconds * 1000,
          transcriptPath: join(
            sessionsDir(this.config),
            `${reqId}-impact-${randomUUID()}.jsonl`,
          ),
          tools: 'none',
        })
        return {
          status: result.status,
          text: result.text,
          reason: result.reason,
          sessionId: result.sessionId,
          toolCalls: result.toolCalls,
        }
      },
    }
  }

  status(reqId?: string): OperationResult {
    if (!reqId) {
      const requirements = this.repo.listRequirements(this.config.project)
      return ok(`项目 ${this.config.project} 共 ${requirements.length} 条需求`, {
        requirements: requirements.map((requirement) => ({
          reqId: requirement.reqId,
          status: requirement.status,
          versions: requirement.versions.length,
          title: requirement.versions[requirement.versions.length - 1]?.text.slice(0, 60) ?? '',
        })),
      })
    }
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    return ok(`需求 ${reqId} 状态：${requirement.status}`, this.requirementView(requirement))
  }

  /**
   * 只读状态看板：需求、任务与待处理问题的事实视图。
   * 供 Web 客户端页面与测试共用；不写记录，也不提供批准、推进或验收入口。
   * @param limit 需求条数上限；搜索时仍受同一上限约束。
   * @param query 搜索词；匹配范围见 runtime/board.ts。
   */
  statusBoard(limit?: number, query?: string): StatusBoardView {
    return buildStatusBoard({ repository: this.repo, project: this.config.project, limit, query })
  }

  // ------------------------------------------------------------ 运维

  /** 供协调器周期调用；不直接暴露给模型或页面动作。 */
  async opsTick(signal?: AbortSignal): Promise<Awaited<ReturnType<OpsRuntime['tick']>>> {
    return this.ops.tick(signal)
  }

  opsStatus(eventId?: string): OperationResult {
    if (eventId) {
      const detail = this.ops.detail(eventId)
      if (!detail) return fail('not_found', `未找到运维事件 ${eventId}`)
      return ok(`运维事件 ${eventId}`, detail)
    }
    return ok('运维事件与统计', {
      summary: this.ops.summary(),
      events: this.ops.list(),
    })
  }

  opsDecide(input: {
    eventId: string
    decision: 'approve' | 'decline'
    by: string
    source: string
    reason?: string
  }): OperationResult {
    return this.ops.decide(input)
  }

  opsConfirmUnknown(input: { eventId: string; by: string; reason: string }): OperationResult {
    return this.ops.confirmUnknown(input)
  }

  opsClose(input: {
    eventId: string
    by: string
    reason: string
    confirmUnknown?: boolean
  }): OperationResult {
    return this.ops.close(input)
  }

  opsRequestFix(input: { eventId: string; by: string; source: string }): OperationResult {
    return this.ops.requestFix(input)
  }

  /**
   * 单条需求的完整只读详情：在 status 视图之上补充最新任务包正文、
   * 交付产物、验收记录与进度，供工作台展开需求后展示。
   */
  requirementDetail(reqId: string): OperationResult {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    const view = this.requirementView(requirement) as Record<string, unknown>
    const plan = this.repo.latestTaskPlan(reqId)
    const artifacts = plan ? this.repo.taskArtifacts(reqId, plan.planVersion) : []
    const runs = plan ? this.repo.taskRuns(reqId, plan.planVersion) : []
    const delivered = new Set(artifacts.map((artifact) => artifact.taskId))
    const runByTask = new Map(runs.map((run) => [run.taskId, run]))
    const progress = {
      total: plan?.tasks.length ?? 0,
      delivered: 0,
      failed: 0,
      awaitingUser: 0,
      awaitingInput: 0,
      blocked: 0,
      running: 0,
      pending: 0,
    }
    for (const task of plan?.tasks ?? []) {
      const run = runByTask.get(task.taskId)
      if (delivered.has(task.taskId)) progress.delivered += 1
      else if (run?.state === TASK_RUN_RUNNING && /ask_user_question/i.test(run.reason)) {
        progress.awaitingInput += 1
      } else if (run?.state === TASK_RUN_RUNNING) progress.running += 1
      else if (run?.state === TASK_RUN_FAILED) progress.failed += 1
      else if (run?.state === TASK_RUN_BLOCKED) progress.blocked += 1
      else if (run?.state === TASK_RUN_AWAITING_USER) progress.awaitingUser += 1
      else progress.pending += 1
    }
    const requests = this.repo.requestsFor(reqId)
    return ok(`需求 ${reqId} 详情`, {
      ...view,
      latestPlan: plan,
      artifacts,
      acceptanceRecord: this.repo.acceptance(reqId),
      businessReview: plan ? this.repo.businessReviewForCandidate(
        reqId,
        plan.planVersion,
        plan.tasks.every((task) => delivered.has(task.taskId))
          ? this.candidateIdentity(plan, artifacts)
          : '',
      ) : null,
      candidateBuild: plan ? this.repo.candidateBuild(reqId, plan.planVersion) : null,
      deployment: plan ? this.repo.deployment(reqId, plan.planVersion) : null,
      archivedDeliveries: plan
        ? plan.tasks.flatMap((task) =>
            this.repo.archivedArtifacts(reqId, plan.planVersion, task.taskId).map((entry) => ({
              taskId: task.taskId,
              ...entry,
            })),
          )
        : [],
      progress,
      unknownRequests: requests.filter((request) => request.state === 'unknown').length,
      activeRequests: requests.filter(
        (request) => request.state === 'pending' || request.state === 'claimed',
      ).length,
      stopRequested: requirement.blockedReason.startsWith('停止请求'),
    })
  }

  showPlan(reqId: string, planVersion?: number): OperationResult {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    const plan =
      planVersion === undefined
        ? this.repo.latestTaskPlan(reqId)
        : this.repo.taskPlan(reqId, planVersion)
    if (!plan) return fail('plan_missing', `需求 ${reqId} 没有对应任务包`)
    const approval = this.repo.planApproval(reqId, plan.planVersion)
    return ok(`需求 ${reqId} 任务包 v${plan.planVersion}`, {
      plan,
      authorization: authorizePlan(plan, approval),
      analysis: this.repo.latestAnalysis(reqId),
    })
  }

  evidence(reqId: string): OperationResult {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    const plan = this.repo.latestTaskPlan(reqId)
    if (!plan) return fail('plan_missing', `需求 ${reqId} 没有任务包`)
    const artifacts = this.repo.taskArtifacts(reqId, plan.planVersion)
    const evidence = plan.tasks.map((task) => ({
      taskId: task.taskId,
      artifact: artifacts.find((artifact) => artifact.taskId === task.taskId) ?? null,
      files: this.repo.evidence(reqId, plan.planVersion, task.taskId),
    }))
    return ok(`需求 ${reqId} 交付证据（任务包 v${plan.planVersion}）`, {
      planVersion: plan.planVersion,
      evidence,
      acceptance: this.repo.acceptance(reqId),
      candidate: plan ? this.repo.candidate(reqId, plan.planVersion) : null,
    })
  }

  listRequests(reqId?: string): OperationResult {
    const requests = reqId
      ? this.repo.requestsFor(reqId)
      : this.repo.pendingRequests(this.config.project)
    return ok(`共 ${requests.length} 条操作请求`, { requests: requests.map(requestView) })
  }

  // ------------------------------------------------------------ 执行流水线

  /** 执行一条已领取的请求；返回结局文本。调用方负责请求状态落库。 */
  async executeRequest(
    request: ServiceRequestRecord,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed' | 'unknown'; detail: string }> {
    const requirement = this.repo.getRequirement(request.reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${request.reqId}` }
    if (isTerminal(requirement.status)) {
      return { state: 'failed', detail: `需求已处于终态 ${requirement.status}` }
    }
    if (request.action === 'analyze') {
      return this.executeAnalysis(request.reqId, signal)
    }
    if (request.action === 'plan') {
      return this.executeDevPlanning(
        request.reqId,
        signal,
        request.source.includes(':plan-change:'),
      )
    }
    if (request.action === ACTION_VERIFY) {
      const verification = await this.executeVerification(request.reqId, signal)
      if (verification.state === 'repair') {
        return this.executeAdvance(request.reqId, signal, request.requestId)
      }
      return verification.state === 'done'
        ? { state: 'done' as const, detail: verification.detail }
        : { state: verification.state, detail: verification.detail }
    }
    return this.executeAdvance(request.reqId, signal, request.requestId)
  }

  private async executeAnalysis(
    reqId: string,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed' | 'unknown'; detail: string }> {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${reqId}` }
    const started = Date.now()
    const transcript = join(sessionsDir(this.config), `${reqId}-analyze.jsonl`)
    // 需求 Agent 只读项目事实：活动需求、任务、时间与状态；不开放工具，也不写记录。
    const facts = buildProjectFacts({
      repository: this.repo,
      project: this.config.project,
      currentReqId: reqId,
      now: this.now(),
    })
    const result = await this.runner.run({
      role: 'analyze',
      cwd: this.config.projectPath,
      prompt: analysisPrompt(requirement, facts),
      permission: 'workspace-write',
      timeoutMs: this.config.agent.timeoutSeconds * 1000,
      transcriptPath: transcript,
      signal,
      tools: 'none',
    })
    this.charge(reqId, started)
    if (result.status !== 'completed') return { state: this.mapAgentState(result.status), detail: result.reason }
    let draft
    try {
      draft = parseAnalysisDraft(result.text)
    } catch (error) {
      this.repo.setStatus(reqId, 'blocked', `分析结果畸形：${(error as Error).message}`)
      return { state: 'failed', detail: (error as Error).message }
    }
    const analysis: RequirementAnalysis & { reqId: string } = {
      reqId,
      analysisVersion: this.repo.nextAnalysisVersion(reqId),
      requirementVersion: requirement.versions.length,
      goal: draft.goal,
      scenarios: draft.scenarios,
      acceptanceCriteria: draft.acceptanceCriteria,
      clarifications: draft.clarifications,
      createdAt: this.now(),
    }
    this.repo.recordAnalysis(analysis)
    const status = statusForAnalysis(analysis)
    this.repo.setStatus(
      reqId,
      status,
      analysis.clarifications.length > 0 ? `待澄清：${analysis.clarifications.join('；')}` : '',
    )
    return {
      state: 'done',
      detail:
        analysis.clarifications.length > 0
          ? `分析 v${analysis.analysisVersion} 完成，有 ${analysis.clarifications.length} 条待澄清；等待人工回答后修订需求`
          : `分析 v${analysis.analysisVersion} 完成`,
    }
  }

  private async executeDevPlanning(
    reqId: string,
    signal: AbortSignal,
    permittedPlanChange = false,
  ): Promise<{ state: 'done' | 'failed' | 'unknown'; detail: string }> {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${reqId}` }
    // 入队时未批准、执行时已批准：仍必须拒绝，避免旧请求悄悄覆盖已冻结的任务包。
    const latestPlan = this.repo.latestTaskPlan(reqId)
    if (latestPlan && this.repo.planApproval(reqId, latestPlan.planVersion) && !permittedPlanChange) {
      return {
        state: 'failed',
        detail: `任务包 v${latestPlan.planVersion} 已批准并冻结；修改任务包需要所有者显式许可并说明原因`,
      }
    }
    const analysis = this.repo.latestAnalysis(reqId)
    if (!analysis) return { state: 'failed', detail: '尚无分析结论，不能规划' }
    if (analysis.requirementVersion !== requirement.versions.length) {
      return {
        state: 'failed',
        detail: `最新分析依据需求 v${analysis.requirementVersion}，当前是 v${requirement.versions.length}；请重新分析`,
      }
    }
    if (analysis.clarifications.length > 0) {
      return { state: 'failed', detail: '分析仍有待澄清项；回答后修订需求并重新分析' }
    }
    let feedback = ''
    let lastError = ''
    let lastPlan: TaskPlan | undefined
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const transcript = join(sessionsDir(this.config), `${reqId}-plan-a${attempt}.jsonl`)
      const started = Date.now()
      const result = await this.runner.run({
        role: 'plan',
        cwd: this.config.projectPath,
        prompt: devPlanningPrompt(requirement, analysis) + feedback,
        permission: 'workspace-write',
        timeoutMs: this.config.agent.timeoutSeconds * 1000,
        transcriptPath: transcript,
        signal,
        tools: 'none',
      })
      this.charge(reqId, started)
      if (result.status !== 'completed') {
        return { state: this.mapAgentState(result.status), detail: result.reason }
      }
      let plan: TaskPlan
      try {
        plan = parseTaskPlanDraft(result.text, {
          requirementId: reqId,
          project: requirement.project,
          planVersion: this.repo.nextPlanVersion(reqId),
          requirementVersion: requirement.versions.length,
          now: this.now(),
        })
      } catch (error) {
        lastError = `任务包不合规：${(error as Error).message}`
        feedback = `\n\n上一次输出的任务包被程序拒绝：${(error as Error).message}。请修正后重新输出完整 JSON。`
        continue
      }
      const packages = this.existingPackages()
      const violations = [
        ...languageViolations(plan),
        ...outsideActiveSource(plan),
        ...unknownPackages(plan, packages),
      ]
      if (violations.length > 0) {
        lastError = `任务包越过 TypeScript 语言/工程边界：${violations
          .map((violation) => `${violation.taskId}.${violation.field}=${violation.value}（${violation.reason}）`)
          .join('；')}`
        feedback = `\n\n上一次输出的任务包被程序拒绝：${lastError}。不得使用 Python、旧 .venv 或旧 forgeloop CLI；请只修改 TypeScript 工程并给出 npm/node 测试命令。重新输出完整 JSON。`
        continue
      }
      this.repo.recordTaskPlan(plan)
      lastPlan = plan
      const reviewOutcome = await this.reviewPlan(requirement, analysis, plan, signal)
      if (reviewOutcome.state !== 'done') {
        this.repo.setStatus(
          reqId,
          PLAN_PROPOSED,
          '任务包已生成，但验证 Agent 的实现前评审未完成；不能批准',
        )
        return { state: reviewOutcome.state, detail: reviewOutcome.detail }
      }
      if (reviewOutcome.review.verdict === 'block') {
        lastError = `实现前评审阻断：${reviewOutcome.review.blocking.join('；')}`
        feedback = `\n\n上一次任务包被验证 Agent 的实现前评审阻断：\n- ${reviewOutcome.review.blocking.join('\n- ')}\n请修正技术方案、任务文件范围或测试命令后重新输出完整 JSON。`
        continue
      }
      this.repo.setStatus(reqId, PLAN_PROPOSED)
      return {
        state: 'done',
        detail: `已生成任务包 v${plan.planVersion}（${plan.tasks.length} 个任务）并通过实现前评审；等待批准`,
      }
    }
    if (lastPlan) {
      this.repo.setStatus(reqId, PLAN_PROPOSED, lastError)
    } else {
      this.repo.setStatus(reqId, 'blocked', lastError)
    }
    return { state: 'failed', detail: lastError }
  }

  /**
   * 实现前评审：验证 Agent 只读任务包与分析，产出验证计划。
   * 评审通过才允许批准；阻断原因会反馈给规划 Agent 重新生成任务包。
   */
  private async reviewPlan(
    requirement: Requirement,
    analysis: RequirementAnalysis,
    plan: TaskPlan,
    signal: AbortSignal,
  ): Promise<
    | { state: 'done'; review: PlanReview }
    | { state: 'failed' | 'unknown'; detail: string }
  > {
    let feedback = ''
    let lastMalformed = ''
    let review: PlanReview | null = null
    let lastSession = ''
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const started = Date.now()
      const transcript = join(
        sessionsDir(this.config),
        `${requirement.reqId}-plan-review-v${plan.planVersion}-r${attempt}.jsonl`,
      )
      const result = await this.runner.run({
        role: 'verify-plan',
        cwd: this.config.projectPath,
        prompt: planReviewPrompt({ requirement, analysis, plan }) + feedback,
        permission: 'workspace-write',
        timeoutMs: this.config.agent.timeoutSeconds * 1000,
        transcriptPath: transcript,
        signal,
        tools: 'none',
      })
      this.charge(requirement.reqId, started)
      if (result.status !== 'completed') {
        return {
          state: result.status === 'aborted' || result.status === 'timeout' ? 'unknown' : 'failed',
          detail: `实现前评审未取得可用结论：${result.reason}`,
        }
      }
      lastSession = result.sessionId
      let parsed: PlanReview
      try {
        parsed = parsePlanReview(result.text)
      } catch (error) {
        // 评审材料畸形属于可修正的评审输出问题：带着明确的 JSON 结构要求重试一次，
        // 仍失败则 fail-closed，不伪造通过，也不占用研发重新规划的次数。
        lastMalformed = (error as Error).message
        feedback = `\n\n上一次输出无法解析：${lastMalformed}。请重新只输出一个完整 JSON 对象，字段与上面要求一致，scenarios 不得重复。`
        continue
      }
      // 评审模型自报通过还不够：验证计划必须覆盖分析中的每个场景与验收标准。
      // 缺项先带着精确缺项重试评审；仍缺项才按阻断记录，交回研发重新规划。
      if (parsed.verdict === 'pass') {
        const coverage = validatePlanCoverage(analysis, parsed)
        if (coverage.length > 0) {
          feedback = `\n\n上一次验证计划没有覆盖以下分析原文，请逐字引用（可附加说明，但不能改写）后重新输出：\n- ${coverage.join('\n- ')}`
          if (attempt < 2) continue
          parsed = { ...parsed, verdict: 'block', blocking: coverage }
        }
      }
      review = parsed
      break
    }
    if (!review) {
      return {
        state: 'failed',
        detail: `实现前评审结果畸形（fail-closed）：${lastMalformed || '连续两次未取得可用结论'}`,
      }
    }
    const result = { sessionId: lastSession }
    const dir = planReviewDir(this.config, requirement.reqId, plan.planVersion)
    mkdirSync(dir, { recursive: true })
    const reportPath = join(dir, 'plan-review.json')
    // 摘要必须绑定“已落库的任务包”：内存对象与恢复对象的字段顺序不同，
    // 若按内存对象计算，批准时重新加载后再核对会永远判为过期。
    const planSha256 = sha256OfText(JSON.stringify(this.repo.taskPlan(requirement.reqId, plan.planVersion) ?? plan))
    const report = {
      kind: 'plan-review',
      reqId: requirement.reqId,
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      planSha256,
      verdict: review.verdict,
      blocking: review.blocking,
      findings: review.findings,
      summary: review.summary,
      verification_plan: review.verificationPlan,
      sessionId: result.sessionId,
      at: this.now(),
    }
    const reportJson = `${JSON.stringify(report, null, 2)}\n`
    writeFileSync(reportPath, reportJson, 'utf8')
    this.repo.recordPlanReview({
      requirementId: requirement.reqId,
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      planSha256,
      verdict: review.verdict,
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      sessionId: result.sessionId,
      reviewedAt: this.now(),
    })
    return { state: 'done', review }
  }

  /**
   * 候选在验证开始前就无法组装（例如交付 diff 与当前基线冲突）：
   * 如实记录一次阻断验证与失败轮次，让“回到研发修复”有据可依。
   */
  private recordPreflightBlock(input: {
    reqId: string
    plan: TaskPlan
    candidateSha256: string
    planReviewSha256: string
    blocking: readonly string[]
  }): string {
    const dir = verificationDir(this.config, input.reqId, input.plan.planVersion, input.candidateSha256)
    mkdirSync(dir, { recursive: true })
    const report = {
      kind: 'verification',
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      requirementVersion: input.plan.requirementVersion,
      candidateSha256: input.candidateSha256,
      workspaceSha256: '',
      planReviewSha256: input.planReviewSha256,
      verdict: 'block',
      summary: '候选无法在当前基线组装，未执行验证命令',
      findings: [],
      blocking: [...input.blocking],
      scenarios: [],
      commands: [],
      candidateIntegrity: null,
      materials: [],
      sessionId: '',
      at: this.now(),
    }
    const reportJson = `${JSON.stringify(report, null, 2)}\n`
    const reportPath = join(dir, 'verification.json')
    writeFileSync(reportPath, reportJson, 'utf8')
    this.repo.recordVerification({
      requirementId: input.reqId,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidateSha256,
      requirementVersion: input.plan.requirementVersion,
      workspaceSha256: '',
      verdict: 'block',
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      evidenceDir: dir,
      sessionId: '',
      verifiedAt: this.now(),
    })
    this.repo.recordFailureRound(input.reqId, {
      roundId: `verification-${input.plan.planVersion}-${input.candidateSha256.slice(0, 12)}-preflight`,
      stage: FAILURE_VERIFICATION,
      summary: `独立验证无法组装候选：${input.blocking.join('；')}`.slice(0, 1000),
      occurredAt: this.now(),
    })
    this.repo.setStatus(
      input.reqId,
      'blocked',
      `独立验证无法组装候选（候选 ${input.candidateSha256.slice(0, 16)}…）：${input.blocking.join('；')}`,
    )
    return reportPath
  }

  /**
   * 独立验证：把已交付任务的全部 diff 应用成固定候选，交给验证 Agent 在独立目录
   * 编写验证测试并产出命令清单与逐场景报告；程序随后实际执行命令并只看退出码、
   * 日志与必过场景覆盖，模型自述不构成通过。
   */
  private async executeVerification(
    reqId: string,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed' | 'unknown' | 'repair'; detail: string }> {
    const authorized = this.requireAuthorizedPlan(reqId)
    if (!authorized.ok) return { state: 'failed', detail: authorized.result.message }
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${reqId}` }
    const analysis = this.repo.latestAnalysis(reqId)
    if (!analysis) return { state: 'failed', detail: `需求 ${reqId} 尚无分析结论；不能验证` }
    const plan = authorized.value.plan
    const artifacts = this.repo.taskArtifacts(reqId, plan.planVersion)
    const missing = plan.tasks.filter(
      (task) => !artifacts.some((artifact) => artifact.taskId === task.taskId),
    )
    if (missing.length > 0) {
      return {
        state: 'failed',
        detail: `仍有任务未交付，不能开始独立验证：${missing.map((task) => task.taskId).join('、')}`,
      }
    }
    const reviewRecord = this.repo.planReview(reqId, plan.planVersion)
    if (!reviewRecord) {
      return { state: 'failed', detail: `任务包 v${plan.planVersion} 尚未通过实现前评审；不能开始独立验证` }
    }
    if (reviewRecord.verdict !== 'pass') {
      return {
        state: 'failed',
        detail: `任务包 v${plan.planVersion} 的实现前评审未通过：${planReviewBlocking(reviewRecord.reportJson)}`,
      }
    }
    let planReview: PlanReview
    try {
      planReview = parsePlanReview(reviewRecord.reportJson)
    } catch (error) {
      return { state: 'failed', detail: `实现前评审证据畸形：${(error as Error).message}` }
    }
    const candidateSha256 = this.candidateIdentity(plan, artifacts)
    const existing = this.repo.verificationForCandidate(reqId, plan.planVersion, candidateSha256)
    if (existing) {
      if (existing.verdict === 'block') {
        return {
          state: 'failed',
          detail: `候选 ${candidateSha256.slice(0, 16)}… 的独立验证已阻断：${verificationBlocking(existing.reportJson)}；需修复后产生新候选再验证`,
        }
      }
      if (!this.verificationMaterialValid(existing)) {
        return { state: 'failed', detail: '独立验证报告文件缺失或摘要不一致；需重新验证' }
      }
      return {
        state: 'done',
        detail: `候选 ${candidateSha256.slice(0, 16)}… 已通过独立验证；等待验收`,
      }
    }

    this.repo.ensureBudget(reqId, plan.tasks.reduce((sum, task) => sum + task.limits.limitSeconds, 0))
    const budget = new ExecutionBudget(this.repo.budget(reqId).limitSeconds, this.repo.budget(reqId).consumedSeconds)
    if (!budget.canStartAction()) {
      this.repo.setStatus(reqId, 'blocked', '执行工时已用尽；需显式延长或拆分任务')
      return { state: 'failed', detail: '执行工时已用尽；需显式延长或拆分任务' }
    }

    const dir = verificationDir(this.config, reqId, plan.planVersion, candidateSha256)
    const workspace = join(dir, 'workspace')
    mkdirSync(dir, { recursive: true })
    const baseline = headCommit(this.config.projectPath)
    const snapshot = prepareSnapshotWorkspace({
      projectPath: this.config.projectPath,
      workspacePath: workspace,
      baselineCommit: baseline,
    })
    const diffs: string[] = []
    for (const task of plan.tasks) {
      const evidence = this.repo.evidence(reqId, plan.planVersion, task.taskId)
      if (!evidence) {
        return { state: 'failed', detail: `任务 ${task.taskId} 缺少交付证据；不能验证` }
      }
      const applied = this.applyDiffFile(workspace, evidence.candidatePath, task.taskId, task.taskId)
      if (!applied.ok) {
        const blocking = [`任务 ${task.taskId} 的候选 diff 无法应用到验证副本：${applied.detail}`]
        const reportPath = this.recordPreflightBlock({
          reqId,
          plan,
          candidateSha256,
          planReviewSha256: reviewRecord.reportSha256,
          blocking,
        })
        return {
          state: 'failed',
          detail: `任务 ${task.taskId} 的候选 diff 无法应用到验证副本：${applied.detail}；证据 ${reportPath}；需修复后产生新候选再验证`,
        }
      }
      const diff = readFileSync(evidence.candidatePath, 'utf8')
      if (diff.trim()) diffs.push(diff)
    }
    runCommand('git', ['add', '-A'], workspace)
    runCommand('git', ['commit', '-qm', 'forgeloop: verification candidate'], workspace)
    if (this.config.worktreePrepareCommand.length > 0) {
      const prepare = runCommand(
        this.config.worktreePrepareCommand[0]!,
        this.config.worktreePrepareCommand.slice(1),
        workspace,
        this.config.formalTestTimeoutSeconds * 1000,
      )
      writeFileSync(
        join(dir, 'workspace-prepare.log'),
        `${JSON.stringify(this.config.worktreePrepareCommand)}\nexit_code: ${prepare.code}\n${prepare.stdout}\n${prepare.stderr}\n`,
        'utf8',
      )
      if (prepare.code !== 0) {
        this.repo.setStatus(
          reqId,
          'blocked',
          `验证工作副本准备命令失败（退出码 ${prepare.code}）；这是环境问题，候选未被判定失败`,
        )
        return {
          state: 'failed',
          detail: `验证工作副本准备命令失败（退出码 ${prepare.code}）；需修复依赖或环境后重新验证`,
        }
      }
      runCommand('git', ['reset', '--hard', 'HEAD'], workspace)
      runCommand('git', ['clean', '-fd'], workspace)
    }
    const workspaceSha256 = requireGit(workspace, ['rev-parse', 'HEAD^{tree}'])
    const workspaceHead = requireGit(workspace, ['rev-parse', 'HEAD'])
    const candidateDiff = diffs.join('\n')
    writeFileSync(join(dir, 'candidate.diff'), candidateDiff, 'utf8')
    writeFileSync(
      join(dir, 'candidate.json'),
      `${JSON.stringify(
        {
          reqId,
          planVersion: plan.planVersion,
          requirementVersion: plan.requirementVersion,
          candidateSha256,
          workspaceSha256,
          baselineCommit: baseline,
          snapshot,
          tasks: plan.tasks.map((task) => ({
            taskId: task.taskId,
            candidateSha256: artifacts.find((artifact) => artifact.taskId === task.taskId)?.candidateSha256 ?? '',
          })),
          at: this.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const started = Date.now()
    const run = await this.runner.run({
      role: 'verify',
      cwd: workspace,
      prompt: verificationPrompt({
        requirement,
        analysis,
        plan,
        planReview,
        candidateSha256,
        workspaceSha256,
        workspacePath: workspace,
        diff: candidateDiff,
      }),
      permission: 'workspace-write',
      timeoutMs: this.config.agent.timeoutSeconds * 1000,
      transcriptPath: join(dir, 'verify.jsonl'),
      signal,
      tools: 'default',
    })
    this.charge(reqId, started)
    if (run.status !== 'completed') {
      this.repo.setStatus(
        reqId,
        'blocked',
        `独立验证 Agent ${run.status === 'aborted' ? '被停止' : run.status === 'timeout' ? '超时' : '未完成'}：${run.reason}`,
      )
      return {
        state: run.status === 'aborted' || run.status === 'timeout' ? 'unknown' : 'failed',
        detail: `独立验证未取得可用结论：${run.reason}`,
      }
    }

    const commandsPath = join(workspace, 'verification/commands.json')
    const reportPathInWorkspace = join(workspace, 'verification/report.json')
    if (!existsSync(commandsPath) || !existsSync(reportPathInWorkspace)) {
      this.repo.setStatus(reqId, 'blocked', '独立验证未产出 verification/commands.json 与 verification/report.json')
      return { state: 'failed', detail: '独立验证未产出命令清单或逐场景报告；需重新验证' }
    }
    let commands: VerificationCommand[]
    let report: VerificationReport
    try {
      commands = parseVerificationCommands(readFileSync(commandsPath, 'utf8'))
      report = parseVerificationReport(readFileSync(reportPathInWorkspace, 'utf8'))
    } catch (error) {
      this.repo.setStatus(reqId, 'blocked', `独立验证材料畸形：${(error as Error).message}`)
      return { state: 'failed', detail: `独立验证材料畸形（fail-closed）：${(error as Error).message}` }
    }

    const changed = workspaceChanges(workspace)
    const currentHead = requireGit(workspace, ['rev-parse', 'HEAD'])
    if (currentHead !== workspaceHead) {
      this.repo.setStatus(reqId, 'blocked', '独立验证期间候选提交发生变化；需重新验证')
      return { state: 'failed', detail: '独立验证期间候选提交发生变化（fail-closed）；需重新验证' }
    }
    const outsideVerification = changed.filter((path) => !path.startsWith(VERIFICATION_MATERIAL_DIR))
    if (outsideVerification.length > 0) {
      this.repo.setStatus(
        reqId,
        'blocked',
        `独立验证修改了 verification/ 之外的文件：${outsideVerification.join('、')}`,
      )
      return {
        state: 'failed',
        detail: `独立验证越出独立验证目录（fail-closed）：${outsideVerification.join('、')}`,
      }
    }

    const commandRuns: Array<{
      label: string
      argv: readonly string[]
      exitCode: number | null
      timedOut: boolean
      aborted: boolean
      logPath: string
      logSha256: string
      durationMs: number
      output: string
    }> = []
    const failedCommands: string[] = []
    for (const [index, command] of commands.entries()) {
      const label = command.label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || `command-${index + 1}`
      const test = await this.formalTest({
        ctx: this.ctx,
        cwd: workspace,
        argv: command.argv,
        timeoutMs: this.config.formalTestTimeoutSeconds * 1000,
        logPath: join(dir, `verification-${index + 1}-${label}.log`),
        signal,
      })
      commandRuns.push({
        label: command.label,
        argv: command.argv,
        exitCode: test.exitCode,
        timedOut: test.timedOut,
        aborted: test.aborted,
        logPath: test.logPath,
        logSha256: test.logSha256,
        durationMs: test.durationMs,
        output: test.output,
      })
      if (test.aborted) {
        this.repo.setStatus(reqId, 'blocked', '独立验证命令被停止；外部副作用需核对')
        return { state: 'unknown', detail: '独立验证命令被停止：外部副作用需核对，不会盲目重放' }
      }
      if (test.timedOut) {
        failedCommands.push(`${command.label} 超时`)
      } else if (test.exitCode !== 0) {
        failedCommands.push(`${command.label} 退出码 ${test.exitCode === null ? 'null' : test.exitCode}`)
      }
    }

    // 验证命令本身也可能改坏候选：执行后重新核对 HEAD 与受保护内容。
    // 合法材料只有 verification/；Git 忽略的构建输出不属于候选。
    const integrityIssues: string[] = []
    const afterHead = requireGit(workspace, ['rev-parse', 'HEAD'])
    if (afterHead !== workspaceHead) {
      integrityIssues.push(
        `验证期间候选提交发生变化：${workspaceHead.slice(0, 12)} → ${afterHead.slice(0, 12)}`,
      )
    }
    const afterChanges = workspaceChanges(workspace)
    const outsideAfter = afterChanges.filter((path) => !path.startsWith(VERIFICATION_MATERIAL_DIR))
    if (outsideAfter.length > 0) {
      integrityIssues.push(`验证命令修改了固定候选：${outsideAfter.join('、')}`)
    }
    const candidateContentSha256 = sha256OfText(requireGit(workspace, ['diff', 'HEAD', '--binary']))
    const materials = verificationMaterials(dir)

    const coverageIssues = validateVerificationCoverage(planReview.verificationPlan, report)
    const evidenceIssues = validateScenarioEvidence(planReview.verificationPlan, report, commandRuns)
    const anyScenarioFailed = report.scenarios.some((scenario) => scenario.status === 'fail')
    const verdict: 'pass' | 'block' =
      report.verdict === 'pass' &&
      failedCommands.length === 0 &&
      coverageIssues.length === 0 &&
      evidenceIssues.length === 0 &&
      integrityIssues.length === 0 &&
      !anyScenarioFailed
        ? 'pass'
        : 'block'
    const blocking = [
      ...report.blocking,
      ...integrityIssues,
      ...evidenceIssues,
      ...(anyScenarioFailed ? ['报告存在未通过的验证场景'] : []),
      ...failedCommands.map((failure) => `验证命令失败：${failure}`),
      ...coverageIssues,
    ]
    const canonical = {
      kind: 'verification',
      reqId,
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      candidateSha256,
      workspaceSha256,
      planReviewSha256: reviewRecord.reportSha256,
      verdict,
      summary: report.summary,
      findings: report.findings,
      blocking,
      scenarios: report.scenarios,
      commands: commandRuns.map(({ output: _output, ...rest }) => rest),
      candidateIntegrity: {
        head: afterHead,
        candidateContentSha256,
        changes: afterChanges,
        allowedPaths: [VERIFICATION_MATERIAL_DIR],
        ignoredBuildOutputsExcluded: true,
      },
      materials,
      sessionId: run.sessionId,
      at: this.now(),
    }
    const reportJson = `${JSON.stringify(canonical, null, 2)}\n`
    const reportPath = join(dir, 'verification.json')
    writeFileSync(reportPath, reportJson, 'utf8')
    this.repo.recordVerification({
      requirementId: reqId,
      planVersion: plan.planVersion,
      candidateSha256,
      requirementVersion: plan.requirementVersion,
      workspaceSha256,
      verdict,
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      evidenceDir: dir,
      sessionId: run.sessionId,
      verifiedAt: this.now(),
    })

    if (verdict === 'block') {
      const roundId = `verification-${plan.planVersion}-${candidateSha256.slice(0, 12)}`
      const recorded = this.repo.recordFailureRound(reqId, {
        roundId,
        stage: FAILURE_VERIFICATION,
        summary: `独立验证阻断：${blocking.join('；') || report.summary}`.slice(0, 1000),
        occurredAt: this.now(),
      })
      const budgetLeft = this.remainingFailureRounds(reqId)
      const blockingText = blocking.join('；') || report.summary
      const rounds = this.repo.failureRounds(reqId).length
      // 任务包冻结：验证提出的问题交回研发执行角色修复，不重新规划。
      // 修复额度用尽时停在 blocked，等待追加授权或所有者决定。
      if (budgetLeft > 0) {
        const repairReason = `独立验证阻断，返回研发修复：${blockingText}`.slice(0, 900)
        const reopened = this.reopenDeliveredTasks({
          reqId,
          plan,
          identity: candidateSha256,
          reason: repairReason,
        })
        if (reopened.length > 0) {
          this.repo.setStatus(
            reqId,
            'blocked',
            `独立验证阻断（候选 ${candidateSha256.slice(0, 16)}…）：${blockingText}；已返回研发修复（失败轮次 ${rounds}，剩余 ${budgetLeft}）`,
          )
          return {
            state: 'repair',
            detail: `独立验证阻断：${blockingText}；已返回研发修复，任务包 v${plan.planVersion} 不变；证据 ${reportPath}`,
          }
        }
      }
      this.repo.setStatus(
        reqId,
        'blocked',
        `独立验证阻断（候选 ${candidateSha256.slice(0, 16)}…）：${blockingText}${
          recorded ? `；失败轮次 ${rounds}` : ''
        }${budgetLeft === 0 ? '；失败轮次额度已用尽' : ''}`,
      )
      return {
        state: 'failed',
        detail: `独立验证阻断：${blockingText}；证据 ${reportPath}`,
      }
    }

    const businessReview = await this.executeBusinessReview(reqId, signal)
    if (businessReview.state !== 'done') return businessReview
    this.repo.setStatus(reqId, EXECUTING)
    return {
      state: 'done',
      detail: `候选 ${candidateSha256.slice(0, 16)}… 已通过独立验证（${report.scenarios.length} 个场景，${commandRuns.length} 条命令）；${businessReview.detail}`,
    }
  }

  /** 业务终审报告文件与摘要是否仍一致。 */
  private businessReviewMaterialValid(record: { reportPath: string; reportSha256: string }): boolean {
    return (
      existsSync(record.reportPath) &&
      sha256OfText(readFileSync(record.reportPath, 'utf8')) === record.reportSha256
    )
  }

  /**
   * 业务终审：需求 Agent 在新会话里按原始需求复核业务场景与验收标准。
   * 证据必须来自独立验证实际执行的命令输出，不能只复述验证报告。
   */
  private async executeBusinessReview(
    reqId: string,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed' | 'unknown'; detail: string }> {
    const authorized = this.requireAuthorizedPlan(reqId)
    if (!authorized.ok) return { state: 'failed', detail: authorized.result.message }
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${reqId}` }
    const analysis = this.repo.latestAnalysis(reqId)
    if (!analysis) return { state: 'failed', detail: `需求 ${reqId} 尚无分析结论；不能做业务终审` }
    const plan = authorized.value.plan
    const artifacts = this.repo.taskArtifacts(reqId, plan.planVersion)
    const missing = plan.tasks.filter((task) => !artifacts.some((artifact) => artifact.taskId === task.taskId))
    if (missing.length > 0) {
      return {
        state: 'failed',
        detail: `仍有任务未交付，不能做业务终审：${missing.map((task) => task.taskId).join('、')}`,
      }
    }
    const verification = this.repo.verification(reqId, plan.planVersion)
    if (!verification || verification.verdict !== 'pass') {
      return { state: 'failed', detail: `独立验证未通过；不能做业务终审` }
    }
    const candidateSha256 = this.candidateIdentity(plan, artifacts)
    if (verification.candidateSha256 !== candidateSha256) {
      return { state: 'failed', detail: '独立验证绑定的候选与当前材料不一致；需重新验证后再终审' }
    }
    if (!this.verificationMaterialValid(verification)) {
      return { state: 'failed', detail: '独立验证报告文件缺失或摘要不一致；不能做业务终审' }
    }
    const existing = this.repo.businessReviewForCandidate(reqId, plan.planVersion, candidateSha256)
    if (existing) {
      if (existing.verdict === 'block') {
        return {
          state: 'failed',
          detail: `候选 ${candidateSha256.slice(0, 16)}… 的业务终审已阻断；需修复后产生新候选`,
        }
      }
      if (existing.verificationSha256 === verification.reportSha256 && this.businessReviewMaterialValid(existing)) {
        return { state: 'done', detail: '业务终审已通过；等待验收' }
      }
      return {
        state: 'failed',
        detail: '业务终审报告缺失、摘要不一致或未绑定当前独立验证；需重新终审',
      }
    }

    // 终审证据只取独立验证实际执行的命令输出；报告文件缺失或摘要不符即 fail-closed。
    const facts: Array<{ label: string; argv: readonly string[]; exitCode: number | null; logTail: string }> = []
    let canonical: Record<string, unknown> = {}
    try {
      canonical = JSON.parse(readFileSync(verification.reportPath, 'utf8')) as Record<string, unknown>
    } catch {
      return { state: 'failed', detail: '独立验证报告无法解析；不能做业务终审' }
    }
    const commands = Array.isArray(canonical.commands) ? canonical.commands : []
    for (const raw of commands) {
      if (typeof raw !== 'object' || raw === null) continue
      const command = raw as Record<string, unknown>
      const label = typeof command.label === 'string' ? command.label : ''
      const logPath = typeof command.logPath === 'string' ? command.logPath : ''
      if (!label || !logPath) continue
      if (!existsSync(logPath)) {
        return { state: 'failed', detail: `验证命令 ${label} 的日志缺失；不能做业务终审` }
      }
      const text = readFileSync(logPath, 'utf8')
      if (typeof command.logSha256 === 'string' && sha256OfText(text) !== command.logSha256) {
        return { state: 'failed', detail: `验证命令 ${label} 的日志摘要不一致；不能做业务终审` }
      }
      facts.push({
        label,
        argv: Array.isArray(command.argv) ? command.argv.map((part) => String(part)) : [],
        exitCode: typeof command.exitCode === 'number' ? command.exitCode : null,
        logTail: text.slice(-4000),
      })
    }
    if (facts.length === 0) {
      return { state: 'failed', detail: '独立验证没有可核对的命令输出；不能做业务终审' }
    }

    const dir = businessReviewDir(this.config, reqId, plan.planVersion)
    mkdirSync(dir, { recursive: true })
    const started = Date.now()
    const run = await this.runner.run({
      role: 'business-review',
      cwd: dir,
      prompt: businessReviewPrompt({
        requirement,
        analysis,
        plan,
        candidateSha256,
        commands: facts,
      }),
      permission: 'workspace-write',
      timeoutMs: this.config.agent.timeoutSeconds * 1000,
      transcriptPath: join(dir, 'business-review.jsonl'),
      signal,
      tools: 'none',
    })
    this.charge(reqId, started)
    if (run.status !== 'completed') {
      this.repo.setStatus(
        reqId,
        'blocked',
        `业务终审 Agent ${run.status === 'aborted' ? '被停止' : run.status === 'timeout' ? '超时' : '未完成'}：${run.reason}`,
      )
      return {
        state: run.status === 'aborted' || run.status === 'timeout' ? 'unknown' : 'failed',
        detail: `业务终审未取得结论：${run.reason}`,
      }
    }
    let review: BusinessReview
    try {
      review = parseBusinessReview(run.text)
    } catch (error) {
      this.repo.setStatus(reqId, 'blocked', `业务终审材料畸形：${(error as Error).message}`)
      return { state: 'failed', detail: `业务终审材料畸形（fail-closed）：${(error as Error).message}` }
    }
    const issues = validateBusinessReview({
      scenarios: analysis.scenarios,
      acceptanceCriteria: analysis.acceptanceCriteria,
      review,
      runs: facts.map((fact) => ({ label: fact.label, output: fact.logTail })),
    })
    const verdict: 'pass' | 'block' = review.verdict === 'pass' && issues.length === 0 ? 'pass' : 'block'
    const blocking = verdict === 'block' ? (issues.length > 0 ? issues : review.blocking) : []
    const report = {
      kind: 'business-review',
      reqId,
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      candidateSha256,
      verificationSha256: verification.reportSha256,
      verdict,
      summary: review.summary,
      findings: review.findings,
      blocking,
      scenarios: review.scenarios,
      acceptance: review.acceptance,
      sessionId: run.sessionId,
      at: this.now(),
    }
    const reportJson = `${JSON.stringify(report, null, 2)}\n`
    const reportPath = join(dir, 'business-review.json')
    writeFileSync(reportPath, reportJson, 'utf8')
    this.repo.recordBusinessReview({
      requirementId: reqId,
      planVersion: plan.planVersion,
      candidateSha256,
      requirementVersion: plan.requirementVersion,
      verificationSha256: verification.reportSha256,
      verdict,
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      sessionId: run.sessionId,
      reviewedAt: this.now(),
    })
    if (verdict === 'block') {
      this.repo.recordFailureRound(reqId, {
        roundId: `business-review-${plan.planVersion}-${candidateSha256.slice(0, 12)}`,
        stage: FAILURE_BUSINESS_REVIEW,
        summary: `业务终审阻断：${blocking.join('；') || review.summary}`.slice(0, 1000),
        occurredAt: this.now(),
      })
      this.repo.setStatus(
        reqId,
        'blocked',
        `业务终审阻断（候选 ${candidateSha256.slice(0, 16)}…）：${blocking.join('；') || review.summary}`,
      )
      return {
        state: 'failed',
        detail: `业务终审阻断：${blocking.join('；') || review.summary}；证据 ${reportPath}`,
      }
    }
    this.repo.setStatus(reqId, EXECUTING)
    return {
      state: 'done',
      detail: `业务终审通过（候选 ${candidateSha256.slice(0, 16)}…，${review.scenarios.length} 个业务场景）`,
    }
  }

  private verificationMaterialValid(record: VerificationRecord): boolean {
    return (
      existsSync(record.reportPath) &&
      sha256OfText(readFileSync(record.reportPath, 'utf8')) === record.reportSha256
    )
  }

  private requireAuthorizedPlan(
    reqId: string,
  ): { ok: true; value: { plan: TaskPlan } } | { ok: false; result: OperationResult } {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { ok: false, result: fail('not_found', `未找到需求 ${reqId}`) }
    const plan = this.repo.latestTaskPlan(reqId)
    if (!plan) return { ok: false, result: fail('plan_missing', `需求 ${reqId} 尚无任务包`) }
    if (plan.requirementVersion !== requirement.versions.length) {
      return {
        ok: false,
        result: fail(
          'stale_requirement',
          `任务包 v${plan.planVersion} 依据需求 v${plan.requirementVersion}，当前是 v${requirement.versions.length}；需重新规划与批准`,
        ),
      }
    }
    const approval = this.repo.planApproval(reqId, plan.planVersion)
    const authorization = authorizePlan(plan, approval)
    if (authorization.status !== 'approved') {
      return {
        ok: false,
        result: fail(
          'plan_not_approved',
          `${authorization.reason}；任务包尚未获得批准`,
        ),
      }
    }
    return { ok: true, value: { plan } }
  }

  private async executeAdvance(
    reqId: string,
    signal: AbortSignal,
    requestId: string,
  ): Promise<{ state: 'done' | 'failed' | 'unknown'; detail: string }> {
    const authorized = this.requireAuthorizedPlan(reqId)
    if (!authorized.ok) return { state: 'failed', detail: authorized.result.message }
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${reqId}` }
    const plan = authorized.value.plan
    const approval = this.repo.planApproval(reqId, plan.planVersion)!
    const authorizationSource = authorizationSourceOf(approval)
    const baseline = headCommit(this.config.projectPath)

    this.repo.ensureBudget(reqId, plan.tasks.reduce((sum, task) => sum + task.limits.limitSeconds, 0))
    const budget = new ExecutionBudget(this.repo.budget(reqId).limitSeconds, this.repo.budget(reqId).consumedSeconds)
    if (!budget.canStartAction()) {
      this.repo.setStatus(reqId, 'blocked', '执行工时已用尽；需显式延长或拆分任务')
      return { state: 'failed', detail: '执行工时已用尽；需显式延长或拆分任务' }
    }
    this.repo.setStatus(reqId, EXECUTING)

    // 任务包冻结：验证阻断时把问题交回同一任务包的执行角色修复，然后重新验证；
    // 修复额度由失败轮次控制，用尽后停在 blocked，不再自动循环。
    for (;;) {
      for (const taskId of executionOrder(plan)) {
        if (signal.aborted) return { state: 'unknown', detail: '收到停止请求：在途动作结果需核对' }
        const existing = this.repo.taskArtifact(reqId, plan.planVersion, taskId)
        if (existing) {
          if (existing.authorizationSource !== authorizationSource) {
            return {
              state: 'failed',
              detail: `任务 ${taskId} 的既有交付绑定的是 ${existing.authorizationSource || '未知授权'}，与当前批准不一致；需人工核对`,
            }
          }
          continue
        }
        const outcome = await this.deliverTask({
          requirement,
          plan,
          taskId,
          baseline,
          authorizationSource,
          signal,
          requestId,
        })
        if (outcome.state !== 'delivered') {
          this.repo.setStatus(reqId, outcome.requirementStatus, outcome.reason)
          return {
            state: outcome.state === 'awaiting_user' ? 'done' : outcome.state === 'unknown' ? 'unknown' : 'failed',
            detail: outcome.reason,
          }
        }
      }
      const artifacts = this.repo.taskArtifacts(reqId, plan.planVersion)
      const verification = await this.executeVerification(reqId, signal)
      if (verification.state === 'repair') continue
      if (verification.state !== 'done') {
        return verification.state === 'unknown'
          ? { state: 'unknown' as const, detail: verification.detail }
          : { state: 'failed' as const, detail: verification.detail }
      }
      return {
        state: 'done',
        detail: `任务包 v${plan.planVersion} 的 ${artifacts.length} 个任务已交付，${verification.detail}`,
      }
    }
  }

  private async deliverTask(input: {
    requirement: Requirement
    plan: TaskPlan
    taskId: string
    baseline: string
    authorizationSource: string
    signal: AbortSignal
    /** 推进请求身份：失败轮次 ID 带上它，跨请求重试时同一尝试序号不会互相吞掉。 */
    requestId: string
  }): Promise<{
    state: 'delivered' | 'awaiting_user' | 'failed' | 'unknown' | 'blocked'
    reason: string
    requirementStatus: string
  }> {
    const { requirement, plan, taskId, baseline, authorizationSource, signal, requestId } = input
    const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
    if (!task) return { state: 'blocked', reason: `任务包内没有任务 ${taskId}`, requirementStatus: 'blocked' }
    const taskDir = evidenceDir(this.config, requirement.reqId, plan.planVersion, taskId)
    const worktree = workspaceDir(this.config, requirement.reqId, plan.planVersion, taskId)
    mkdirSync(taskDir, { recursive: true })

    // 人工重试是新的一次 advance；把上一次失败原因和测试日志尾部重新交给实现者，
    // 不要求它从零猜测，也不因此跳过失败轮次或文件边界。
    let feedback = this.previousTaskFailure(requirement.reqId, plan.planVersion, taskId)
    let attempt = 0
    // 失败轮次 ID 绑定本次推进请求：跨请求重试时 attempt 从 1 重新开始，
    // 不能因为与上一次请求的 a1 同名而被当成重复计数。
    const roundIdFor = (attemptNumber: number): string => `${taskId}-${requestId}-a${attemptNumber}`
    const ledger = new GrantLedger(this.repo.grantCount(requirement.reqId), this.repo.failureRounds(requirement.reqId))
    while (attempt < this.config.maxTaskAttempts) {
      attempt += 1
      if (signal.aborted) {
        return { state: 'unknown', reason: '停止请求：开发副本可能已产生改动，需核对后重试', requirementStatus: 'blocked' }
      }
      const snapshot = prepareSnapshotWorkspace({
        projectPath: this.config.projectPath,
        workspacePath: worktree,
        baselineCommit: baseline,
      })
      // 上游任务已交付的改动必须先进入本任务副本；否则依赖任务会在自己的
      // 文件清单里重写上游实现，范围检查会（正确地）阻断它。
      const upstream = ancestorTaskIds(plan, taskId)
      const appliedUpstream: string[] = []
      for (const ancestor of upstream) {
        const evidence = this.repo.evidence(requirement.reqId, plan.planVersion, ancestor)
        if (!evidence) {
          return {
            state: 'blocked',
            reason: `任务 ${taskId} 依赖 ${ancestor}，但缺少其交付证据；不能继续`,
            requirementStatus: 'blocked',
          }
        }
        const applied = this.applyDiffFile(worktree, evidence.candidatePath, taskId, ancestor)
        if (!applied.ok) {
          return {
            state: 'blocked',
            reason: `应用上游任务 ${ancestor} 的候选 diff 失败：${applied.detail}`,
            requirementStatus: 'blocked',
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
      writeFileSync(
        join(taskDir, 'baseline.json'),
        `${JSON.stringify(snapshot, null, 2)}\n`,
        'utf8',
      )
      if (this.config.worktreePrepareCommand.length > 0) {
        const prepare = runCommand(
          this.config.worktreePrepareCommand[0]!,
          this.config.worktreePrepareCommand.slice(1),
          worktree,
          this.config.formalTestTimeoutSeconds * 1000,
        )
        writeFileSync(
          join(taskDir, 'workspace-prepare.log'),
          `${JSON.stringify(this.config.worktreePrepareCommand)}\nexit_code: ${prepare.code}\n${prepare.stdout}\n${prepare.stderr}\n`,
          'utf8',
        )
        if (prepare.code !== 0) {
          return {
            state: 'blocked',
            reason: `工作副本准备命令失败（退出码 ${prepare.code}）：${this.config.worktreePrepareCommand.join(' ')}`,
            requirementStatus: 'blocked',
          }
        }
        // 准备命令只允许影响被忽略的依赖目录；任何对跟踪文件的改动都还原，
        // 保证候选 diff 只包含开发回合的改动。
        runCommand('git', ['reset', '--hard', 'HEAD'], worktree)
        runCommand('git', ['clean', '-fd'], worktree)
      }

      this.recordRun(
        requirement.reqId,
        plan,
        task,
        TASK_RUN_RUNNING,
        task.verification === true ? '启动验证任务' : '启动开发 Agent',
        0,
      )
      if (task.verification === true) {
        const verificationStarted = Date.now()
        const test = await this.formalTest({
          ctx: this.ctx,
          cwd: worktree,
          argv: task.testCommand,
          timeoutMs: this.config.formalTestTimeoutSeconds * 1000,
          logPath: join(taskDir, 'formal-test.log'),
          signal,
        })
        this.charge(requirement.reqId, verificationStarted)
        if (test.aborted) {
          this.recordRun(
            requirement.reqId,
            plan,
            task,
            TASK_RUN_BLOCKED,
            '验证任务被停止：外部副作用需核对，不会盲目重放',
            0,
          )
          return {
            state: 'unknown',
            reason: '验证任务被停止：外部副作用需核对，不会盲目重放',
            requirementStatus: 'blocked',
          }
        }
        if (test.timedOut) {
          this.recordRun(
            requirement.reqId,
            plan,
            task,
            TASK_RUN_BLOCKED,
            `验证任务超时（${this.config.formalTestTimeoutSeconds} 秒）被终止；需核对`,
            0,
          )
          return {
            state: 'unknown',
            reason: `验证任务超过 ${this.config.formalTestTimeoutSeconds} 秒上限并被终止；需人工核对`,
            requirementStatus: 'blocked',
          }
        }
        if (test.exitCode !== 0) {
          const roundId = roundIdFor(attempt)
          const recorded = ledger.recordFailure({
            roundId,
            stage: FAILURE_FORMAL_TEST,
            summary: `验证任务正式测试退出码 ${test.exitCode === null ? 'null' : test.exitCode}`,
            occurredAt: this.now(),
          })
          if (recorded.recorded) {
            this.repo.recordFailureRound(requirement.reqId, {
              roundId,
              stage: FAILURE_FORMAL_TEST,
              summary: `验证任务正式测试退出码 ${test.exitCode === null ? 'null' : test.exitCode}`,
              occurredAt: this.now(),
            })
          }
          this.recordRun(
            requirement.reqId,
            plan,
            task,
            TASK_RUN_FAILED,
            `验证任务正式测试失败（退出码 ${test.exitCode}），日志 ${test.logPath}`,
            0,
          )
          if (!ledger.canRecordFailure) {
            return {
              state: 'awaiting_user',
              reason: `验证任务失败且失败轮次额度已用尽（${ledger.cumulativeFailures}/${ledger.grantCount * 3}）；等待追加授权或停止`,
              requirementStatus: 'blocked',
            }
          }
          continue
        }

        // 验证任务不产生 diff；候选摘要使用空 diff 的稳定摘要，审查材料记录
        // “仅验证、无文件改动”的结论，避免把空 diff 冒充实现。
        const emptyDiff = ''
        const candidatePath = join(taskDir, 'candidate.diff')
        writeFileSync(candidatePath, emptyDiff, 'utf8')
        const reviewPath = join(taskDir, 'review.json')
        const reviewNote = {
          kind: 'verification',
          taskId,
          verdict: 'pass',
          detail: '验证任务仅运行批准过的正式测试，不修改文件，因此没有候选 diff。',
          at: this.now(),
        }
        writeFileSync(reviewPath, `${JSON.stringify(reviewNote, null, 2)}\n`, 'utf8')
        this.repo.recordTaskArtifact({
          requirementId: requirement.reqId,
          planVersion: plan.planVersion,
          taskId,
          candidateSha256: sha256OfText(emptyDiff),
          testEvidenceSha256: test.logSha256,
          reviewSha256: sha256OfText(JSON.stringify(reviewNote)),
          acceptance: task.acceptance,
          authorizationSource,
          recordedAt: this.now(),
          baselineCommit: baseline,
        })
        this.repo.recordEvidence({
          requirementId: requirement.reqId,
          planVersion: plan.planVersion,
          taskId,
          baselineCommit: baseline,
          workspacePath: worktree,
          candidatePath,
          testLogPath: test.logPath,
          reviewPath,
          devSession: '',
          reviewSession: '',
          recordedAt: this.now(),
        })
        this.recordRun(requirement.reqId, plan, task, TASK_RUN_DELIVERED, '', 0)
        rmSync(worktree, { recursive: true, force: true })
        return { state: 'delivered', reason: '', requirementStatus: EXECUTING }
      }

      const devStarted = Date.now()
      const dev = await this.runner.run({
        role: 'dev',
        cwd: worktree,
        prompt: devPrompt({ requirement, plan, task, workdir: worktree }) + feedback,
        // 研发执行只允许在隔离工作副本内改动；默认工具仍可用，越界写入由宿主沙箱拒绝。
        permission: 'workspace-write',
        timeoutMs: this.config.agent.timeoutSeconds * 1000,
        transcriptPath: join(taskDir, 'dev.jsonl'),
        signal,
        onActivity: (events) => {
          this.repo.heartbeatTaskRun({
            requirementId: requirement.reqId,
            planVersion: plan.planVersion,
            taskId,
            reason: summarizeActivity(events),
            updatedAt: this.now(),
          })
        },
      })
      this.charge(requirement.reqId, devStarted)
      if (dev.status === 'aborted' || dev.status === 'timeout') {
        const reason = `开发回合${
          dev.status === 'aborted' ? '被停止' : `超时（${dev.reason || '未给出原因'}）`
        }：工作副本可能有未收口改动，需核对；不会盲目重放`
        // 运行记录必须收口为 blocked：否则任务会永远显示“执行中”，
        // 心跳也停在中断那一刻，看板无法区分“还在跑”和“已经中断”。
        this.recordRun(requirement.reqId, plan, task, TASK_RUN_BLOCKED, reason, 0)
        return { state: 'unknown', reason, requirementStatus: 'blocked' }
      }
      if (dev.status !== 'completed') {
        this.recordRun(requirement.reqId, plan, task, TASK_RUN_FAILED, dev.reason, 0)
        feedback = `\n\n上一次实现回合失败：${dev.reason}。请重新完成。`
        continue
      }

      // 执行角色的范围是整个工作区：计划里的 files 只是预期说明，不是硬边界。
      // 候选 diff 仍记录全部实际改动，供独立审查、验证和审计回查。
      const capture = captureCandidate({
        worktreePath: worktree,
        diffPath: join(taskDir, 'candidate.diff'),
      })
      if (capture.changedFiles.length === 0) {
        this.recordRun(requirement.reqId, plan, task, TASK_RUN_FAILED, '开发回合没有产生任何文件改动', 0)
        feedback = '\n\n上一次实现没有产生任何文件改动。请真正修改允许清单内的文件。'
        continue
      }

      // 独立审查：新会话、只读提示词、独立目录，只针对固定候选 diff。
      const reviewWorkspace = reviewDir(this.config, requirement.reqId, plan.planVersion, taskId)
      mkdirSync(reviewWorkspace, { recursive: true })
      const reviewStarted = Date.now()
      const reviewRun = await this.runner.run({
        role: 'review',
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
        timeoutMs: this.config.agent.timeoutSeconds * 1000,
        transcriptPath: join(taskDir, 'review.jsonl'),
        signal,
        tools: 'none',
      })
      this.charge(requirement.reqId, reviewStarted)
      if (reviewRun.status !== 'completed') {
        const reason = `独立审查未取得可用结论：${reviewRun.reason}`
        this.recordRun(requirement.reqId, plan, task, TASK_RUN_BLOCKED, reason, 0)
        return {
          state: reviewRun.status === 'aborted' || reviewRun.status === 'timeout' ? 'unknown' : 'blocked',
          reason,
          requirementStatus: 'blocked',
        }
      }
      let verdict
      try {
        verdict = parseReviewVerdict(reviewRun.text)
      } catch (error) {
        this.recordRun(requirement.reqId, plan, task, TASK_RUN_BLOCKED, `审查结果畸形：${(error as Error).message}`, 0)
        return {
          state: 'blocked',
          reason: `审查结果畸形（fail-closed）：${(error as Error).message}`,
          requirementStatus: 'blocked',
        }
      }
      const reviewPath = join(taskDir, 'review.json')
      writeFileSync(reviewPath, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')
      if (verdict.verdict === 'block') {
        this.recordRun(
          requirement.reqId,
          plan,
          task,
          TASK_RUN_FAILED,
          `独立审查阻断：${verdict.blocking.join('；')}`,
          0,
        )
        feedback = `\n\n上一次独立审查阻断，必须修复：\n- ${verdict.blocking.join('\n- ')}`
        continue
      }

      const testStarted = Date.now()
      const test = await this.formalTest({
        ctx: this.ctx,
        cwd: worktree,
        argv: task.testCommand,
        timeoutMs: this.config.formalTestTimeoutSeconds * 1000,
        logPath: join(taskDir, 'formal-test.log'),
        signal,
      })
      this.charge(requirement.reqId, testStarted)
      if (test.aborted) {
        return {
          state: 'unknown',
          reason: '正式测试被停止：外部副作用需核对，不会盲目重放',
          requirementStatus: 'blocked',
        }
      }
      if (test.timedOut) {
        return {
          state: 'unknown',
          reason: `正式测试超过 ${this.config.formalTestTimeoutSeconds} 秒上限并被终止；需人工核对`,
          requirementStatus: 'blocked',
        }
      }
      if (test.exitCode !== 0) {
        const recorded = ledger.recordFailure({
          roundId: roundIdFor(attempt),
          stage: FAILURE_FORMAL_TEST,
          summary: `正式测试退出码 ${test.exitCode === null ? 'null' : test.exitCode}`,
          occurredAt: this.now(),
        })
        if (recorded.recorded) {
          this.repo.recordFailureRound(requirement.reqId, {
            roundId: roundIdFor(attempt),
            stage: FAILURE_FORMAL_TEST,
            summary: `正式测试退出码 ${test.exitCode === null ? 'null' : test.exitCode}`,
            occurredAt: this.now(),
          })
        }
        this.recordRun(
          requirement.reqId,
          plan,
          task,
          TASK_RUN_FAILED,
          `正式测试失败（退出码 ${test.exitCode}），日志 ${test.logPath}`,
          0,
        )
        if (!ledger.canRecordFailure) {
          return {
            state: 'awaiting_user',
            reason: `正式测试失败且失败轮次额度已用尽（${ledger.cumulativeFailures}/${ledger.grantCount * 3}）；等待追加授权或停止`,
            requirementStatus: 'blocked',
          }
        }
        feedback = `\n\n上一次正式测试失败（退出码 ${test.exitCode}）。日志：${test.logPath}\n${test.output.slice(-4000)}`
        continue
      }

      this.repo.recordTaskArtifact({
        requirementId: requirement.reqId,
        planVersion: plan.planVersion,
        taskId,
        candidateSha256: capture.diffSha256,
        testEvidenceSha256: test.logSha256,
        reviewSha256: sha256OfText(readFileSync(reviewPath, 'utf8')),
        acceptance: task.acceptance,
        authorizationSource,
        recordedAt: this.now(),
        baselineCommit: baseline,
      })
      this.repo.recordEvidence({
        requirementId: requirement.reqId,
        planVersion: plan.planVersion,
        taskId,
        baselineCommit: baseline,
        workspacePath: worktree,
        candidatePath: capture.diffPath,
        testLogPath: test.logPath,
        reviewPath,
        devSession: dev.sessionId,
        reviewSession: reviewRun.sessionId,
        recordedAt: this.now(),
      })
      this.recordRun(requirement.reqId, plan, task, TASK_RUN_DELIVERED, '', 0)
      rmSync(worktree, { recursive: true, force: true })
      return { state: 'delivered', reason: '', requirementStatus: EXECUTING }
    }
    return {
      state: 'awaiting_user',
      reason: `任务 ${taskId} 已尝试 ${this.config.maxTaskAttempts} 次仍未通过；等待人工决定`,
      requirementStatus: 'blocked',
    }
  }

  /**
   * 上一次失败留下的可复用上下文：运行原因、最近失败轮次与正式测试日志尾部。
   * 只在任务最近一次运行确为失败/阻塞/待决定时返回；交付或运行中不产生反馈。
   */
  private previousTaskFailure(reqId: string, planVersion: number, taskId: string): string {
    const run = this.repo.taskRuns(reqId, planVersion).find((candidate) => candidate.taskId === taskId)
    if (!run || ![TASK_RUN_FAILED, TASK_RUN_BLOCKED, TASK_RUN_AWAITING_USER].includes(run.state)) {
      return ''
    }
    const parts = [`上一次任务运行（${run.state}）：${run.reason || '未记录原因'}`]
    const rounds = this.repo.failureRounds(reqId).slice(-2)
    if (rounds.length > 0) {
      parts.push(`已记录失败轮次：${rounds.map((round) => `${round.roundId} ${round.summary}`).join('；')}`)
    }
    const logPath = join(evidenceDir(this.config, reqId, planVersion, taskId), 'formal-test.log')
    if (existsSync(logPath)) {
      const tail = readFileSync(logPath, 'utf8').slice(-2000).trim()
      if (tail) parts.push(`上一次正式测试日志尾部：\n${tail}`)
    }
    return `\n\n${parts.join('\n')}\n请先针对上述失败修复，不要重复同样的失败。`
  }

  private recordRun(
    reqId: string,
    plan: TaskPlan,
    task: PlannedTask,
    state:
      | typeof TASK_RUN_RUNNING
      | typeof TASK_RUN_DELIVERED
      | typeof TASK_RUN_FAILED
      | typeof TASK_RUN_BLOCKED
      | typeof TASK_RUN_AWAITING_USER,
    reason: string,
    executedSeconds: number,
  ): void {
    this.repo.recordTaskRun({
      requirementId: reqId,
      planVersion: plan.planVersion,
      taskId: task.taskId,
      state,
      reason,
      executedSeconds,
      updatedAt: this.now(),
    })
  }

  /** 应用一个候选 diff：先 git apply，失败后用受控 fuzz；不修改证据原文。 */
  private applyDiffFile(
    dir: string,
    diffPath: string,
    label: string,
    suffix: string,
  ): { ok: boolean; detail: string } {
    const rawDiff = readFileSync(diffPath, 'utf8')
    if (rawDiff.trim() === '') return { ok: true, detail: '' }
    const normalized = rawDiff.endsWith('\n') ? rawDiff : `${rawDiff}\n`
    const applyPath = join(dir, `.apply-${suffix}-${label}.diff`)
    writeFileSync(applyPath, normalized, 'utf8')
    let applied = runCommand('git', ['apply', '--whitespace=nowarn', applyPath], dir, 120_000)
    if (applied.code !== 0) {
      applied = runCommand(
        'patch',
        ['-p1', '--forward', '--fuzz=3', '--no-backup-if-mismatch', '-i', applyPath],
        dir,
        120_000,
      )
    }
    if (applied.code === 0) rmSync(applyPath, { force: true })
    return { ok: applied.code === 0, detail: applied.stderr.trim() || applied.stdout.trim() }
  }

  private existingPackages(): string[] {
    try {
      return readdirSync(join(this.config.projectPath, 'packages'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }

  private charge(reqId: string, startedAt: number): void {
    this.repo.chargeBudget(reqId, Math.max(0, (Date.now() - startedAt) / 1000))
  }

  private mapAgentState(status: 'completed' | 'aborted' | 'timeout' | 'error'): 'failed' | 'unknown' {
    return status === 'aborted' || status === 'timeout' ? 'unknown' : 'failed'
  }

  directorySummary(): unknown {
    return {
      recordsRoot: this.config.recordsRoot,
      projectDir: projectDir(this.config),
      database: recordsPath(this.config),
      projectPath: this.config.projectPath,
      agent:
        this.runner instanceof AgentRunner
          ? this.runner.resolveSelection()
          : { provider: this.config.agent.provider, model: this.config.agent.model },
      autoAdvance: this.config.autoAdvance,
    }
  }
}

export function requestView(request: ServiceRequestRecord): Record<string, unknown> {
  return {
    requestId: request.requestId,
    reqId: request.reqId,
    action: request.action,
    state: request.state,
    planVersion: request.planVersion,
    requestedBy: request.requestedBy,
    source: request.source,
    createdAt: request.createdAt,
    detail: request.detail,
    owner: request.owner,
    claimedAt: request.claimedAt,
    attempts: request.attempts,
  }
}

export { ACCEPTED, CANCELLED, requirementContext, APPROVED }