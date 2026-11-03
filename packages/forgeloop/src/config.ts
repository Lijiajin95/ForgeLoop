/**
 * 插件配置：所有两个部署可能不同的值都在这里，不硬编码。
 * 非法值在插件装载时失败（fail loudly），不静默回落。
 */

import { asRecord } from './domain/json.js'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { errorMessage } from './domain/errors.js'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { RuleViolationError } from './domain/errors.js'
import {
  validateOpsCatalog,
  type OpsAction,
  type OpsActionParam,
  type OpsCatalog,
  type OpsCheck,
  type OpsResource,
  type OpsResourceKind,
  type OpsSeverity,
} from './domain/ops.js'
import {
  DEPLOYMENT_CAPABILITIES,
  DEPLOYMENT_TOOL_KINDS,
  type DeploymentCapability,
  type DeploymentDataScope,
  type DeploymentToolKind,
} from './domain/deployment.js'
import {
  DEFAULT_OPS_PROVIDER_IDS,
  describeOpsProviders,
  findOpsProvider,
} from './domain/ops-provider.js'

export interface AgentConfig {
  readonly provider: string
  readonly model: string
  /** 单个 Agent 回合的上限；-1 表示不限（页面显示 MAX）。 */
  readonly timeoutSeconds: number
  /** 长任务的硬上限；任务包 limit_seconds 只能在此范围内放宽；-1 表示不限。 */
  readonly maxTurnSeconds?: number
  /** 回合连续无新进展的上限；超时取消；-1 表示不启用看门狗。 */
  readonly idleTimeoutSeconds?: number
}

export interface OpsMonitorProcess {
  readonly id: string
  /** 进程归属的登记资源；监控问题只能落在已登记资源上。 */
  readonly resourceId: string
  /** `ps` 命令行中的子串匹配，大小写不敏感。 */
  readonly match: string
}

export interface OpsMonitorLatency {
  readonly id: string
  readonly resourceId: string
  readonly url: string
  readonly timeoutSeconds: number
}

export interface OpsMonitorLog {
  readonly id: string
  readonly resourceId: string
  /** 项目内相对路径或绝对路径；只读取尾部固定字节数。 */
  readonly path: string
  /** 逐行匹配的错误正则；匹配数进入监控快照。 */
  readonly errorPattern: string
}

export interface OpsMonitorAlertFile {
  readonly id: string
  /** JSON 数组文件：每条告警包含 severity、summary、at、resourceId。 */
  readonly path: string
}

/** 外部心跳：每轮扫描后上报一次“仍然活着”，供死信服务判断监控是否停摆。 */
export interface OpsMonitorHeartbeat {
  /** 为空表示不上报。 */
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly timeoutSeconds: number
}

/** 主动监控：定时采集主机、进程、延迟、日志与告警，交给运维 Agent 评审。 */
export interface OpsMonitorConfig {
  readonly enabled: boolean
  readonly intervalSeconds: number
  readonly logLines: number
  /** 产生快照的提供方；当前只登记自研采集器，外部工具接入前不允许配置。 */
  readonly providers: readonly string[]
  readonly processes: readonly OpsMonitorProcess[]
  readonly latency: readonly OpsMonitorLatency[]
  readonly logs: readonly OpsMonitorLog[]
  readonly alertFiles: readonly OpsMonitorAlertFile[]
  readonly heartbeat: OpsMonitorHeartbeat
}

/** 外部告警：只发送到所有者登记的 webhook；为空表示不发。 */
export interface OpsAlertConfig {
  readonly webhook: string
  readonly timeoutSeconds: number
}

export interface DeploymentToolConfig {
  readonly id: string
  readonly kind: DeploymentToolKind
  /** 绝对路径；realpath 必须位于 toolRoot 内。 */
  readonly path: string
  readonly capabilities: readonly DeploymentCapability[]
  readonly timeoutSeconds: number
  /** 允许传给工具的环境变量名；值从宿主环境读取。 */
  readonly env: readonly string[]
}

export interface DeploymentTargetConfig {
  readonly id: string
  readonly toolId: string
  readonly requirementId: string
  /** 目标参数（profile/namespace/unit 等）；语义由工具负责。 */
  readonly params: Readonly<Record<string, string>>
  readonly data: DeploymentDataScope
  readonly approval: 'owner' | 'auto'
  readonly rollback: { readonly keep: number }
}

export interface DeploymentRetentionConfig {
  readonly days: number
  readonly compressEveryDays: number
  readonly maxBytes: number
}

export interface DeploymentAlertConfig {
  readonly webhook: string
  readonly timeoutSeconds: number
}

/** 部署：登记外部工具与目标；ForgeLoop 只调用工具并记录，不内置部署机制。 */
export interface DeploymentsConfig {
  readonly enabled: boolean
  readonly toolRoot: string
  readonly verifyTimeoutSeconds: number
  readonly alerts: DeploymentAlertConfig
  readonly retention: DeploymentRetentionConfig
  readonly tools: readonly DeploymentToolConfig[]
  readonly targets: readonly DeploymentTargetConfig[]
}

/** 研发制品的一条运行日志：装载期登记路径，运维工具只读尾部。 */
export interface OpsArtifactLog {
  readonly id: string
  /** 绝对路径或项目内相对路径；`~` 在装载期展开。 */
  readonly path: string
  /** 可选错误正则；配置后运行状态里统计匹配行数，不配置为 null。 */
  readonly errorPattern: string
}

/**
 * 研发制品：部署进某个 DSH profile 的产物。
 * profile 为空表示只登记日志、不读运行身份；两者至少要有一个。
 */
export interface OpsArtifact {
  readonly id: string
  readonly label: string
  /** 已部署产物所在 profile 的目录名；空字符串表示不关联运行实例。 */
  readonly profile: string
  readonly logs: readonly OpsArtifactLog[]
}

export interface OpsConfig extends OpsCatalog {
  readonly enabled: boolean
  /** 巡检周期；到期的检查在协调器持有单消费者锁时运行。 */
  readonly intervalSeconds: number
  readonly monitor: OpsMonitorConfig
  readonly alerts: OpsAlertConfig
  /** 运维可按需读取的研发制品；工具只能读取这里登记的内容。 */
  readonly artifacts: readonly OpsArtifact[]
}

export interface RawOpsResource {
  id?: string
  kind?: string
  label?: string
}

