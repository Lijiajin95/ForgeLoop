/**
 * 任务执行过程读取：把 AgentRunner 落盘的 dev.jsonl 解析成可公开的会话事件。
 *
 * 只暴露用户/助手公开文本、工具调用及结果、阶段事件；不读取或展示 reasoning 块。
 * 事件按原始 seq/time 排序，调用与结果按 callId 关联；分页只切公开事件，原始文件不被改写。
 */

type JsonRecord = Record<string, unknown>

export interface ExecutionTool {
  readonly callId: string
  readonly name: string
  readonly input: string
  readonly output: string
  readonly isError: boolean
  readonly status: 'pending' | 'completed' | 'failed'
  readonly inputTruncated: boolean
  readonly outputTruncated: boolean
}

export interface ExecutionEvent {
  readonly id: string
  readonly seq: number
  readonly at: string
  readonly kind: 'message' | 'tool' | 'phase'
  readonly role: 'user' | 'assistant' | 'tool' | 'system' | 'phase'
  readonly title: string
  readonly text: string
  readonly textTruncated: boolean
  readonly tool?: ExecutionTool
}

export interface ExecutionPage {
  readonly events: readonly ExecutionEvent[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly truncated: boolean
  readonly stepCount: number
  readonly startedAt: string
  readonly lastActivity: string
  readonly sessionIds: readonly string[]
}

const MAX_TEXT = 8000

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const record = asRecord(block)
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT) return { text, truncated: false }
  return { text: text.slice(-MAX_TEXT), truncated: true }
}

function atOf(value: unknown): string {
  const time = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(time) || time <= 0) return ''
  return new Date(time).toISOString()
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0
}

interface CallState {
  readonly callId: string
  readonly seq: number
  readonly time: number
  readonly name: string
  readonly input: string
  readonly inputTruncated: boolean
  result?: { output: string; isError: boolean; time: number }
}

type ToolResultState = { output: string; isError: boolean; time: number; seq: number }

interface ParseState {
  drafts: ExecutionEvent[]
  readonly calls: Map<string, CallState>
  readonly results: Map<string, ToolResultState>
  readonly sessionIds: Set<string>
  stepCount: number
  firstTime: number
  lastTime: number
}

function emptyState(): ParseState {
  return {
    drafts: [],
    calls: new Map(),
    results: new Map(),
    sessionIds: new Set(),
    stepCount: 0,
    firstTime: Number.POSITIVE_INFINITY,
    lastTime: 0,
  }
}

function messageEvent(input: {
  prefix: string
  role: 'assistant' | 'user'
  title: string
  text: string
  seq: number
  time: number
}): ExecutionEvent {
  const { prefix, role, title, text, seq, time } = input
  const clipped = clip(text)
  return {
    id: `${prefix}:${seq}`,
    seq: finiteOrZero(seq),
    at: atOf(time),
    kind: 'message',
    role,
    title,
    text: clipped.text,
    textTruncated: clipped.truncated,
  }
}

function phaseEvent(type: string, seq: number, time: number): ExecutionEvent {
  const title =
    type === 'turn/start' ? '回合开始' : type === 'turn/end' ? '回合结束' : '工作副本变更'
  return {
    id: `phase:${type}:${seq}`,
    seq: finiteOrZero(seq),
    at: atOf(time),
    kind: 'phase',
    role: 'phase',
    title,
    text: '',
    textTruncated: false,
  }
}

function consumeAssistant(
  data: JsonRecord | undefined,
  seq: number,
  time: number,
  state: ParseState,
): void {
  const message = asRecord(data?.message)
  const text = textOfContent(message?.content)
  if (text)
    state.drafts.push(
      messageEvent({ prefix: 'message', role: 'assistant', title: '公开消息', text, seq, time }),
    )
}

function consumeUser(
  data: JsonRecord | undefined,
  seq: number,
  time: number,
  state: ParseState,
): void {
  const text = textOfContent(data?.content)
  // DSH 在回合中追加的运行上下文/提醒不是业务公开消息，避免淹没任务输入与工具调用。
  if (
    /^<system-reminder>|^Current runtime context\.|^Time sampled while preparing turn/.test(
      text.trim(),
    )
  ) {
    return
  }
  if (text)
    state.drafts.push(
      messageEvent({ prefix: 'user', role: 'user', title: '任务输入', text, seq, time }),
    )
}

function consumeToolCall(
  data: JsonRecord | undefined,
  seq: number,
  time: number,
  state: ParseState,
): void {
  const callId = typeof data?.callId === 'string' ? data.callId : ''
  if (!callId) return
  const name = typeof data?.name === 'string' ? data.name : 'tool'
  const input =
    typeof data?.arguments === 'string' ? data.arguments : JSON.stringify(data?.arguments ?? '')
  const clipped = clip(input)
  state.calls.set(callId, {
    callId,
    seq: finiteOrZero(seq),
    time: finiteOrZero(time),
    name,
    input: clipped.text,
    inputTruncated: clipped.truncated,
  })
}

