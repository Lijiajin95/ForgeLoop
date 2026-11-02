/**
 * DSH 宿主内 Agent 执行器：在本进程创建独立 Agent、投递一次任务、等待回合结束，
 * 读取该会话自己的事件日志，保存可回查轨迹。
 *
 * 这是真实的 DSH Agent（不是旧 Python 业务核心，也不是自建对话壳）：
 * 模型、工具、权限与会话生命周期都由宿主提供；本模块只负责投递、等待、取消与取证。
 */

import { asRecord } from '../domain/json.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { errorMessage } from '../domain/errors.js'
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
  readonly signal?: AbortSignal | undefined
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
  /** 程序指定会话身份；研发会话必须可跨请求恢复，不能每轮随机。 */
  readonly sessionId?: string
}

export interface AgentResumeRequest {
  readonly role: AgentIdentity
  readonly sessionId: string
  readonly permission: 'workspace-write' | 'danger-full-access'
  readonly tools?: 'none' | 'default'
  /** 会话原工作目录；仅用于宿主不支持从会话记录推断目录时的提示。 */
  readonly cwd?: string
}

export interface AgentTurnRequest {
  readonly prompt: string
  readonly timeoutMs: number
  readonly transcriptPath: string
  readonly signal?: AbortSignal | undefined
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
  /** 恢复持久会话的等待上限：宿主卡住时不能让需求永远停在 claimed。 */
  readonly resumeTimeoutMs?: number
}

const DEFAULT_RESUME_TIMEOUT_MS = 60_000

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
  if (typeof getter === 'function') return Reflect.apply(getter, ctx, [name])
  return ctx[name]
}

type ToolsService = { schemas(scope?: unknown): Array<{ name?: string }> }
type RestrictService = { restrict(filter: { deny: string[] }): () => void }
type PresetRegistry = { mount(context: AnyRecord, id: string): Promise<unknown> }
type PermissionService = { set(session: unknown, preset: string): void }
type DefaultModelService = { currentSelection(): { provider?: string; model?: string } }

function toolsService(ctx: AnyRecord): ToolsService | undefined {
  const service = asRecord(serviceOf(ctx, 'tools'))
  const schemas = service?.schemas
  if (typeof schemas !== 'function') return undefined
  return {
    schemas: (scope?: unknown) =>
      Reflect.apply(schemas, service, [scope]) as Array<{ name?: string }>,
  }
}

function restrictService(ctx: AnyRecord): RestrictService | undefined {
  const service = asRecord(serviceOf(ctx, 'tools'))
  const restrict = service?.restrict
  if (typeof restrict !== 'function') return undefined
  return { restrict: (filter) => Reflect.apply(restrict, service, [filter]) as () => void }
}

function presetRegistry(ctx: AnyRecord): PresetRegistry | undefined {
  const service = asRecord(serviceOf(ctx, 'agentPresets'))
  const mount = service?.mount
  if (typeof mount !== 'function') return undefined
  return {
    mount: (context, id) => Reflect.apply(mount, service, [context, id]) as Promise<unknown>,
  }
}

function permissionService(ctx: AnyRecord): PermissionService | undefined {
  const service = asRecord(serviceOf(ctx, 'permissionPresets'))
  const set = service?.set
  if (typeof set !== 'function') return undefined
  return {
    set: (session, preset) => {
      Reflect.apply(set, service, [session, preset])
    },
  }
}

function defaultModelService(ctx: AnyRecord): DefaultModelService | undefined {
  const service = asRecord(serviceOf(ctx, 'agentDefaultModel'))
  const currentSelection = service?.currentSelection
  if (typeof currentSelection !== 'function') return undefined
  return {
    currentSelection: () =>
      Reflect.apply(currentSelection, service, []) as { provider?: string; model?: string },
  }
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
    const data = asRecord(event.data)
    const message = asRecord(data?.message)
    const text = textOfContent(message?.content)
    if (text) return text
  }
  return ''
}

function extractTurnEnd(events: readonly AnyRecord[]): { kind: string; detail: string } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.type !== 'turn/end') continue
    const data = asRecord(event.data)
    const reason = asRecord(data?.reason)
    const kind = typeof reason?.kind === 'string' ? reason.kind : ''
    const error = asRecord(reason?.error)
    const message = typeof error?.message === 'string' ? error.message : ''
    return { kind, detail: message }
  }
  return { kind: '', detail: '回合未给出结束原因' }
}