export interface RawOpsCheck {
  id?: string
  resourceId?: string
  command?: string[]
  timeoutSeconds?: number
  severity?: string
}

export interface RawOpsActionParam {
  name?: string
  values?: string[]
}

export interface RawOpsAction {
  id?: string
  resourceId?: string
  command?: string[]
  params?: RawOpsActionParam[]
  timeoutSeconds?: number
  auto?: boolean
  verifyCheckId?: string
}

export interface RawOpsMonitorProcess {
  id?: string
  resourceId?: string
  match?: string
}

export interface RawOpsMonitorLatency {
  id?: string
  resourceId?: string
  url?: string
  timeoutSeconds?: number
}

export interface RawOpsMonitorLog {
  id?: string
  resourceId?: string
  path?: string
  errorPattern?: string
}

export interface RawOpsMonitorAlertFile {
  id?: string
  path?: string
}

export interface RawOpsMonitorHeartbeat {
  url?: string
  method?: string
  timeoutSeconds?: number
}

export interface RawOpsMonitorConfig {
  enabled?: boolean
  intervalSeconds?: number
  logLines?: number
  providers?: string[]
  processes?: RawOpsMonitorProcess[]
  latency?: RawOpsMonitorLatency[]
  logs?: RawOpsMonitorLog[]
  alertFiles?: RawOpsMonitorAlertFile[]
  heartbeat?: RawOpsMonitorHeartbeat
}

export interface RawOpsAlertConfig {
  webhook?: string
  timeoutSeconds?: number
}

export interface RawOpsArtifactLog {
  id?: string
  path?: string
  errorPattern?: string
}

export interface RawOpsArtifact {
  id?: string
  label?: string
  profile?: string
  logs?: RawOpsArtifactLog[]
}

export interface RawOpsConfig {
  enabled?: boolean
  intervalSeconds?: number
  resources?: RawOpsResource[]
  checks?: RawOpsCheck[]
  actions?: RawOpsAction[]
  monitor?: RawOpsMonitorConfig
  alerts?: RawOpsAlertConfig
  artifacts?: RawOpsArtifact[]
}

export interface RawDeploymentTool {
  id?: string
  kind?: string
  path?: string
  capabilities?: string[]
  timeoutSeconds?: number
  env?: string[]
}

export interface RawDeploymentData {
  volumes?: string[]
  migrations?: string[]
}

export interface RawDeploymentTarget {
  id?: string
  toolId?: string
  requirementId?: string
  params?: Record<string, unknown>
  data?: RawDeploymentData
  approval?: string
  rollback?: { keep?: number }
}

export interface RawDeploymentsConfig {
  enabled?: boolean
  toolRoot?: string
  verifyTimeoutSeconds?: number
  alerts?: { webhook?: string; timeoutSeconds?: number }
  retention?: { days?: number; compressEveryDays?: number; maxBytes?: number }
  tools?: RawDeploymentTool[]
  targets?: RawDeploymentTarget[]
}

export interface AutonomyConfig {
  /** 系统准入总开关；关闭后可信需求也只停在待处理。 */
  readonly enabled: boolean
  /** 是否允许系统准入后整合并提交代码；发布/部署另有授权。 */
  readonly allowCodeCommit: boolean
  /** 可信人类入口来源前缀。 */
  readonly trustedSources: readonly string[]
  /** 放开来源限制：任何非空来源都可以进入系统准入；来源仍完整记录在案。 */
  readonly allowAnySource: boolean
  /** 是否要求提交者与配置所有者一致；false 时运维/工具提交也可进入。 */
  readonly requireOwner: boolean
  /** 提交前在真实项目中执行的检查 argv；为空表示不做额外提交检查。 */
  readonly commitCheckCommand: readonly string[]
}

export interface RawAutonomyConfig {
  enabled?: boolean
  allowCodeCommit?: boolean
  trustedSources?: string[]
  allowAnySource?: boolean
  requireOwner?: boolean
  commitCheckCommand?: string[]
}

export interface ForgeLoopConfig {
  readonly recordsRoot: string
  readonly project: string
  readonly projectPath: string
  readonly owner: string
  readonly pollSeconds: number
  readonly autoAdvance: boolean
  readonly agent: AgentConfig
  /** 正式测试命令的超时；-1 表示不限。 */
  readonly formalTestTimeoutSeconds: number
  /** 同一任务的研发尝试次数；-1 表示不限。 */
  readonly maxTaskAttempts: number
  /** 每次授权可用的失败轮次；-1 表示不限（仍逐轮记录）。 */
  readonly failureRoundsPerGrant: number
  /** 单次推进内的验证重试次数；-1 表示不限。 */
  readonly maxVerificationAttempts: number
  readonly worktreePrepareCommand: readonly string[]
  readonly candidateBuildCommand: readonly string[]
  readonly candidatePackageCommand: readonly string[]
  readonly candidateArtifactPath: string
  /** DSH profile 根目录：部署核对读取目标 profile 的实际安装版本。 */
  readonly dshProfilesRoot: string
  readonly autonomy: AutonomyConfig
  readonly ops: OpsConfig
  readonly deployments: DeploymentsConfig
}

export interface RawConfig {
  recordsRoot?: string
  project?: string
  projectPath?: string
  owner?: string
  pollSeconds?: number
  autoAdvance?: boolean
  agent?: Partial<AgentConfig>
  formalTestTimeoutSeconds?: number
  maxTaskAttempts?: number
  failureRoundsPerGrant?: number
  maxVerificationAttempts?: number
  worktreePrepareCommand?: string[]
  candidateBuildCommand?: string[]
  candidatePackageCommand?: string[]
  candidateArtifactPath?: string
  dshProfilesRoot?: string
  autonomy?: RawAutonomyConfig
  ops?: RawOpsConfig
  deployments?: RawDeploymentsConfig
}

/**
 * ForgeLoop 自己的配置文件：默认 `~/.forgeloop/config.json`，可用 `FORGELOOP_CONFIG`
 * 覆盖路径。DSH 的 cordis 配置只负责装载插件，不再存放业务配置；
 * 文件里的值优先于装载参数，避免两处配置各说一套。
 */
export function defaultConfigPath(): string {
  return join(homedir(), '.forgeloop', 'config.json')
}

