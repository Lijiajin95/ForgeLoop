/**
 * ForgeLoop 业务会话的 DSH agent preset。
 *
 * 该 preset 不挂普通助手工具；用户输入由 `agent/pre-step` 接管后直接进入
 * ForgeLoop 需求受理与需求 Agent 分析，不调用模型聊天。
 */

import { FORGELOOP_PRESET_DESCRIPTION, FORGELOOP_PRESET_ID, FORGELOOP_PRESET_NAME } from './intake.js'

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
  if (typeof getter === 'function') return (getter as (key: string) => unknown).call(ctx, name)
  return ctx[name]
}

/** 读取宿主 preset 注册表；headless profile 没有该服务时返回 undefined。 */
export function presetRegistryOf(ctx: AnyRecord): AgentPresetRegistryLike | undefined {
  const registry = serviceOf(ctx, 'agentPresets') as Partial<AgentPresetRegistryLike> | undefined
  return typeof registry?.register === 'function' ? (registry as AgentPresetRegistryLike) : undefined
}

/**
 * 注册 ForgeLoop 业务会话 preset。已存在同名 preset 时保留既有声明（可能是
 * profile 配置），不覆盖；注册失败只记录原因，插件其余功能继续可用。
 */
export async function registerForgeLoopPreset(
  ctx: AnyRecord,
  log: (message: string) => void = () => undefined,
): Promise<PresetRegistration> {
  const registry = presetRegistryOf(ctx)
  if (!registry) return { ok: false, reason: '宿主没有 agentPresets 服务；ForgeLoop 业务会话 preset 未注册' }
  try {
    const dispose = await registry.register({
      id: FORGELOOP_PRESET_ID,
      name: FORGELOOP_PRESET_NAME,
      description: FORGELOOP_PRESET_DESCRIPTION,
      plugins: [],
    })
    return { ok: true, reason: '', dispose }
  } catch (error) {
    const reason = (error as Error).message
    log(`注册 ForgeLoop 业务会话 preset 失败：${reason}`)
    return { ok: false, reason }
  }
}