function toolCallsOf(events: readonly AnyRecord[]): string[] {
  const names: string[] = []
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = asRecord(event.data)
    if (typeof data?.name === 'string') names.push(data.name)
  }
  return names
}

function closedSessionResult(sessionId: string, transcriptPath: string): AgentRunResult {
  return {
    status: 'error',
    text: '',
    sessionId,
    reason: '会话已结束，不能继续投递回合',
    transcriptPath,
    durationMs: 0,
    toolCalls: [],
  }
}

function writeTranscriptFile(path: string, events: readonly AnyRecord[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
}

function writeTranscript(
  view: SessionHandle,
  turn: AgentTurnRequest,
): ReturnType<AgentView['session']['ownEvents']> {
  const events = view.agent.session.ownEvents()
  writeTranscriptFile(turn.transcriptPath, events)
  return events
}

interface RunResultBase {
  readonly text: string
  readonly sessionId: string
  readonly transcriptPath: string
  readonly durationMs: number
  readonly toolCalls: AgentRunResult['toolCalls']
}

function runResult(
  status: AgentRunResult['status'],
  reason: string,
  base: RunResultBase,
): AgentRunResult {
  return { status, reason, ...base }
}

function runOutcome(input: {
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly whenIdleError: string
  readonly turn: ReturnType<typeof extractTurnEnd>
  readonly text: string
  readonly timeoutMs: number
}): { status: AgentRunResult['status']; reason: string } {
  if (input.timedOut) {
    return {
      status: 'timeout',
      reason: `Agent 回合超过 ${Math.round(input.timeoutMs / 1000)} 秒上限，已取消`,
    }
  }
  if (input.aborted) {
    return { status: 'aborted', reason: 'Agent 回合因停止请求被取消；回合未正常完成' }
  }
  if (input.whenIdleError) {
    return { status: 'error', reason: `Agent 回合失败：${input.whenIdleError}` }
  }
  if (input.turn.kind !== 'completed') {
    return {
      status: input.turn.kind === 'aborted' ? 'aborted' : 'error',
      reason: `Agent 回合未正常完成：${input.turn.kind || '未给出结束原因'}${input.turn.detail ? `（${input.turn.detail}）` : ''}`,
    }
  }
  if (!input.text) {
    return { status: 'error', reason: 'Agent 回合完成但没有产出可用文本' }
  }
  return { status: 'completed', reason: '' }
}

type SessionHandle = { agent: AgentView; dispose(): Promise<void> }

/** 宿主的 Agent 服务视图：create 必然存在，resume 因宿主版本不同而可能缺省。 */
interface AgentService {
  create(options: AnyRecord): Promise<SessionHandle>
  /** 宿主恢复接口；返回空句柄按宿主缺陷处理，不当作恢复成功。 */
  resume?(options: AnyRecord): Promise<SessionHandle | undefined>
}

export class AgentRunner {
  private readonly ctx: AnyRecord
  private readonly agent: AgentConfig

  private readonly resumeTimeoutMs: number

  constructor(options: AgentRunnerOptions) {
    this.ctx = options.ctx
    this.agent = options.agent
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS
  }

  /** 解析实际使用的 provider/model：配置显式给出优先，否则用宿主默认选择。 */
  resolveSelection(): { provider: string; model: string } {
    if (this.agent.provider && this.agent.model) {
      return { provider: this.agent.provider, model: this.agent.model }
    }
    const service = defaultModelService(this.ctx)
    const selection = service?.currentSelection()
    if (!selection?.provider || !selection.model) {
      throw new Error(
        '没有可用的模型选择：请在插件配置 agent.provider/agent.model 指定，或确保宿主提供默认模型',
      )
    }
    return { provider: selection.provider, model: selection.model }
  }

  private setupFor(
    tools: 'none' | 'default' | undefined,
  ): ((agentCtx: AnyRecord) => unknown) | undefined {
    const toolService = toolsService(this.ctx)
    const presetId = tools === 'none' ? undefined : 'standard'
    if (tools === 'none' && toolService) {
      return (agentCtx: AnyRecord) => {
        const names = toolService
          .schemas()
          .map((schema) => schema.name)
          .filter((name): name is string => Boolean(name))
        const scoped = restrictService(agentCtx)
        if (names.length > 0) scoped?.restrict({ deny: names })
      }
    }
    if (!presetId) return undefined
    return async (agentCtx: AnyRecord) => {
      const registry = presetRegistry(this.ctx)
      if (!registry?.mount) {
        throw new Error('宿主没有 agentPresets.mount，无法为开发 Agent 组合编码工具')
      }
      await registry.mount(agentCtx, presetId)
    }
  }

  /**
   * 打开一段连续会话：不再每轮新建 Agent，供同一需求的技术方案、实现、自验、
   * 修复或验证阶段复用上下文与工作目录。宿主重启后会话不存在，依据持久证据恢复。
   */
  async open(request: AgentOpenRequest): Promise<AgentSession> {
    const selection = this.resolveSelection()
    const sessionId = request.sessionId ?? `session-fl-${request.role}-${randomUUID()}`
    const agents = this.agentService()
    const setup = this.setupFor(request.tools)
    const handle = await agents.create({
      sessionId,
      meta: {
        cwd: request.cwd,
        ...(request.tools === 'none' ? {} : { agentPreset: 'standard' }),
      },
      agentOptions: { provider: selection.provider, model: selection.model },
      ...(setup ? { setup } : {}),
    })
    const presets = permissionService(this.ctx)
    presets?.set(handle.agent.session, request.permission)
    return this.wrapSession(handle, sessionId)
  }

  /**
   * 从宿主持久化的会话恢复研发 Agent：宿主重启后内存里没有 handle，但会话与工作目录
   * 仍然存在。宿主不支持恢复时明确失败，不假装恢复成新会话。
   */
  async resume(request: AgentResumeRequest): Promise<AgentSession> {
    const selection = this.resolveSelection()
    const agents = this.agentService()
    if (typeof agents.resume !== 'function') {
      throw new Error('宿主不支持恢复持久会话（agents.resume）；不能假装恢复研发会话')
    }
    const setup = this.setupFor(request.tools)
    let handle: SessionHandle | undefined
    try {
      handle = await this.withResumeDeadline(
        agents.resume({
          resumeSessionId: request.sessionId,
          agentOptions: { provider: selection.provider, model: selection.model },
          ...(setup ? { setup } : {}),
        }),
        request.sessionId,
      )
    } catch (error) {
      throw new Error(`恢复研发会话 ${request.sessionId} 失败：${errorMessage(error)}`, {
        cause: error,
      })
    }
    if (!handle) {
      throw new Error(`宿主恢复了研发会话 ${request.sessionId} 但返回空句柄；拒绝继续`)
    }
    const presets = permissionService(this.ctx)
    try {
      presets?.set(handle.agent.session, request.permission)
    } catch (error) {
      throw new Error(
        `宿主恢复了研发会话 ${request.sessionId} 但句柄不可用：${errorMessage(error)}；拒绝继续`,
        { cause: error },
      )
    }
    return this.wrapSession(handle, request.sessionId)
  }

  /** 恢复可能因为宿主内部等待而挂起；超时报错交回调用方，不静默降级为新会话。 */
  private async withResumeDeadline(
    pending: Promise<SessionHandle | undefined>,
    sessionId: string,
  ): Promise<SessionHandle | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error(`宿主在 ${this.resumeTimeoutMs}ms 内没有恢复会话 ${sessionId}`))
      }, this.resumeTimeoutMs)
      timer.unref()
    })
    // 超时后宿主仍可能返回或拒绝：晚到的句柄立刻释放，晚到的拒绝不变成未处理异常。
    void pending.then(
      (handle) => {
        if (timedOut && handle) void handle.dispose().catch(() => undefined)
      },
      () => undefined,
    )
    try {
      return await Promise.race([pending, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private agentService(): AgentService {
    return this.ctx.agents as AgentService
  }

  private wrapSession(handle: SessionHandle, sessionId: string): AgentSession {
    let dead = false
    let disposed = false
    const startTurnWatch = (
      turn: AgentTurnRequest,
    ): { isTimedOut: () => boolean; isAborted: () => boolean; stop: () => void } => {
      let aborted = false
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        handle.agent.cancel({ kind: 'user' })
      }, turn.timeoutMs)
      timer.unref()
      const onAbort = (): void => {
        aborted = true
        handle.agent.cancel({ kind: 'user' })
      }
      turn.signal?.addEventListener('abort', onAbort, { once: true })
      return {
        isTimedOut: () => timedOut,
        isAborted: () => aborted,
        stop: () => {
          clearTimeout(timer)
          turn.signal?.removeEventListener('abort', onAbort)
        },
      }
    }
    const flushActivity = (turn: AgentTurnRequest): void => {
      try {
        const events = handle.agent.session.ownEvents()
        writeTranscriptFile(turn.transcriptPath, events)
        turn.onActivity?.(events)
      } catch {
        // 活动快照是观测数据；写入失败不能中断 Agent 回合。
      }
    }
    return {
      sessionId,
      async send(turn: AgentTurnRequest): Promise<AgentRunResult> {
        const started = Date.now()
        if (dead) return closedSessionResult(sessionId, turn.transcriptPath)
        const watch = startTurnWatch(turn)
        const activityTimer = setInterval(() => {
          flushActivity(turn)
        }, 1_500)
        activityTimer.unref()
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
          whenIdleError = errorMessage(error)
        } finally {
          watch.stop()
          clearInterval(activityTimer)
        }
        const events = writeTranscript(handle, turn)
        const base = {
          text: extractAssistantText(events),
          sessionId,
          transcriptPath: turn.transcriptPath,
          durationMs: Date.now() - started,
          toolCalls: toolCallsOf(events),
        }
        if (watch.isTimedOut()) {
          dead = true
          return {
            ...base,
            status: 'timeout',
            reason: `Agent 回合超过 ${Math.round(turn.timeoutMs / 1000)} 秒上限，已取消`,
          }
        }
        if (watch.isAborted()) {
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
        if (!base.text) {
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
            timer.unref()
          }),
        ])
      },
    }
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const started = Date.now()
    const selection = this.resolveSelection()
    const sessionId = `session-fl-${request.role}-${randomUUID()}`
    const agents = this.agentService()
    const tools = toolsService(this.ctx)
    // 编程式 Agent 默认不组合会话 preset，也就没有 shell/fs 等编码工具。
    // 开发与审查角色必须显式挂载 standard preset；只做推理的角色继续显式禁用全部工具。
    const presetId = request.tools === 'none' ? undefined : 'standard'
    const setup =
      request.tools === 'none' && tools
        ? (agentCtx: AnyRecord) => {
            const names = tools
              .schemas()
              .map((schema) => schema.name)
              .filter((name): name is string => Boolean(name))
            const scoped = restrictService(agentCtx)
            if (names.length > 0) scoped?.restrict({ deny: names })
          }
        : presetId
          ? async (agentCtx: AnyRecord) => {
              const registry = presetRegistry(this.ctx)
              if (!registry?.mount)
                throw new Error('宿主没有 agentPresets.mount，无法为开发 Agent 组合编码工具')
              await registry.mount(agentCtx, presetId)
            }
          : undefined
    const handle = await agents.create({
      sessionId,
      meta: { cwd: request.cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      agentOptions: { provider: selection.provider, model: selection.model },
      ...(setup ? { setup } : {}),
    })
    const sessions = permissionService(this.ctx)
    sessions?.set(handle.agent.session, request.permission)

    let aborted = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      handle.agent.cancel({ kind: 'user' })
    }, request.timeoutMs)
    timer.unref()
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
    activityTimer.unref()
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
      whenIdleError = errorMessage(error)
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

    const text = extractAssistantText(events)
    const base: RunResultBase = {
      text,
      sessionId,
      transcriptPath,
      durationMs: Date.now() - started,
      toolCalls: toolCallsOf(events),
    }
    const outcome = runOutcome({
      timedOut,
      aborted,
      whenIdleError,
      turn: extractTurnEnd(events),
      text,
      timeoutMs: request.timeoutMs,
    })
    return runResult(outcome.status, outcome.reason, base)
  }
}
