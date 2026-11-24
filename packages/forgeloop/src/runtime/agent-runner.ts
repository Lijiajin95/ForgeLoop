import { asRecord } from '../domain/json.js'
import { mkdirSync } from 'node:fs'
import { errorMessage } from '../domain/errors.js'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentConfig, ForgeLoopConfig } from '../config.js'
import type { AgentIdentity } from '../domain/agents.js'
import { bestEffort } from './best-effort.js'
import { createPluginLogger, type PluginLogger } from './log.js'
import { TranscriptWriter } from './transcript.js'

type AnyRecord = Record<string, unknown>

export interface AgentRunRequest {
  readonly role: AgentIdentity
  readonly cwd: string
  readonly prompt: string
  readonly permission: 'workspace-write' | 'danger-full-access'
  readonly timeoutMs?: number | undefined
  readonly idleTimeoutMs?: number | undefined
  readonly transcriptPath: string
  readonly signal?: AbortSignal | undefined
  readonly tools?: 'none' | 'default'
  readonly allowTools?: readonly string[]
  readonly onActivity?: (events: readonly AnyRecord[]) => void
}

export interface AgentOpenRequest {
  readonly role: AgentIdentity
  readonly cwd: string
  readonly permission: 'workspace-write' | 'danger-full-access'
  readonly tools?: 'none' | 'default'
  readonly allowTools?: readonly string[]
  readonly sessionId?: string
  readonly reqId?: string
}

export interface AgentResumeRequest {
  readonly role: AgentIdentity
  readonly sessionId: string
  readonly permission: 'workspace-write' | 'danger-full-access'
  readonly tools?: 'none' | 'default'
  readonly allowTools?: readonly string[]
  readonly cwd?: string
}

export interface AgentTurnRequest {
  readonly prompt: string
  readonly timeoutMs?: number | undefined
  readonly idleTimeoutMs?: number | undefined
  readonly transcriptPath: string
  readonly signal?: AbortSignal | undefined
  readonly onActivity?: (events: readonly AnyRecord[]) => void
}

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

export function sessionFromRunner(
  runner: { run(request: AgentRunRequest): Promise<AgentRunResult> },
  request: AgentOpenRequest,
): AgentSession {
  const sessionId = `session-fl-${request.role}-fallback`
  let closed = false
  return {
    sessionId,
    async send(turn) {
      if (closed) {
        return {
          status: 'error',
          text: '',
          sessionId,
          reason: '会话已关闭',
          transcriptPath: turn.transcriptPath,
          durationMs: 0,
          toolCalls: [],
        }
      }
      return runner.run({
        role: request.role,
        cwd: request.cwd,
        prompt: turn.prompt,
        permission: request.permission,
        timeoutMs: turn.timeoutMs,
        transcriptPath: turn.transcriptPath,
        ...(turn.signal ? { signal: turn.signal } : {}),
        ...(request.tools ? { tools: request.tools } : {}),
        ...(turn.onActivity ? { onActivity: turn.onActivity } : {}),
      })
    },
    async close() {
      closed = true
    },
  }
}

