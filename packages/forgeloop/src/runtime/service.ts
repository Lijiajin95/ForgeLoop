/**
 * ForgeLoop 业务运行时：把领域规则、权威记录与 DSH Agent 执行接在一起。
 * 命令与工具都是本类的薄包装；这里不依赖任何交互界面。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { candidatesDir, evidenceDir, projectDir, recordsPath, reviewDir, sessionsDir, workspaceDir } from '../config.js'
import { Database } from '../records/db.js'
import { Repository, type ServiceRequestRecord } from '../records/repository.js'
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
  type PlannedTask,
  type TaskPlan,
} from '../domain/task-plan.js'
import { GrantLedger, FAILURE_FORMAL_TEST, MAX_ROUNDS_PER_GRANT } from '../domain/counting.js'
import { ExecutionBudget } from '../domain/limits.js'
import { sha256OfBytes, sha256OfText } from '../domain/delivery.js'
import { ACCEPTED, APPROVED, CANCELLED, EXECUTING, PLAN_PROPOSED, isTerminal } from '../domain/status.js'
import {
  TASK_RUN_AWAITING_USER,
  TASK_RUN_BLOCKED,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
} from '../domain/status.js'
import { languageViolations, outsideActiveSource, unknownPackages } from '../domain/language.js'
import { buildImpactFacts, type ImpactRequest } from '../domain/impact.js'
import {
  explainImpactFacts,
  type ImpactExplainAgent,
  type ImpactExplainAgentResponse,
} from '../domain/impact-explain.js'
import { AgentRunner } from './agent-runner.js'
import { buildStatusBoard, type StatusBoardView } from './board.js'
import { runFormalTest } from './formal-test.js'
import { analysisPrompt, devPrompt, parseReviewVerdict, planningPrompt, reviewPrompt, requirementContext } from './prompts.js'
import { captureCandidate, headCommit, prepareSnapshotWorkspace, runCommand } from './workspace.js'

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

export class ForgeLoopRuntime {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly runner: AgentLike
  private readonly formalTest: typeof runFormalTest
  private readonly ctx: Record<string, unknown>
  private readonly clock: () => Date

  constructor(options: RuntimeOptions) {
    this.ctx = options.ctx
    this.config = options.config
    this.clock = options.now ?? (() => new Date())
    this.repo = new Repository(Database.open(recordsPath(this.config)))
    this.runner = options.runner ?? new AgentRunner({ ctx: options.ctx, agent: this.config.agent })
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
        ? `已受理需求 ${requirement.reqId}（版本 1）。下一步：/fl analyze ${requirement.reqId}`
        : `同一客户端幂等键已受理为需求 ${requirement.reqId}，未重复创建`,
      this.requirementView(requirement),
    )
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
    action: 'analyze' | 'plan' | 'advance'
    by: string
    source: string
  }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${input.reqId} 已处于终态 ${requirement.status}，不能再排队`)
    }
    let planVersion = 0
    if (input.action === 'advance') {
      const authorization = this.requireAuthorizedPlan(input.reqId)
      if (!authorization.ok) return authorization.result
      planVersion = authorization.value.plan.planVersion
    } else if (input.action === 'plan' && this.repo.latestAnalysis(input.reqId) === null) {
      return fail('analysis_missing', `需求 ${input.reqId} 尚无分析结论；先运行 /fl analyze`)
    }
    try {
      const { request, created } = this.repo.recordRequest({
        requestId: `rq-${randomUUID()}`,
        reqId: input.reqId,
        project: this.config.project,
        planVersion,
        action: input.action,
        requestedBy: input.by,
        source: input.source,
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

  approvePlan(input: { reqId: string; planVersion: number; by: string; source: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) return fail('terminal', `需求已处于终态 ${requirement.status}`)
    const plan = this.repo.taskPlan(input.reqId, input.planVersion)
    if (!plan) return fail('plan_missing', `需求 ${input.reqId} 没有任务包 v${input.planVersion}`)
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
      `已批准需求 ${input.reqId} 的任务包 v${input.planVersion}（依据需求 v${plan.requirementVersion}）；下一步 /fl advance ${input.reqId}`,
      { authorizationSource: authorizationSourceOf(approval), tasks: plan.tasks.map((task) => task.taskId) },
    )
  }

  grant(input: { reqId: string; by: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    const count = this.repo.appendGrant(input.reqId, input.by, this.now())
    return ok(`已为需求 ${input.reqId} 追加第 ${count} 次失败轮次授权（累计不清零）`, { grants: count })
  }

  recover(input: { reqId: string; by: string; confirm: boolean }): OperationResult {
    const requests = this.repo.requestsFor(input.reqId).filter((request) => request.state === 'unknown')
    if (requests.length === 0) return fail('nothing_to_recover', `需求 ${input.reqId} 没有待核对的请求`)
    if (!input.confirm) {
      return fail(
        'confirm_required',
        `需求 ${input.reqId} 有 ${requests.length} 条结果未知的请求；核对工作副本与产物后使用 /fl recover ${input.reqId} confirm`,
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
    if (this.config.candidateBuildCommand.length === 0 || this.config.candidatePackageCommand.length === 0 || !this.config.candidateArtifactPath) {
      return fail('candidate_not_configured', '未配置 candidateBuildCommand / candidatePackageCommand / candidateArtifactPath')
    }
    if (input.version !== undefined && !/^\d+\.\d+\.\d+$/.test(input.version)) {
      return fail('version_invalid', `候选版本必须是 x.y.z，实际 ${JSON.stringify(input.version)}`)
    }
    const dir = candidatesDir(this.config, input.reqId, plan.planVersion)
    const baseline = headCommit(this.config.projectPath)
    prepareSnapshotWorkspace({ projectPath: this.config.projectPath, workspacePath: dir, baselineCommit: baseline })
    if (input.version !== undefined) {
      const packageJsonPath = join(dir, 'packages/forgeloop/package.json')
      if (!existsSync(packageJsonPath)) {
        return fail('package_missing', `候选副本缺少插件包清单 ${packageJsonPath}`)
      }
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
      packageJson.version = input.version
      writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
    }
    for (const taskId of executionOrder(plan)) {
      const evidence = this.repo.evidence(input.reqId, plan.planVersion, taskId)
      if (!evidence) return fail('evidence_missing', `任务 ${taskId} 缺少证据路径`)
      // 历史候选 diff 可能缺尾部换行；为 patch 归一化到临时文件，不改动证据原文。
      const applied = this.applyDiffFile(dir, evidence.candidatePath, taskId, taskId)
      if (!applied.ok) {
        return fail('patch_failed', `任务 ${taskId} 的候选 diff 无法应用到候选副本：${applied.detail}`)
      }
    }
    const log: string[] = []
    for (const [label, command, timeout] of [
      ['prepare', this.config.worktreePrepareCommand, this.config.formalTestTimeoutSeconds * 1000],
      ['build', this.config.candidateBuildCommand, this.config.formalTestTimeoutSeconds * 1000],
      ['package', this.config.candidatePackageCommand, this.config.formalTestTimeoutSeconds * 1000],
    ] as const) {
      if (command.length === 0) continue
      const result = runCommand(command[0]!, command.slice(1), dir, timeout)
      log.push(
        `=== ${label} (exit ${result.code})\n$ ${command.join(' ')}\n${result.stdout}\n${result.stderr}`,
      )
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
    }
    if (!artifact.sha256 || !artifact.tarball) {
      return fail('artifact_malformed', `产物清单缺少 sha256/tarball：${artifactPath}`)
    }
    const candidateSha = sha256OfBytes(readFileSync(artifact.tarball))
    if (candidateSha !== artifact.sha256) {
      return fail('artifact_mismatch', `产物摘要与清单不一致：清单 ${artifact.sha256}，实际 ${candidateSha}`)
    }
    this.repo.recordCandidate({
      reqId: input.reqId,
      planVersion: plan.planVersion,
      sha256: candidateSha,
      tarball: artifact.tarball,
      files: artifact.files ?? [],
      gitHead: artifact.gitHead ?? baseline,
      builtAt: artifact.builtAt ?? this.now(),
      evidenceDir: dir,
    })
    return ok(`已构建候选包 ${artifact.tarball}（sha256 ${candidateSha.slice(0, 16)}…）`, {
      sha256: candidateSha,
      tarball: artifact.tarball,
      files: artifact.files ?? [],
      evidenceDir: dir,
    })
  }

  accept(input: { reqId: string; by: string; source: string; artifactSha256?: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
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
      binding = this.buildAcceptanceBinding(input.reqId, latestPlan, artifacts, input.artifactSha256)
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
    reqId: string,
    plan: TaskPlan,
    artifacts: ReturnType<Repository['taskArtifacts']>,
    artifactSha256?: string,
  ) {
    const ordered = plan.tasks.map((task) => {
      const artifact = artifacts.find((candidate) => candidate.taskId === task.taskId)
      if (!artifact) throw new RuleViolationError(`任务 ${task.taskId} 缺少交付产物`)
      return artifact
    })
    return {
      candidateSha256: sha256OfText(ordered.map((artifact) => artifact.candidateSha256).join(':')),
      testEvidenceSha256: sha256OfText(ordered.map((artifact) => artifact.testEvidenceSha256).join(':')),
      reviewSha256: sha256OfText(ordered.map((artifact) => artifact.reviewSha256).join(':')),
      artifactSha256: artifactSha256 ?? '',
      baselineCommit: ordered[0]?.baselineCommit ?? '',
    }
  }

  // ------------------------------------------------------------ 查询

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
      delivered: artifacts.map((artifact) => artifact.taskId),
      runs: runs.map((run) => ({ taskId: run.taskId, state: run.state, reason: run.reason })),
      failureRounds: recordedFailures.length,
      grants,
      failureRoundDetails: recordedFailures.map((round) => ({
        roundId: round.roundId,
        stage: round.stage,
        summary: round.summary,
        occurredAt: round.occurredAt,
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
   */
  statusBoard(limit?: number): StatusBoardView {
    return buildStatusBoard({ repository: this.repo, project: this.config.project, limit })
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
      return this.executePlanning(request.reqId, signal)
    }
    return this.executeAdvance(request.reqId, signal)
  }

  private async executeAnalysis(
    reqId: string,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed' | 'unknown'; detail: string }> {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${reqId}` }
    const started = Date.now()
    const transcript = join(sessionsDir(this.config), `${reqId}-analyze.jsonl`)
    const result = await this.runner.run({
      role: 'analyze',
      cwd: this.config.projectPath,
      prompt: analysisPrompt(requirement),
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
          : `分析 v${analysis.analysisVersion} 完成；下一步 /fl plan ${reqId}`,
    }
  }

  private async executePlanning(
    reqId: string,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed' | 'unknown'; detail: string }> {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${reqId}` }
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
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const transcript = join(sessionsDir(this.config), `${reqId}-plan-a${attempt}.jsonl`)
      const started = Date.now()
      const result = await this.runner.run({
        role: 'plan',
        cwd: this.config.projectPath,
        prompt: planningPrompt(requirement, analysis.goal) + feedback,
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
      this.repo.setStatus(reqId, PLAN_PROPOSED)
      return {
        state: 'done',
        detail: `已生成任务包 v${plan.planVersion}（${plan.tasks.length} 个任务）；审阅后 /fl approve ${reqId} ${plan.planVersion}`,
      }
    }
    this.repo.setStatus(reqId, 'blocked', lastError)
    return { state: 'failed', detail: lastError }
  }

  private requireAuthorizedPlan(
    reqId: string,
  ): { ok: true; value: { plan: TaskPlan } } | { ok: false; result: OperationResult } {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { ok: false, result: fail('not_found', `未找到需求 ${reqId}`) }
    const plan = this.repo.latestTaskPlan(reqId)
    if (!plan) return { ok: false, result: fail('plan_missing', `需求 ${reqId} 尚无任务包；先 /fl plan`) }
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
          `${authorization.reason}；先 /fl approve ${reqId} ${plan.planVersion}`,
        ),
      }
    }
    return { ok: true, value: { plan } }
  }

  private async executeAdvance(
    reqId: string,
    signal: AbortSignal,
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
    return {
      state: 'done',
      detail: `任务包 v${plan.planVersion} 的 ${artifacts.length} 个任务已交付；等待整体验收：/fl accept ${reqId}`,
    }
  }

  private async deliverTask(input: {
    requirement: Requirement
    plan: TaskPlan
    taskId: string
    baseline: string
    authorizationSource: string
    signal: AbortSignal
  }): Promise<{
    state: 'delivered' | 'awaiting_user' | 'failed' | 'unknown' | 'blocked'
    reason: string
    requirementStatus: string
  }> {
    const { requirement, plan, taskId, baseline, authorizationSource, signal } = input
    const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
    if (!task) return { state: 'blocked', reason: `任务包内没有任务 ${taskId}`, requirementStatus: 'blocked' }
    const taskDir = evidenceDir(this.config, requirement.reqId, plan.planVersion, taskId)
    const worktree = workspaceDir(this.config, requirement.reqId, plan.planVersion, taskId)
    mkdirSync(taskDir, { recursive: true })

    let feedback = ''
    let attempt = 0
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

      const devStarted = Date.now()
      const dev = await this.runner.run({
        role: 'dev',
        cwd: worktree,
        prompt: devPrompt({ requirement, plan, task, workdir: worktree }) + feedback,
        permission: 'danger-full-access',
        timeoutMs: this.config.agent.timeoutSeconds * 1000,
        transcriptPath: join(taskDir, 'dev.jsonl'),
        signal,
      })
      this.charge(requirement.reqId, devStarted)
      if (dev.status === 'aborted' || dev.status === 'timeout') {
        return {
          state: 'unknown',
          reason: `开发回合${dev.status === 'aborted' ? '被停止' : '超时'}：工作副本可能有未收口改动，需核对；不会盲目重放`,
          requirementStatus: 'blocked',
        }
      }
      if (dev.status !== 'completed') {
        this.recordRun(requirement.reqId, plan, task, TASK_RUN_FAILED, dev.reason, 0)
        feedback = `\n\n上一次实现回合失败：${dev.reason}。请重新完成。`
        continue
      }

      const capture = captureCandidate({
        worktreePath: worktree,
        allowedFiles: task.files,
        diffPath: join(taskDir, 'candidate.diff'),
      })
      if (capture.violations.length > 0) {
        this.recordRun(
          requirement.reqId,
          plan,
          task,
          TASK_RUN_BLOCKED,
          `改动越出批准文件清单：${capture.violations.join('、')}`,
          0,
        )
        return {
          state: 'blocked',
          reason: `任务 ${taskId} 的改动越出批准文件清单：${capture.violations.join('、')}；需人工决定`,
          requirementStatus: 'blocked',
        }
      }
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
        return {
          state: reviewRun.status === 'aborted' || reviewRun.status === 'timeout' ? 'unknown' : 'blocked',
          reason: `独立审查未取得可用结论：${reviewRun.reason}`,
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
          roundId: `${taskId}-a${attempt}`,
          stage: FAILURE_FORMAL_TEST,
          summary: `正式测试退出码 ${test.exitCode === null ? 'null' : test.exitCode}`,
          occurredAt: this.now(),
        })
        if (recorded.recorded) {
          this.repo.recordFailureRound(requirement.reqId, {
            roundId: `${taskId}-a${attempt}`,
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
            reason: `正式测试失败且失败轮次额度已用尽（${ledger.cumulativeFailures}/${ledger.grantCount * 3}）；等待 /fl grant ${requirement.reqId} 或停止`,
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

  private recordRun(
    reqId: string,
    plan: TaskPlan,
    task: PlannedTask,
    state: typeof TASK_RUN_DELIVERED | typeof TASK_RUN_FAILED | typeof TASK_RUN_BLOCKED | typeof TASK_RUN_AWAITING_USER,
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