/**
 * 研发会话注册表：一个需求绑定一个研发会话与一份固定工作区。
 *
 * - 会话不随需求结束销毁：只把忙闲置回 idle，并写入“会话 + 需求”总结。
 * - 本进程内保存 live handle，跨请求复用同一段上下文；宿主重启后从持久会话恢复。
 * - 会话被占用时需求进入等待，不新建并行会话，也不覆盖别人的现场。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { devSessionDir, devSessionWorkspaceDir } from '../config.js'
import type { Requirement } from '../domain/requirement.js'
import type { TaskPlan } from '../domain/task-plan.js'
import { AGENT_DEV } from '../domain/agents.js'
import { sha256OfText } from '../domain/delivery.js'
import { errorMessage } from '../domain/errors.js'
import type { Repository } from '../records/repository.js'
import type { RequirementDevSessionRecord } from '../records/rows.js'
import type { AgentOpenRequest, AgentResumeRequest, AgentSession } from './agent-runner.js'
import type { ExecutionDev } from './execution-dev.js'
import { devSessionSummaryPrompt } from './prompts.js'

export interface DevSessionsDeps {
  config: ForgeLoopConfig
  repo: Repository
  now: () => string
  openAgent: (request: AgentOpenRequest) => Promise<AgentSession>
  /** 宿主不支持恢复时省略；省略时不会把旧会话伪装成新会话。 */
  resumeAgent?: ((request: AgentResumeRequest) => Promise<AgentSession>) | undefined
  executionDev: ExecutionDev
}

export type AcquireDevSessionResult =
  | {
      ok: true
      session: AgentSession
      sessionId: string
      workspace: string
      baselineCommit: string
      snapshotCommit: string
      selectedBy: string
      reason: string
      fresh: boolean
    }
  | {
      ok: false
      state: 'busy' | 'unavailable'
      sessionId: string
      detail: string
    }

export interface AcquireRequest {
  readonly reqId: string
  readonly requirementVersion: number
  readonly selectedSessionId: string | null
  readonly selectionReason: string
  readonly selectedBy: string
  readonly requestId: string
  readonly signal: AbortSignal
  /** 选中会话确认不可用时改派新会话（更新绑定）；仅在调用方明确要求恢复时开启。 */
  readonly allowRebind?: boolean
}

export interface FinishDevSessionResult {
  readonly summary: string
  readonly summaryPath: string
  readonly summarySha256: string
  readonly source: 'agent' | 'fallback'
}

export class DevSessionRegistry {
  private readonly live = new Map<string, AgentSession>()

  constructor(private readonly deps: DevSessionsDeps) {}

  /** 当前进程里仍存活的研发会话；宿主重启后为空。 */
  liveSession(sessionId: string): AgentSession | undefined {
    return this.live.get(sessionId)
  }

  /**
   * 取本进程内的会话句柄；宿主重启后从持久会话恢复。
   * 恢复失败（宿主不支持、超时、会话已不存在、句柄不可用）一律显式报错，
   * 不新建同名会话冒充恢复：调用方据此把需求改派到新会话，旧会话与工作区保留。
   */
  private async sessionFor(sessionId: string, workspace: string): Promise<AgentSession> {
    const existing = this.live.get(sessionId)
    if (existing) return existing
    if (!this.deps.resumeAgent) {
      throw new Error('宿主不支持恢复研发会话（agents.resume）；不能新建同名会话冒充恢复')
    }
    let resumed: AgentSession | undefined
    try {
      resumed = await this.deps.resumeAgent({
        role: AGENT_DEV,
        sessionId,
        permission: 'workspace-write',
        tools: 'default',
        cwd: workspace,
      })
    } catch (error) {
      throw new Error(
        `研发会话 ${sessionId} 无法从宿主恢复：${errorMessage(error)}；记录与工作区保留，不冒充恢复`,
        { cause: error },
      )
    }
    this.live.set(sessionId, resumed)
    return resumed
  }

  /**
   * 取得需求要使用的研发会话：已有绑定优先；否则采用主控 Agent 的选择；
   * 选不中、非法或没有会话时新建。会话忙时不占用，返回等待。
   */
  async acquire(input: AcquireRequest): Promise<AcquireDevSessionResult> {
    const binding = this.deps.repo.requirementDevSession(input.reqId, input.requirementVersion)
    const selectedSessionId = (binding?.sessionId ?? input.selectedSessionId) || null
    const selectedBy = binding?.selectedBy ?? input.selectedBy
    const reason = binding?.reason ?? input.selectionReason
    if (!selectedSessionId) return this.createFresh({ ...input, selectedBy, reason })
    return this.acquireSelected({
      ...input,
      binding,
      sessionId: selectedSessionId,
      selectedBy,
      reason,
    })
  }

