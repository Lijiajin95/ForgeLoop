/**
 * 计划批准与验收批准（迁移自旧 `domain/approval.py`）：
 * - 批准绑定任务身份与方案版本；重复或旧版本决定不能重复执行。
 * - 验收批准还绑定实际交付材料；材料变化后原批准失效。
 */

import type { DeliveryBinding } from './delivery.js'
import { verifyBinding } from './delivery.js'
import { RuleViolationError } from './errors.js'

export const APPROVAL_PLAN = 'plan'
export const APPROVAL_ACCEPTANCE = 'acceptance'
export type ApprovalStage = typeof APPROVAL_PLAN | typeof APPROVAL_ACCEPTANCE

export interface Approval {
  readonly taskId: string
  readonly planVersion: number
  readonly stage: ApprovalStage
  readonly decidedAt: string
  readonly binding: DeliveryBinding | null
  readonly approvedBy: string
  readonly source: string
}

export type ConsumeStatus = 'ok' | 'missing' | 'stale' | 'already_used' | 'material_changed'

export interface ConsumeResult {
  readonly status: ConsumeStatus
  readonly approval: Approval | null
  readonly reason: string
}

/** 批准记录簿：记录批准、校验执行前绑定、拒绝重复或旧版本执行。 */
export class ApprovalBook {
  private readonly recorded = new Map<string, Approval>()
  private readonly consumed = new Set<string>()

  constructor(approvals: readonly Approval[] = []) {
    for (const approval of approvals) {
      const key = `${approval.taskId}:${approval.stage}`
      const current = this.recorded.get(key)
      if (current === undefined || approval.planVersion >= current.planVersion) {
        this.recorded.set(key, approval)
      }
    }
  }

  markConsumed(taskId: string, planVersion: number, stage: ApprovalStage): void {
    this.consumed.add(`${taskId}:${planVersion}:${stage}`)
  }

  record(approval: Approval): void {
    const key = `${approval.taskId}:${approval.stage}`
    const current = this.recorded.get(key)
    if (current !== undefined && approval.planVersion < current.planVersion) {
      throw new RuleViolationError('不能记录比生效版本更旧的批准')
    }
    this.recorded.set(key, approval)
  }

  effective(taskId: string, stage: ApprovalStage): Approval | null {
    return this.recorded.get(`${taskId}:${stage}`) ?? null
  }

  /** 执行前消费批准：一次批准只允许触发一次执行；旧版本或材料变化均拒绝。 */
  consume(
    taskId: string,
    planVersion: number,
    stage: ApprovalStage,
    currentBinding?: DeliveryBinding | null,
  ): ConsumeResult {
    const approval = this.recorded.get(`${taskId}:${stage}`)
    if (approval === undefined) {
      return { status: 'missing', approval: null, reason: '未找到该阶段的批准；未批准不开始执行' }
    }
    if (planVersion !== approval.planVersion) {
      return {
        status: 'stale',
        approval,
        reason: `方案版本 ${planVersion} 不是生效版本 ${approval.planVersion}；旧版本决定不能重复执行`,
      }
    }
    if (approval.binding !== null) {
      if (currentBinding === undefined || currentBinding === null) {
        return {
          status: 'material_changed',
          approval,
          reason: '批准已绑定交付材料，但缺少当前材料身份；不能沿用原批准',
        }
      }
      const decision = verifyBinding(approval.binding, currentBinding)
      if (!decision.valid) return { status: 'material_changed', approval, reason: decision.reason }
    }
    if (this.consumed.has(`${taskId}:${planVersion}:${stage}`)) {
      return {
        status: 'already_used',
        approval,
        reason: '该批准已触发过执行；重复决定不能重复执行',
      }
    }
    return { status: 'ok', approval, reason: '' }
  }
}