/**
 * DSH 宿主内 Agent 执行器：在本进程创建独立 Agent、投递一次任务、等待回合结束，
 * 读取该会话自己的事件日志，保存可回查轨迹。
 *
 * 这是真实的 DSH Agent（不是旧 Python 业务核心，也不是自建对话壳）：
 * 模型、工具、权限与会话生命周期都由宿主提供；本模块只负责投递、等待、取消与取证。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentConfig } from '../config.js'
import type { AgentIdentity } from '../domain/agents.js'

type AnyRecord = Record<string, unknown>

export interface AgentRunRequest {
  readonly role: AgentIdentity
  readonly cwd: string
  readonly prompt: string
  readonly permission: 'workspace-write' | 'danger-full-access'
  readonly timeoutMs: number
  readonly transcriptPath: string
  readonly signal?: AbortSignal
  /** 'none' 用于只做推理的阶段：不给 Agent 任何工具，避免无界探索。 */
  readonly tools?: 'none' | 'default'
  /** 运行中周期性回报当前事件快照，供任务心跳与详情页使用。 */
  readonly onActivity?: (events: readonly AnyRecord[]) => void
}

export interface AgentOpenRequest {
  readonly role: AgentIdentity
  readonly cwd: string
  readonly permission: 'workspace-write' | 'danger-full-access'
  readonly tools?: 'none' | 'default'
}

export interface AgentTurnRequest {
  readonly prompt: string
  readonly timeoutMs: number
  readonly transcriptPath: string
  readonly signal?: AbortSignal
  readonly onActivity?: (events: readonly AnyRecord[]) => void
}

/** 同一身份的一段连续工作：多轮 send 共享会话、工作目录与上下文。 */
export interface AgentSession {
  readonly sessionId: string
  send(turn: AgentTurnRequest): Promise<AgentRunResult>
  close(): Promise<void>
}

export interface AgentRunResult {
  readonly status: 'completed' | 'aborted' | 'timeout' | 'error'
  readonly text: string
  readonly sessionId: string
  readonly reason: string
  readonly transcriptPath: string
  readonly durationMs: number
  readonly toolCalls: readonly string[]
}

export interface AgentRunnerOptions {
  readonly ctx: AnyRecord
  readonly agent: AgentConfig
}

interface AgentView {
  readonly id: string
  readonly session: SessionView
  followup(message: unknown): void
  whenIdle(): Promise<void>
  cancel(cause: unknown, options?: unknown): void
}

interface SessionView {
  ownEvents(): readonly AnyRecord[]
}

function serviceOf(ctx: AnyRecord, name: string): unknown {
  const getter = ctx.get
  if (typeof getter === 'function') return (getter as (key: string) => unknown).call(ctx, name)
  return ctx[name]
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

function extractAssistantText(events: readonly AnyRecord[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.type !== 'assistant/message') continue
    const data = event.data as AnyRecord | undefined
    const message = data?.message as AnyRecord | undefined
    const text = textOfContent(message?.content)
    if (text) return text
  }
  return ''
}

function extractTurnEnd(events: readonly AnyRecord[]): { kind: string; detail: string } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.type !== 'turn/end') continue
    const data = event.data as AnyRecord | undefined
    const reason = data?.reason as AnyRecord | undefined
    const kind = typeof reason?.kind === 'string' ? reason.kind : ''
    const error = reason?.error as AnyRecord | undefined
    const message = typeof error?.message === 'string' ? error.message : ''
    return { kind, detail: message }
  }
  return { kind: '', detail: '回合未给出结束原因' }
}

function toolCallsOf(events: readonly AnyRecord[]): string[] {
  const names: string[] = []
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = event.data as AnyRecord | undefined
    if (typeof data?.name === 'string') names.push(data.name)
  }
  return names
}

export class AgentRunner {
  private readonly ctx: AnyRecord
  private readonly agent: AgentConfig

  constructor(options: AgentRunnerOptions) {
    this.ctx = options.ctx
    this.agent = options.agent
  }

  /** 解析实际使用的 provider/model：配置显式给出优先，否则用宿主默认选择。 */
  resolveSelection(): { provider: string; model: string } {
    if (this.agent.provider && this.agent.model) {
      return { provider: this.agent.provider, model: this.agent.model }
    }
    const service = serviceOf(this.ctx, 'agentDefaultModel') as
      | { currentSelection(): { provider?: string; model?: string } }
      | undefined
    const selection = service?.currentSelection()
    if (!selection?.provider || !selection.model) {
      throw new Error(
        '没有可用的模型选择：请在插件配置 agent.provider/agent.model 指定，或确保宿主提供默认模型',
      )
    }
    return { provider: selection.provider, model: selection.model }
  }

