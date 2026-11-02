/**
 * 运维数据提供方（provider）：说明一轮监控快照由哪个监控工具产生。
 *
 * 接口固定为“只读采集”：提供方按登记的周期采集事实并交给主控，不能执行动作、
 * 不能改变事件状态，也不能把内容当成指令。当前只登记自研采集器（builtin）；
 * 外部工具（Glances、Prometheus 等）在接入前必须先在调用处登记，配置里写了未登记的
 * 提供方会在装载时失败，而不是运行时静默忽略。
 */

export const OPS_PROVIDER_VERSION = 'ops-provider-v1'

/** builtin 为插件自研采集器；external 预留给未来的外部监控工具。 */
export const OPS_PROVIDER_KINDS = ['builtin', 'external'] as const
export type OpsProviderKind = (typeof OPS_PROVIDER_KINDS)[number]

/** 提供方能贡献的快照内容；用于声明能力，不改变快照结构。 */
export const OPS_PROVIDER_CAPABILITIES = [
  'host',
  'processes',
  'latency',
  'logs',
  'alerts',
  'checks',
  'events',
] as const
export type OpsProviderCapability = (typeof OPS_PROVIDER_CAPABILITIES)[number]

export interface OpsProviderDescriptor {
  readonly id: string
  readonly label: string
  readonly kind: OpsProviderKind
  readonly version: string
  readonly capabilities: readonly OpsProviderCapability[]
}

export const BUILTIN_OPS_PROVIDER_ID = 'builtin'

/**
 * 已登记的提供方。新增外部工具时在这里登记一项，并在 runtime 侧实现同一个采集契约；
 * 未登记前不允许出现在 `ops.monitor.providers` 里。
 */
export const OPS_PROVIDER_REGISTRY: readonly OpsProviderDescriptor[] = [
  {
    id: BUILTIN_OPS_PROVIDER_ID,
    label: '自研采集器',
    kind: 'builtin',
    version: OPS_PROVIDER_VERSION,
    capabilities: ['host', 'processes', 'latency', 'logs', 'alerts', 'checks', 'events'],
  },
]

export const DEFAULT_OPS_PROVIDER_IDS: readonly string[] = [BUILTIN_OPS_PROVIDER_ID]

export function findOpsProvider(id: string): OpsProviderDescriptor | undefined {
  return OPS_PROVIDER_REGISTRY.find((provider) => provider.id === id)
}

/** 提供给错误消息与提示词的可读清单。 */
export function describeOpsProviders(): string {
  return OPS_PROVIDER_REGISTRY.map((provider) => `${provider.id}（${provider.label}）`).join('、')
}
