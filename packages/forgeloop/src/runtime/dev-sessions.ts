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

  private async sessionFor(sessionId: string, workspace: string): Promise<AgentSession> {
    const existing = this.live.get(sessionId)
    if (existing) return existing
    if (!this.deps.resumeAgent) {
      throw new Error('宿主不支持恢复研发会话；不能新建同名会话冒充恢复')
    }
    const resumed = await this.deps.resumeAgent({
      role: AGENT_DEV,
      sessionId,
      permission: 'workspace-write',
      tools: 'default',
      cwd: workspace,
    })
    this.live.set(sessionId, resumed)
    return resumed
  }

  /**
   * 取得需求要使用的研发会话：已有绑定优先；否则采用主控 Agent 的选择；
   * 选不中、非法或没有会话时新建。会话忙时不占用，返回等待。
   */
  async acquire(input: {
    reqId: string
    requirementVersion: number
    selectedSessionId: string | null
    selectionReason: string
    selectedBy: string
    requestId: string
    signal: AbortSignal
  }): Promise<AcquireDevSessionResult> {
    const binding = this.deps.repo.requirementDevSession(input.reqId, input.requirementVersion)
    let selectedSessionId = binding?.sessionId ?? input.selectedSessionId
    const selectedBy = binding?.selectedBy ?? input.selectedBy
    const reason = binding?.reason ?? input.selectionReason
    if (selectedSessionId === '') selectedSessionId = null

    if (selectedSessionId) {
      const record = this.deps.repo.devSession(selectedSessionId)
      if (record) {
        return this.acquireExisting({
          ...input,
          sessionId: selectedSessionId,
          workspace: record.workspace,
          selectedBy,
          reason,
        })
      }
      if (binding) {
        return {
          ok: false,
          state: 'unavailable',
          sessionId: selectedSessionId,
          detail: `需求绑定的研发会话 ${selectedSessionId} 不存在；不能静默换会话`,
        }
      }
    }
    return this.createFresh({ ...input, selectedBy, reason })
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
