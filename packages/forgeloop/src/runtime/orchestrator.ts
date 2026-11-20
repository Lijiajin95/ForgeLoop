import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ForgeLoopConfig } from '../config.js'
import { sessionsDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import { parseJsonLoose } from '../domain/requirement.js'
import { asRecord } from '../domain/json.js'
import { errorMessage } from '../domain/errors.js'
import { AGENT_ORCHESTRATOR } from '../domain/agents.js'
import type { Repository } from '../records/repository.js'
import type { AgentRunRequest, AgentRunResult } from './agent-runner.js'
import { orchestratorPrompt, type DevSessionCandidate } from './prompts.js'

const MAX_CANDIDATES = 20

const MAX_SUMMARY_CHARS = 400

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

export interface OrchestratorDeps {
  config: ForgeLoopConfig
  repo: Repository
  run: (request: AgentRunRequest) => Promise<AgentRunResult>
}

export interface OrchestratorChoice {
  readonly sessionId: string | null
  readonly reason: string
  readonly source: 'model' | 'fallback'
  readonly alternatives: readonly string[]
}

export class SessionOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private candidates(): DevSessionCandidate[] {
    const candidates: DevSessionCandidate[] = []
    for (const session of this.deps.repo.devSessions(this.deps.config.project)) {
      if (candidates.length >= MAX_CANDIDATES) break
      if (!existsSync(join(session.workspace, '.git'))) continue
      const summary = this.deps.repo.latestDevSessionSummary(session.sessionId)
      candidates.push({
        sessionId: session.sessionId,
        workspace: session.workspace,
        state: session.state,
        lastReqId: session.lastReqId,
        updatedAt: session.updatedAt,
        summary: clip(summary?.summary ?? session.summary, MAX_SUMMARY_CHARS),
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
      return {
        sessionId: null,
        reason: '没有可复用的研发会话',
        source: 'fallback',
        alternatives: [],
      }
    }
    if (isAborted(input.signal)) {
      return {
        sessionId: null,
        reason: '停止请求：未进行会话路由',
        source: 'fallback',
        alternatives: [],
      }
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
        reason: `主控 Agent 无法路由（${errorMessage(error)}）；新建研发会话`,
        source: 'fallback',
        alternatives: [],
      }
    }
    if (isAborted(input.signal)) {
      return {
        sessionId: null,
        reason: '停止请求：未采用主控路由结果',
        source: 'fallback',
        alternatives: [],
      }
    }
    if (result.status !== 'completed') {
      return {
        sessionId: null,
        reason: `主控 Agent 未取得可用路由（${result.reason || result.status}）；新建研发会话`,
        source: 'fallback',
        alternatives: [],
      }
    }
    return this.interpret(result.text, candidates)
  }

  private interpret(text: string, candidates: readonly DevSessionCandidate[]): OrchestratorChoice {
    let data: Record<string, unknown>
    try {
      data = asRecord(parseJsonLoose(text, '主控路由结果')) ?? {}
    } catch {
      return {
        sessionId: null,
        reason: '主控路由结果畸形；新建研发会话',
        source: 'fallback',
        alternatives: [],
      }
    }
    const raw = data.session_id
    const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 500) : ''
    if (typeof raw !== 'string' || raw.trim() === '') {
      return {
        sessionId: null,
        reason: reason || '主控 Agent 判断没有合适会话；新建研发会话',
        source: 'model',
        alternatives: [],
      }
    }
    const selected = raw.trim()
    const match = candidates.find((candidate) => candidate.sessionId === selected)
    if (!match) {
      return {
        sessionId: null,
        reason: `主控 Agent 选择了不存在的会话 ${selected.slice(0, 80)}；新建研发会话`,
        source: 'fallback',
        alternatives: [],
      }
    }
    return {
      sessionId: match.sessionId,
      reason: reason || '主控 Agent 选择复用该研发会话',
      source: 'model',
      alternatives: candidates
        .map((candidate) => candidate.sessionId)
        .filter((sessionId) => sessionId !== match.sessionId),
    }
  }
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}