export interface AgentRunnerOptions {
  readonly ctx: AnyRecord
  readonly agent: AgentConfig
  readonly config?: ForgeLoopConfig
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
  readonly seq: number
  readonly inheritedEventCount: number
  snapshotEvents(fromSeq: number, toSeqExclusive: number): readonly AnyRecord[]
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

export function restrictToolNames(
  agentCtx: AnyRecord,
  tools: ToolsService,
  allowed?: readonly string[],
): void {
  const names = tools
    .schemas()
    .map((schema) => schema.name)
    .filter((name): name is string => Boolean(name))
  const deny = allowed ? names.filter((name) => !allowed.includes(name)) : names
  const service = restrictService(agentCtx)
  if (!service) {
    throw new Error('宿主未提供工具限制服务，拒绝以未受限工具运行')
  }
  if (deny.length === 0) return
  service.restrict({ deny })
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

const DEBUG_TEXT_LIMIT = 8_000

function clipDebug(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > DEBUG_TEXT_LIMIT ? `${text.slice(0, DEBUG_TEXT_LIMIT)}…[truncated]` : text
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

function transcriptOf(session: SessionView, path: string): TranscriptWriter {
  return new TranscriptWriter(path, session)
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
  readonly idleTimedOut: boolean
  readonly idleMs: number
  readonly aborted: boolean
  readonly whenIdleError: string
  readonly turn: ReturnType<typeof extractTurnEnd>
  readonly text: string
  readonly timeoutMs: number
}): { status: AgentRunResult['status']; reason: string } {
  if (input.timedOut || input.idleTimedOut) {
    return {
      status: 'timeout',
      reason: input.idleTimedOut
        ? `Agent 回合连续 ${Math.round(input.idleMs / 1000)} 秒没有新进展，已取消`
        : `Agent 回合超过 ${Math.round(input.timeoutMs / 1000)} 秒上限，已取消`,
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

interface AgentService {
  create(options: AnyRecord): Promise<SessionHandle>
  /** 宿主恢复接口；返回空句柄按宿主缺陷处理，不当作恢复成功。 */
  resume?(options: AnyRecord): Promise<SessionHandle | undefined>
}

function requestedTimeoutMs(request: { timeoutMs?: number | undefined }): number {
  return request.timeoutMs ?? -1
}

function armTurnTimeout(timeoutMs: number, fire: () => void): NodeJS.Timeout | undefined {
  if (timeoutMs <= 0) return undefined
  const timer = setTimeout(fire, timeoutMs)
  timer.unref()
  return timer
}

function idleWatch(
  idleMs: number,
  cancel: () => void,
): { touch: (eventCount: number) => void; stop: () => void; timedOut: () => boolean } {
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  let lastCount = -1
  const arm = (): void => {
    if (idleMs <= 0) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      cancel()
    }, idleMs)
    timer.unref()
  }
  arm()
  return {
    touch: (eventCount: number) => {
      if (eventCount === lastCount) return
      lastCount = eventCount
      arm()
    },
    stop: () => {
      if (timer) clearTimeout(timer)
    },
    timedOut: () => timedOut,
  }
}

export class AgentRunner {
  private readonly ctx: AnyRecord
  private readonly agent: AgentConfig
  private readonly config: ForgeLoopConfig | undefined
  private logger: PluginLogger | null = null

  private readonly resumeTimeoutMs: number

  constructor(options: AgentRunnerOptions) {
    this.ctx = options.ctx
    this.agent = options.agent
    this.config = options.config
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS
  }

  private debugLog(message: string, context: Record<string, unknown>): void {
    if (!this.config || this.config.logging.level !== 'debug') return
    this.logger ??= createPluginLogger(this.config)
    this.logger.debug(message, context)
  }

  private logTurn(input: {
    request: AgentRunRequest
    selection: { provider: string; model: string }
    sessionId: string
    events: readonly AnyRecord[]
    outcome: { status: AgentRunResult['status']; reason: string }
    base: RunResultBase
  }): void {
    const { request, selection, sessionId, events, outcome, base } = input
    this.debugLog('agent.turn', {
      event: 'agent.turn',
      role: request.role,
      provider: selection.provider,
      model: selection.model,
      sessionId,
      status: outcome.status,
      reason: outcome.reason,
      durationMs: base.durationMs,
      toolCalls: base.toolCalls,
      prompt: clipDebug(request.prompt),
      output: clipDebug(base.text),
    })
    if (this.config?.logging.level !== 'debug') return
    for (const event of events) {
      if (event.type !== 'tool/call') continue
      const data = asRecord(event.data)
      this.debugLog('agent.tool_call', {
        event: 'agent.tool_call',
        role: request.role,
        sessionId,
        tool: typeof data?.name === 'string' ? data.name : '',
        input: clipDebug(data?.arguments ?? data?.args ?? data?.input ?? ''),
      })
    }
  }

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

  private setupFor(request: {
    tools?: 'none' | 'default'
    allowTools?: readonly string[] | undefined
  }): ((agentCtx: AnyRecord) => unknown) | undefined {
    const tools = toolsService(this.ctx)
    const presetId = request.tools === 'none' || request.allowTools ? undefined : 'standard'
    if (request.allowTools) {
      return (agentCtx: AnyRecord) => {
        if (!tools) throw new Error('宿主未提供工具服务，无法执行工具白名单')
        restrictToolNames(agentCtx, tools, request.allowTools)
      }
    }
    if (request.tools === 'none' && tools) {
      return (agentCtx: AnyRecord) => {
        restrictToolNames(agentCtx, tools)
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

  async open(request: AgentOpenRequest): Promise<AgentSession> {
    const selection = this.resolveSelection()
    const sessionId = request.sessionId ?? `session-fl-${request.role}-${randomUUID()}`
    const agents = this.agentService()
    const presetId = request.tools === 'none' || request.allowTools ? undefined : 'standard'
    const setup = this.setupFor(request)
    const handle = await agents.create({
      sessionId,
      meta: { cwd: request.cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      agentOptions: { provider: selection.provider, model: selection.model },
      ...(setup ? { setup } : {}),
    })
    const presets = permissionService(this.ctx)
    presets?.set(handle.agent.session, request.permission)
    return this.wrapSession(handle, sessionId)
  }

  async resume(request: AgentResumeRequest): Promise<AgentSession> {
    const selection = this.resolveSelection()
    const agents = this.agentService()
    if (typeof agents.resume !== 'function') {
      throw new Error('宿主不支持恢复持久会话（agents.resume）；不能假装恢复研发会话')
    }
    const setup = this.setupFor(request)
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
    ): {
      isTimedOut: () => boolean
      isIdleTimedOut: () => boolean
      isAborted: () => boolean
      idleMs: number
      touch: (eventCount: number) => void
      stop: () => void
    } => {
      let aborted = false
      let timedOut = false
      const idleMs = turn.idleTimeoutMs ?? (this.agent.idleTimeoutSeconds ?? -1) * 1000
      const timeoutMs = turn.timeoutMs ?? -1
      let idleTimedOut = false
      let idleTimer: NodeJS.Timeout | undefined
      let lastEventCount = -1
      const armIdle = (): void => {
        if (idleMs <= 0) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          idleTimedOut = true
          handle.agent.cancel({ kind: 'user' })
        }, idleMs)
        idleTimer.unref()
      }
      armIdle()
      const timer = armTurnTimeout(timeoutMs, () => {
        timedOut = true
        handle.agent.cancel({ kind: 'user' })
      })
      const onAbort = (): void => {
        aborted = true
        handle.agent.cancel({ kind: 'user' })
      }
      turn.signal?.addEventListener('abort', onAbort, { once: true })
      return {
        isTimedOut: () => timedOut,
        isIdleTimedOut: () => idleTimedOut,
        isAborted: () => aborted,
        idleMs,
        touch: (eventCount: number) => {
          if (eventCount === lastEventCount) return
          lastEventCount = eventCount
          armIdle()
        },
        stop: () => {
          if (timer) clearTimeout(timer)
          if (idleTimer) clearTimeout(idleTimer)
          turn.signal?.removeEventListener('abort', onAbort)
        },
      }
    }
    const flushActivity = (
      turn: AgentTurnRequest,
      watch: ReturnType<typeof startTurnWatch>,
      transcript: TranscriptWriter,
    ): void => {
      const events = transcript.flushQuietly()
      watch.touch(events.length)
      bestEffort(() => {
        turn.onActivity?.(events)
      })
    }
    return {
      sessionId,
      async send(turn: AgentTurnRequest): Promise<AgentRunResult> {
        const started = Date.now()
        if (dead) return closedSessionResult(sessionId, turn.transcriptPath)
        const watch = startTurnWatch(turn)
        const transcript = transcriptOf(handle.agent.session, turn.transcriptPath)
        const activityTimer = setInterval(() => {
          flushActivity(turn, watch, transcript)
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
        const events = transcript.finish()
        const base = {
          text: extractAssistantText(events),
          sessionId,
          transcriptPath: turn.transcriptPath,
          durationMs: Date.now() - started,
          toolCalls: toolCallsOf(events),
        }
        if (watch.isTimedOut() || watch.isIdleTimedOut()) {
          dead = true
          return {
            ...base,
            status: 'timeout',
            reason: watch.isIdleTimedOut()
              ? `Agent 回合连续 ${Math.round(watch.idleMs / 1000)} 秒没有新进展，已取消`
              : `Agent 回合超过 ${Math.round((turn.timeoutMs ?? -1) / 1000)} 秒上限，已取消`,
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
    const presetId = request.tools === 'none' || request.allowTools ? undefined : 'standard'
    const setup = request.allowTools
      ? (agentCtx: AnyRecord) => {
          if (tools) restrictToolNames(agentCtx, tools, request.allowTools)
        }
      : request.tools === 'none' && tools
        ? (agentCtx: AnyRecord) => {
            restrictToolNames(agentCtx, tools)
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
    const idleMs = request.idleTimeoutMs ?? (this.agent.idleTimeoutSeconds ?? -1) * 1000
    const idle = idleWatch(idleMs, () => {
      handle.agent.cancel({ kind: 'user' })
    })
    const timeoutMs = requestedTimeoutMs(request)
    const timer = armTurnTimeout(timeoutMs, () => {
      timedOut = true
      handle.agent.cancel({ kind: 'user' })
    })
    const onAbort = () => {
      aborted = true
      handle.agent.cancel({ kind: 'user' })
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })

    mkdirSync(dirname(request.transcriptPath), { recursive: true })
    const transcript = transcriptOf(handle.agent.session, request.transcriptPath)
    const flushActivity = (): void => {
      const events = transcript.flushQuietly()
      idle.touch(events.length)
      bestEffort(() => {
        request.onActivity?.(events)
      })
    }
    const activityTimer = setInterval(flushActivity, 1_500)
    activityTimer.unref()
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      idle.stop()
      clearInterval(activityTimer)
      request.signal?.removeEventListener('abort', onAbort)
    }
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
      cleanup()
    }

    const events = transcript.finish()
    const transcriptPath = request.transcriptPath

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
      idleTimedOut: idle.timedOut(),
      idleMs,
      aborted,
      whenIdleError,
      turn: extractTurnEnd(events),
      text,
      timeoutMs,
    })
    this.logTurn({ request, selection, sessionId, events, outcome, base })
    return runResult(outcome.status, outcome.reason, base)
  }
}