function consumeToolResult(
  data: JsonRecord | undefined,
  seq: number,
  time: number,
  state: ParseState,
): void {
  const callId = typeof data?.toolCallId === 'string' ? data.toolCallId : ''
  if (!callId) return
  const message = asRecord(data?.message)
  state.results.set(callId, {
    output: textOfContent(message?.content),
    isError: message?.isError === true,
    time: finiteOrZero(time),
    seq: finiteOrZero(seq),
  })
}

function noteEvent(
  event: JsonRecord,
  data: JsonRecord | undefined,
  time: number,
  state: ParseState,
): void {
  if (Number.isFinite(time) && time > 0) {
    state.firstTime = Math.min(state.firstTime, time)
    state.lastTime = Math.max(state.lastTime, time)
  }
  if (typeof event.sessionId === 'string') state.sessionIds.add(event.sessionId)
  if (typeof data?.sessionId === 'string') state.sessionIds.add(data.sessionId)
}

function consumeEvent(event: JsonRecord, state: ParseState): void {
  const type = typeof event.type === 'string' ? event.type : ''
  const seq = typeof event.seq === 'number' ? event.seq : Number(event.seq)
  const time = typeof event.time === 'number' ? event.time : Number(event.time)
  const data = asRecord(event.data)
  noteEvent(event, data, time, state)

  switch (type) {
    case 'step/start':
      state.stepCount += 1
      return
    case 'assistant/message':
      consumeAssistant(data, seq, time, state)
      return
    case 'user/message':
      consumeUser(data, seq, time, state)
      return
    case 'tool/call':
      consumeToolCall(data, seq, time, state)
      return
    case 'tool/result':
      consumeToolResult(data, seq, time, state)
      return
    case 'turn/start':
    case 'turn/end':
    case 'workspace/changes':
      state.drafts.push(phaseEvent(type, seq, time))
      return
    default:
      return
  }
}

function appendToolEvents(state: ParseState): void {
  for (const call of state.calls.values()) {
    const result = state.results.get(call.callId)
    const output = clip(result?.output ?? '')
    const isError = result?.isError ?? false
    state.drafts.push({
      id: `tool:${call.callId}`,
      seq: call.seq,
      at: atOf(call.time),
      kind: 'tool',
      role: 'tool',
      title: call.name,
      text: '',
      textTruncated: false,
      tool: {
        callId: call.callId,
        name: call.name,
        input: call.input,
        output: output.text,
        isError,
        status: result ? (isError ? 'failed' : 'completed') : 'pending',
        inputTruncated: call.inputTruncated,
        outputTruncated: output.truncated,
      },
    })
  }
  for (const [callId, result] of state.results) {
    if (state.calls.has(callId)) continue
    const output = clip(result.output)
    state.drafts.push({
      id: `tool-result:${callId}`,
      seq: result.seq,
      at: atOf(result.time),
      kind: 'tool',
      role: 'tool',
      title: '工具结果（缺少调用记录）',
      text: '',
      textTruncated: false,
      tool: {
        callId,
        name: 'unrecorded',
        input: '',
        output: output.text,
        isError: result.isError,
        status: result.isError ? 'failed' : 'completed',
        inputTruncated: false,
        outputTruncated: output.truncated,
      },
    })
  }
}

function toPage(state: ParseState, offset: number, limit: number): ExecutionPage {
  state.drafts.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
  const total = state.drafts.length
  const page = state.drafts.slice(offset, offset + limit)
  return {
    events: page,
    total,
    offset,
    limit,
    truncated: offset + page.length < total,
    stepCount: state.stepCount,
    startedAt: Number.isFinite(state.firstTime) ? new Date(state.firstTime).toISOString() : '',
    lastActivity: state.lastTime > 0 ? new Date(state.lastTime).toISOString() : '',
    sessionIds: [...state.sessionIds],
  }
}

/**
 * 解析一轮或多轮 dev.jsonl。offset/limit 只作用于最终公开事件数组。
 * 无法解析的行被忽略；调用/结果缺少对端时保留可见记录，不伪造另一方。
 */
export function parseTaskExecution(
  source: string,
  options: { offset?: number | undefined; limit?: number | undefined } = {},
): ExecutionPage {
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 100)))
  const state = emptyState()
  for (const line of source.split('\n')) {
    if (!line.trim()) continue
    let event: JsonRecord
    try {
      event = JSON.parse(line) as JsonRecord
    } catch {
      continue
    }
    consumeEvent(event, state)
  }
  appendToolEvents(state)
  return toPage(state, offset, limit)
}
