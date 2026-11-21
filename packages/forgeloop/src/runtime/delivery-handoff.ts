import type { ForgeLoopConfig } from '../config.js'
import type { DeploymentTargetConfig } from '../config.js'
import { ACCEPTED, COMMITTED } from '../domain/status.js'
import { errorMessage } from '../domain/errors.js'
import { asRecord } from '../domain/json.js'
import type { OperationResult } from './operation-result.js'
import type { Repository } from '../records/repository.js'
import type { Deployments } from './deployments.js'
import type { DeploymentService } from './deployment-service.js'
import type { DeliveryHandoffState } from '../records/delivery-store.js'
import { safeInstallableDelivery } from './installable-delivery.js'

export interface DeliveryHandoffDeps {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly now: () => string
  readonly buildCandidate: (reqId: string) => Promise<OperationResult>
  readonly deployments: Deployments
  readonly deploymentService: DeploymentService
  readonly ops: { recheckFix(eventId: string, intentId: string): Promise<void> }
}

export interface DeliveryRuntime {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly deployments: Deployments
  readonly deploymentService: DeploymentService
  readonly ops: { recheckFix(eventId: string, intentId: string): Promise<void> }
  buildCandidate(input: { reqId: string; by: string }): Promise<OperationResult>
}

export function createDeliveryHandoff(
  runtime: DeliveryRuntime,
  now: () => string,
): DeliveryHandoff {
  return new DeliveryHandoff({
    config: runtime.config,
    repo: runtime.repo,
    now,
    buildCandidate: (reqId) => runtime.buildCandidate({ reqId, by: 'system:delivery' }),
    deployments: runtime.deployments,
    deploymentService: runtime.deploymentService,
    ops: runtime.ops,
  })
}

export interface DeliveryTickResult {
  readonly built: number
  readonly proposed: number
  readonly applied: number
  readonly verified: number
  readonly failed: number
}

interface DeliveryPlan {
  readonly reqId: string
  readonly planVersion: number
  readonly candidateSha256: string
  readonly requirementVersion: number
}

type BuildRecord = NonNullable<ReturnType<Repository['latestCandidateBuild']>>

const SKIP_STATES = new Set<DeliveryHandoffState>([
  'verified',
  'proposed',
  'deploy_failed',
  'verify_failed',
])

export class DeliveryHandoff {
  constructor(private readonly deps: DeliveryHandoffDeps) {}

  async tick(): Promise<DeliveryTickResult> {
    const result = { built: 0, proposed: 0, applied: 0, verified: 0, failed: 0 }
    await this.drainRechecks()
    for (const requirement of this.deps.repo.listRequirements(this.deps.config.project)) {
      const plan = this.deliveryPlan(requirement.reqId)
      if (!plan) continue
      const build = await this.ensureBuild(plan, result)
      if (!build) continue
      for (const target of this.autoTargets(plan.reqId)) {
        await this.deliverOne(plan.reqId, build, target, result)
      }
    }
    await this.verifyAppliedAutoTargets(result)
    return result
  }