export function loadConfigFile(
  path = process.env.FORGELOOP_CONFIG?.trim() || defaultConfigPath(),
): RawConfig {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new RuleViolationError(`ForgeLoop 配置文件不是合法 JSON：${path}：${errorMessage(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RuleViolationError(`ForgeLoop 配置文件必须是 JSON 对象：${path}`)
  }
  return parsed
}

/** 合并顺序：宿主装载参数做底，独立配置文件覆盖；缺文件时保持原样。 */
export function mergeConfig(base: RawConfig, file: RawConfig): RawConfig {
  return { ...base, ...file }
}

/**
 * 装载业务配置：优先独立文件。两者都没有关键值时报错，而不是静默回落到
 * “当前目录/.forgeloop”——静默回落会让插件连到另一个记录库，造成假死或分叉。
 */
export function loadConfigOrThrow(
  base: RawConfig = {},
  path = process.env.FORGELOOP_CONFIG?.trim() || defaultConfigPath(),
): RawConfig {
  // 装载参数已经给出关键路径（测试或显式宿主配置）时以它为准；
  // 只有宿主没有配置时才读取独立文件，避免测试被本机配置污染。
  if (base.recordsRoot || base.projectPath) return base
  const file = loadConfigFile(path)
  if (Object.keys(file).length === 0) {
    throw new RuleViolationError(
      `ForgeLoop 配置缺失：请写入 ${path}（或用 FORGELOOP_CONFIG 指定路径），不要依赖默认目录`,
    )
  }
  return mergeConfig(base, file)
}

function positiveNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RuleViolationError(`配置 ${field} 必须是正数，实际 ${JSON.stringify(value)}`)
  }
  return value
}

function positiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RuleViolationError(`配置 ${field} 必须是正整数，实际 ${JSON.stringify(value)}`)
  }
  return value
}

/** 执行限制类配置：-1 表示不限，其他负值、0 与非数字拒绝。 */
function limitNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || (value !== -1 && value <= 0)) {
    throw new RuleViolationError(
      `配置 ${field} 必须为 -1 或正数（-1 表示不限），实际 ${JSON.stringify(value)}`,
    )
  }
  return value
}

function limitInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || (value !== -1 && value <= 0)) {
    throw new RuleViolationError(
      `配置 ${field} 必须为 -1 或正整数（-1 表示不限），实际 ${JSON.stringify(value)}`,
    )
  }
  return value
}

function stringList(value: unknown, field: string, fallback: readonly string[]): readonly string[] {
  if (value === undefined) return fallback
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === 'string' && item.trim() !== '')
  ) {
    throw new RuleViolationError(`配置 ${field} 必须是字符串数组`)
  }
  return value
}

function booleanValue(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new RuleViolationError(`配置 ${field} 必须是布尔值`)
  return value
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RuleViolationError(`配置 ${field} 必须是非空字符串`)
  }
  return value.trim()
}

function objectList(value: unknown, field: string): Array<Record<string, unknown>> {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new RuleViolationError(`配置 ${field} 必须是数组`)
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new RuleViolationError(`配置 ${field}[${index}] 必须是对象`)
    }
    return asRecord(item) ?? {}
  })
}

/**
 * 系统准入与提交检查配置。默认对可信人类入口开放研发与提交，但发布/部署不在授权内；
 * 所有者可以在配置文件中关闭或收紧来源前缀。
 */
function parseAutonomyConfig(raw: RawAutonomyConfig | undefined): AutonomyConfig {
  const source = raw ?? {}
  const trustedSources = stringList(source.trustedSources, 'autonomy.trustedSources', [
    'dsh-session:',
  ])
  if (trustedSources.length === 0) {
    throw new RuleViolationError(
      '配置 autonomy.trustedSources 不能为空；关闭准入请用 enabled=false',
    )
  }
  const commitCheckCommand = stringList(
    source.commitCheckCommand,
    'autonomy.commitCheckCommand',
    [],
  )
  return {
    enabled: booleanValue(source.enabled, 'autonomy.enabled', true),
    allowCodeCommit: booleanValue(source.allowCodeCommit, 'autonomy.allowCodeCommit', true),
    trustedSources,
    allowAnySource: booleanValue(source.allowAnySource, 'autonomy.allowAnySource', true),
    requireOwner: booleanValue(source.requireOwner, 'autonomy.requireOwner', false),
    commitCheckCommand,
  }
}

function assertHttpUrl(value: string, field: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new RuleViolationError(`配置 ${field} 必须是合法的 http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RuleViolationError(`配置 ${field} 只接受 http(s) URL`)
  }
}

function monitorId(seen: Set<string>, value: unknown, field: string): string {
  const id = requiredText(value, field)
  if (seen.has(id)) throw new RuleViolationError(`配置 ${field} 重复：${id}`)
  seen.add(id)
  return id
}

function knownResource(ids: ReadonlySet<string>, value: unknown, field: string): string {
  const resourceId = requiredText(value, field)
  if (!ids.has(resourceId)) {
    throw new RuleViolationError(`配置 ${field} 引用了未登记的资源：${resourceId}`)
  }
  return resourceId
}

function parseMonitorProcesses(
  items: RawOpsMonitorProcess[] | undefined,
  ids: ReadonlySet<string>,
  seen: Set<string>,
): OpsMonitorProcess[] {
  return objectList(items, 'ops.monitor.processes').map((item, index) => {
    const field = `ops.monitor.processes[${index}]`
    const match = requiredText(item.match, `${field}.match`)
    if (match.length > 200) {
      throw new RuleViolationError(`配置 ${field}.match 超过 200 字符上限`)
    }
    return {
      id: monitorId(seen, item.id, `${field}.id`),
      resourceId: knownResource(ids, item.resourceId, `${field}.resourceId`),
      match,
    }
  })
}

function parseMonitorLatency(
  items: RawOpsMonitorLatency[] | undefined,
  ids: ReadonlySet<string>,
  seen: Set<string>,
): OpsMonitorLatency[] {
  return objectList(items, 'ops.monitor.latency').map((item, index) => {
    const field = `ops.monitor.latency[${index}]`
    const url = requiredText(item.url, `${field}.url`)
    assertHttpUrl(url, `${field}.url`)
    const timeoutSeconds = positiveNumber(item.timeoutSeconds, `${field}.timeoutSeconds`, 5)
    if (timeoutSeconds > 60) {
      throw new RuleViolationError(`配置 ${field}.timeoutSeconds 不能大于 60 秒`)
    }
    return {
      id: monitorId(seen, item.id, `${field}.id`),
      resourceId: knownResource(ids, item.resourceId, `${field}.resourceId`),
      url,
      timeoutSeconds,
    }
  })
}

