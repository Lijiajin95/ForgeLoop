/**
 * 主动监控的采集器：把主机指标、进程、网络延迟、日志尾部、外部告警、
 * 检查最后状态与活动事件收成一份有界快照。
 *
 * 所有采集失败都写进 `errors` 或来源自身的 `error`，不抛出整体失败：
 * 一次读取不到日志不应该让整轮监控停摆；模型只能看到已采集到的事实。
 * 日志与告警内容是不可信数据，只作为材料进入提示词，不是指令。
 */

import { execFile } from 'node:child_process'
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { asRecord } from '../domain/json.js'
import { errorMessage } from '../domain/errors.js'
import { isOpsActive, type OpsSeverity } from '../domain/ops.js'
import { BUILTIN_OPS_PROVIDER_ID, findOpsProvider } from '../domain/ops-provider.js'
import type { ForgeLoopConfig, OpsMonitorLog } from '../config.js'
import type { Repository } from '../records/repository.js'

const CPU_SAMPLE_MS = 100
const MAX_LOG_BYTES = 64 * 1024
const MAX_LOG_LINE = 500
const MAX_ALERTS = 20
const MAX_EVENTS = 20
const MAX_ERRORS = 20
const MAX_ERROR_LENGTH = 300
const MAX_ALERT_FILE_BYTES = 64 * 1024
const PS_TIMEOUT_MS = 5_000

export interface MonitorHostFacts {
  readonly load1: number
  readonly load5: number
  readonly load15: number
  readonly cpuCount: number
  readonly cpuPercent: number
  readonly memoryTotalBytes: number
  readonly memoryFreeBytes: number
  readonly memoryUsedPercent: number
  readonly uptimeSeconds: number
}

export interface MonitorProcessFacts {
  readonly id: string
  readonly resourceId: string
  readonly match: string
  readonly count: number
  readonly cpuPercent: number
  readonly rssBytes: number
  readonly error: string
}

export interface MonitorLatencyFacts {
  readonly id: string
  readonly resourceId: string
  readonly url: string
  readonly ok: boolean
  readonly status: number
  readonly ms: number
  readonly error: string
}

export interface MonitorLogFacts {
  readonly id: string
  readonly resourceId: string
  readonly path: string
  readonly lines: number
  readonly matches: number
  readonly samples: readonly string[]
  readonly tail: readonly string[]
  readonly error: string
}

export interface MonitorAlertFileFacts {
  readonly id: string
  readonly path: string
  readonly count: number
  readonly error: string
}

export interface MonitorAlertFacts {
  readonly source: string
  readonly severity: OpsSeverity
  readonly summary: string
  readonly at: string
  readonly resourceId: string
}

export interface MonitorCheckFacts {
  readonly checkId: string
  readonly resourceId: string
  readonly at: string
  readonly code: number | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly output: string
}

export interface MonitorEventFacts {
  readonly eventId: string
  readonly resourceId: string
  readonly checkId: string
  readonly severity: string
  readonly state: string
  readonly title: string
  readonly signature: string
  readonly openedAt: string
}

/** 产生这份快照的提供方；当前只有自研采集器。 */
export interface MonitorProviderFacts {
  readonly id: string
  readonly kind: string
  readonly version: string
}

export interface MonitorSnapshot {
  readonly at: string
  readonly project: string
  readonly providers: readonly MonitorProviderFacts[]
  readonly host: MonitorHostFacts
  readonly processes: readonly MonitorProcessFacts[]
  readonly latency: readonly MonitorLatencyFacts[]
  readonly logs: readonly MonitorLogFacts[]
  readonly alertFiles: readonly MonitorAlertFileFacts[]
  readonly alerts: readonly MonitorAlertFacts[]
  readonly checks: readonly MonitorCheckFacts[]
  readonly events: readonly MonitorEventFacts[]
  readonly errors: readonly string[]
}

export interface MonitorCollectionInput {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly now: Date
  readonly signal?: AbortSignal
}

