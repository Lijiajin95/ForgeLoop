/**
 * 单任务推进状态与产物身份：开发者 → 独立审查 → 正式测试 → 交付。
 * 规则：审查阻断回到开发；测试失败计入失败轮次，额度未尽才自动重试；
 * 交付必须同时具备候选 diff、测试证据与审查结论的摘要。
 */

import { RuleViolationError } from './errors.js'
import {
  TASK_RUN_AWAITING_USER,
  TASK_RUN_BLOCKED,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
  type TaskRunState,
} from './status.js'

export interface TaskArtifact {
  readonly requirementId: string
  readonly planVersion: number
  readonly taskId: string
  readonly candidateSha256: string
  readonly testEvidenceSha256: string
  readonly reviewSha256: string
  readonly acceptance: string
  readonly authorizationSource: string
  readonly recordedAt: string
  readonly baselineCommit: string
}

export interface TaskRun {
  readonly requirementId: string
  readonly planVersion: number
  readonly taskId: string
  readonly state: TaskRunState
  readonly reason: string
  readonly executedSeconds: number
  readonly updatedAt: string
}

export interface ArtifactDraft {
  readonly candidateSha256: string
  readonly testEvidenceSha256: string
  readonly reviewSha256: string
  readonly acceptance: string
  readonly authorizationSource: string
  readonly baselineCommit: string
}

export function validateArtifact(draft: ArtifactDraft): void {
  if (!draft.candidateSha256) throw new RuleViolationError('交付缺少候选 diff 摘要')
  if (!draft.testEvidenceSha256) throw new RuleViolationError('交付缺少正式测试证据摘要')
  if (!draft.reviewSha256) throw new RuleViolationError('交付缺少独立审查结论摘要')
  if (!draft.authorizationSource.trim()) {
    throw new RuleViolationError('交付缺少任务级授权来源；授权来源只能由真实批准派生')
  }
}

export const STAGE_DEVELOP = 'dev'
export const STAGE_REVIEW = 'review'
export const STAGE_TEST = 'test'
export const STAGE_DELIVER = 'deliver'
export type Stage = typeof STAGE_DEVELOP | typeof STAGE_REVIEW | typeof STAGE_TEST | typeof STAGE_DELIVER

export interface RoutingInput {
  readonly stage: Stage
  readonly passed: boolean
  readonly blockingReview: boolean
  readonly attempts: number
  readonly maxAttempts: number
  readonly grantAvailable: boolean
  readonly stopped: boolean
}

export interface Routing {
  readonly next: Stage | 'retry_dev' | 'done' | typeof TASK_RUN_AWAITING_USER | typeof TASK_RUN_BLOCKED
  readonly state: TaskRunState | null
  readonly reason: string
}

/** 纯路由：调用方只需落实这里给出的下一步与拒绝原因。 */
export function routeStage(input: RoutingInput): Routing {
  if (input.stopped) {
    return { next: TASK_RUN_AWAITING_USER, state: TASK_RUN_AWAITING_USER, reason: '收到停止请求，不再启动新动作' }
  }
  if (input.attempts >= input.maxAttempts) {
    return {
      next: TASK_RUN_AWAITING_USER,
      state: TASK_RUN_FAILED,
      reason: `任务已尝试 ${input.attempts} 次仍未通过，等待人工决定`,
    }
  }
  switch (input.stage) {
    case STAGE_DEVELOP:
      return input.passed
        ? { next: STAGE_REVIEW, state: null, reason: '' }
        : { next: 'retry_dev', state: null, reason: '开发未产出可用改动' }
    case STAGE_REVIEW:
      if (input.blockingReview) {
        return { next: 'retry_dev', state: null, reason: '独立审查阻断，回到开发' }
      }
      return input.passed
        ? { next: STAGE_TEST, state: null, reason: '' }
        : { next: TASK_RUN_BLOCKED, state: TASK_RUN_BLOCKED, reason: '审查结论不可用，停止推进' }
    case STAGE_TEST:
      if (input.passed) return { next: STAGE_DELIVER, state: null, reason: '' }
      if (!input.grantAvailable) {
        return {
          next: TASK_RUN_AWAITING_USER,
          state: TASK_RUN_AWAITING_USER,
          reason: '正式测试失败且失败轮次额度已用尽；等待追加授权或其他决定',
        }
      }
      return { next: 'retry_dev', state: null, reason: '正式测试失败，额度未尽，回到开发' }
    case STAGE_DELIVER:
      return input.passed
        ? { next: 'done', state: TASK_RUN_DELIVERED, reason: '' }
        : { next: TASK_RUN_BLOCKED, state: TASK_RUN_BLOCKED, reason: '交付材料不完整，不能记为已交付' }
    default:
      return { next: TASK_RUN_BLOCKED, state: TASK_RUN_BLOCKED, reason: `未知阶段 ${String(input.stage)}` }
  }
}