function parseMonitorLogs(
  items: RawOpsMonitorLog[] | undefined,
  ids: ReadonlySet<string>,
  seen: Set<string>,
): OpsMonitorLog[] {
  return objectList(items, 'ops.monitor.logs').map((item, index) => {
    const field = `ops.monitor.logs[${index}]`
    const errorPattern = requiredText(item.errorPattern, `${field}.errorPattern`)
    try {
      new RegExp(errorPattern)
    } catch (error) {
      throw new RuleViolationError(
        `配置 ${field}.errorPattern 不是合法正则：${errorMessage(error)}`,
      )
    }
    return {
      id: monitorId(seen, item.id, `${field}.id`),
      resourceId: knownResource(ids, item.resourceId, `${field}.resourceId`),
      path: requiredText(item.path, `${field}.path`),
      errorPattern,
    }
  })
}

function parseMonitorAlertFiles(
  items: RawOpsMonitorAlertFile[] | undefined,
  seen: Set<string>,
): OpsMonitorAlertFile[] {
  return objectList(items, 'ops.monitor.alertFiles').map((item, index) => {
    const field = `ops.monitor.alertFiles[${index}]`
    return {
      id: monitorId(seen, item.id, `${field}.id`),
      path: requiredText(item.path, `${field}.path`),
    }
  })
}

/**
 * 监控提供方：默认只用自研采集器。写了未登记的提供方（例如未来的 Glances）
 * 在装载时失败，避免运行时静默忽略——“支持对接”不等于“已经支持”。
 */
function parseMonitorProviders(value: unknown): string[] {
  if (value === undefined) return [...DEFAULT_OPS_PROVIDER_IDS]
  if (!Array.isArray(value)) {
    throw new RuleViolationError('配置 ops.monitor.providers 必须是字符串数组')
  }
  if (value.length === 0) {
    throw new RuleViolationError('配置 ops.monitor.providers 至少需要一个监控提供方')
  }
  const seen = new Set<string>()
  return value.map((item, index) => {
    const field = `ops.monitor.providers[${index}]`
    const id = requiredText(item, field)
    if (seen.has(id)) throw new RuleViolationError(`配置 ${field} 重复：${id}`)
    seen.add(id)
    if (!findOpsProvider(id)) {
      throw new RuleViolationError(
        `配置 ${field} 引用了未登记的监控提供方：${id}（当前只登记 ${describeOpsProviders()}）`,
      )
    }
    return id
  })
}

const HEARTBEAT_METHODS = ['GET', 'POST'] as const

function parseMonitorHeartbeat(raw: RawOpsMonitorHeartbeat | undefined): OpsMonitorHeartbeat {
  const source = raw ?? {}
  if (source.url !== undefined && typeof source.url !== 'string') {
    throw new RuleViolationError('配置 ops.monitor.heartbeat.url 必须是字符串')
  }
  const url = typeof source.url === 'string' ? source.url.trim() : ''
  if (url) assertHttpUrl(url, 'ops.monitor.heartbeat.url')
  const rawMethod = typeof source.method === 'string' ? source.method.trim().toUpperCase() : ''
  const method = rawMethod === '' ? 'GET' : rawMethod
  if (method !== 'GET' && method !== 'POST') {
    throw new RuleViolationError(
      `配置 ops.monitor.heartbeat.method 只能是 ${HEARTBEAT_METHODS.join(' 或 ')}`,
    )
  }
  const timeoutSeconds = positiveNumber(
    source.timeoutSeconds,
    'ops.monitor.heartbeat.timeoutSeconds',
    5,
  )
  if (timeoutSeconds > 30) {
    throw new RuleViolationError('配置 ops.monitor.heartbeat.timeoutSeconds 不能大于 30 秒')
  }
  return { url, method, timeoutSeconds }
}

/**
 * 主动监控目录：采集来源必须指向已登记资源，身份唯一，URL/正则在装载期校验。
 * 默认关闭；启用后由运维巡检按自己的周期运行，不与检查周期绑定。
 */
function parseMonitorConfig(
  raw: RawOpsMonitorConfig | undefined,
  resources: readonly OpsResource[],
): OpsMonitorConfig {
  const source = raw ?? {}
  const intervalSeconds = positiveNumber(source.intervalSeconds, 'ops.monitor.intervalSeconds', 300)
  if (intervalSeconds < 30) {
    throw new RuleViolationError('配置 ops.monitor.intervalSeconds 不能小于 30 秒')
  }
  const logLines = positiveInteger(source.logLines, 'ops.monitor.logLines', 80)
  if (logLines > 500) throw new RuleViolationError('配置 ops.monitor.logLines 不能大于 500')
  const ids = new Set(resources.map((resource) => resource.id))
  const seen = new Set<string>()
  return {
    enabled: booleanValue(source.enabled, 'ops.monitor.enabled', false),
    intervalSeconds,
    logLines,
    providers: parseMonitorProviders(source.providers),
    processes: parseMonitorProcesses(source.processes, ids, seen),
    latency: parseMonitorLatency(source.latency, ids, seen),
    logs: parseMonitorLogs(source.logs, ids, seen),
    alertFiles: parseMonitorAlertFiles(source.alertFiles, seen),
    heartbeat: parseMonitorHeartbeat(source.heartbeat),
  }
}

function parseAlertConfig(raw: RawOpsAlertConfig | undefined): OpsAlertConfig {
  const source = raw ?? {}
  if (source.webhook !== undefined && typeof source.webhook !== 'string') {
    throw new RuleViolationError('配置 ops.alerts.webhook 必须是字符串')
  }
  const webhook = typeof source.webhook === 'string' ? source.webhook.trim() : ''
  if (webhook) assertHttpUrl(webhook, 'ops.alerts.webhook')
  const timeoutSeconds = positiveNumber(source.timeoutSeconds, 'ops.alerts.timeoutSeconds', 10)
  if (timeoutSeconds > 60) {
    throw new RuleViolationError('配置 ops.alerts.timeoutSeconds 不能大于 60 秒')
  }
  return { webhook, timeoutSeconds }
}