function bounded(value: string, max = MAX_ERROR_LENGTH): string {
  const text = value.trim().replace(/\s+/g, ' ')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function projectPathOf(config: ForgeLoopConfig, path: string): string {
  return isAbsolute(path) ? path : resolve(config.projectPath, path)
}

function limitErrors(errors: string[]): string[] {
  return errors.slice(0, MAX_ERRORS).map((error) => bounded(error))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

// ---------------------------------------------------------------- 主机

function cpuTimes(): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { idle, total }
}

async function collectHostFacts(): Promise<MonitorHostFacts> {
  const first = cpuTimes()
  await sleep(CPU_SAMPLE_MS)
  const second = cpuTimes()
  const totalDelta = second.total - first.total
  const idleDelta = second.idle - first.idle
  // 采样窗口没有推进时退回开机以来的平均占用，避免输出 NaN 或 100%。
  const busy =
    totalDelta > 0
      ? 100 * (1 - idleDelta / totalDelta)
      : second.total > 0
        ? 100 * (1 - second.idle / second.total)
        : 0
  const total = totalmem()
  const free = freemem()
  const [load1 = 0, load5 = 0, load15 = 0] = loadavg()
  return {
    load1: round1(load1),
    load5: round1(load5),
    load15: round1(load15),
    cpuCount: cpus().length,
    cpuPercent: round1(Math.min(100, Math.max(0, busy))),
    memoryTotalBytes: total,
    memoryFreeBytes: free,
    memoryUsedPercent: total > 0 ? round1(100 * (1 - free / total)) : 0,
    uptimeSeconds: Math.round(uptime()),
  }
}

// ---------------------------------------------------------------- 进程

interface ProcessRow {
  readonly cpu: number
  readonly rssBytes: number
  readonly command: string
}

function parseProcessLine(line: string): ProcessRow | null {
  const matched = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
  if (!matched) return null
  const cpu = Number(matched[2])
  const rss = Number(matched[3])
  const command = matched[4] ?? ''
  if (!Number.isFinite(cpu) || !Number.isFinite(rss) || !command) return null
  return { cpu, rssBytes: rss * 1024, command }
}

function readProcessTable(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ rows: ProcessRow[]; error: string }> {
  return new Promise((resolveTable) => {
    try {
      execFile(
        'ps',
        ['-axo', 'pid=,pcpu=,rss=,comm='],
        {
          cwd,
          timeout: PS_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, LC_ALL: 'C' },
          ...(signal ? { signal } : {}),
        },
        (error, stdout) => {
          if (error) {
            resolveTable({ rows: [], error: bounded(error.message) })
            return
          }
          const rows = stdout
            .split('\n')
            .map((line) => parseProcessLine(line))
            .filter((row): row is ProcessRow => row !== null)
          resolveTable({ rows, error: '' })
        },
      )
    } catch (error) {
      // 受限环境可能直接禁止 spawn（EPERM）；监控降级为无进程表，而不是中断整次采集。
      resolveTable({ rows: [], error: bounded(errorMessage(error)) })
    }
  })
}

async function collectProcesses(
  config: ForgeLoopConfig,
  errors: string[],
  signal?: AbortSignal,
): Promise<MonitorProcessFacts[]> {
  const sources = config.ops.monitor.processes
  if (sources.length === 0) return []
  const table = await readProcessTable(config.projectPath, signal)
  if (table.error) errors.push(`进程采集失败：${table.error}`)
  return sources.map((source) => {
    if (table.error) {
      return {
        id: source.id,
        resourceId: source.resourceId,
        match: source.match,
        count: 0,
        cpuPercent: 0,
        rssBytes: 0,
        error: table.error,
      }
    }
    const needle = source.match.toLowerCase()
    const matched = table.rows.filter((row) => row.command.toLowerCase().includes(needle))
    return {
      id: source.id,
      resourceId: source.resourceId,
      match: source.match,
      count: matched.length,
      cpuPercent: round1(matched.reduce((sum, row) => sum + row.cpu, 0)),
      rssBytes: matched.reduce((sum, row) => sum + row.rssBytes, 0),
      error: '',
    }
  })
}

// ---------------------------------------------------------------- 延迟

async function cancelBody(response: Response): Promise<void> {
  if (!response.body) return
  try {
    await response.body.cancel()
  } catch {
    // 取不取消不影响本次探测结论。
  }
}

async function collectLatency(
  config: ForgeLoopConfig,
  errors: string[],
  signal?: AbortSignal,
): Promise<MonitorLatencyFacts[]> {
  const facts: MonitorLatencyFacts[] = []
  for (const source of config.ops.monitor.latency) {
    const timeout = AbortSignal.timeout(source.timeoutSeconds * 1000)
    const started = Date.now()
    try {
      const response = await fetch(source.url, {
        method: 'GET',
        redirect: 'follow',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'user-agent': 'forgeloop-ops/0.0.2' },
      })
      await cancelBody(response)
      facts.push({
        id: source.id,
        resourceId: source.resourceId,
        url: source.url,
        ok: response.ok,
        status: response.status,
        ms: Date.now() - started,
        error: '',
      })
    } catch (error) {
      const message = bounded(errorMessage(error))
      errors.push(`延迟探测 ${source.id} 失败：${message}`)
      facts.push({
        id: source.id,
        resourceId: source.resourceId,
        url: source.url,
        ok: false,
        status: 0,
        ms: Date.now() - started,
        error: message,
      })
    }
  }
  return facts
}

// ---------------------------------------------------------------- 日志

