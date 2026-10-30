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
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined
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

interface CallState {
  readonly callId: string
  readonly seq: number
  readonly time: number
  readonly name: string
  readonly input: string
  readonly inputTruncated: boolean
  result?: { output: string; isError: boolean; time: number }
}

interface DraftEvent extends ExecutionEvent {}

/**
 * 解析一轮或多轮 dev.jsonl。offset/limit 只作用于最终公开事件数组。
 * 无法解析的行被忽略；调用/结果缺少对端时保留可见记录，不伪造另一方。
 */
export function parseTaskExecution(
  source: string,
  options: { offset?: number; limit?: number } = {},
): ExecutionPage {
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 100)))
  const drafts: DraftEvent[] = []
  const calls = new Map<string, CallState>()
  const results = new Map<string, { output: string; isError: boolean; time: number; seq: number }>()
  const sessionIds = new Set<string>()
  let stepCount = 0
  let firstTime = Number.POSITIVE_INFINITY
  let lastTime = 0

  for (const line of source.split('\n')) {
    if (!line.trim()) continue
    let event: JsonRecord
    try {
      event = JSON.parse(line) as JsonRecord
    } catch {
      continue
    }
    const type = typeof event.type === 'string' ? event.type : ''
    const seq = typeof event.seq === 'number' ? event.seq : Number(event.seq)
    const time = typeof event.time === 'number' ? event.time : Number(event.time)
    if (Number.isFinite(time) && time > 0) {
      firstTime = Math.min(firstTime, time)
      lastTime = Math.max(lastTime, time)
    }
    const data = asRecord(event.data)
    if (typeof event.sessionId === 'string') sessionIds.add(event.sessionId)
    if (typeof data?.sessionId === 'string') sessionIds.add(data.sessionId)

    if (type === 'step/start') {
      stepCount += 1
      continue
    }
    if (type === 'assistant/message') {
      const message = asRecord(data?.message)
      const text = textOfContent(message?.content)
      if (text) {
        const clipped = clip(text)
        drafts.push({
          id: `message:${seq}`,
          seq: Number.isFinite(seq) ? seq : 0,
          at: atOf(time),
          kind: 'message',
          role: 'assistant',
          title: '公开消息',
          text: clipped.text,
          textTruncated: clipped.truncated,
        })
      }
      continue
    }
    if (type === 'user/message') {
      const text = textOfContent(data?.content)
      // DSH 在回合中追加的运行上下文/提醒不是业务公开消息，避免淹没任务输入与工具调用。
      if (/^<system-reminder>|^Current runtime context\.|^Time sampled while preparing turn/.test(text.trim())) continue
      if (text) {
        const clipped = clip(text)
        drafts.push({
          id: `user:${seq}`,
          seq: Number.isFinite(seq) ? seq : 0,
          at: atOf(time),
          kind: 'message',
          role: 'user',
          title: '任务输入',
          text: clipped.text,
          textTruncated: clipped.truncated,
        })
      }
      continue
    }
    if (type === 'tool/call') {
      const callId = typeof data?.callId === 'string' ? data.callId : ''
      const name = typeof data?.name === 'string' ? data.name : 'tool'
      const input = typeof data?.arguments === 'string' ? data.arguments : JSON.stringify(data?.arguments ?? '')
      if (!callId) continue
      const clipped = clip(input)
      calls.set(callId, {
        callId,
        seq: Number.isFinite(seq) ? seq : 0,
        time: Number.isFinite(time) ? time : 0,
        name,
        input: clipped.text,
        inputTruncated: clipped.truncated,
      })
      continue
    }
    if (type === 'tool/result') {
      const callId = typeof data?.toolCallId === 'string' ? data.toolCallId : ''
      const message = asRecord(data?.message)
      const output = textOfContent(message?.content)
      if (!callId) continue
      results.set(callId, {
        output,
        isError: message?.isError === true,
        time: Number.isFinite(time) ? time : 0,
        seq: Number.isFinite(seq) ? seq : 0,
      })
      continue
    }
    if (type === 'turn/start' || type === 'turn/end' || type === 'workspace/changes') {
      drafts.push({
        id: `phase:${type}:${seq}`,
        seq: Number.isFinite(seq) ? seq : 0,
        at: atOf(time),
        kind: 'phase',
        role: 'phase',
        title: type === 'turn/start' ? '回合开始' : type === 'turn/end' ? '回合结束' : '工作副本变更',
        text: '',
        textTruncated: false,
      })
    }
  }

  for (const call of calls.values()) {
    const result = results.get(call.callId)
    const output = clip(result?.output ?? '')
    const isError = result?.isError ?? false
    drafts.push({
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
  for (const [callId, result] of results) {
    if (calls.has(callId)) continue
    const output = clip(result.output)
    drafts.push({
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

  drafts.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
  const total = drafts.length
  const page = drafts.slice(offset, offset + limit)
  return {
    events: page,
    total,
    offset,
    limit,
    truncated: offset + page.length < total,
    stepCount,
    startedAt: Number.isFinite(firstTime) ? new Date(firstTime).toISOString() : '',
    lastActivity: lastTime > 0 ? new Date(lastTime).toISOString() : '',
    sessionIds: [...sessionIds],
  }
}