  /** 已有会话（绑定或主控选中）：占用、重建或改派；忙则原样交给调用方等待。 */
  private async acquireSelected(
    input: AcquireRequest & {
      binding: RequirementDevSessionRecord | null
      sessionId: string
      selectedBy: string
      reason: string
    },
  ): Promise<AcquireDevSessionResult> {
    const record = this.deps.repo.devSession(input.sessionId)
    const recover = input.allowRebind === true
    if (!record) {
      if (input.binding && !recover) {
        return {
          ok: false,
          state: 'unavailable',
          sessionId: input.sessionId,
          detail: `需求绑定的研发会话 ${input.sessionId} 不存在；不能静默换会话`,
        }
      }
      if (input.binding) return this.rebindAfterFailure(input, '会话记录缺失')
      return this.createFresh({ ...input, selectedBy: input.selectedBy, reason: input.reason })
    }
    const acquired = await this.acquireExisting({
      ...input,
      workspace: record.workspace,
      reason: input.reason,
    })
    if (acquired.ok || acquired.state === 'busy' || !recover) return acquired
    return this.rebindAfterFailure(input, acquired.detail)
  }

  /** 原会话不可用时改派新会话；旧会话记录与工作区不删除，只更新需求绑定。 */
  private async rebindAfterFailure(
    input: { reqId: string; requirementVersion: number; requestId: string; signal: AbortSignal },
    detail: string,
  ): Promise<AcquireDevSessionResult> {
    const reason = `原研发会话不可用（${clipDetail(detail)}），改派新会话`
    return this.createFresh({
      ...input,
      selectedBy: 'recovery',
      reason: reason.length > 500 ? reason.slice(0, 500) : reason,
    })
  }

  private async acquireExisting(input: {
    reqId: string
    requirementVersion: number
    selectedBy: string
    requestId: string
    signal: AbortSignal
    sessionId: string
    workspace: string
    reason: string
  }): Promise<AcquireDevSessionResult> {
    const now = this.deps.now()
    if (!this.deps.repo.leaseDevSession(input.sessionId, input.requestId, now)) {
      return {
        ok: false,
        state: 'busy',
        sessionId: input.sessionId,
        detail: `研发会话 ${input.sessionId} 正忙；需求进入队列等待会话空闲`,
      }
    }
    try {
      const binding = this.deps.repo.requirementDevSession(input.reqId, input.requirementVersion)
      const status = this.deps.executionDev.workspaceStatus(input.workspace)
      let baselineCommit = binding?.baselineCommit ?? ''
      let snapshotCommit = binding?.snapshotCommit ?? ''
      let fresh = false
      if (baselineCommit === '' || snapshotCommit === '' || !status.exists) {
        if (status.exists && !status.clean) {
          throw new Error(
            `研发会话 ${input.sessionId} 的工作区有未提交改动，不能按新需求基线刷新；保留现场等待人工处理`,
          )
        }
        const prepared = this.deps.executionDev.prepareDevWorkspace(input.workspace)
        baselineCommit = prepared.baselineCommit
        snapshotCommit = prepared.snapshotCommit
        fresh = true
      }
      const bound = this.deps.repo.bindRequirementDevSession({
        reqId: input.reqId,
        requirementVersion: input.requirementVersion,
        sessionId: input.sessionId,
        workspace: input.workspace,
        baselineCommit,
        snapshotCommit,
        selectedBy: input.selectedBy,
        reason: input.reason,
        now,
      })
      const session = await this.sessionFor(input.sessionId, input.workspace)
      return {
        ok: true,
        session,
        sessionId: input.sessionId,
        workspace: bound.workspace,
        baselineCommit: bound.baselineCommit,
        snapshotCommit: bound.snapshotCommit,
        selectedBy: bound.selectedBy,
        reason: bound.reason,
        fresh,
      }
    } catch (error) {
      this.deps.repo.releaseDevSession(input.sessionId, this.deps.now())
      return {
        ok: false,
        state: 'unavailable',
        sessionId: input.sessionId,
        detail: errorMessage(error),
      }
    }
  }

