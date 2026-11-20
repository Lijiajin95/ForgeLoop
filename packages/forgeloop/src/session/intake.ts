import { asRecord } from '../domain/json.js'
import type { ForgeLoopConfig } from '../config.js'
import { errorMessage } from '../domain/errors.js'
import { documentDirectiveOf, documentIntakeResultOf } from '../domain/design-document.js'
import { designDocumentIntakeOf } from '../runtime/design-document-intake.js'
import type { OperationResult } from '../runtime/operation-result.js'
import type { RequirementAnalysis } from '../domain/requirement.js'
import { inputKindOf } from '../domain/requirement.js'
import type { ForgeLoopRuntime } from '../runtime/service.js'
import {
  FORGELOOP_ANALYSIS_EVENT,
  FORGELOOP_ANSWER_EVENT,
  FORGELOOP_CLARIFICATION_EVENT,
  FORGELOOP_ERROR_EVENT,
  FORGELOOP_INTAKE_EVENT,
  appendSessionEvent,
  type AnalysisEventData,
  type AnswerEventData,
  type ClarificationEventData,
  type ErrorEventData,
  type IntakeEventData,
  type SessionEventLogger,
} from './events.js'

type AnyRecord = Record<string, unknown>

export const FORGELOOP_PRESET_ID = 'forgeloop'
export const FORGELOOP_PRESET_NAME = 'ForgeLoop 业务会话'
export const FORGELOOP_PRESET_DESCRIPTION =
  '描述业务目标或问题；ForgeLoop 会把它拆解为需求并交给产品 Agent 分析，不进入普通聊天。'

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
  readonly signal?: AbortSignal | undefined
}

export type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: readonly unknown[] }

export type PreStepNext = () => Promise<PreStepDecision>

export interface SessionIntakeOptions {
  readonly runtime: ForgeLoopRuntime
  readonly config: ForgeLoopConfig
  readonly log?: SessionEventLogger
  readonly now?: () => Date
  readonly presetOf?: ((agent: AgentViewLike) => string | undefined) | undefined
}

export function isForgeLoopSession(
  agent: AgentViewLike | undefined,
  presetOf?: (agent: AgentViewLike) => string | undefined,
): boolean {
  if (!agent) return false
  const header = agent.session?.header
  if (!header) return false
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
    const record = asRecord(message)
    return record?.role === 'user' && asRecord(record.source)?.kind === 'user'
  })
}

export function messageText(message: UserMessageLike): string {
  return textOfContent(message.content)
}

export type IntakeDirective =
  | { readonly kind: 'new'; readonly text: string }
  | {
      readonly kind: 'answer'
      readonly reqId: string
      readonly questionIds: readonly string[]
      readonly text: string
    }
  | { readonly kind: 'auto'; readonly text: string }

const NEW_REQUIREMENT_PREFIX = /^\s*(?:新需求|新问题|新缺陷)\s*[：:]\s*/i
/** 支持“回答 req-x：…”与“回答 req-x [Q1-1,Q1-2]：…”，编号必须显式可回查。 */
const ANSWER_TARGET_PREFIX =
  /^\s*(?:回答|答复|澄清)\s*(req-[A-Za-z0-9-]+)\s*(?:\[([^\]]*)\]|((?:\s*Q\d+-\d+)+))?\s*[：:]\s*/i

function questionIdsOf(bracket: string | undefined, repeated: string | undefined): string[] {
  const source = bracket ?? repeated ?? ''
  return [...new Set(source.match(/Q\d+-\d+/gi) ?? [])].map((id) => id.toUpperCase())
}

export function parseIntakeDirective(text: string): IntakeDirective {
  const answer = ANSWER_TARGET_PREFIX.exec(text)
  if (answer) {
    return {
      kind: 'answer',
      reqId: answer[1] ?? '',
      questionIds: questionIdsOf(answer[2], answer[3]),
      text: text.slice(answer[0].length).trim(),
    }
  }
  const next = NEW_REQUIREMENT_PREFIX.exec(text)
  if (next) {
    return { kind: 'new', text: text.slice(next[0].length).trim() }
  }
  return { kind: 'auto', text }
}

export class SessionIntake {
  private readonly runtime: ForgeLoopRuntime
  private readonly config: ForgeLoopConfig
  private readonly log: SessionEventLogger
  private readonly now: () => Date
  private readonly presetOf: ((agent: AgentViewLike) => string | undefined) | undefined
  private readonly processed = new Set<string>()

  constructor(options: SessionIntakeOptions) {
    this.runtime = options.runtime
    this.config = options.config
    this.log = options.log ?? (() => undefined)
    this.now = options.now ?? (() => new Date())
    this.presetOf = options.presetOf
  }