  /**
   * 打开一段连续会话：不再每轮新建 Agent，供同一需求的技术方案、实现、自验、
   * 修复或验证阶段复用上下文与工作目录。宿主重启后会话不存在，依据持久证据恢复。
   */
  async open(request: AgentOpenRequest): Promise<AgentSession> {
    const selection = this.resolveSelection()
    const sessionId = `session-fl-${request.role}-${randomUUID()}`
    const agents = this.ctx.agents as { create(options: AnyRecord): Promise<{ agent: AgentView; dispose(): Promise<void> }> }
    const tools = serviceOf(this.ctx, 'tools') as
      | { schemas(scope?: unknown): Array<{ name?: string }> }
      | undefined
    const presetId = request.tools === 'none' ? undefined : 'standard'
    const setup =
      request.tools === 'none' && tools
        ? (agentCtx: AnyRecord) => {
            const names = tools.schemas().map((schema) => schema.name).filter((name): name is string => Boolean(name))
            const scoped = serviceOf(agentCtx, 'tools') as
              | { restrict(filter: { deny: string[] }): () => void }
              | undefined
            if (names.length > 0) scoped?.restrict({ deny: names })
          }
        : presetId
          ? async (agentCtx: AnyRecord) => {
              const registry = serviceOf(this.ctx, 'agentPresets') as
                | { mount(context: AnyRecord, id: string): Promise<unknown> }
                | undefined
              if (!registry?.mount) throw new Error('宿主没有 agentPresets.mount，无法为开发 Agent 组合编码工具')
              await registry.mount(agentCtx, presetId)
            }
          : undefined
    const handle = await agents.create({
      sessionId,
      meta: { cwd: request.cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      agentOptions: { provider: selection.provider, model: selection.model },
      ...(setup ? { setup } : {}),
    })
    const presets = serviceOf(this.ctx, 'permissionPresets') as
      | { set(session: unknown, preset: string): void }
      | undefined
    presets?.set(handle.agent.session, request.permission)

    let dead = false
    let disposed = false
    return {
      sessionId,
      async send(turn: AgentTurnRequest): Promise<AgentRunResult> {
        const started = Date.now()
        if (dead) {
          return {
            status: 'error',
            text: '',
            sessionId,
            reason: '会话已结束，不能继续投递回合',
            transcriptPath: turn.transcriptPath,
            durationMs: 0,
            toolCalls: [],
          }
        }
        let aborted = false
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          handle.agent.cancel({ kind: 'user' })
        }, turn.timeoutMs)
        timer.unref?.()
        const onAbort = () => {
          aborted = true
          handle.agent.cancel({ kind: 'user' })
        }
        turn.signal?.addEventListener('abort', onAbort, { once: true })
        mkdirSync(dirname(turn.transcriptPath), { recursive: true })
        const flush = (): void => {
          try {
            const events = handle.agent.session.ownEvents()
            writeFileSync(
              turn.transcriptPath,
              `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
              'utf8',
            )
            turn.onActivity?.(events)
          } catch {
            // 活动快照是观测数据；写入失败不能中断 Agent 回合。
          }
        }
        const activityTimer = setInterval(flush, 1_500)
        activityTimer.unref?.()
        let whenIdleError = ''
        try {
          handle.agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: turn.prompt }],
            source: { kind: 'user' },
          })
          await handle.agent.whenIdle()
        } catch (error) {
          whenIdleError = (error as Error).message
        } finally {
          clearTimeout(timer)
          clearInterval(activityTimer)
          turn.signal?.removeEventListener('abort', onAbort)
        }
        const events = handle.agent.session.ownEvents()
        mkdirSync(dirname(turn.transcriptPath), { recursive: true })
        writeFileSync(
          turn.transcriptPath,
          `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
          'utf8',
        )
        const text = extractAssistantText(events)
        const durationMs = Date.now() - started
        const base = {
          text,
          sessionId,
          transcriptPath: turn.transcriptPath,
          durationMs,
          toolCalls: toolCallsOf(events),
        }
        if (timedOut) {
          dead = true
          return {
            ...base,
            status: 'timeout',
            reason: `Agent 回合超过 ${Math.round(turn.timeoutMs / 1000)} 秒上限，已取消`,
          }
        }
        if (aborted) {
          dead = true
          return {
            ...base,
            status: 'aborted',
            reason: 'Agent 回合因停止请求被取消；回合未正常完成',
          }
        }
        if (whenIdleError) {
          dead = true
          return { ...base, status: 'error', reason: `Agent 回合失败：${whenIdleError}` }
        }
        const end = extractTurnEnd(events)
        if (end.kind !== 'completed') {
          dead = true
          return {
            ...base,
            status: end.kind === 'aborted' ? 'aborted' : 'error',
            reason: `Agent 回合未正常完成：${end.kind || '未给出结束原因'}${end.detail ? `（${end.detail}）` : ''}`,
          }
        }
        if (!text) {
          return { ...base, status: 'error', reason: 'Agent 回合完成但没有产出可用文本' }
        }
        return { ...base, status: 'completed', reason: '' }
      },
      async close(): Promise<void> {
        if (disposed) return
        disposed = true
        dead = true
        // 宿主 dispose 在极端情况下可能等待未完成的工具/流；收口必须有界，
        // 否则请求会永远停在 claimed，协调器无法记录失败或重排。
        await Promise.race([
          handle.dispose().catch(() => undefined),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000)
            timer.unref?.()
          }),
        ])
      },
    }
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const started = Date.now()
    const selection = this.resolveSelection()
    const sessionId = `session-fl-${request.role}-${randomUUID()}`
    const agents = this.ctx.agents as { create(options: AnyRecord): Promise<{ agent: AgentView; dispose(): Promise<void> }> }
    const tools = serviceOf(this.ctx, 'tools') as
      | { schemas(scope?: unknown): Array<{ name?: string }> }
      | undefined
    // 编程式 Agent 默认不组合会话 preset，也就没有 shell/fs 等编码工具。
    // 开发与审查角色必须显式挂载 standard preset；只做推理的角色继续显式禁用全部工具。
    const presetId = request.tools === 'none' ? undefined : 'standard'
    const setup =
      request.tools === 'none' && tools
        ? (agentCtx: AnyRecord) => {
            const names = tools.schemas().map((schema) => schema.name).filter((name): name is string => Boolean(name))
            const scoped = serviceOf(agentCtx, 'tools') as
              | { restrict(filter: { deny: string[] }): () => void }
              | undefined
            if (names.length > 0) scoped?.restrict({ deny: names })
          }
        : presetId
          ? async (agentCtx: AnyRecord) => {
              const registry = serviceOf(this.ctx, 'agentPresets') as
                | { mount(context: AnyRecord, id: string): Promise<unknown> }
                | undefined
              if (!registry?.mount) throw new Error('宿主没有 agentPresets.mount，无法为开发 Agent 组合编码工具')
              await registry.mount(agentCtx, presetId)
            }
          : undefined
    const handle = await agents.create({
      sessionId,
      meta: { cwd: request.cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      agentOptions: { provider: selection.provider, model: selection.model },
      ...(setup ? { setup } : {}),
    })
    const sessions = serviceOf(this.ctx, 'permissionPresets') as
      | { set(session: unknown, preset: string): void }
      | undefined
    sessions?.set(handle.agent.session, request.permission)

    let aborted = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      handle.agent.cancel({ kind: 'user' })
    }, request.timeoutMs)
    timer.unref?.()
    const onAbort = () => {
      aborted = true
      handle.agent.cancel({ kind: 'user' })
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })

    mkdirSync(dirname(request.transcriptPath), { recursive: true })
    const flushActivity = (): void => {
      try {
        const events = handle.agent.session.ownEvents()
        writeFileSync(
          request.transcriptPath,
          `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
          'utf8',
        )
        request.onActivity?.(events)
      } catch {
        // 活动快照是观测数据；写入失败不能中断 Agent 回合。
      }
    }
    const activityTimer = setInterval(flushActivity, 1_500)
    activityTimer.unref?.()
    let whenIdleError = ''
    try {
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: request.prompt }],
        source: { kind: 'user' },
      })
      await handle.agent.whenIdle()
    } catch (error) {
      whenIdleError = (error as Error).message
    } finally {
      clearTimeout(timer)
      clearInterval(activityTimer)
      request.signal?.removeEventListener('abort', onAbort)
    }

    const events = handle.agent.session.ownEvents()
    const transcriptPath = request.transcriptPath
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(
      transcriptPath,
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    )

    await handle.dispose().catch(() => undefined)

    const turn = extractTurnEnd(events)
    const text = extractAssistantText(events)
    const durationMs = Date.now() - started
    if (timedOut) {
      return {
        status: 'timeout',
        text,
        sessionId,
        reason: `Agent 回合超过 ${Math.round(request.timeoutMs / 1000)} 秒上限，已取消`,
        transcriptPath,
        durationMs,
        toolCalls: toolCallsOf(events),
      }
    }
    if (aborted) {
      return {
        status: 'aborted',
        text,
        sessionId,
        reason: 'Agent 回合因停止请求被取消；回合未正常完成',
        transcriptPath,
        durationMs,
        toolCalls: toolCallsOf(events),
      }
    }
    if (whenIdleError) {
      return {
        status: 'error',
        text,
        sessionId,
        reason: `Agent 回合失败：${whenIdleError}`,
        transcriptPath,
        durationMs,
        toolCalls: toolCallsOf(events),
      }
    }
    if (turn.kind !== 'completed') {
      return {
        status: turn.kind === 'aborted' ? 'aborted' : 'error',
        text,
        sessionId,
        reason: `Agent 回合未正常完成：${turn.kind || '未给出结束原因'}${turn.detail ? `（${turn.detail}）` : ''}`,
        transcriptPath,
        durationMs,
        toolCalls: toolCallsOf(events),
      }
    }
    if (!text) {
      return {
        status: 'error',
        text: '',
        sessionId,
        reason: 'Agent 回合完成但没有产出可用文本',
        transcriptPath,
        durationMs,
        toolCalls: toolCallsOf(events),
      }
    }
    return {
      status: 'completed',
      text,
      sessionId,
      reason: '',
      transcriptPath,
      durationMs,
      toolCalls: toolCallsOf(events),
    }
  }
}