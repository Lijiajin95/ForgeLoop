/**
 * 研发会话路由的组合入口：把主控 Agent 与研发会话注册表接到运行时，
 * 并提供“该需求绑定的会话是否空闲”的查询。业务运行时只持有这一个依赖。
 */

import type { ForgeLoopConfig } from '../config.js'
import type { Repository } from '../records/repository.js'
import type {
  AgentOpenRequest,
  AgentResumeRequest,
  AgentRunRequest,
  AgentRunResult,
  AgentSession,
} from './agent-runner.js'
import { DevSessionRegistry } from './dev-sessions.js'
import type { ExecutionDev } from './execution-dev.js'
import { SessionOrchestrator } from './orchestrator.js'

export interface SessionRoutingDeps {
  config: ForgeLoopConfig
  repo: Repository
  now: () => string
  runner: {
    run(request: AgentRunRequest): Promise<AgentRunResult>
    resume?(request: AgentResumeRequest): Promise<AgentSession>
  }
  openAgent: (request: AgentOpenRequest) => Promise<AgentSession>
  executionDev: ExecutionDev
}

export class SessionRouting {
  readonly devSessions: DevSessionRegistry
  readonly orchestrator: SessionOrchestrator

  constructor(private readonly deps: SessionRoutingDeps) {
    this.devSessions = new DevSessionRegistry({
      config: deps.config,
      repo: deps.repo,
      now: deps.now,
      openAgent: deps.openAgent,
      ...(deps.runner.resume
        ? {
            resumeAgent: (request: AgentResumeRequest) => {
              if (!deps.runner.resume) throw new Error('宿主不支持恢复研发会话')
              return deps.runner.resume(request)
            },
          }
        : {}),
      executionDev: deps.executionDev,
    })
    this.orchestrator = new SessionOrchestrator({
      config: deps.config,
      repo: deps.repo,
      run: (request) => deps.runner.run(request),
    })
  }

  /** 需求已绑定会话且会话空闲：只有这时才重新排队等待中的需求。 */
  idleForRequirement(reqId: string, requirementVersion: number): boolean {
    const binding = this.deps.repo.requirementDevSession(reqId, requirementVersion)
    if (!binding) return false
    return this.deps.repo.devSession(binding.sessionId)?.state === 'idle'
  }
}
