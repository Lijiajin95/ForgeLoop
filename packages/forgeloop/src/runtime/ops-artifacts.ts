/**
 * 研发制品只读视图：给运维 Agent 两个能力的实现层。
 *
 * - 运行状态：profile 安装根、安装版本、runtime-identity（pid/启动时间）、进程是否存活、
 *   身份摘要是否仍与安装文件一致，以及各登记日志的大小、修改时间与错误行数。
 * - 日志尾部：只读登记路径的固定字节尾部，可按字面过滤并限定行数。
 *
 * 只接受配置 `ops.artifacts` 里登记的 id；不接受任意路径。所有输出有界，
 * 读不到只返回事实与错误，不抛整体失败；内容是不可信数据，只作材料。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { ForgeLoopConfig, OpsArtifact, OpsArtifactLog } from '../config.js'
import { sha256OfBytes } from '../domain/delivery.js'
import { errorMessage } from '../domain/errors.js'
import { parseJsonObject } from '../domain/json.js'
import { processAlive, readInstalledVersion } from './deployment-inspect.js'
import { pluginLogPath } from './log.js'
import { readLogTail } from './log-tail.js'

/** 运维 Agent 唯一的工具面：只能读制品状态与登记日志。 */
export const OPS_ARTIFACT_TOOL_NAMES = ['forgeloop_ops_artifact', 'forgeloop_ops_logs'] as const

/** 程序内建的插件日志入口：无需 ops.artifacts 配置即可读到自身运行日志。 */
export const PLUGIN_LOG_ARTIFACT_ID = 'forgeloop-plugin'
export const PLUGIN_LOG_ID = 'plugin'

/** 部署进 profile 的包名；当前只有 ForgeLoop 自身作为研发制品。 */
const ARTIFACT_PACKAGE = 'forgeloop-dsh'
const MAX_LOG_BYTES = 64 * 1024
const MAX_LINE_CHARS = 500
const MAX_LOG_TEXT = 60_000
const DEFAULT_LINES = 80
const MAX_LINES = 500
const MAX_CONTAINS = 120

export interface ArtifactLogQuery {
  readonly artifactId: string
  readonly logId: string
  readonly lines?: number
  readonly contains?: string
}

export interface ArtifactLogLineView {
  readonly artifactId: string
  readonly logId: string
  readonly path: string
  readonly sizeBytes: number
  readonly modifiedAt: string
  readonly errorMatches: number | null
  readonly totalLines: number
  readonly matchedLines: number
  readonly lines: readonly string[]
}

export interface ArtifactLogStat {
  readonly id: string
  readonly path: string
  readonly exists: boolean
  readonly sizeBytes: number
  readonly modifiedAt: string
  readonly errorMatches: number | null
  readonly error: string
}

export interface ArtifactRuntime {
  readonly profileDir: string
  readonly installedRoot: string
  readonly packagePresent: boolean
  readonly installedVersion: string
  readonly identityPresent: boolean
  readonly identityKind: string
  readonly identityVersion: string
  readonly pid: number
  readonly startedAt: string
  readonly alive: boolean
  readonly matchesInstalled: boolean
  readonly detail: string
}

export interface ArtifactStateView {
  readonly artifactId: string
  readonly label: string
  readonly profile: string
  readonly runtime: ArtifactRuntime | null
  readonly logs: readonly ArtifactLogStat[]
}

type Ok<T> = { readonly ok: true; readonly data: T }
type Err = { readonly ok: false; readonly reason: string }

function builtinArtifact(config: ForgeLoopConfig): OpsArtifact {
  return {
    id: PLUGIN_LOG_ARTIFACT_ID,
    label: 'ForgeLoop 插件运行日志',
    profile: '',
    logs: [{ id: PLUGIN_LOG_ID, path: pluginLogPath(config), errorPattern: 'ERROR' }],
  }
}

