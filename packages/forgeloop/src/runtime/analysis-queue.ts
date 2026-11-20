import type { ForgeLoopConfig } from '../config.js'
import { sourceTrusted } from '../domain/admission.js'
import type { AnalysisMode } from '../domain/analysis.js'
import type { Requirement } from '../domain/requirement.js'
import type { RequirementQueue } from '../domain/requirement-queue.js'
import { ANALYSIS_FAILED, isTerminal } from '../domain/status.js'
import type { Repository } from '../records/repository.js'
import { fail, ok, type OperationResult } from './operation-result.js'

const MAX_AUTO_ANALYSIS_RETRIES = 3

export const ANALYSIS_RETRY_SOURCE = 'system:analysis-retry'

export function analysisModeOf(source: string): AnalysisMode {
  if (source.startsWith(ANALYSIS_RETRY_SOURCE)) return 'auto'
  if (source.endsWith(':analysis-retry')) return 'manual'
  return 'initial'
}

export interface AnalysisQueueDeps {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly queue: RequirementQueue
  readonly now: () => string
  readonly requestOperation: (input: {
    reqId: string
    action: 'analyze'
    by: string
    source: string
  }) => OperationResult
  readonly intakeQueuedRequirement: () => string | null
}

export class AnalysisQueue {
  constructor(private readonly deps: AnalysisQueueDeps) {}

  accepted(
    requirement: Requirement,
    input: { created: boolean; source: string; analyze: boolean },
  ): string {
    const trusted =
      this.deps.config.autonomy.enabled && sourceTrusted(input.source, this.deps.config.autonomy)
    if (!input.created || !trusted || !input.analyze) return ''
    this.deps.queue.enqueue({
      requirementId: requirement.reqId,
      project: this.deps.config.project,
      enqueuedAt: requirement.versions[0]?.createdAt ?? this.deps.now(),
    })
    const started = this.deps.intakeQueuedRequirement() === requirement.reqId
    return started ? '；已入队并开始自动分析' : '；已入队，等待研发任务空闲'
  }

  enqueue(reqId: string): OperationResult {
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${reqId} 已处于终态 ${requirement.status}，不能入队`)
    }
    const analysis = this.deps.repo.latestAnalysis(reqId)
    if (!analysis || analysis.requirementVersion !== requirement.versions.length) {
      return fail('analysis_missing', `需求 ${reqId} 尚无当前版本的产品分析，不能入队`)
    }
    if (analysis.clarifications.length > 0) {
      return fail('clarification_required', `需求 ${reqId} 仍有待澄清项，不能入队`)
    }
    this.deps.queue.enqueue({
      requirementId: reqId,
      project: this.deps.config.project,
      enqueuedAt: this.deps.now(),
    })
    const started = this.deps.intakeQueuedRequirement() === reqId
    return ok(
      started ? `需求 ${reqId} 已入队并开始自动推进` : `需求 ${reqId} 已入队，等待研发任务空闲`,
      { reqId, started },
    )
  }

  autoRetry(): string[] {
    const queued: string[] = []
    for (const requirement of this.deps.repo.listRequirements(this.deps.config.project)) {
      if (requirement.status !== ANALYSIS_FAILED) continue
      if (this.deps.repo.activeStop(requirement.reqId)) continue
      const attempts = this.deps.repo.analysisAttempts(
        requirement.reqId,
        requirement.versions.length,
      )
      const auto = attempts.filter((attempt) => attempt.kind === 'auto').length
      if (auto >= MAX_AUTO_ANALYSIS_RETRIES) continue
      const active = this.deps.repo
        .requestsFor(requirement.reqId)
        .some((request) => ['pending', 'claimed'].includes(request.state))
      if (active) continue
      const outcome = this.deps.requestOperation({
        reqId: requirement.reqId,
        action: 'analyze',
        by: 'system:analysis-retry',
        source: ANALYSIS_RETRY_SOURCE,
      })
      if (outcome.ok) queued.push(requirement.reqId)
    }
    return queued
  }

  retry(input: { reqId: string; by: string; source: string }): OperationResult {
    const requirement = this.deps.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${input.reqId} 已处于终态 ${requirement.status}，不能重试`)
    }
    if (requirement.status !== ANALYSIS_FAILED) {
      return fail(
        'not_failed',
        `需求 ${input.reqId} 当前状态 ${requirement.status}，没有失败的产品分析`,
      )
    }
    const queued = this.deps.requestOperation({
      reqId: input.reqId,
      action: 'analyze',
      by: input.by,
      source: `${input.source}:analysis-retry`,
    })
    if (!queued.ok) return queued
    return ok(`已受理需求 ${input.reqId} 的产品分析重试：${queued.message}`, queued.data)
  }
}