const MAX_DEPLOYMENT_TOOLS = 20
const MAX_DEPLOYMENT_TARGETS = 50
const MAX_DEPLOYMENT_PARAMS = 20
const DEFAULT_DEPLOYMENT_MAX_BYTES = 10 * 1024 * 1024 * 1024
const DEPLOYMENT_TOOL_TIMEOUT_LIMIT = 3600
const DEPLOYMENT_VERIFY_TIMEOUT_LIMIT = 86_400
const DEPLOYMENT_TOOL_KIND_BY_NAME: Record<string, DeploymentToolKind> = Object.fromEntries(
  DEPLOYMENT_TOOL_KINDS.map((kind) => [kind, kind]),
)
const DEPLOYMENT_CAPABILITY_BY_NAME: Record<string, DeploymentCapability> = Object.fromEntries(
  DEPLOYMENT_CAPABILITIES.map((capability) => [capability, capability]),
)

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function deploymentToolRootOf(value: unknown, deploymentRoot: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : 'tools'
  const root = resolve(deploymentRoot, expandHome(text))
  if (!isInside(resolve(deploymentRoot), root)) {
    throw new RuleViolationError('配置 deployments.toolRoot 必须是部署目录的子目录')
  }
  return root
}

function deploymentPathVerified(path: string, toolRoot: string, field: string): string {
  if (!isAbsolute(path)) {
    throw new RuleViolationError(`配置 ${field} 必须是绝对路径`)
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new RuleViolationError(`配置 ${field} 指向的脚本不存在：${path}`)
  }
  if (!isInside(resolve(toolRoot), resolve(path))) {
    throw new RuleViolationError(`配置 ${field} 必须位于 deployments.toolRoot 内`)
  }
  let realRoot: string
  let realFile: string
  try {
    realRoot = realpathSync(toolRoot)
    realFile = realpathSync(path)
  } catch (error) {
    throw new RuleViolationError(`配置 ${field} 无法解析真实路径：${errorMessage(error)}`)
  }
  if (!isInside(realRoot, realFile)) {
    throw new RuleViolationError(`配置 ${field} 必须位于 deployments.toolRoot 内`)
  }
  return realFile
}

function parseDeploymentParams(value: unknown, field: string): Record<string, string> {
  const record = asRecord(value) ?? {}
  const entries = Object.entries(record)
  if (entries.length > MAX_DEPLOYMENT_PARAMS) {
    throw new RuleViolationError(`配置 ${field} 不能超过 ${MAX_DEPLOYMENT_PARAMS} 项`)
  }
  const params: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (!key.trim() || key.length > 60) {
      throw new RuleViolationError(`配置 ${field} 的参数名必须非空且不超过 60 字符`)
    }
    if (typeof item !== 'string' || !item.trim() || item.length > 200) {
      throw new RuleViolationError(`配置 ${field}.${key} 必须是 1–200 字符的字符串`)
    }
    params[key] = item.trim()
  }
  return params
}

function parseDeploymentAlerts(raw: RawDeploymentsConfig['alerts']): DeploymentAlertConfig {
  const source = raw ?? {}
  if (source.webhook !== undefined && typeof source.webhook !== 'string') {
    throw new RuleViolationError('配置 deployments.alerts.webhook 必须是字符串')
  }
  const webhook = typeof source.webhook === 'string' ? source.webhook.trim() : ''
  if (webhook) assertHttpUrl(webhook, 'deployments.alerts.webhook')
  const timeoutSeconds = positiveNumber(
    source.timeoutSeconds,
    'deployments.alerts.timeoutSeconds',
    10,
  )
  if (timeoutSeconds > 60) {
    throw new RuleViolationError('配置 deployments.alerts.timeoutSeconds 不能大于 60 秒')
  }
  return { webhook, timeoutSeconds }
}

function parseDeploymentRetention(
  raw: RawDeploymentsConfig['retention'],
): DeploymentRetentionConfig {
  const source = raw ?? {}
  const days = positiveInteger(source.days, 'deployments.retention.days', 120)
  if (days > 3650) throw new RuleViolationError('配置 deployments.retention.days 不能大于 3650 天')
  const compressEveryDays = positiveInteger(
    source.compressEveryDays,
    'deployments.retention.compressEveryDays',
    30,
  )
  if (compressEveryDays > days) {
    throw new RuleViolationError('配置 deployments.retention.compressEveryDays 不能大于 days')
  }
  const maxBytes = positiveInteger(
    source.maxBytes,
    'deployments.retention.maxBytes',
    DEFAULT_DEPLOYMENT_MAX_BYTES,
  )
  if (maxBytes < 1024 * 1024) {
    throw new RuleViolationError('配置 deployments.retention.maxBytes 不能小于 1 MiB')
  }
  return { days, compressEveryDays, maxBytes }
}

function parseDeploymentTools(
  items: RawDeploymentTool[] | undefined,
  toolRoot: string,
): DeploymentToolConfig[] {
  const list = objectList(items, 'deployments.tools')
  if (list.length > MAX_DEPLOYMENT_TOOLS) {
    throw new RuleViolationError(`配置 deployments.tools 不能超过 ${MAX_DEPLOYMENT_TOOLS} 个`)
  }
  const seen = new Set<string>()
  return list.map((item, index) => {
    const field = `deployments.tools[${index}]`
    const id = requiredText(item.id, `${field}.id`)
    if (seen.has(id)) throw new RuleViolationError(`配置 ${field}.id 重复：${id}`)
    seen.add(id)
    const rawKind = requiredText(item.kind, `${field}.kind`)
    const kind = DEPLOYMENT_TOOL_KIND_BY_NAME[rawKind]
    if (!kind) {
      throw new RuleViolationError(
        `配置 ${field}.kind 只能是 ${DEPLOYMENT_TOOL_KINDS.join('、')}，实际 ${rawKind}`,
      )
    }
    const path = deploymentPathVerified(
      requiredText(item.path, `${field}.path`),
      toolRoot,
      `${field}.path`,
    )
    const rawCapabilities = stringList(item.capabilities, `${field}.capabilities`, [])
    if (rawCapabilities.length === 0) {
      throw new RuleViolationError(`配置 ${field}.capabilities 至少要声明 preflight 与 apply`)
    }
    const capabilities: DeploymentCapability[] = []
    for (const rawCapability of rawCapabilities) {
      const capability = DEPLOYMENT_CAPABILITY_BY_NAME[rawCapability]
      if (!capability) {
        throw new RuleViolationError(
          `配置 ${field}.capabilities 含未登记能力：${rawCapability}（可用 ${DEPLOYMENT_CAPABILITIES.join('、')}）`,
        )
      }
      if (capabilities.includes(capability)) {
        throw new RuleViolationError(`配置 ${field}.capabilities 重复：${capability}`)
      }
      capabilities.push(capability)
    }
    for (const required of ['preflight', 'apply'] as const) {
      if (!capabilities.includes(required)) {
        throw new RuleViolationError(`配置 ${field}.capabilities 缺少 ${required}`)
      }
    }
    const timeoutSeconds = positiveNumber(item.timeoutSeconds, `${field}.timeoutSeconds`, 300)
    if (timeoutSeconds > DEPLOYMENT_TOOL_TIMEOUT_LIMIT) {
      throw new RuleViolationError(
        `配置 ${field}.timeoutSeconds 不能大于 ${DEPLOYMENT_TOOL_TIMEOUT_LIMIT} 秒`,
      )
    }
    return {
      id,
      kind,
      path,
      capabilities,
      timeoutSeconds,
      env: stringList(item.env, `${field}.env`, []),
    }
  })
}