function findArtifact(config: ForgeLoopConfig, id: string): OpsArtifact | undefined {
  // 显式配置同 id 时以配置为准，便于把日志换到别的路径。
  return (
    config.ops.artifacts.find((artifact) => artifact.id === id) ??
    (id === PLUGIN_LOG_ARTIFACT_ID ? builtinArtifact(config) : undefined)
  )
}

function findLog(artifact: OpsArtifact, id: string): OpsArtifactLog | undefined {
  return artifact.logs.find((log) => log.id === id)
}

function logPath(config: ForgeLoopConfig, log: OpsArtifactLog): string {
  return isAbsolute(log.path) ? log.path : resolve(config.projectPath, log.path)
}

function bounded(value: string, max = MAX_LINE_CHARS): string {
  const text = value.replace(/\s+$/, '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function modifiedAtOf(path: string): string {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return ''
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 按错误正则统计尾部命中行；未配置正则时返回 null，避免把“没统计”显示成 0。 */
function errorMatchesOf(lines: readonly string[], pattern: string): number | null {
  if (!pattern) return null
  try {
    const regex = new RegExp(pattern)
    return lines.filter((line) => regex.test(line)).length
  } catch {
    return null
  }
}

function readLines(config: ForgeLoopConfig, log: OpsArtifactLog): string[] {
  return readLogTail(logPath(config, log), MAX_LOG_BYTES).filter((line) => line.length > 0)
}

/** 从尾部向前取行：先保证行数，再保证总字符数，避免一次回灌整份日志。 */
function tailWithinBudget(lines: readonly string[], limit: number): string[] {
  const picked: string[] = []
  let budget = MAX_LOG_TEXT
  for (let index = lines.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const line = bounded(lines[index] ?? '')
    if (line.length > budget) break
    budget -= line.length + 1
    picked.push(line)
  }
  return picked.reverse()
}

export function readArtifactLog(
  config: ForgeLoopConfig,
  query: ArtifactLogQuery,
): Ok<ArtifactLogLineView> | Err {
  const artifact = findArtifact(config, query.artifactId)
  if (!artifact) return { ok: false, reason: `未登记研发制品：${query.artifactId}` }
  const log = findLog(artifact, query.logId)
  if (!log) return { ok: false, reason: `制品 ${artifact.id} 没有登记日志：${query.logId}` }
  const lines = query.lines ?? DEFAULT_LINES
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LINES) {
    return { ok: false, reason: `lines 必须是 1–${MAX_LINES} 的整数` }
  }
  const contains = (query.contains ?? '').trim()
  if (contains.length > MAX_CONTAINS) {
    return { ok: false, reason: `contains 不能超过 ${MAX_CONTAINS} 字符` }
  }
  const path = logPath(config, log)
  let tail: string[]
  try {
    tail = readLines(config, log)
  } catch (error) {
    return {
      ok: false,
      reason: `日志 ${log.id} 不可读：${bounded(errorMessage(error), 300)}`,
    }
  }
  const needle = contains.toLowerCase()
  const matched = needle ? tail.filter((line) => line.toLowerCase().includes(needle)) : tail
  return {
    ok: true,
    data: {
      artifactId: artifact.id,
      logId: log.id,
      path,
      sizeBytes: sizeOf(path),
      modifiedAt: modifiedAtOf(path),
      errorMatches: errorMatchesOf(tail, log.errorPattern),
      totalLines: tail.length,
      matchedLines: matched.length,
      lines: tailWithinBudget(matched, lines),
    },
  }
}

function identityOf(
  installedRoot: string,
  installedVersion: string,
): Pick<
  ArtifactRuntime,
  | 'identityPresent'
  | 'identityKind'
  | 'identityVersion'
  | 'pid'
  | 'startedAt'
  | 'alive'
  | 'matchesInstalled'
  | 'detail'
> {
  const empty = {
    identityPresent: false,
    identityKind: '',
    identityVersion: '',
    pid: 0,
    startedAt: '',
    alive: false,
    matchesInstalled: false,
    detail: '没有运行身份文件',
  }
  const path = join(installedRoot, 'runtime-identity.json')
  if (!existsSync(path)) return empty
  try {
    const identity = parseJsonObject(readFileSync(path, 'utf8'))
    const pid = typeof identity.pid === 'number' ? identity.pid : 0
    const kind = typeof identity.kind === 'string' ? identity.kind : ''
    const version = typeof identity.version === 'string' ? identity.version : ''
    const startedAt = typeof identity.startedAt === 'string' ? identity.startedAt : ''
    const indexSha256 = typeof identity.indexSha256 === 'string' ? identity.indexSha256 : ''
    const serviceSha256 = typeof identity.serviceSha256 === 'string' ? identity.serviceSha256 : ''
    let matchesInstalled = false
    let detail = `运行身份 pid=${pid || '未知'}`
    try {
      const indexHash = sha256OfBytes(readFileSync(join(installedRoot, 'lib/index.js')))
      const serviceHash = sha256OfBytes(readFileSync(join(installedRoot, 'lib/runtime/service.js')))
      matchesInstalled =
        kind === 'forgeloop-runtime-identity' &&
        version === installedVersion &&
        indexSha256 === indexHash &&
        serviceSha256 === serviceHash
      detail += matchesInstalled ? '，入口与服务摘要与安装文件一致' : '，身份与安装文件不一致'
    } catch {
      detail += '，无法读取安装文件摘要'
    }
    return {
      identityPresent: true,
      identityKind: kind,
      identityVersion: version,
      pid,
      startedAt,
      alive: processAlive(pid),
      matchesInstalled,
      detail,
    }
  } catch (error) {
    return { ...empty, detail: `运行身份文件无法解析：${bounded(errorMessage(error), 200)}` }
  }
}

function logStatOf(config: ForgeLoopConfig, log: OpsArtifactLog): ArtifactLogStat {
  const path = logPath(config, log)
  const base = { id: log.id, path, errorMatches: null }
  if (!existsSync(path)) {
    return { ...base, exists: false, sizeBytes: 0, modifiedAt: '', error: '文件不存在' }
  }
  try {
    const lines = readLines(config, log)
    return {
      ...base,
      exists: true,
      sizeBytes: sizeOf(path),
      modifiedAt: modifiedAtOf(path),
      errorMatches: errorMatchesOf(lines, log.errorPattern),
      error: '',
    }
  } catch (error) {
    return {
      ...base,
      exists: true,
      sizeBytes: sizeOf(path),
      modifiedAt: modifiedAtOf(path),
      error: bounded(errorMessage(error), 300),
    }
  }
}

export function readArtifactState(
  config: ForgeLoopConfig,
  artifactId: string,
): Ok<ArtifactStateView> | Err {
  const artifact = findArtifact(config, artifactId)
  if (!artifact) return { ok: false, reason: `未登记研发制品：${artifactId}` }
  const logs = artifact.logs.map((log) => logStatOf(config, log))
  if (!artifact.profile) {
    return {
      ok: true,
      data: { artifactId: artifact.id, label: artifact.label, profile: '', runtime: null, logs },
    }
  }
  const profileDir = join(config.dshProfilesRoot, artifact.profile)
  const installedRoot = join(profileDir, 'node_modules', ARTIFACT_PACKAGE)
  const packagePresent = existsSync(installedRoot)
  const installedVersion = packagePresent ? readInstalledVersion(installedRoot) : ''
  const runtime = packagePresent
    ? {
        profileDir,
        installedRoot,
        packagePresent,
        installedVersion,
        ...identityOf(installedRoot, installedVersion),
      }
    : {
        profileDir,
        installedRoot,
        packagePresent,
        installedVersion,
        identityPresent: false,
        identityKind: '',
        identityVersion: '',
        pid: 0,
        startedAt: '',
        alive: false,
        matchesInstalled: false,
        detail: 'profile 下没有安装产物',
      }
  return {
    ok: true,
    data: {
      artifactId: artifact.id,
      label: artifact.label,
      profile: artifact.profile,
      runtime,
      logs,
    },
  }
}
