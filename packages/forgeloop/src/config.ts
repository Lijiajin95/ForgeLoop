/**
 * 插件配置：所有两个部署可能不同的值都在这里，不硬编码。
 * 非法值在插件装载时失败（fail loudly），不静默回落。
 */

import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { RuleViolationError } from './domain/errors.js'

export interface AgentConfig {
  readonly provider: string
  readonly model: string
  readonly timeoutSeconds: number
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
  }
}

/** 记录根下的项目目录：与旧版 `.forgeloop/projects/<name>` 布局一致。 */
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

export function candidatesDir(config: ForgeLoopConfig, reqId: string, planVersion: number): string {
  return join(projectDir(config), 'candidates', reqId, `v${planVersion}`)
}

export function sessionsDir(config: ForgeLoopConfig): string {
  return join(projectDir(config), 'sessions')
}