function parseDeploymentTargets(
  items: RawDeploymentTarget[] | undefined,
  tools: ReadonlyMap<string, DeploymentToolConfig>,
  alerts: DeploymentAlertConfig,
): DeploymentTargetConfig[] {
  const list = objectList(items, 'deployments.targets')
  if (list.length > MAX_DEPLOYMENT_TARGETS) {
    throw new RuleViolationError(`配置 deployments.targets 不能超过 ${MAX_DEPLOYMENT_TARGETS} 个`)
  }
  const seen = new Set<string>()
  return list.map((item, index) => {
    const field = `deployments.targets[${index}]`
    const id = requiredText(item.id, `${field}.id`)
    if (seen.has(id)) throw new RuleViolationError(`配置 ${field}.id 重复：${id}`)
    seen.add(id)
    const toolId = requiredText(item.toolId, `${field}.toolId`)
    const tool = tools.get(toolId)
    if (!tool) throw new RuleViolationError(`配置 ${field}.toolId 引用了未登记的工具：${toolId}`)
    const requirementId = requiredText(item.requirementId, `${field}.requirementId`)
    const params = parseDeploymentParams(item.params, `${field}.params`)
    const data = asRecord(item.data) ?? {}
    const volumes = stringList(data.volumes, `${field}.data.volumes`, [])
    const migrations = stringList(data.migrations, `${field}.data.migrations`, [])
    const hasData = volumes.length > 0 || migrations.length > 0
    if (hasData && !tool.capabilities.includes('data-rollback')) {
      throw new RuleViolationError(
        `配置 ${field}.data 声明了卷或迁移，但工具 ${toolId} 没有 data-rollback 能力`,
      )
    }
    const approval = typeof item.approval === 'string' ? item.approval.trim() : 'owner'
    if (approval !== 'owner' && approval !== 'auto') {
      throw new RuleViolationError(`配置 ${field}.approval 只能是 owner 或 auto`)
    }
    const rollback = asRecord(item.rollback) ?? {}
    const keep = positiveInteger(rollback.keep, `${field}.rollback.keep`, 1)
    if (keep > 10) throw new RuleViolationError(`配置 ${field}.rollback.keep 不能大于 10`)
    if (approval === 'auto') {
      if (keep < 1) throw new RuleViolationError(`配置 ${field} 启用 auto 时必须保留回退产物`)
      if (!alerts.webhook) {
        throw new RuleViolationError(
          `配置 ${field} 启用 auto 时必须配置 deployments.alerts.webhook（重载失败告警）`,
        )
      }
    }
    return {
      id,
      toolId,
      requirementId,
      params,
      data: { volumes, migrations },
      approval,
      rollback: { keep },
    }
  })
}

/**
 * 部署目录：登记外部部署工具与目标。默认关闭；工具脚本与目标在装载期校验，
 * 非法值不会在运行期被忽略。当前版本只支持本机部署，多机配置直接失败。
 */
function parseDeployments(
  raw: RawDeploymentsConfig | undefined,
  deploymentRoot: string,
): DeploymentsConfig {
  const source = raw ?? {}
  const enabled = booleanValue(source.enabled, 'deployments.enabled', false)
  const toolRoot = deploymentToolRootOf(source.toolRoot, deploymentRoot)
  const verifyTimeoutSeconds = positiveNumber(
    source.verifyTimeoutSeconds,
    'deployments.verifyTimeoutSeconds',
    600,
  )
  if (verifyTimeoutSeconds < 30 || verifyTimeoutSeconds > DEPLOYMENT_VERIFY_TIMEOUT_LIMIT) {
    throw new RuleViolationError(
      `配置 deployments.verifyTimeoutSeconds 必须在 30–${DEPLOYMENT_VERIFY_TIMEOUT_LIMIT} 秒`,
    )
  }
  const alerts = parseDeploymentAlerts(source.alerts)
  const retention = parseDeploymentRetention(source.retention)
  const tools = parseDeploymentTools(source.tools, toolRoot)
  const byId = new Map(tools.map((tool) => [tool.id, tool]))
  const targets = parseDeploymentTargets(source.targets, byId, alerts)
  return { enabled, toolRoot, verifyTimeoutSeconds, alerts, retention, tools, targets }
}

/** profile 目录名必须是一段：拒绝 `.`、`..` 与路径分隔符，避免读到 profile 根之外。 */
const PROFILE_SEGMENT = /^[A-Za-z0-9._-]+$/
const MAX_ARTIFACTS = 20
const MAX_ARTIFACT_LOGS = 20

/**
 * 研发制品目录：每条日志一个登记路径，运维工具只能读取这里列出的文件。
 * profile 只接受单个目录名；路径支持 `~` 展开，其余相对路径按项目根解析。
 */