function readTail(path: string, maxBytes: number): string[] {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length <= 0) return []
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const chunk = readSync(fd, buffer, read, length - read, start + read)
      if (chunk <= 0) break
      read += chunk
    }
    const lines = buffer.subarray(0, read).toString('utf8').split('\n')
    // 从文件中间开始读时，第一行可能被截断，丢弃而不是当成完整日志行。
    if (start > 0) lines.shift()
    return lines
  } finally {
    closeSync(fd)
  }
}

function logFacts(
  config: ForgeLoopConfig,
  source: OpsMonitorLog,
  errors: string[],
): MonitorLogFacts {
  const path = projectPathOf(config, source.path)
  try {
    const pattern = new RegExp(source.errorPattern)
    const lines = readTail(path, MAX_LOG_BYTES)
    const tail = lines
      .filter((line) => line.length > 0)
      .slice(-config.ops.monitor.logLines)
      .map((line) => bounded(line, MAX_LOG_LINE))
    const matched = lines.filter((line) => pattern.test(line))
    return {
      id: source.id,
      resourceId: source.resourceId,
      path,
      lines: tail.length,
      matches: matched.length,
      samples: matched.slice(0, 3).map((line) => bounded(line, MAX_LOG_LINE)),
      tail,
      error: '',
    }
  } catch (error) {
    const message = bounded(errorMessage(error))
    errors.push(`日志 ${source.id} 不可读：${message}`)
    return {
      id: source.id,
      resourceId: source.resourceId,
      path,
      lines: 0,
      matches: 0,
      samples: [],
      tail: [],
      error: message,
    }
  }
}

// ---------------------------------------------------------------- 外部告警

function parseAlert(value: unknown, source: string): MonitorAlertFacts | null {
  const data = asRecord(value)
  if (!data) return null
  const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
  if (!summary) return null
  const severity =
    data.severity === 'critical' || data.severity === 'major' || data.severity === 'minor'
      ? data.severity
      : 'major'
  return {
    source,
    severity,
    summary: bounded(summary, MAX_ERROR_LENGTH),
    at: typeof data.at === 'string' ? data.at : '',
    resourceId: typeof data.resourceId === 'string' ? data.resourceId : '',
  }
}

function collectAlerts(
  config: ForgeLoopConfig,
  errors: string[],
): { files: MonitorAlertFileFacts[]; alerts: MonitorAlertFacts[] } {
  const files: MonitorAlertFileFacts[] = []
  const alerts: MonitorAlertFacts[] = []
  for (const source of config.ops.monitor.alertFiles) {
    const path = projectPathOf(config, source.path)
    try {
      const content = readFileSync(path)
      if (content.length > MAX_ALERT_FILE_BYTES) {
        throw new Error(`告警文件超过 ${MAX_ALERT_FILE_BYTES} 字节上限`)
      }
      const parsed: unknown = JSON.parse(content.toString('utf8'))
      if (!Array.isArray(parsed)) throw new Error('告警文件必须是 JSON 数组')
      const parsedAlerts = parsed
        .slice(0, Math.max(0, MAX_ALERTS - alerts.length))
        .map((item) => parseAlert(item, source.id))
        .filter((item): item is MonitorAlertFacts => item !== null)
      files.push({ id: source.id, path, count: parsedAlerts.length, error: '' })
      alerts.push(...parsedAlerts)
    } catch (error) {
      const message = bounded(errorMessage(error))
      errors.push(`告警文件 ${source.id} 不可读：${message}`)
      files.push({ id: source.id, path, count: 0, error: message })
    }
  }
  return { files, alerts }
}

// ---------------------------------------------------------------- 检查与事件

function collectChecks(
  config: ForgeLoopConfig,
  repo: Repository,
  errors: string[],
): MonitorCheckFacts[] {
  const facts: MonitorCheckFacts[] = []
  for (const check of config.ops.checks) {
    const raw = repo.getMeta(`ops_check_last:${check.id}`)
    if (!raw) continue
    try {
      const data: unknown = JSON.parse(raw)
      const record = asRecord(data)
      if (!record) throw new Error('最后状态不是对象')
      facts.push({
        checkId: check.id,
        resourceId: check.resourceId,
        at: typeof record.at === 'string' ? record.at : '',
        code: typeof record.code === 'number' ? record.code : null,
        timedOut: record.timedOut === true,
        aborted: record.aborted === true,
        output: typeof record.output === 'string' ? bounded(record.output, 500) : '',
      })
    } catch (error) {
      errors.push(`检查 ${check.id} 的最后状态不可读：${bounded(errorMessage(error))}`)
    }
  }
  return facts
}

function collectEvents(config: ForgeLoopConfig, repo: Repository): MonitorEventFacts[] {
  return repo
    .listOpsEvents(config.project)
    .filter((event) => isOpsActive(event.state))
    .slice(0, MAX_EVENTS)
    .map((event) => ({
      eventId: event.eventId,
      resourceId: event.resourceId,
      checkId: event.checkId,
      severity: event.severity,
      state: event.state,
      title: event.title,
      signature: event.signature,
      openedAt: event.openedAt,
    }))
}

