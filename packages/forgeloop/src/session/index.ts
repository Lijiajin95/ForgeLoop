import type { ForgeLoopConfig } from '../config.js'
import { errorMessage } from '../domain/errors.js'
import type { ForgeLoopRuntime } from '../runtime/service.js'
import { createPluginLogger } from '../runtime/log.js'
import { FORGELOOP_ERROR_EVENT, appendSessionEvent } from './events.js'
import {
  SessionIntake,
  isForgeLoopSession,
  type AgentViewLike,
  type PreStepDecision,
  type PreStepNext,
  type PreStepPayloadLike,
} from './intake.js'
import { presetRegistryOf, registerForgeLoopPreset, type PresetRegistration } from './preset.js'

type AnyRecord = Record<string, unknown>

export const UNBOUND_WORKSPACE_MESSAGE =
  '当前会话没有绑定 DSH 工作区：请先在某个工作区中新建 ForgeLoop 业务会话再提交需求；ForgeLoop 不跨工作区读写。'

export interface SessionTenant {
  readonly id: string
  readonly runtime: ForgeLoopRuntime
  readonly config: ForgeLoopConfig
}

export interface SessionTenantSource {
  forCwd(cwd: string): Promise<SessionTenant | undefined>
}

export interface SessionSurfaceOptions {
  readonly runtime?: ForgeLoopRuntime | undefined
  readonly config?: ForgeLoopConfig | undefined
  readonly log?: (message: string) => void
  readonly tenants?: SessionTenantSource | undefined
}

export interface SessionSurface {
  readonly intake: SessionIntake | undefined
  readonly ready: Promise<PresetRegistration>
  dispose(): Promise<void>
}

type Listener = (payload: PreStepPayloadLike, next: PreStepNext) => Promise<PreStepDecision>

export function installSessionSurface(
  ctx: AnyRecord,
  options: SessionSurfaceOptions,
): SessionSurface {
  const loggerConfig = options.config ?? options.runtime?.config
  const logger = loggerConfig ? createPluginLogger(loggerConfig) : undefined
  const log =
    options.log ??
    ((message: string) => {
      logger?.warn(`[forgeloop] ${message}`)
    })
  const registry = presetRegistryOf(ctx)
  const presetOf = registry?.composedPreset
    ? (agent: AgentViewLike) => registry.composedPreset?.(agent.ctx)
    : undefined
  const intake =
    options.runtime !== undefined && options.config !== undefined
      ? new SessionIntake({
          runtime: options.runtime,
          config: options.config,
          log,
          presetOf,
        })
      : undefined

  const tenantIntakes = new Map<string, SessionIntake>()
  const intakeFor = (tenant: SessionTenant): SessionIntake => {
    const existing = tenantIntakes.get(tenant.id)
    if (existing) return existing
    const created = new SessionIntake({
      runtime: tenant.runtime,
      config: tenant.config,
      log,
      presetOf,
    })
    tenantIntakes.set(tenant.id, created)
    return created
  }

  const handleScoped = async (
    payload: PreStepPayloadLike,
    next: PreStepNext,
  ): Promise<PreStepDecision> => {
    const tenants = options.tenants
    if (!tenants) {
      if (intake) return intake.handlePreStep(payload, next)
      log('ForgeLoop 会话表面没有可用运行时：请检查工作区服务或单项目配置')
      return { kind: 'reject' }
    }
    const agent = payload.agent
    if (!isForgeLoopSession(agent, presetOf)) return next()
    const cwd = agent?.session?.header?.cwd
    const tenant = typeof cwd === 'string' && cwd ? await tenants.forCwd(cwd) : undefined
    if (!tenant) {
      appendSessionEvent(
        agent?.session,
        FORGELOOP_ERROR_EVENT,
        {
          eventId: `forgeloop:error:workspace:${payload.turn ?? 0}`,
          reqId: '',
          message: UNBOUND_WORKSPACE_MESSAGE,
          at: new Date().toISOString(),
        },
        log,
      )
      return { kind: 'reject' }
    }
    return intakeFor(tenant).handlePreStep(payload, next)
  }

  const disposers: Array<() => void> = []
  const on = (ctx as { on?: (event: string, listener: Listener) => unknown }).on
  if (typeof on === 'function') {
    const dispose: unknown = Reflect.apply(on, ctx, [
      'agent/pre-step',
      (payload: PreStepPayloadLike, next: PreStepNext) => handleScoped(payload, next),
    ])
    if (typeof dispose === 'function')
      disposers.push(() => {
        Reflect.apply(dispose, ctx, [])
      })
  } else {
    log('宿主没有 ctx.on，无法安装 agent/pre-step 输入接管')
  }

  let cancelled = false
  let presetDispose: (() => Promise<void>) | undefined
  const ready = registerForgeLoopPreset(ctx, log)
    .then(async (result) => {
      if (result.ok && result.dispose) {
        if (cancelled) await result.dispose()
        else presetDispose = result.dispose
      }
      return result
    })
    .catch((error: unknown) => ({
      ok: false,
      reason: `preset 注册异常：${errorMessage(error)}`,
    }))

  return {
    intake,
    ready,
    async dispose() {
      cancelled = true
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          continue
        }
      }
      await ready.catch(() => undefined)
      await presetDispose?.().catch(() => undefined)
      presetDispose = undefined
    },
  }
}