  private deliveryPlan(reqId: string): DeliveryPlan | null {
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) return null
    if (requirement.status !== COMMITTED && requirement.status !== ACCEPTED) return null
    if (this.deps.repo.activeStop(reqId)) return null
    const admission = this.deps.repo.latestAdmission(reqId)
    if (!admission || admission.decision !== 'admit') return null
    if (admission.requirementVersion !== requirement.versions.length) return null
    const plan = this.deps.repo.latestTaskPlan(reqId)
    if (!plan || plan.requirementVersion !== requirement.versions.length) return null
    const candidate = this.deps.repo.latestCodeCandidate(reqId, plan.planVersion)
    if (!candidate) return null
    return {
      reqId,
      planVersion: plan.planVersion,
      candidateSha256: candidate.candidateSha256,
      requirementVersion: requirement.versions.length,
    }
  }

  private async ensureBuild(
    plan: DeliveryPlan,
    result: { built: number; failed: number },
  ): Promise<BuildRecord | null> {
    const existing = this.deps.repo.latestCandidateBuild(plan.reqId)
    if (
      existing &&
      existing.candidateSha256 === plan.candidateSha256 &&
      existing.planVersion === plan.planVersion
    ) {
      return existing
    }
    const marker = this.deps.repo.deliveryStore.handoff(plan.reqId, plan.candidateSha256, '')
    if (marker?.state === 'build_failed') return null
    const built = await this.deps.buildCandidate(plan.reqId)
    if (!built.ok) {
      this.deps.repo.deliveryStore.recordHandoff({
        reqId: plan.reqId,
        candidateSha256: plan.candidateSha256,
        targetId: '',
        state: 'build_failed',
        detail: built.message.slice(0, 1000),
        updatedAt: this.deps.now(),
      })
      result.failed += 1
      return null
    }
    const record = this.deps.repo.latestCandidateBuild(plan.reqId)
    if (!record) {
      result.failed += 1
      return null
    }
    this.deps.repo.deliveryStore.recordHandoff({
      reqId: plan.reqId,
      candidateSha256: plan.candidateSha256,
      targetId: '',
      state: 'built',
      detail: record.artifactSha256,
      updatedAt: this.deps.now(),
    })
    result.built += 1
    return record
  }

  private autoTargets(reqId: string): DeploymentTargetConfig[] {
    return this.deps.config.deployments.targets.filter(
      (target) =>
        target.autoDeliver && (target.requirementId === '' || target.requirementId === reqId),
    )
  }

  private async deliverOne(
    reqId: string,
    build: BuildRecord,
    target: DeploymentTargetConfig,
    result: { proposed: number; applied: number; verified: number; failed: number },
  ): Promise<void> {
    const existing = this.deps.repo.deliveryStore.handoff(reqId, build.candidateSha256, target.id)
    if (existing && SKIP_STATES.has(existing.state)) return
    const source = `auto-deliver:${reqId}:${target.id}:${build.artifactSha256}`
    const requested = await this.deps.deploymentService.request({
      targetId: target.id,
      requirementId: reqId,
      by: 'system:delivery',
      source,
    })
    const data = asRecord(requested.data)
    const intentId = typeof data?.intentId === 'string' ? data.intentId : ''
    const state = typeof data?.state === 'string' ? data.state : ''
    if (!requested.ok || !intentId) {
      this.record({ reqId, build, target }, 'deploy_failed', requested.message)
      result.failed += 1
      return
    }
    if (state === 'awaiting_approval') {
      this.record({ reqId, build, target }, 'proposed', `部署 ${intentId} 等待所有者批准`)
      result.proposed += 1
      return
    }
    if (state === 'applied_pending_verify' || state === 'applying') {
      this.record({ reqId, build, target }, 'deployed', `部署 ${intentId} 已执行，待核对`)
      result.applied += 1
      if (state !== 'applied_pending_verify') return
      await this.verifyAndRecheck({ reqId, build, target, intentId }, result)
      return
    }
    if (state === 'verified') {
      this.record(
        { reqId, build, target },
        'verified',
        `部署 ${intentId} 已核对${this.recordDelivery(reqId)}`,
      )
      result.verified += 1
      await this.ensureAndDrainRechecks(reqId, intentId)
      return
    }
    this.record(
      { reqId, build, target },
      'deploy_failed',
      `部署 ${intentId} 状态 ${state || '未知'}`,
    )
    result.failed += 1
  }

  private async verifyAndRecheck(
    input: {
      reqId: string
      build: BuildRecord
      target: DeploymentTargetConfig
      intentId: string
    },
    result: { verified: number; failed: number },
  ): Promise<void> {
    const verified = await this.deps.deployments.verify(input.intentId, 'system:coordinator')
    if (!verified.ok) {
      this.record(input, 'verify_failed', verified.message)
      result.failed += 1
      return
    }
    this.record(input, 'verified', `${verified.message}${this.recordDelivery(input.reqId)}`)
    result.verified += 1
    await this.ensureAndDrainRechecks(input.reqId, input.intentId)
  }

  private recordDelivery(reqId: string): string {
    const delivery = safeInstallableDelivery(
      { config: this.deps.config, repo: this.deps.repo, now: this.deps.now },
      reqId,
    )
    return delivery.ok ? `；${delivery.message}` : `；未登记可安装交付：${delivery.message}`
  }

  private async verifyAppliedAutoTargets(result: {
    verified: number
    failed: number
  }): Promise<void> {
    const targets = new Map(
      this.deps.config.deployments.targets.map((target) => [target.id, target]),
    )
    for (const intent of this.deps.deployments.list(200)) {
      if (intent.state !== 'applied_pending_verify') continue
      const target = targets.get(intent.targetId)
      if (!target || target.approval !== 'auto') continue
      const verified = await this.deps.deployments.verify(intent.intentId, 'system:coordinator')
      if (verified.ok) result.verified += 1
      else result.failed += 1
      if (verified.ok) this.recordDelivery(intent.requirementId)
      if (verified.ok) await this.ensureAndDrainRechecks(intent.requirementId, intent.intentId)
    }
  }

  private record(
    input: { reqId: string; build: BuildRecord; target: DeploymentTargetConfig },
    state: DeliveryHandoffState,
    detail: string,
  ): void {
    this.deps.repo.deliveryStore.recordHandoff({
      reqId: input.reqId,
      candidateSha256: input.build.candidateSha256,
      targetId: input.target.id,
      state,
      detail: detail.slice(0, 1000),
      updatedAt: this.deps.now(),
    })
  }

  private async ensureAndDrainRechecks(reqId: string, intentId: string): Promise<void> {
    const eventIds = this.deps.repo
      .listOpsEvents(this.deps.config.project)
      .filter((event) => event.fixRequirementId === reqId)
      .map((event) => event.eventId)
    this.deps.repo.deliveryStore.ensureRechecks({
      reqId,
      intentId,
      eventIds,
      at: this.deps.now(),
    })
    await this.drainRechecks()
  }

  private async drainRechecks(): Promise<void> {
    for (const pending of this.deps.repo.deliveryStore.allPendingRechecks()) {
      try {
        await this.deps.ops.recheckFix(pending.eventId, pending.intentId)
        this.deps.repo.deliveryStore.recordRecheckOutcome({
          ...pending,
          state: 'done',
          detail: '原事件复核已执行',
          at: this.deps.now(),
        })
      } catch (error) {
        this.deps.repo.deliveryStore.recordRecheckOutcome({
          ...pending,
          state: 'pending',
          detail: errorMessage(error),
          at: this.deps.now(),
        })
      }
    }
  }
}