// ---------------------------------------------------------------- 收集接口

/** 提供方一次采集的产物：只读事实，失败写进 `errors`，不抛整体失败。 */
export interface MonitorProviderProduct {
  readonly host: MonitorHostFacts
  readonly processes: readonly MonitorProcessFacts[]
  readonly latency: readonly MonitorLatencyFacts[]
  readonly logs: readonly MonitorLogFacts[]
  readonly alertFiles: readonly MonitorAlertFileFacts[]
  readonly alerts: readonly MonitorAlertFacts[]
  readonly errors: readonly string[]
}

/**
 * 监控提供方接口。外部工具（Glances、Prometheus 等）接入时实现同一份 `collect`：
 * 只读采集、有界返回、失败写 `errors`，不能执行动作或改变事件状态。
 */
export interface OpsMonitorProvider {
  readonly id: string
  collect(input: MonitorContext): Promise<MonitorProviderProduct>
}

export type MonitorContext = MonitorCollectionInput

const EMPTY_HOST: MonitorHostFacts = {
  load1: 0,
  load5: 0,
  load15: 0,
  cpuCount: 0,
  cpuPercent: 0,
  memoryTotalBytes: 0,
  memoryFreeBytes: 0,
  memoryUsedPercent: 0,
  uptimeSeconds: 0,
}

/** 自研采集器：主机、进程、延迟、日志、告警文件，全部来自本机只读接口。 */
const BUILTIN_PROVIDER: OpsMonitorProvider = {
  id: BUILTIN_OPS_PROVIDER_ID,
  async collect(input) {
    const { config } = input
    const errors: string[] = []
    const [host, processes, latency] = await Promise.all([
      collectHostFacts(),
      collectProcesses(config, errors, input.signal),
      collectLatency(config, errors, input.signal),
    ])
    const logs = config.ops.monitor.logs.map((source) => logFacts(config, source, errors))
    const { files, alerts } = collectAlerts(config, errors)
    return { host, processes, latency, logs, alertFiles: files, alerts, errors }
  },
}

/** 已实现的提供方；新增外部工具时在这里登记实现，并在 domain 登记表加描述符。 */
const PROVIDER_IMPLEMENTATIONS: readonly OpsMonitorProvider[] = [BUILTIN_PROVIDER]

function resolveProvider(id: string): OpsMonitorProvider | undefined {
  return PROVIDER_IMPLEMENTATIONS.find((provider) => provider.id === id)
}

function collectProviders(config: ForgeLoopConfig, errors: string[]): MonitorProviderFacts[] {
  const facts: MonitorProviderFacts[] = []
  for (const id of config.ops.monitor.providers) {
    const provider = findOpsProvider(id)
    if (!provider || !resolveProvider(id)) {
      errors.push(`监控提供方 ${id} 未登记`)
      continue
    }
    facts.push({ id: provider.id, kind: provider.kind, version: provider.version })
  }
  return facts
}

/**
 * 采集一轮快照。提供方按 `ops.monitor.providers` 选择；当前只登记自研采集器，
 * 因此默认由 `builtin` 产出全部事实。检查最后状态与活动事件来自记录层，不归提供方。
 * 单个来源失败只记录错误，不影响其他来源与整轮评审。
 */
export async function collectMonitorSnapshot(
  input: MonitorCollectionInput,
): Promise<MonitorSnapshot> {
  const { config, repo, now } = input
  const errors: string[] = []
  const providers = collectProviders(config, errors)
  if (input.signal?.aborted) {
    return {
      at: now.toISOString(),
      project: config.project,
      providers,
      host: EMPTY_HOST,
      processes: [],
      latency: [],
      logs: [],
      alertFiles: [],
      alerts: [],
      checks: [],
      events: [],
      errors: ['采集已取消'],
    }
  }
  const provider = providers.length > 0 ? resolveProvider(providers[0]?.id ?? '') : undefined
  if (!provider) {
    errors.push('没有可用的监控提供方')
    return {
      at: now.toISOString(),
      project: config.project,
      providers,
      host: EMPTY_HOST,
      processes: [],
      latency: [],
      logs: [],
      alertFiles: [],
      alerts: [],
      checks: [],
      events: [],
      errors: limitErrors(errors),
    }
  }
  const product = await provider.collect(input)
  const allErrors = [...errors, ...product.errors]
  return {
    at: now.toISOString(),
    project: config.project,
    providers,
    host: product.host,
    processes: product.processes,
    latency: product.latency,
    logs: product.logs,
    alertFiles: product.alertFiles,
    alerts: product.alerts,
    checks: collectChecks(config, repo, allErrors),
    events: collectEvents(config, repo),
    errors: limitErrors(allErrors),
  }
}
