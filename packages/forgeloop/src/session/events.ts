// DSH 只接受“已知事件”或显式 ignorable 的 `plugin:` 记录；外部插件不能追加新的
// 普通 Session 事件类型，否则该会话在下一次打开时会被拒绝。
export const FORGELOOP_INTAKE_EVENT = 'plugin:forgeloop/intake'
export const FORGELOOP_ANALYSIS_EVENT = 'plugin:forgeloop/analysis'
export const FORGELOOP_CLARIFICATION_EVENT = 'plugin:forgeloop/clarification-request'
export const FORGELOOP_ANSWER_EVENT = 'plugin:forgeloop/clarification-answer'
export const FORGELOOP_PLAN_EVENT = 'plugin:forgeloop/plan'
export const FORGELOOP_ERROR_EVENT = 'plugin:forgeloop/error'

import { asRecord } from '../domain/json.js'
import type { InputKind } from '../domain/requirement.js'
import { errorMessage } from '../domain/errors.js'
import { resolveHostSessionAppender, type SessionAppender } from './host-appender.js'

let injectedAppender: SessionAppender | undefined

export function setSessionEventAppender(appender: SessionAppender | null | undefined): void {
  injectedAppender = appender ?? undefined
}

const hostAppender = await resolveHostSessionAppender()

export interface AppendableSession {
  append(type: string, data: Record<string, unknown>): unknown
}

export type SessionEventLogger = (message: string) => void

export interface IntakeEventData {
  readonly eventId: string
  readonly reqId: string
  readonly text: string
  readonly sessionId: string
  readonly messageId: string
  readonly turn: number
  /** duplicate 表示同一份设计文档已受理，未重复创建需求。 */
  readonly status: 'accepted' | 'duplicate'
  /** 设计文档快照身份：路径、摘要、字节数与受理结论；普通粘贴正文时缺省。 */
  readonly document?: {
    readonly kind: 'inline' | 'project-doc'
    readonly path: string
    readonly sha256: string
    readonly bytes: number
    readonly title: string
    readonly outcome: 'created' | 'duplicate' | 'revised' | 'recreated'
  }
  readonly at: string
}

export interface AnalysisEventData {
  readonly eventId: string
  readonly reqId: string
  readonly analysisVersion: number
  readonly requirementVersion: number
  /** 输入分诊：需求走需求流程，问题直接交研发处理。 */
  readonly inputKind: InputKind
  readonly goal: string
  readonly scenarios: readonly string[]
  readonly businessRules: readonly string[]
  readonly exceptions: readonly string[]
  readonly nonGoals: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly clarifications: readonly string[]
  readonly model: string
  readonly promptVersion: string
  readonly toolCalls: readonly string[]
  readonly at: string
}

export interface ClarificationEventData {
  readonly eventId: string
  readonly reqId: string
  readonly requirementVersion: number
  readonly analysisVersion: number
  readonly questions: readonly string[]
  /** 与 questions 一一对应的稳定问题编号，例如 Q1-1。 */
  readonly questionIds?: readonly string[]
  /** 回答与新需求入口的确定性提示；不构成授权或验收。 */
  readonly hint?: string
  readonly at: string
}

export interface AnswerEventData {
  readonly eventId: string
  readonly reqId: string
  readonly requirementVersion: number
  readonly answer: string
  /** 本次回答针对的问题编号与原文，便于回看“回答了什么”。 */
  readonly questionIds?: readonly string[]
  readonly questions?: readonly string[]
  readonly at: string
}

export interface PlanTaskData {
  readonly taskId: string
  readonly goal: string
  readonly files: readonly string[]
  readonly acceptance: string
  readonly testCommand: readonly string[]
  readonly dependsOn: readonly string[]
  readonly verification?: boolean
}

export interface PlanEventData {
  readonly eventId: string
  readonly reqId: string
  readonly planVersion: number
  readonly requirementVersion: number
  readonly technicalSolution: {
    readonly summary: string
    readonly approach: readonly string[]
    readonly risks: readonly string[]
  } | null
  readonly tasks: readonly PlanTaskData[]
  readonly at: string
}

export interface ErrorEventData {
  readonly eventId: string
  readonly reqId: string
  readonly message: string
  readonly at: string
}

/**
 * 追加一条自定义事件；append 不可用或宿主拒绝该事件时只记录日志并返回 false。
 * 调用方必须继续拒绝普通模型步骤，不能因为展示失败退回普通聊天。
 */
export function appendSessionEvent(
  session: unknown,
  type: string,
  data: object,
  log: SessionEventLogger = () => undefined,
): boolean {
  try {
    const record = asRecord(data) ?? {}
    const appender = injectedAppender ?? hostAppender
    if (appender) {
      appender(session, type, record)
      return true
    }
    const append = asRecord(session)?.append
    if (typeof append !== 'function') {
      log(`会话没有 append 能力，未写入 ${type}`)
      return false
    }
    Reflect.apply(append, session, [type, record])
    return true
  } catch (error) {
    log(`写入会话事件 ${type} 失败：${errorMessage(error)}`)
    return false
  }
}
