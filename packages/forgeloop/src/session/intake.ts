/**
 * ForgeLoop 业务会话的输入接管。
 *
 * 在 DSH 的 `agent/pre-step` waterfall 中，只处理 agentPreset=forgeloop 的
 * 非子 Agent 会话：把人类输入交给需求受理与需求 Agent 分析，然后 reject 普通
 * 模型步骤。用户看到的是自定义会话事件，不是普通聊天回复。
 */

import type { ForgeLoopConfig } from '../config.js'
import type { RequirementAnalysis } from '../domain/requirement.js'
import type { ForgeLoopRuntime } from '../runtime/service.js'
import {
  FORGELOOP_ANALYSIS_EVENT,
  FORGELOOP_ANSWER_EVENT,
  FORGELOOP_CLARIFICATION_EVENT,
  FORGELOOP_ERROR_EVENT,
  FORGELOOP_INTAKE_EVENT,
  FORGELOOP_PLAN_EVENT,
  appendSessionEvent,
  type AnalysisEventData,
  type AnswerEventData,
  type ClarificationEventData,
  type ErrorEventData,
  type IntakeEventData,
  type PlanEventData,
  type SessionEventLogger,
} from './events.js'

type AnyRecord = Record<string, unknown>

export const FORGELOOP_PRESET_ID = 'forgeloop'
export const FORGELOOP_PRESET_NAME = 'ForgeLoop 业务会话'
export const FORGELOOP_PRESET_DESCRIPTION =
  '描述业务目标或问题；ForgeLoop 会把它拆解为需求并交给需求 Agent 分析，不进入普通聊天。'

export interface SessionViewLike {
  readonly id?: string
  readonly header?: AnyRecord
  append?(type: string, data: Record<string, unknown>): unknown
}

export interface AgentViewLike {
  readonly session?: SessionViewLike
  readonly ctx?: AnyRecord
}

export interface UserMessageLike {
  readonly id?: string
  readonly role?: string
  readonly content?: unknown
  readonly source?: { readonly kind?: string }
}

export interface PreStepPayloadLike {
  readonly agent?: AgentViewLike
  readonly messages?: readonly unknown[]
  readonly turn?: number
  readonly signal?: AbortSignal
}

export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: readonly unknown[] }

export type PreStepNext = () => Promise<PreStepDecision>

export interface SessionIntakeOptions {
  readonly runtime: ForgeLoopRuntime
  readonly config: ForgeLoopConfig
  readonly log?: SessionEventLogger
  readonly now?: () => Date
  /** 读取会话当前生效的 preset；缺省或返回 undefined 时回退到 session header。 */
  readonly presetOf?: (agent: AgentViewLike) => string | undefined
}

/**
 * 是否是 ForgeLoop 业务会话：当前 preset 匹配且不是子 Agent 会话。
 * Web 会话的 header 是创建事实；用户可能在首轮前切换 preset，因此优先读取
 * 运行中的 preset 组合，header 只作为回退。
 */
export function isForgeLoopSession(
  agent: AgentViewLike | undefined,
  presetOf?: (agent: AgentViewLike) => string | undefined,
): boolean {
  if (!agent) return false
  const header = agent.session?.header
  if (typeof header !== 'object' || header === null) return false
  if (header.origin === 'subagent') return false
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return false
  const current = presetOf?.(agent)
  if (current !== undefined) return current === FORGELOOP_PRESET_ID
  return header.agentPreset === FORGELOOP_PRESET_ID
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is AnyRecord => typeof block === 'object' && block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n')
    .trim()
}

export function humanMessages(messages: readonly unknown[]): UserMessageLike[] {
  return messages.filter((message): message is UserMessageLike => {
    const record = message as AnyRecord | undefined
    return record?.role === 'user' && (record.source as AnyRecord | undefined)?.kind === 'user'
  })
}

export function messageText(message: UserMessageLike): string {
  return textOfContent(message.content)
}

/** 业务会话的确定性输入接管器；不依赖浏览器，也不依赖命令表面。 */
export class SessionIntake {
  private readonly runtime: ForgeLoopRuntime
  private readonly config: ForgeLoopConfig
  private readonly log: SessionEventLogger
  private readonly now: () => Date
  private readonly presetOf?: (agent: AgentViewLike) => string | undefined
  private readonly processed = new Set<string>()

  constructor(options: SessionIntakeOptions) {
    this.runtime = options.runtime
    this.config = options.config
    this.log = options.log ?? (() => undefined)
    this.now = options.now ?? (() => new Date())
    this.presetOf = options.presetOf
  }

