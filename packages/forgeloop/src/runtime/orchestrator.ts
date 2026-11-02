/**
 * 主控 Agent：把新需求路由到最合适的既有研发会话。
 *
 * 主控只读需求、分析与会话摘要，输出一个会话 ID；程序校验该 ID 是否存在，
 * 选不中、非法或模型不可用时返回 null，由程序新建会话。路由结果不是批准，
 * 也不改变需求范围。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ForgeLoopConfig } from '../config.js'
import { sessionsDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import { parseJsonLoose } from '../domain/requirement.js'
import { asRecord } from '../domain/json.js'
import { AGENT_ORCHESTRATOR } from '../domain/agents.js'
import type { Repository } from '../records/repository.js'
import type { AgentRunRequest, AgentRunResult } from './agent-runner.js'
import { orchestratorPrompt, type DevSessionCandidate } from './prompts.js'

export interface OrchestratorDeps {
  config: ForgeLoopConfig
  repo: Repository
  run: (request: AgentRunRequest) => Promise<AgentRunResult>
}

export interface OrchestratorChoice {
  readonly sessionId: string | null
  readonly reason: string
  readonly source: 'model' | 'fallback'
}

export class SessionOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private candidates(): DevSessionCandidate[] {
    const candidates: DevSessionCandidate[] = []
    for (const session of this.deps.repo.devSessions(this.deps.config.project)) {
      if (!existsSync(join(session.workspace, '.git'))) continue
      const summary = this.deps.repo.latestDevSessionSummary(session.sessionId)
      candidates.push({
        sessionId: session.sessionId,
        workspace: session.workspace,
        state: session.state,
        lastReqId: session.lastReqId,
        updatedAt: session.updatedAt,
        summary: summary?.summary ?? session.summary,
      })
    }
    return candidates
  }

  async choose(input: {
    requirement: Requirement
    analysis: RequirementAnalysis
    signal: AbortSignal
  }): Promise<OrchestratorChoice> {
    const candidates = this.candidates()
    if (candidates.length === 0) {
      return { sessionId: null, reason: '没有可复用的研发会话', source: 'fallback' }
    }
    if (input.signal.aborted) {
      return { sessionId: null, reason: '停止请求：未进行会话路由', source: 'fallback' }
    }
    let result: AgentRunResult
    try {
      result = await this.deps.run({
        role: AGENT_ORCHESTRATOR,
        cwd: this.deps.config.projectPath,
        prompt: orchestratorPrompt({
          requirement: input.requirement,
          analysis: input.analysis,
          sessions: candidates,
        }),
        permission: 'workspace-write',
        timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
        transcriptPath: join(
          sessionsDir(this.deps.config),
          `${input.requirement.reqId}-orchestrator-${randomUUID().slice(0, 8)}.jsonl`,
        ),
        signal: input.signal,
        tools: 'none',
      })
    } catch (error) {
      return {
        sessionId: null,
        reason: `主控 Agent 无法路由（${error instanceof Error ? error.message : String(error)}）；新建研发会话`,
        source: 'fallback',
      }
    }
    if (result.status !== 'completed') {
      return {
        sessionId: null,
        reason: `主控 Agent 未取得可用路由（${result.reason || result.status}）；新建研发会话`,
        source: 'fallback',
      }
    }
    return this.interpret(result.text, candidates)
  }

  /** 解析并校验主控输出：只接受候选清单里的会话 ID。 */
  private interpret(text: string, candidates: readonly DevSessionCandidate[]): OrchestratorChoice {
    let data: Record<string, unknown>
    try {
      data = asRecord(parseJsonLoose(text, '主控路由结果')) ?? {}
    } catch {
      return {
        sessionId: null,
        reason: '主控路由结果畸形；新建研发会话',
        source: 'fallback',
      }
    }
    const raw = data.session_id
    const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 500) : ''
    if (typeof raw !== 'string' || raw.trim() === '') {
      return {
        sessionId: null,
        reason: reason || '主控 Agent 判断没有合适会话；新建研发会话',
        source: 'model',
      }
    }
    const selected = raw.trim()
    const match = candidates.find((candidate) => candidate.sessionId === selected)
    if (!match) {
      return {
        sessionId: null,
        reason: `主控 Agent 选择了不存在的会话 ${selected.slice(0, 80)}；新建研发会话`,
        source: 'fallback',
      }
    }
    return {
      sessionId: match.sessionId,
      reason: reason || '主控 Agent 选择复用该研发会话',
      source: 'model',
    }
  }
}