  private async createFresh(input: {
    reqId: string
    requirementVersion: number
    selectedBy: string
    reason: string
    requestId: string
    signal: AbortSignal
  }): Promise<AcquireDevSessionResult> {
    const sessionId = `session-fl-dev-${randomUUID()}`
    const workspace = devSessionWorkspaceDir(this.deps.config, sessionId)
    try {
      const prepared = this.deps.executionDev.prepareDevWorkspace(workspace)
      this.deps.repo.upsertDevSession({
        sessionId,
        project: this.deps.config.project,
        workspace,
        now: this.deps.now(),
      })
      if (!this.deps.repo.leaseDevSession(sessionId, input.requestId, this.deps.now())) {
        throw new Error(`新建研发会话 ${sessionId} 后无法占用`)
      }
      this.deps.repo.bindRequirementDevSession({
        reqId: input.reqId,
        requirementVersion: input.requirementVersion,
        sessionId,
        workspace,
        baselineCommit: prepared.baselineCommit,
        snapshotCommit: prepared.snapshotCommit,
        selectedBy: input.selectedBy,
        reason: input.reason,
        now: this.deps.now(),
      })
      const session = await this.deps.openAgent({
        role: AGENT_DEV,
        cwd: workspace,
        permission: 'workspace-write',
        tools: 'default',
        sessionId,
        reqId: input.reqId,
      })
      this.live.set(sessionId, session)
      return {
        ok: true,
        session,
        sessionId,
        workspace,
        baselineCommit: prepared.baselineCommit,
        snapshotCommit: prepared.snapshotCommit,
        selectedBy: input.selectedBy,
        reason: input.reason,
        fresh: true,
      }
    } catch (error) {
      this.deps.repo.releaseDevSession(sessionId, this.deps.now())
      return {
        ok: false,
        state: 'unavailable',
        sessionId,
        detail: errorMessage(error),
      }
    }
  }

  /**
   * 需求结束时写“当前会话内容 + 需求内容”总结并释放会话。
   * 总结回合失败时用需求与任务包生成确定性摘要，不把总结失败伪装成研发失败。
   */
  async finish(input: {
    reqId: string
    requirementVersion: number
    sessionId: string
    session: AgentSession
    requirement: Requirement
    plan: TaskPlan | null
    outcome: string
  }): Promise<FinishDevSessionResult> {
    const dir = devSessionDir(this.deps.config, input.sessionId)
    mkdirSync(dir, { recursive: true })
    const transcriptPath = join(dir, `${input.reqId}-summary.jsonl`)
    let summary = ''
    let source: FinishDevSessionResult['source'] = 'agent'
    try {
      const result = await input.session.send({
        prompt: devSessionSummaryPrompt({
          requirement: input.requirement,
          plan: input.plan,
          outcome: input.outcome,
        }),
        timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
        transcriptPath,
      })
      if (result.status === 'completed' && result.text.trim()) {
        summary = result.text.trim().slice(0, 8_000)
      }
    } catch {
      // 落到程序化摘要；会话取消/超时不能让需求状态卡在 busy。
    }
    if (!summary) {
      source = 'fallback'
      summary = fallbackSummary(input.requirement, input.plan, input.outcome)
    }
    const summaryPath = join(dir, `${input.reqId}.md`)
    writeFileSync(summaryPath, `${summary}\n`, 'utf8')
    const summarySha256 = sha256OfText(summary)
    const now = this.deps.now()
    this.deps.repo.recordDevSessionSummary({
      sessionId: input.sessionId,
      reqId: input.reqId,
      summary,
      summarySha256,
      summaryPath,
      now,
    })
    this.deps.repo.updateDevSession(input.sessionId, {
      summary,
      summarySha256,
      summaryPath,
      lastReqId: input.reqId,
      state: 'idle',
      leaseRequestId: '',
      updatedAt: now,
    })
    this.deps.repo.releaseRequirementDevSession(input.reqId, input.requirementVersion, now)
    return { summary, summaryPath, summarySha256, source }
  }

  /** 需求被放弃/崩溃后只释放占用，不写总结；会话与工作区仍保留。 */
  release(input: { sessionId: string }): void {
    this.deps.repo.releaseDevSession(input.sessionId, this.deps.now())
  }
}

/** 不可用原因进入绑定说明时压成一行，避免把多行报错塞进记录。 */
function clipDetail(detail: string): string {
  const flattened = detail.trim().replace(/\s+/g, ' ')
  return flattened.length > 200 ? `${flattened.slice(0, 200)}…` : flattened
}

function fallbackSummary(requirement: Requirement, plan: TaskPlan | null, outcome: string): string {
  const latest = requirement.versions[requirement.versions.length - 1]
  const title = (latest?.text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
    ?.slice(0, 120)
  const tasks =
    plan === null
      ? '本次未形成任务包。'
      : `任务包 v${plan.planVersion}：${plan.tasks.map((task) => task.taskId).join('、') || '无任务'}。`
  return [
    `需求 ${requirement.reqId}：${title || '（无标题）'}`,
    `需求原文：${(latest?.text ?? '').slice(0, 500)}`,
    tasks,
    `本次结局：${outcome}`,
    '会话总结由程序在模型总结不可用时生成；现场与证据目录仍可回查。',
  ].join('\n')
}