  /** 只接管 ForgeLoop 业务会话；其他会话原样交给后续 waterfall。 */
  async handlePreStep(payload: PreStepPayloadLike, next: PreStepNext): Promise<PreStepDecision> {
    const agent = payload.agent
    if (!isForgeLoopSession(agent, this.presetOf)) return next()

    const messages = humanMessages(payload.messages ?? [])
    if (messages.length === 0) {
      // 业务会话不运行普通模型步骤；系统注入的上下文也不应触发聊天。
      return { kind: 'reject' }
    }
    const session = agent?.session
    for (const [index, message] of messages.entries()) {
      try {
        await this.intakeOne({
          session,
          message,
          index,
          turn: payload.turn ?? 0,
          signal: payload.signal,
        })
      } catch (error) {
        this.appendError(
          session,
          `forgeloop:error:${payload.turn ?? 0}:${index}`,
          '',
          `需求受理异常：${(error as Error).message}`,
          this.now().toISOString(),
        )
      }
    }
    return { kind: 'reject' }
  }

  private async intakeOne(input: {
    session: SessionViewLike | undefined
    message: UserMessageLike
    index: number
    turn: number
    signal?: AbortSignal
  }): Promise<void> {
    const session = input.session
    const sessionId = typeof session?.id === 'string' && session.id ? session.id : 'unknown-session'
    const messageId =
      typeof input.message.id === 'string' && input.message.id
        ? input.message.id
        : `turn-${input.turn}-message-${input.index}`
    const dedupeKey = `${sessionId}:${messageId}`
    if (this.processed.has(dedupeKey)) return
    this.processed.add(dedupeKey)

    const text = messageText(input.message)
    const at = this.now().toISOString()
    if (!text) {
      this.appendError(session, `forgeloop:error:${dedupeKey}`, '', '输入没有可受理的文本内容', at)
      return
    }

    const pending = this.runtime.pendingClarifications(sessionId)
    if (pending.length > 1) {
      this.appendError(
        session,
        `forgeloop:error:${dedupeKey}`,
        '',
        `本会话有 ${pending.length} 条需求等待澄清；请先只保留一个待回答需求或明确指定需求身份`,
        at,
      )
      return
    }
    if (pending.length === 1) {
      await this.answerOne({
        session,
        sessionId,
        messageId,
        text,
        turn: input.turn,
        signal: input.signal,
        reqId: pending[0]!.reqId,
        at,
      })
      return
    }
    await this.submitOne({ session, sessionId, messageId, text, turn: input.turn, signal: input.signal, at })
  }

  private async submitOne(input: {
    session: SessionViewLike | undefined
    sessionId: string
    messageId: string
    text: string
    turn: number
    signal?: AbortSignal
    at: string
  }): Promise<void> {
    const { session, sessionId, messageId, text, turn, at } = input
    const source = `dsh-session:${sessionId}:${messageId}`
    let submitted: ReturnType<ForgeLoopRuntime['submit']>
    try {
      submitted = this.runtime.submit({
        text,
        by: this.config.owner,
        source,
        clientKey: source,
      })
    } catch (error) {
      this.appendError(session, `forgeloop:error:${sessionId}:${messageId}`, '', `需求受理异常：${(error as Error).message}`, at)
      return
    }
    if (!submitted.ok) {
      this.appendError(session, `forgeloop:error:${sessionId}:${messageId}`, '', submitted.message, at)
      return
    }
    const reqId = this.reqIdOf(submitted.data)
    if (!reqId) {
      this.appendError(session, `forgeloop:error:${sessionId}:${messageId}`, '', '需求已写入但没有返回身份', at)
      return
    }

    const intake: IntakeEventData = {
      eventId: `forgeloop:intake:${sessionId}:${messageId}`,
      reqId,
      text,
      sessionId,
      messageId,
      turn,
      status: 'accepted',
      at,
    }
    appendSessionEvent(session, FORGELOOP_INTAKE_EVENT, intake as unknown as Record<string, unknown>, this.log)

    let outcome: Awaited<ReturnType<ForgeLoopRuntime['analyzeRequirement']>>
    try {
      outcome = await this.runtime.analyzeRequirement(reqId, input.signal)
    } catch (error) {
      this.appendError(session, `forgeloop:error:${reqId}`, reqId, `需求分析异常：${(error as Error).message}`, at)
      return
    }
    if (!outcome.ok || !outcome.analysis) {
      this.appendError(session, `forgeloop:error:${reqId}`, reqId, outcome.message, at)
      return
    }
    this.appendAnalysis(session, reqId, outcome.analysis, at)
    this.appendClarificationIfNeeded(session, reqId, outcome.analysis, at)
    // 方案与实现由协调器自动排入研发 Agent；人类会话不再直接调用旧规划入口，
    // 否则会并行生成第二份任务包并把需求打回 plan_proposed。
  }