function parseArtifacts(items: RawOpsArtifact[] | undefined): OpsArtifact[] {
  const list = objectList(items, 'ops.artifacts')
  if (list.length > MAX_ARTIFACTS) {
    throw new RuleViolationError(`配置 ops.artifacts 不能超过 ${MAX_ARTIFACTS} 个`)
  }
  const seen = new Set<string>()
  return list.map((item, index) => {
    const field = `ops.artifacts[${index}]`
    const id = requiredText(item.id, `${field}.id`)
    if (seen.has(id)) throw new RuleViolationError(`配置 ${field}.id 重复：${id}`)
    seen.add(id)
    const profile = typeof item.profile === 'string' ? item.profile.trim() : ''
    if (profile && (profile === '.' || profile === '..' || !PROFILE_SEGMENT.test(profile))) {
      throw new RuleViolationError(`配置 ${field}.profile 只能是单个 profile 目录名：${profile}`)
    }
    const logList = objectList(item.logs, `${field}.logs`)
    if (logList.length > MAX_ARTIFACT_LOGS) {
      throw new RuleViolationError(`配置 ${field}.logs 不能超过 ${MAX_ARTIFACT_LOGS} 条`)
    }
    const logSeen = new Set<string>()
    const logs = logList.map((entry, logIndex) => {
      const logField = `${field}.logs[${logIndex}]`
      const logId = requiredText(entry.id, `${logField}.id`)
      if (logSeen.has(logId)) throw new RuleViolationError(`配置 ${logField}.id 重复：${logId}`)
      logSeen.add(logId)
      const path = expandHome(requiredText(entry.path, `${logField}.path`))
      const errorPattern = typeof entry.errorPattern === 'string' ? entry.errorPattern.trim() : ''
      if (errorPattern) {
        try {
          new RegExp(errorPattern)
        } catch (error) {
          throw new RuleViolationError(
            `配置 ${logField}.errorPattern 不是合法正则：${errorMessage(error)}`,
          )
        }
      }
      return { id: logId, path, errorPattern }
    })
    if (!profile && logs.length === 0) {
      throw new RuleViolationError(`配置 ${field} 至少要登记一个 profile 或一条日志`)
    }
    return {
      id,
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id,
      profile,
      logs,
    }
  })
}

/**
 * 运维目录：资源、只读检查与登记动作。目录非法时装载失败，
 * 不在运行期猜测或放宽；未启用的目录也做同样的静态校验。
 */
function parseOpsConfig(raw: RawOpsConfig | undefined): OpsConfig {
  const source = raw ?? {}
  const enabled = booleanValue(source.enabled, 'ops.enabled', false)
  const intervalSeconds = positiveNumber(source.intervalSeconds, 'ops.intervalSeconds', 300)
  if (intervalSeconds < 30) throw new RuleViolationError('配置 ops.intervalSeconds 不能小于 30 秒')

  const resources: OpsResource[] = objectList(source.resources, 'ops.resources').map(
    (item, index) => ({
      id: requiredText(item.id, `ops.resources[${index}].id`),
      kind: (typeof item.kind === 'string' && item.kind.trim()
        ? item.kind.trim()
        : 'other') as OpsResourceKind,
      label:
        typeof item.label === 'string' && item.label.trim()
          ? item.label.trim()
          : requiredText(item.id, `ops.resources[${index}].id`),
    }),
  )

  const checks: OpsCheck[] = objectList(source.checks, 'ops.checks').map((item, index) => ({
    id: requiredText(item.id, `ops.checks[${index}].id`),
    resourceId: requiredText(item.resourceId, `ops.checks[${index}].resourceId`),
    command: stringList(item.command, `ops.checks[${index}].command`, []),
    timeoutSeconds: positiveNumber(item.timeoutSeconds, `ops.checks[${index}].timeoutSeconds`, 60),
    severity: (typeof item.severity === 'string' && item.severity.trim()
      ? item.severity.trim()
      : 'major') as OpsSeverity,
  }))

  const checksByResource = new Map<string, OpsCheck[]>()
  for (const check of checks) {
    const list = checksByResource.get(check.resourceId) ?? []
    list.push(check)
    checksByResource.set(check.resourceId, list)
  }

  const actions: OpsAction[] = objectList(source.actions, 'ops.actions').map((item, index) => {
    const resourceId = requiredText(item.resourceId, `ops.actions[${index}].resourceId`)
    const candidates = checksByResource.get(resourceId) ?? []
    const verifyCheckId =
      typeof item.verifyCheckId === 'string' && item.verifyCheckId.trim()
        ? item.verifyCheckId.trim()
        : candidates.length === 1
          ? (candidates[0]?.id ?? '')
          : ''
    if (!verifyCheckId) {
      throw new RuleViolationError(
        `配置 ops.actions[${index}].verifyCheckId 必填：资源 ${resourceId} 有 ${candidates.length} 个检查，无法唯一推断`,
      )
    }
    const params: OpsActionParam[] = objectList(item.params, `ops.actions[${index}].params`).map(
      (param, paramIndex) => ({
        name: requiredText(param.name, `ops.actions[${index}].params[${paramIndex}].name`),
        values: stringList(param.values, `ops.actions[${index}].params[${paramIndex}].values`, []),
      }),
    )
    return {
      id: requiredText(item.id, `ops.actions[${index}].id`),
      resourceId,
      command: stringList(item.command, `ops.actions[${index}].command`, []),
      params,
      timeoutSeconds: positiveNumber(
        item.timeoutSeconds,
        `ops.actions[${index}].timeoutSeconds`,
        60,
      ),
      auto: booleanValue(item.auto, `ops.actions[${index}].auto`, false),
      verifyCheckId,
    }
  })

  const catalog: OpsCatalog = { resources, checks, actions }
  validateOpsCatalog(catalog)
  const monitor = parseMonitorConfig(source.monitor, resources)
  const alerts = parseAlertConfig(source.alerts)
  const artifacts = parseArtifacts(source.artifacts)
  if (monitor.enabled && !enabled) {
    throw new RuleViolationError('配置 ops.monitor 启用时需要同时启用 ops')
  }
  if (enabled && checks.length === 0 && !monitor.enabled) {
    throw new RuleViolationError(
      '配置 ops 启用时至少要登记一个检查，或启用 ops.monitor 主动监控；否则不会产生任何运维事件',
    )
  }
  return { enabled, intervalSeconds, ...catalog, monitor, alerts, artifacts }
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

function textOr(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback
}

export function resolveConfig(raw: RawConfig, cwd = process.cwd()): ForgeLoopConfig {
  const project = textOr(raw.project, 'forgeloop')
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
    throw new RuleViolationError(
      `配置 project 只能是安全的项目名，实际 ${JSON.stringify(raw.project)}`,
    )
  }
  const projectPath = resolve(cwd, expandHome(textOr(raw.projectPath, '.')))
  // Desktop 和 Web 的启动目录可能不同；项目数据始终相对已选项目定位。
  const recordsRoot = resolve(projectPath, expandHome(textOr(raw.recordsRoot, '.forgeloop')))
  const pollSeconds = positiveNumber(raw.pollSeconds, 'pollSeconds', 5)
  if (pollSeconds < 1) throw new RuleViolationError('配置 pollSeconds 不能小于 1 秒')
  const agentProvider = textOr(raw.agent?.provider, '')
  const agentModel = textOr(raw.agent?.model, '')
  const deploymentRoot = join(recordsRoot, 'projects', project, 'deployments')
  return {
    recordsRoot,
    project,
    projectPath,
    owner: textOr(raw.owner, 'local-owner'),
    pollSeconds,
    autoAdvance: raw.autoAdvance === true,
    agent: {
      provider: agentProvider,
      model: agentModel,
      timeoutSeconds: limitNumber(raw.agent?.timeoutSeconds, 'agent.timeoutSeconds', -1),
      maxTurnSeconds: limitNumber(raw.agent?.maxTurnSeconds, 'agent.maxTurnSeconds', -1),
      idleTimeoutSeconds: limitNumber(
        raw.agent?.idleTimeoutSeconds,
        'agent.idleTimeoutSeconds',
        -1,
      ),
    },
    formalTestTimeoutSeconds: limitNumber(
      raw.formalTestTimeoutSeconds,
      'formalTestTimeoutSeconds',
      -1,
    ),
    maxTaskAttempts: limitInteger(raw.maxTaskAttempts, 'maxTaskAttempts', -1),
    failureRoundsPerGrant: limitInteger(raw.failureRoundsPerGrant, 'failureRoundsPerGrant', -1),
    maxVerificationAttempts: limitInteger(
      raw.maxVerificationAttempts,
      'maxVerificationAttempts',
      -1,
    ),
    worktreePrepareCommand: stringList(raw.worktreePrepareCommand, 'worktreePrepareCommand', []),
    candidateBuildCommand: stringList(raw.candidateBuildCommand, 'candidateBuildCommand', []),
    candidatePackageCommand: stringList(raw.candidatePackageCommand, 'candidatePackageCommand', []),
    candidateArtifactPath: textOr(raw.candidateArtifactPath, ''),
    dshProfilesRoot: resolve(
      projectPath,
      expandHome(textOr(raw.dshProfilesRoot, join(homedir(), '.dsh', 'profiles'))),
    ),
    autonomy: parseAutonomyConfig(raw.autonomy),
    ops: parseOpsConfig(raw.ops),
    deployments: parseDeployments(raw.deployments, deploymentRoot),
  }
}

