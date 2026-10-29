/**
 * ForgeLoop 业务会话的自定义会话事件。
 *
 * 这些事件只写入 DSH Session 日志用于可回放的对话呈现（log-only），
 * 不带 surfaceOp，不进入模型消息历史，也不构成业务授权或验收证据。
 */

// DSH 只接受“已知事件”或显式 ignorable 的 `plugin:` 记录；外部插件不能追加新的
// 普通 Session 事件类型，否则该会话在下一次打开时会被拒绝。
export const FORGELOOP_INTAKE_EVENT = 'plugin:forgeloop/intake'
export const FORGELOOP_ANALYSIS_EVENT = 'plugin:forgeloop/analysis'
export const FORGELOOP_CLARIFICATION_EVENT = 'plugin:forgeloop/clarification-request'
export const FORGELOOP_ANSWER_EVENT = 'plugin:forgeloop/clarification-answer'
export const FORGELOOP_PLAN_EVENT = 'plugin:forgeloop/plan'
export const FORGELOOP_ERROR_EVENT = 'plugin:forgeloop/error'

import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

type AppendRecord = (session: unknown, type: string, data: unknown) => unknown
let appendRecord: AppendRecord | undefined
try {
  // 从 DSH 自己的入口解析包，避免把宿主内部包写进插件依赖；测试环境找不到时
  // 回退到 session.append，仅用于不持久化 DSH 日志的假会话。
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
  const requireFromDsh = createRequire(entry)
  const sessionModule = (await import(
    pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session')).href
  )) as { appendPluginRecord?: AppendRecord }
  appendRecord = sessionModule.appendPluginRecord
} catch {
  appendRecord = undefined
}

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
  readonly status: 'accepted'
  readonly at: string
}

export interface AnalysisEventData {
  readonly eventId: string
  readonly reqId: string
  readonly analysisVersion: number
  readonly requirementVersion: number
  readonly goal: string
  readonly scenarios: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly clarifications: readonly string[]
  readonly at: string
}

export interface ClarificationEventData {
  readonly eventId: string
  readonly reqId: string
  readonly requirementVersion: number
  readonly analysisVersion: number
  readonly questions: readonly string[]
  readonly at: string
}

export interface AnswerEventData {
  readonly eventId: string
  readonly reqId: string
  readonly requirementVersion: number
  readonly answer: string
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
  data: Record<string, unknown>,
  log: SessionEventLogger = () => undefined,
): boolean {
  try {
    if (appendRecord) {
      appendRecord(session, type, data)
      return true
    }
    const append = (session as Partial<AppendableSession> | undefined)?.append
    if (typeof append !== 'function') {
      log(`会话没有 append 能力，未写入 ${type}`)
      return false
    }
    append.call(session, type, data)
    return true
  } catch (error) {
    log(`写入会话事件 ${type} 失败：${(error as Error).message}`)
    return false
  }
}
