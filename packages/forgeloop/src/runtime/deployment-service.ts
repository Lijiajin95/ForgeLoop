/**
 * 部署接口的运行时门面：把看板/协调器的部署动作集中在这里，
 * 复核所有者身份、解析候选制品并委托给 Deployments 状态机。
 *
 * 模型工具不经过这里；看板认证端点以 config.owner 调用。
 */

import type { Deployments } from './deployments.js'
import type { ForgeLoopConfig } from '../config.js'
import type { Repository } from '../records/repository.js'
import { ownerOnly } from './deployment-access.js'
import { fail, type OperationResult } from './operation-result.js'

export interface DeploymentServiceDeps {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly deployments: Deployments
}

export class DeploymentService {
  constructor(private readonly deps: DeploymentServiceDeps) {}

  /** 已登记目标与最近 intent；只读。 */
  rollouts(limit = 20): { targets: unknown[]; rollouts: unknown[] } {
    return {
      targets: this.deps.config.deployments.targets.map((target) => ({
        id: target.id,
        toolId: target.toolId,
        requirementId: target.requirementId,
        approval: target.approval,
      })),
      rollouts: this.deps.deployments.list(limit),
    }
  }

  rollout(intentId: string): unknown {
    return this.deps.deployments.detail(intentId)
  }

  /**
   * 提议一次部署：target 必须已登记；需求取调用方显式指定，省略时用 target 默认需求。
   * 制品取该需求最近一次候选构建。是否自动执行由 target.approval 决定；门禁与 preflight 仍然全部执行。
   */
  async request(input: {
    targetId: string
    requirementId?: string
    by: string
    source: string
  }): Promise<OperationResult> {
    const target = this.deps.config.deployments.targets.find((item) => item.id === input.targetId)
    if (!target) return fail('not_found', `未登记部署目标：${input.targetId}`)
    const requirementId = input.requirementId?.trim() || target.requirementId
    if (!requirementId) {
      return fail('requirement_required', '部署必须指定所属需求；目标未配置默认需求')
    }
    const existing = this.deps.deployments
      .list(200)
      .find((intent) => intent.source === input.source)
    const openStates = [
      'draft',
      'awaiting_approval',
      'ready',
      'applying',
      'applied_pending_verify',
      'verifying',
      'verified',
      'rolling_back',
    ]
    if (existing && openStates.includes(existing.state)) {
      return {
        ok: true,
        code: 'duplicate',
        message: `同一来源已发起部署 ${existing.intentId}（${existing.state}）`,
        data: { intentId: existing.intentId, state: existing.state, duplicate: true },
      }
    }
    const build = this.deps.repo.latestCandidateBuild(requirementId)
    if (!build) return fail('not_found', `需求 ${requirementId} 没有候选构建`)
    return this.deps.deployments.request({
      targetId: target.id,
      requirementId,
      artifact: {
        sha256: build.artifactSha256,
        path: build.tarball,
        version: build.packageVersion,
      },
      source: input.source,
    })
  }

  async approve(input: { intentId: string; by: string }): Promise<OperationResult> {
    const denied = ownerOnly(this.deps.config.owner, input.by)
    if (denied) return denied
    return this.deps.deployments.approve(input.intentId)
  }

  reject(input: { intentId: string; by: string; reason: string }): OperationResult {
    const denied = ownerOnly(this.deps.config.owner, input.by)
    if (denied) return denied
    return this.deps.deployments.reject(input.intentId, input.reason)
  }

  async verify(input: { intentId: string; by: string }): Promise<OperationResult> {
    const denied = ownerOnly(this.deps.config.owner, input.by)
    if (denied) return denied
    return this.deps.deployments.verify(input.intentId)
  }

  async rollback(input: {
    intentId: string
    by: string
    reason: string
  }): Promise<OperationResult> {
    const denied = ownerOnly(this.deps.config.owner, input.by)
    if (denied) return denied
    return this.deps.deployments.rollback(input.intentId, input.reason)
  }
}
