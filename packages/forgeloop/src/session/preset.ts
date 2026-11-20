import {
  FORGELOOP_PRESET_DESCRIPTION,
  FORGELOOP_PRESET_ID,
  FORGELOOP_PRESET_NAME,
} from './intake.js'

import { errorMessage } from '../domain/errors.js'

type AnyRecord = Record<string, unknown>

export interface AgentPresetDefinitionLike {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly plugins: readonly unknown[]
}

export interface AgentPresetRegistryLike {
  register(definition: AgentPresetDefinitionLike): Promise<() => Promise<void>>
  composedPreset?(ctx: unknown): string | undefined
}

export interface PresetRegistration {
  readonly ok: boolean
  readonly reason: string
  readonly dispose?: () => Promise<void>
}

function serviceOf(ctx: AnyRecord, name: string): unknown {
  const getter = ctx.get
  if (typeof getter === 'function') return Reflect.apply(getter, ctx, [name])
  return ctx[name]
}

export function presetRegistryOf(ctx: AnyRecord): AgentPresetRegistryLike | undefined {
  const registry = serviceOf(ctx, 'agentPresets') as Partial<AgentPresetRegistryLike> | undefined
  return typeof registry?.register === 'function'
    ? (registry as AgentPresetRegistryLike)
    : undefined
}

export async function registerForgeLoopPreset(
  ctx: AnyRecord,
  log: (message: string) => void = () => undefined,
): Promise<PresetRegistration> {
  const registry = presetRegistryOf(ctx)
  if (!registry)
    return { ok: false, reason: '宿主没有 agentPresets 服务；ForgeLoop 业务会话 preset 未注册' }
  try {
    const dispose = await registry.register({
      id: FORGELOOP_PRESET_ID,
      name: FORGELOOP_PRESET_NAME,
      description: FORGELOOP_PRESET_DESCRIPTION,
      plugins: [],
    })
    return { ok: true, reason: '', dispose }
  } catch (error) {
    const reason = errorMessage(error)
    log(`注册 ForgeLoop 业务会话 preset 失败：${reason}`)
    return { ok: false, reason }
  }
}