/** 记录根下的项目目录：`<recordsRoot>/projects/<name>`。 */
export function projectDir(config: ForgeLoopConfig): string {
  return join(config.recordsRoot, 'projects', config.project)
}

export function recordsPath(config: ForgeLoopConfig): string {
  return join(projectDir(config), 'records.sqlite')
}

export function evidenceDir(
  config: ForgeLoopConfig,
  reqId: string,
  planVersion: number,
  taskId: string,
): string {
  return join(projectDir(config), 'evidence', reqId, `v${planVersion}`, taskId)
}

export function workspaceDir(
  config: ForgeLoopConfig,
  reqId: string,
  planVersion: number,
  taskId: string,
): string {
  return join(projectDir(config), 'workspaces', reqId, `v${planVersion}`, taskId)
}

/** 需求级研发现场：同一需求的方案、实现、自验与修复共用，不按阶段重建。 */
export function devWorkspaceDir(config: ForgeLoopConfig, reqId: string): string {
  return join(projectDir(config), 'workspaces', reqId, 'dev')
}

/** 研发会话的固定工作区：路径随会话保留，内容按新需求基线刷新。 */
export function devSessionWorkspaceDir(config: ForgeLoopConfig, sessionId: string): string {
  return join(projectDir(config), 'workspaces', 'dev-sessions', sessionId)
}

/** 研发会话总结与阶段轨迹目录；总结文件随会话 ID 与需求 ID 绑定。 */
export function devSessionDir(config: ForgeLoopConfig, sessionId: string): string {
  return join(sessionsDir(config), 'dev-sessions', sessionId)
}

/** 提交检查与整合证据目录；每次提交尝试独立一份，旧记录不覆盖。 */
export function integrationDir(
  config: ForgeLoopConfig,
  reqId: string,
  candidateSha256: string,
): string {
  return join(projectDir(config), 'integrations', reqId, candidateSha256.slice(0, 16))
}

export function reviewDir(
  config: ForgeLoopConfig,
  reqId: string,
  planVersion: number,
  taskId: string,
): string {
  return join(projectDir(config), 'reviews', reqId, `v${planVersion}`, taskId)
}

/** 实现前评审的固定目录；每个任务包版本一份。 */
export function planReviewDir(config: ForgeLoopConfig, reqId: string, planVersion: number): string {
  return join(projectDir(config), 'reviews', reqId, `v${planVersion}`, 'plan')
}

/** 验证方案目录：候选生成前按任务包版本固定，供同一验证会话设计与复用。 */
export function verificationPlanDir(
  config: ForgeLoopConfig,
  reqId: string,
  planVersion: number,
): string {
  return join(projectDir(config), 'verifications', reqId, `v${planVersion}`, 'plan')
}

/** 独立验证目录：按候选身份隔离，保留旧候选的验证证据。 */
export function verificationDir(
  config: ForgeLoopConfig,
  reqId: string,
  planVersion: number,
  candidateSha256: string,
): string {
  return join(
    projectDir(config),
    'verifications',
    reqId,
    `v${planVersion}`,
    candidateSha256.slice(0, 16),
  )
}

/** 业务终审目录：按任务包版本保存，报告绑定当前候选身份。 */
export function businessReviewDir(
  config: ForgeLoopConfig,
  reqId: string,
  planVersion: number,
): string {
  return join(projectDir(config), 'reviews', reqId, `v${planVersion}`, 'business')
}

export function candidatesDir(config: ForgeLoopConfig, reqId: string, planVersion: number): string {
  return join(projectDir(config), 'candidates', reqId, `v${planVersion}`)
}

export function sessionsDir(config: ForgeLoopConfig): string {
  return join(projectDir(config), 'sessions')
}

/** 运维事件证据目录：检查输出、诊断、动作日志与恢复复核各一份。 */
export function opsDir(config: ForgeLoopConfig, eventId: string): string {
  return join(projectDir(config), 'ops', eventId)
}
