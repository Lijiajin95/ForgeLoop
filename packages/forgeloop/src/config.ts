/**
 * 插件配置：所有两个部署可能不同的值都在这里，不硬编码。
 * 非法值在插件装载时失败（fail loudly），不静默回落。
 */

import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { RuleViolationError } from './domain/errors.js'
import {
  OPS_SEVERITIES,
  validateOpsCatalog,
  type OpsAction,
  type OpsActionParam,
  type OpsCatalog,
  type OpsCheck,
  type OpsResource,
  type OpsResourceKind,
  type OpsSeverity,
} from './domain/ops.js'

export interface AgentConfig {
  readonly provider: string
  readonly model: string
  readonly timeoutSeconds: number
}

export interface OpsConfig extends OpsCatalog {
  readonly enabled: boolean
  /** 巡检周期；到期的检查在协调器持有单消费者锁时运行。 */
  readonly intervalSeconds: number
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

export interface RawOpsConfig {
  enabled?: boolean
  intervalSeconds?: number
  resources?: RawOpsResource[]
  checks?: RawOpsCheck[]
  actions?: RawOpsAction[]
}

export interface ForgeLoopConfig {
  readonly recordsRoot: string
  readonly project: string
  readonly projectPath: string
  readonly owner: string
  readonly pollSeconds: number
  readonly autoAdvance: boolean
  readonly agent: AgentConfig
  readonly formalTestTimeoutSeconds: number
  readonly maxTaskAttempts: number
  readonly worktreePrepareCommand: readonly string[]
  readonly candidateBuildCommand: readonly string[]
  readonly candidatePackageCommand: readonly string[]
  readonly candidateArtifactPath: string
  readonly ops: OpsConfig
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
  worktreePrepareCommand?: string[]
  candidateBuildCommand?: string[]
  candidatePackageCommand?: string[]
  candidateArtifactPath?: string
  ops?: RawOpsConfig
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

function stringList(value: unknown, field: string, fallback: readonly string[]): readonly string[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new RuleViolationError(`配置 ${field} 必须是字符串数组`)
  }
  return value as string[]
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
    return item as Record<string, unknown>
  })
}

/**
 * 运维目录：资源、只读检查与登记动作。目录非法时装载失败，
 * 不在运行期猜测或放宽；未启用的目录也做同样的静态校验。
 */
function parseOpsConfig(raw: RawOpsConfig | undefined): OpsConfig {
  const source = (raw ?? {}) as RawOpsConfig
  const enabled = booleanValue(source.enabled, 'ops.enabled', false)
  const intervalSeconds = positiveNumber(source.intervalSeconds, 'ops.intervalSeconds', 300)
  if (intervalSeconds < 30) throw new RuleViolationError('配置 ops.intervalSeconds 不能小于 30 秒')

  const resources: OpsResource[] = objectList(source.resources, 'ops.resources').map((item, index) => ({
    id: requiredText(item.id, `ops.resources[${index}].id`),
    kind: (typeof item.kind === 'string' && item.kind.trim() ? item.kind.trim() : 'other') as OpsResourceKind,
    label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : requiredText(item.id, `ops.resources[${index}].id`),
  }))

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
          ? candidates[0]!.id
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
      timeoutSeconds: positiveNumber(item.timeoutSeconds, `ops.actions[${index}].timeoutSeconds`, 60),
      auto: booleanValue(item.auto, `ops.actions[${index}].auto`, false),
      verifyCheckId,
    }
  })

  const catalog: OpsCatalog = { resources, checks, actions }
  validateOpsCatalog(catalog)
  if (enabled && checks.length === 0) {
    throw new RuleViolationError('配置 ops 启用时至少要登记一个检查；否则不会产生任何运维事件')
  }
  return { enabled, intervalSeconds, ...catalog }
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

export function resolveConfig(raw: RawConfig, cwd = process.cwd()): ForgeLoopConfig {
  const project = raw.project?.trim() || 'forgeloop'
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
    throw new RuleViolationError(`配置 project 只能是安全的项目名，实际 ${JSON.stringify(raw.project)}`)
  }
  const projectPath = resolve(cwd, expandHome(raw.projectPath?.trim() || '.'))
  // Desktop 和 Web 的启动目录可能不同；项目数据始终相对已选项目定位。
  const recordsRoot = resolve(projectPath, expandHome(raw.recordsRoot?.trim() || '.forgeloop'))
  const pollSeconds = positiveNumber(raw.pollSeconds, 'pollSeconds', 5)
  if (pollSeconds < 1) throw new RuleViolationError('配置 pollSeconds 不能小于 1 秒')
  const agentProvider = raw.agent?.provider?.trim() || ''
  const agentModel = raw.agent?.model?.trim() || ''
  return {
    recordsRoot,
    project,
    projectPath,
    owner: raw.owner?.trim() || 'local-owner',
    pollSeconds,
    autoAdvance: raw.autoAdvance === true,
    agent: {
      provider: agentProvider,
      model: agentModel,
      timeoutSeconds: positiveNumber(raw.agent?.timeoutSeconds, 'agent.timeoutSeconds', 1800),
    },
    formalTestTimeoutSeconds: positiveNumber(
      raw.formalTestTimeoutSeconds,
      'formalTestTimeoutSeconds',
      1800,
    ),
    maxTaskAttempts: positiveInteger(raw.maxTaskAttempts, 'maxTaskAttempts', 3),
    worktreePrepareCommand: stringList(raw.worktreePrepareCommand, 'worktreePrepareCommand', []),
    candidateBuildCommand: stringList(raw.candidateBuildCommand, 'candidateBuildCommand', []),
    candidatePackageCommand: stringList(raw.candidatePackageCommand, 'candidatePackageCommand', []),
    candidateArtifactPath: raw.candidateArtifactPath?.trim() || '',
    ops: parseOpsConfig(raw.ops),
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

export function workspaceDir(config: ForgeLoopConfig, reqId: string, planVersion: number, taskId: string): string {
  return join(projectDir(config), 'workspaces', reqId, `v${planVersion}`, taskId)
}

export function reviewDir(config: ForgeLoopConfig, reqId: string, planVersion: number, taskId: string): string {
  return join(projectDir(config), 'reviews', reqId, `v${planVersion}`, taskId)
}

/** 实现前评审的固定目录；每个任务包版本一份。 */
export function planReviewDir(config: ForgeLoopConfig, reqId: string, planVersion: number): string {
  return join(projectDir(config), 'reviews', reqId, `v${planVersion}`, 'plan')
}

/** 独立验证目录：按候选身份隔离，保留旧候选的验证证据。 */
export function verificationDir(
  config: ForgeLoopConfig,
  reqId: string,
  planVersion: number,
  candidateSha256: string,
): string {
  return join(projectDir(config), 'verifications', reqId, `v${planVersion}`, candidateSha256.slice(0, 16))
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