  private async answerOne(input: {
    session: SessionViewLike | undefined
    sessionId: string
    messageId: string
    text: string
    turn: number
    signal?: AbortSignal
    reqId: string
    at: string
  }): Promise<void> {
    const { session, sessionId, messageId, text, turn, at, reqId } = input
    const source = `dsh-session:${sessionId}:${messageId}`
    let outcome: Awaited<ReturnType<ForgeLoopRuntime['answerClarifications']>>
    try {
      outcome = await this.runtime.answerClarifications({
        reqId,
        answer: text,
        by: this.config.owner,
        source,
        signal: input.signal,
      })
    } catch (error) {
      this.appendError(session, `forgeloop:error:${reqId}`, reqId, `澄清回答异常：${(error as Error).message}`, at)
      return
    }
    if (!outcome.ok || !outcome.analysis) {
      this.appendError(session, `forgeloop:error:${reqId}`, reqId, outcome.message, at)
      return
    }
    const answer: AnswerEventData = {
      eventId: `forgeloop:answer:${sessionId}:${messageId}`,
      reqId,
      requirementVersion: outcome.requirementVersion ?? 0,
      answer: text,
      at,
    }
    appendSessionEvent(session, FORGELOOP_ANSWER_EVENT, answer as unknown as Record<string, unknown>, this.log)
    this.appendAnalysis(session, reqId, outcome.analysis, at)
    this.appendClarificationIfNeeded(session, reqId, outcome.analysis, at)
    // 方案与实现由协调器自动排入研发 Agent；人类会话不再直接调用旧规划入口，
    // 否则会并行生成第二份任务包并把需求打回 plan_proposed。
  }

  /** 需求分析完成且无待澄清项后交给研发 Agent 拆解任务；拆解本身不等于批准或执行。 */
  private async planIfReady(
    session: SessionViewLike | undefined,
    reqId: string,
    analysis: RequirementAnalysis,
    signal: AbortSignal | undefined,
    at: string,
  ): Promise<void> {
    if (analysis.clarifications.length > 0) return
    let outcome: Awaited<ReturnType<ForgeLoopRuntime['planDevTasks']>>
    try {
      outcome = await this.runtime.planDevTasks(reqId, signal)
    } catch (error) {
      this.appendError(session, `forgeloop:error:${reqId}:plan`, reqId, `研发 Agent 任务拆解异常：${(error as Error).message}`, at)
      return
    }
    if (!outcome.ok || !outcome.plan) {
      this.appendError(session, `forgeloop:error:${reqId}:plan`, reqId, outcome.message, at)
      return
    }
    const plan: PlanEventData = {
      eventId: `forgeloop:plan:${reqId}:v${outcome.plan.planVersion}`,
      reqId,
      planVersion: outcome.plan.planVersion,
      requirementVersion: outcome.plan.requirementVersion,
      technicalSolution: outcome.plan.technicalSolution ?? null,
      tasks: outcome.plan.tasks.map((task) => ({
        taskId: task.taskId,
        goal: task.goal,
        files: task.files,
        acceptance: task.acceptance,
        testCommand: task.testCommand,
        dependsOn: task.dependsOn,
        ...(task.verification === true ? { verification: true } : {}),
      })),
      at,
    }
    appendSessionEvent(session, FORGELOOP_PLAN_EVENT, plan as unknown as Record<string, unknown>, this.log)
  }

  private appendClarificationIfNeeded(
    session: SessionViewLike | undefined,
    reqId: string,
    analysis: RequirementAnalysis,
    at: string,
  ): void {
    if (analysis.clarifications.length === 0) return
    const data: ClarificationEventData = {
      eventId: `forgeloop:clarification:${reqId}:v${analysis.analysisVersion}`,
      reqId,
      requirementVersion: analysis.requirementVersion,
      analysisVersion: analysis.analysisVersion,
      questions: analysis.clarifications,
      at,
    }
    appendSessionEvent(session, FORGELOOP_CLARIFICATION_EVENT, data as unknown as Record<string, unknown>, this.log)
  }

  private appendAnalysis(
    session: SessionViewLike | undefined,
    reqId: string,
    analysis: RequirementAnalysis,
    at: string,
  ): void {
    const data: AnalysisEventData = {
      eventId: `forgeloop:analysis:${reqId}:v${analysis.analysisVersion}`,
      reqId,
      analysisVersion: analysis.analysisVersion,
      requirementVersion: analysis.requirementVersion,
      goal: analysis.goal,
      scenarios: analysis.scenarios,
      acceptanceCriteria: analysis.acceptanceCriteria,
      clarifications: analysis.clarifications,
      at,
    }
    appendSessionEvent(session, FORGELOOP_ANALYSIS_EVENT, data as unknown as Record<string, unknown>, this.log)
  }

  private appendError(
    session: SessionViewLike | undefined,
    eventId: string,
    reqId: string,
    message: string,
    at: string,
  ): void {
    const data: ErrorEventData = { eventId, reqId, message, at }
    appendSessionEvent(session, FORGELOOP_ERROR_EVENT, data as unknown as Record<string, unknown>, this.log)
  }

  private reqIdOf(view: unknown): string {
    const data = view as AnyRecord | undefined
    const reqId = data?.reqId
    return typeof reqId === 'string' ? reqId : ''
  }
}
