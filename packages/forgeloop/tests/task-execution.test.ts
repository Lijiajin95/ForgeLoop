import { describe, expect, it } from 'vitest'
import { parseTaskExecution } from '../src/runtime/task-execution.js'

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

const SOURCE = [
  line({
    type: 'user/message',
    seq: 1,
    time: 1000,
    data: { content: [{ type: 'text', text: '实现任务' }] },
  }),
  line({
    type: 'assistant/message',
    seq: 2,
    time: 2000,
    data: {
      message: {
        content: [
          { type: 'reasoning', text: '隐藏推理不应展示' },
          { type: 'text', text: '我先检查工作区。' },
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' },
        ],
      },
    },
  }),
  line({
    type: 'tool/call',
    seq: 3,
    time: 2001,
    data: { callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' },
  }),
  line({
    type: 'tool/result',
    seq: 4,
    time: 2500,
    data: {
      toolCallId: 'call-1',
      message: { content: [{ type: 'text', text: '/workspace' }], isError: false },
    },
  }),
  line({ type: 'step/start', seq: 5, time: 2600, data: { turn: 1, step: 2 } }),
  line({
    type: 'session-log-deepseek/delivery-accepted',
    seq: 6,
    time: 2700,
    data: { sessionId: 'session-real' },
  }),
  line({ type: 'turn/end', seq: 7, time: 2800, data: {} }),
  'not-json\n',
].join('')

describe('task execution parser', () => {
  it('keeps public text, drops reasoning and pairs tools by call identity', () => {
    const page = parseTaskExecution(SOURCE)
    expect(page.total).toBe(4)
    expect(page.stepCount).toBe(1)
    expect(page.sessionIds).toContain('session-real')
    expect(page.startedAt).toBe(new Date(1000).toISOString())
    expect(page.lastActivity).toBe(new Date(2800).toISOString())
    expect(page.events.map((event) => event.kind)).toEqual(['message', 'message', 'tool', 'phase'])
    const assistant = page.events.find((event) => event.role === 'assistant')!
    expect(assistant.text).toContain('检查工作区')
    expect(JSON.stringify(page)).not.toContain('隐藏推理')
    const tool = page.events.find((event) => event.kind === 'tool')!
    expect(tool.tool).toMatchObject({
      callId: 'call-1',
      name: 'bash',
      status: 'completed',
      isError: false,
    })
    expect(tool.tool?.output).toBe('/workspace')
    expect(page.events.some((event) => event.title === '公开消息')).toBe(true)
  })

  it('pages public events without changing identity and reports truncation', () => {
    const first = parseTaskExecution(SOURCE, { offset: 0, limit: 2 })
    const second = parseTaskExecution(SOURCE, { offset: 2, limit: 2 })
    expect(first.events).toHaveLength(2)
    expect(first.truncated).toBe(true)
    expect(second.offset).toBe(2)
    expect(second.events).toHaveLength(2)
    expect(second.truncated).toBe(false)
    expect(first.events[0]!.seq).toBeLessThan(second.events[0]!.seq)
  })

  it('keeps a pending tool call visible when the result is missing', () => {
    const page = parseTaskExecution(
      line({
        type: 'tool/call',
        seq: 1,
        time: 1,
        data: { callId: 'call-x', name: 'read', arguments: '{}' },
      }),
    )
    expect(page.events[0]?.tool).toMatchObject({ callId: 'call-x', status: 'pending', output: '' })
  })

  it('handles empty content, orphan results, invalid identities and phase events', () => {
    const page = parseTaskExecution(
      [
        line({
          type: 'assistant/message',
          seq: 1,
          time: 1,
          data: { message: { content: 'not-an-array' } },
        }),
        line({
          type: 'assistant/message',
          seq: 2,
          time: 2,
          data: { message: { content: [{ type: 'text', text: '' }] } },
        }),
        line({
          type: 'tool/call',
          seq: 3,
          time: 3,
          data: { callId: '', name: 'ignored', arguments: '{}' },
        }),
        line({
          type: 'tool/result',
          seq: 4,
          time: 4,
          data: {
            toolCallId: 'orphan',
            message: { content: [{ type: 'text', text: 'orphan output' }], isError: true },
          },
        }),
        line({ type: 'turn/start', seq: 5, time: 0, data: {} }),
        line({ type: 'workspace/changes', seq: 6, time: 6, data: {} }),
      ].join(''),
    )
    expect(page.events.map((event) => event.kind)).toEqual(['tool', 'phase', 'phase'])
    expect(page.events[0]?.tool).toMatchObject({
      callId: 'orphan',
      status: 'failed',
      output: 'orphan output',
    })
    expect(page.events[1]?.at).toBe('')
    expect(page.events[2]?.title).toBe('工作副本变更')
  })

  it('does not expose DSH runtime reminders as public user messages', () => {
    const page = parseTaskExecution(
      [
        line({
          type: 'user/message',
          seq: 1,
          time: 1,
          data: { content: [{ type: 'text', text: '公开任务输入' }] },
        }),
        line({
          type: 'user/message',
          seq: 2,
          time: 2,
          data: {
            content: [{ type: 'text', text: '<system-reminder>内部上下文</system-reminder>' }],
          },
        }),
        line({
          type: 'user/message',
          seq: 3,
          time: 3,
          data: { content: [{ type: 'text', text: 'Current runtime context. 不应展示' }] },
        }),
      ].join(''),
    )
    expect(page.events).toHaveLength(1)
    expect(page.events[0]?.text).toBe('公开任务输入')
  })

  it('keeps a truncated tool input and uses the last part of the input', () => {
    const input = 'x'.repeat(9000)
    const page = parseTaskExecution(
      line({
        type: 'tool/call',
        seq: 1,
        time: 1,
        data: { callId: 'call-input', name: 'bash', arguments: input },
      }),
    )
    expect(page.events[0]?.tool?.inputTruncated).toBe(true)
    expect(page.events[0]?.tool?.input).toHaveLength(8000)
  })

  it('marks long tool output truncated but keeps the tail', () => {
    const output = 'x'.repeat(9000)
    const page = parseTaskExecution(
      [
        line({
          type: 'tool/call',
          seq: 1,
          time: 1,
          data: { callId: 'call-long', name: 'bash', arguments: '{}' },
        }),
        line({
          type: 'tool/result',
          seq: 2,
          time: 2,
          data: {
            toolCallId: 'call-long',
            message: { content: [{ type: 'text', text: output }], isError: true },
          },
        }),
      ].join(''),
    )
    expect(page.events[0]?.tool?.outputTruncated).toBe(true)
    expect(page.events[0]?.tool?.output).toHaveLength(8000)
    expect(page.events[0]?.tool?.status).toBe('failed')
  })
})

describe('task execution malformed and fallback fields', () => {
  it('accepts string sequence/time and object arguments, with fallback tool names', () => {
    const page = parseTaskExecution(
      [
        line({
          type: 'tool/call',
          seq: '1',
          time: '1000',
          data: { callId: 'c-1', arguments: { command: 'pwd' } },
        }),
        line({
          type: 'tool/result',
          seq: '2',
          time: '2000',
          data: { toolCallId: 'c-1', message: { content: [], isError: true } },
        }),
      ].join(''),
    )
    expect(page.events[0]?.tool).toMatchObject({
      name: 'tool',
      input: '{"command":"pwd"}',
      status: 'failed',
      isError: true,
    })
    expect(page.startedAt).toBe(new Date(1000).toISOString())
    expect(page.lastActivity).toBe(new Date(2000).toISOString())
  })

  it('ignores calls and results without identities', () => {
    const page = parseTaskExecution(
      [
        line({ type: 'tool/call', seq: 1, time: 1000, data: { name: 'bash' } }),
        line({ type: 'tool/result', seq: 2, time: 2000, data: { message: {} } }),
        line({ type: 'custom', seq: 3, time: 3000, data: { sessionId: 'data-session' } }),
      ].join(''),
    )
    expect(page.total).toBe(0)
    expect(page.sessionIds).toEqual(['data-session'])
  })

  it('records session ids from the event and data envelope', () => {
    const page = parseTaskExecution(
      [
        line({
          type: 'turn/start',
          seq: 1,
          time: 1000,
          sessionId: 'top-session',
          data: { sessionId: 'data-session' },
        }),
      ].join(''),
    )
    expect(page.sessionIds).toEqual(['top-session', 'data-session'])
  })

  it('keeps empty timestamps when no event has a usable time', () => {
    const page = parseTaskExecution(
      [
        line({ type: 'turn/start', seq: 1, time: 0, data: {} }),
        line({ type: 'turn/end', seq: 2, time: 'not-a-time', data: {} }),
      ].join(''),
    )
    expect(page.startedAt).toBe('')
    expect(page.lastActivity).toBe('')
  })

  it('sorts events with the same sequence by identity', () => {
    const page = parseTaskExecution(
      [
        line({ type: 'tool/result', seq: 5, time: 1000, data: { toolCallId: 'z' } }),
        line({ type: 'tool/result', seq: 5, time: 1000, data: { toolCallId: 'a' } }),
      ].join(''),
    )
    expect(page.events.map((event) => event.id)).toEqual(['tool-result:a', 'tool-result:z'])
  })
})
