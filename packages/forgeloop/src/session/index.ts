/**
 * ForgeLoop 业务会话接入：注册 agent preset，并在 DSH 的 agent/pre-step
 * waterfall 上接管该 preset 会话的人类输入。
 */

import type { ForgeLoopConfig } from '../config.js'
import type { ForgeLoopRuntime } from '../runtime/service.js'
import { SessionIntake, type PreStepDecision, type PreStepNext, type PreStepPayloadLike } from './intake.js'
import { presetRegistryOf, registerForgeLoopPreset, type PresetRegistration } from './preset.js'

type AnyRecord = Record<string, unknown>

export interface SessionSurfaceOptions {
  readonly runtime: ForgeLoopRuntime
  readonly config: ForgeLoopConfig
  readonly log?: (message: string) => void
}

export interface SessionSurface {
  readonly intake: SessionIntake
  /** preset 注册结果；宿主没有 agentPresets 时 reason 说明缺口。 */
  readonly ready: Promise<PresetRegistration>
  dispose(): Promise<void>
}

type Listener = (payload: PreStepPayloadLike, next: PreStepNext) => Promise<PreStepDecision>

/** 安装输入接管与 preset；返回的 dispose 供插件卸载时释放。 */
export function installSessionSurface(ctx: AnyRecord, options: SessionSurfaceOptions): SessionSurface {
  const log = options.log ?? ((message: string) => console.warn(`[forgeloop] ${message}`))
  const registry = presetRegistryOf(ctx)
  const intake = new SessionIntake({
    runtime: options.runtime,
    config: options.config,
    log,
    presetOf: registry?.composedPreset
      ? (agent) => registry.composedPreset?.(agent.ctx as never)
      : undefined,
  })

  const disposers: Array<() => void> = []
  const on = ctx.on as ((event: string, listener: Listener) => unknown) | undefined
  if (typeof on === 'function') {
    const dispose = on.call(ctx, 'agent/pre-step', (payload, next) => intake.handlePreStep(payload, next))
    if (typeof dispose === 'function') disposers.push(dispose as () => void)
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
      reason: `preset 注册异常：${(error as Error).message}`,
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
          // 单个监听器清理失败不阻止其余清理。
        }
      }
      await ready.catch(() => undefined)
      await presetDispose?.().catch(() => undefined)
      presetDispose = undefined
    },
  }
}