  async handlePreStep(payload: PreStepPayloadLike, next: PreStepNext): Promise<PreStepDecision> {
    const agent = payload.agent
    if (!isForgeLoopSession(agent, this.presetOf)) return next()

    const messages = humanMessages(payload.messages ?? [])
    if (messages.length === 0) {
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
        this.appendError(session, `forgeloop:error:${payload.turn ?? 0}:${index}`, {
          reqId: '',
          message: `需求受理异常：${errorMessage(error)}`,
          at: this.now().toISOString(),
        })
      }
    }
    return { kind: 'reject' }
  }

  private async intakeOne(input: {
    session: SessionViewLike | undefined
    message: UserMessageLike
    index: number
    turn: number
    signal?: AbortSignal | undefined
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
      this.appendError(session, `forgeloop:error:${dedupeKey}`, {
        reqId: '',
        message: '输入没有可受理的文本内容',
        at,
      })
      return
    }

    const directive = parseIntakeDirective(text)
    const pending = this.runtime.pendingClarifications(sessionId)
    const target = { session, sessionId, messageId, turn: input.turn, signal: input.signal, at }
    if (directive.kind === 'new') {
      const document = documentDirectiveOf(directive.text)
      if (document) {
        await this.submitDocument({ ...target, path: document.path, text: directive.text })
        return
      }
      await this.submitNewDirective({ ...target, text: directive.text, dedupeKey })
      return
    }
    if (directive.kind === 'answer') {
      await this.answerDirective({ ...target, directive, pending, dedupeKey })
      return
    }
    const document = documentDirectiveOf(text)
    if (document) {
      await this.submitDocument({ ...target, path: document.path, text })
      return
    }
    if (pending.length > 1) {
      this.appendError(session, `forgeloop:error:${dedupeKey}`, {
        reqId: '',
        message: `本会话有 ${pending.length} 条需求等待澄清；请用“回答 <需求编号>：<回答>”指定对象，或写成“新需求：<内容>”提交独立需求。待回答：${pending
          .map((item) => item.reqId)
          .join('、')}`,
        at,
      })
      return
    }
    const only = pending[0]
    if (only) {
      await this.answerToTarget({ ...target, text, reqId: only.reqId, pending: only })
      return
    }
    await this.submitOne({ ...target, text })
  }

  private async submitNewDirective(input: {
    session: SessionViewLike | undefined
    sessionId: string
    messageId: string
    turn: number
    signal?: AbortSignal | undefined
    at: string
    text: string
    dedupeKey: string
  }): Promise<void> {
    if (!input.text) {
      this.appendError(input.session, `forgeloop:error:${input.dedupeKey}`, {
        reqId: '',
        message: '新需求入口后没有内容；请写成“新需求：<内容>”',
        at: input.at,
      })
      return
    }
    await this.submitOne({
      session: input.session,
      sessionId: input.sessionId,
      messageId: input.messageId,
      text: input.text,
      turn: input.turn,
      signal: input.signal,
      at: input.at,
    })
  }

  private async answerDirective(input: {
    session: SessionViewLike | undefined
    sessionId: string
    messageId: string
    turn: number
    signal?: AbortSignal | undefined
    at: string
    dedupeKey: string
    directive: Extract<IntakeDirective, { kind: 'answer' }>
    pending: Awaited<ReturnType<ForgeLoopRuntime['pendingClarifications']>>
  }): Promise<void> {
    const target = input.pending.find((item) => item.reqId === input.directive.reqId)
    if (!target) {
      this.appendError(input.session, `forgeloop:error:${input.dedupeKey}`, {
        reqId: input.directive.reqId,
        message:
          input.pending.length === 0
            ? `需求 ${input.directive.reqId} 当前没有待澄清项；如需提交新需求，请写成“新需求：<内容>”`
            : `需求 ${input.directive.reqId} 不在本会话待澄清列表中；当前待回答需求：${input.pending
                .map((item) => item.reqId)
                .join('、')}`,
        at: input.at,
      })
      return
    }
    if (!input.directive.text) {
      this.appendError(input.session, `forgeloop:error:${input.dedupeKey}`, {
        reqId: target.reqId,
        message: '澄清回答入口后没有内容；请写成“回答 <需求编号>：<回答>”',
        at: input.at,
      })
      return
    }
    const invalid = input.directive.questionIds.filter((id) => !target.questionIds.includes(id))
    if (invalid.length > 0) {
      this.appendError(input.session, `forgeloop:error:${input.dedupeKey}`, {
        reqId: target.reqId,
        message: `问题 ${invalid.join('、')} 不是当前开放问题；仍待回答：${target.questionIds.join('、')}`,
        at: input.at,
      })
      return
    }
    await this.answerToTarget({
      session: input.session,
      sessionId: input.sessionId,
      messageId: input.messageId,
      turn: input.turn,
      signal: input.signal,
      at: input.at,
      text: input.directive.text,
      reqId: target.reqId,
      pending: target,
      questionIds:
        input.directive.questionIds.length > 0 ? input.directive.questionIds : target.questionIds,
    })
  }

  private async answerToTarget(input: {
    session: SessionViewLike | undefined
    sessionId: string
    messageId: string
    turn: number
    signal?: AbortSignal | undefined
    at: string
    text: string
    reqId: string
    pending: { questionIds: readonly string[]; questions: readonly string[] }
    questionIds?: readonly string[]
  }): Promise<void> {
    await this.answerOne({
      session: input.session,
      sessionId: input.sessionId,
      messageId: input.messageId,
      text: input.text,
      turn: input.turn,
      signal: input.signal,
      reqId: input.reqId,
      questionIds: input.questionIds ?? input.pending.questionIds,
      questions: input.pending.questions,
      at: input.at,
    })
  }

  private async submitOne(input: {
    session: SessionViewLike | undefined
    sessionId: string
    messageId: string
    text: string
    turn: number
    signal?: AbortSignal | undefined
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
        analyze: false,
      })
    } catch (error) {
      this.appendError(session, `forgeloop:error:${sessionId}:${messageId}`, {
        reqId: '',
        message: `需求受理异常：${errorMessage(error)}`,
        at: at,
      })
      return
    }
    if (!submitted.ok) {
      this.appendError(session, `forgeloop:error:${sessionId}:${messageId}`, {
        reqId: '',
        message: submitted.message,
        at: at,
      })
      return
    }
    const reqId = this.reqIdOf(submitted.data)
    if (!reqId) {
      this.appendError(session, `forgeloop:error:${sessionId}:${messageId}`, {
        reqId: '',
        message: '需求已写入但没有返回身份',
        at: at,
      })
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
    appendSessionEvent(session, FORGELOOP_INTAKE_EVENT, intake, this.log)
    await this.analyzeAndShow({ session, reqId, at, signal: input.signal })
    // 否则会并行生成第二份任务包并把需求打回 plan_proposed。
  }

  private async submitDocument(input: {
    session: SessionViewLike | undefined
    sessionId: string
    messageId: string
    turn: number
    signal?: AbortSignal | undefined
    at: string
    path: string
    text: string
  }): Promise<void> {
    const { session, sessionId, messageId, at } = input
    const source = `dsh-session:${sessionId}:${messageId}`
    let submitted: OperationResult
    try {
      submitted = designDocumentIntakeOf(this.runtime, () => this.now().toISOString()).intake({
        path: input.path,
        by: this.config.owner,
        source,
        clientKey: source,
        analyze: false,
      })
    } catch (error) {
      this.appendError(session, `forgeloop:error:${sessionId}:${messageId}`, {
        reqId: '',
        message: `设计文档受理异常：${errorMessage(error)}`,
        at,
      })
      return
    }
    if (!submitted.ok) {
      this.appendError(session, `forgeloop:error:${sessionId}:${messageId}`, {
        reqId: '',
        message: submitted.message,
        at,
      })
      return
    }
    const data = documentIntakeResultOf(submitted.data)
    if (!data) {
      this.appendError(session, `forgeloop:error:${sessionId}:${messageId}`, {
        reqId: '',
        message: '设计文档已写入但没有返回需求身份',
        at,
      })
      return
    }
    const intake: IntakeEventData = {
      eventId: `forgeloop:intake:${sessionId}:${messageId}`,
      reqId: data.reqId,
      text: input.text,
      sessionId,
      messageId,
      turn: input.turn,
      status: data.outcome === 'duplicate' ? 'duplicate' : 'accepted',
      document: { ...data.document, outcome: data.outcome },
      at,
    }
    appendSessionEvent(session, FORGELOOP_INTAKE_EVENT, intake, this.log)
    if (data.outcome === 'duplicate') return
    await this.analyzeAndShow({ session, reqId: data.reqId, at, signal: input.signal })
  }

  private async analyzeAndShow(input: {
    session: SessionViewLike | undefined
    reqId: string
    at: string
    signal?: AbortSignal | undefined
  }): Promise<void> {
    const { session, reqId, at } = input
    let outcome: Awaited<ReturnType<ForgeLoopRuntime['analyzeRequirement']>>
    try {
      outcome = await this.runtime.analyzeRequirement(reqId, input.signal)
    } catch (error) {
      this.appendError(session, `forgeloop:error:${reqId}`, {
        reqId: reqId,
        message: `需求分析异常：${errorMessage(error)}`,
        at: at,
      })
      return
    }
    if (!outcome.ok || !outcome.analysis) {
      this.appendError(session, `forgeloop:error:${reqId}`, {
        reqId: reqId,
        message: outcome.message,
        at: at,
      })
      return
    }
    this.appendAnalysis(session, reqId, outcome.analysis, at)
    this.appendClarificationIfNeeded(session, reqId, outcome.analysis, at)
    this.enqueueIfReady(reqId, outcome.analysis)
  }

  private async answerOne(input: {
    session: SessionViewLike | undefined
    sessionId: string
    messageId: string
    text: string
    turn: number
    signal?: AbortSignal | undefined
    reqId: string
    questionIds: readonly string[]
    questions: readonly string[]
    at: string
  }): Promise<void> {
    const { session, sessionId, messageId, text, at, reqId } = input
    const source = `dsh-session:${sessionId}:${messageId}`
    let outcome: Awaited<ReturnType<ForgeLoopRuntime['answerClarifications']>>
    try {
      outcome = await this.runtime.answerClarifications({
        reqId,
        answer: text,
        by: this.config.owner,
        source,
        questionIds: input.questionIds,
        signal: input.signal,
      })
    } catch (error) {
      this.appendError(session, `forgeloop:error:${reqId}`, {
        reqId: reqId,
        message: `澄清回答异常：${errorMessage(error)}`,
        at: at,
      })
      return
    }
    if (!outcome.ok || !outcome.analysis) {
      this.appendError(session, `forgeloop:error:${reqId}`, {
        reqId: reqId,
        message: outcome.message,
        at: at,
      })
      return
    }
    const answeredIds = outcome.answeredQuestionIds ?? input.questionIds
    const answer: AnswerEventData = {
      eventId: `forgeloop:answer:${sessionId}:${messageId}`,
      reqId,
      requirementVersion: outcome.requirementVersion ?? 0,
      answer: text,
      questionIds: answeredIds,
      questions: answeredIds.map((id) => input.questions[input.questionIds.indexOf(id)] ?? id),
      at,
    }
    appendSessionEvent(session, FORGELOOP_ANSWER_EVENT, answer, this.log)
    this.appendAnalysis(session, reqId, outcome.analysis, at)
    this.appendClarificationIfNeeded(session, reqId, outcome.analysis, at)
    this.enqueueIfReady(reqId, outcome.analysis)
    // 否则会并行生成第二份任务包并把需求打回 plan_proposed。
  }

  private enqueueIfReady(reqId: string, analysis: RequirementAnalysis): void {
    if (analysis.clarifications.length > 0) return
    const outcome = this.runtime.analysisQueue.enqueue(reqId)
    if (!outcome.ok) this.log(`[forgeloop] 需求 ${reqId} 入队失败：${outcome.message}`)
  }

  private appendClarificationIfNeeded(
    session: SessionViewLike | undefined,
    reqId: string,
    analysis: RequirementAnalysis,
    at: string,
  ): void {
    if (analysis.clarifications.length === 0) return
    const open = this.runtime.openClarifications(reqId)
    const data: ClarificationEventData = {
      eventId: `forgeloop:clarification:${reqId}:v${analysis.analysisVersion}`,
      reqId,
      requirementVersion: analysis.requirementVersion,
      analysisVersion: analysis.analysisVersion,
      questions: analysis.clarifications,
      questionIds: open.map((question) => question.questionId),
      hint: `直接回复按澄清回答处理；如需提交独立需求，请写成“新需求：<内容>”。本会话有多条待澄清或只想回答部分问题时，用“回答 ${reqId} [Q1-1]：<回答>”指定对象。`,
      at,
    }
    appendSessionEvent(session, FORGELOOP_CLARIFICATION_EVENT, data, this.log)
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
      inputKind: inputKindOf(analysis),
      goal: analysis.goal,
      scenarios: analysis.scenarios,
      businessRules: analysis.businessRules ?? [],
      exceptions: analysis.exceptions ?? [],
      nonGoals: analysis.nonGoals ?? [],
      acceptanceCriteria: analysis.acceptanceCriteria,
      clarifications: analysis.clarifications,
      model: analysis.model ?? '',
      promptVersion: analysis.promptVersion ?? '',
      toolCalls: analysis.toolCalls ?? [],
      at,
    }
    appendSessionEvent(session, FORGELOOP_ANALYSIS_EVENT, data, this.log)
  }

  private appendError(
    session: SessionViewLike | undefined,
    eventId: string,
    detail: { reqId: string; message: string; at: string },
  ): void {
    const { reqId, message, at } = detail
    const data: ErrorEventData = { eventId, reqId, message, at }
    appendSessionEvent(session, FORGELOOP_ERROR_EVENT, data, this.log)
  }

  private reqIdOf(view: unknown): string {
    const data = asRecord(view)
    const reqId = data?.reqId
    return typeof reqId === 'string' ? reqId : ''
  }
}
