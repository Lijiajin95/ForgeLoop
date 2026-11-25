import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import pino, { type DestinationStream } from 'pino'
import type { ForgeLoopConfig, LogLevel, LoggingConfig } from '../config.js'
import { projectDir } from '../config.js'

export interface LogErrorRecord {
  readonly name: string
  readonly message: string
  readonly stack: string
}

export interface LogContext {
  readonly event?: string
  readonly reqId?: string
  readonly taskId?: string
  readonly actionId?: string
  readonly error?: unknown
  readonly [key: string]: unknown
}

export interface PluginLogger {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
}

export interface LoggerOptions {
  readonly now?: () => Date
  readonly pathOf?: (config: ForgeLoopConfig) => string
  readonly destination?: DestinationStream
  readonly dedupeWindowMs?: number
  readonly dedupeMaxEntries?: number
  readonly retentionDays?: number
  readonly echo?: boolean
}

type LogLevelName = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const LEVEL_RANK: Record<LogLevelName, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }
const LEVEL_THRESHOLD: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const CONTEXT_KEYS = new Set<string>(['event', 'reqId', 'taskId', 'actionId'])
const DEFAULT_LOGGING: LoggingConfig = {
  level: 'info',
  maxBytes: 10 * 1024 * 1024,
  retentionDays: 14,
}
const DEFAULT_DEDUPE_WINDOW_MS = 60_000
const DEFAULT_DEDUPE_MAX_ENTRIES = 500
const LOG_FILE = /^plugin\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log$/
const LEGACY_LOG_FILE = /^plugin-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.log$/
const GZIP_FILE = /^plugin\.(\d{4}-\d{2}-\d{2})\.\d+\.log\.gz$/
const LEGACY_GZIP_FILE = /^plugin-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.log\.gz$/
const KEEP_RAW = /key|token|secret|password|authorization|credential/i
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]'],
  [
    /((?:api[_-]?key|access[_-]?token|secret|password|token)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
    '$1[REDACTED]',
  ],
]

export function redactText(text: string): string {
  let output = text
  for (const [pattern, replacement] of REDACTIONS) output = output.replace(pattern, replacement)
  return output
}

export function clipText(value: unknown, limit = 8_000): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text
}

/** 递归脱敏：用于转录与证据里的结构化数据，只替换密钥类字段与文本片段。 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return value
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      output[key] = KEEP_RAW.test(key) ? '[REDACTED]' : redactValue(item, depth + 1)
    }
    return output
  }
  return value
}

export function pluginLogDirectory(config: ForgeLoopConfig): string {
  return join(projectDir(config), 'logs')
}

export function pluginLogBase(config: ForgeLoopConfig): string {
  return join(pluginLogDirectory(config), 'plugin.log')
}

export function pluginLogPath(config: ForgeLoopConfig): string {
  return newestLogFile(pluginLogBase(config))
}

export function hostLogBase(config: ForgeLoopConfig): string {
  return join(config.recordsRoot, 'logs', 'plugin.log')
}

export function hostLogPath(config: ForgeLoopConfig): string {
  return newestLogFile(hostLogBase(config))
}

function newestLogFile(base: string): string {
  const directory = dirname(base)
  const stem = basename(base, '.log')
  try {
    const candidates = readdirSync(directory)
      .filter((name) => LOG_FILE.test(name) && name.startsWith(`${stem}.`))
      .map((name) => ({ name, at: statSync(join(directory, name)).mtimeMs }))
      .sort((left, right) => right.at - left.at)
    if (candidates[0]) return join(directory, candidates[0].name)
  } catch {
    return base
  }
  return base
}

const loggerCache = new Map<string, PluginLogger>()

/** 同一记录根的运行时共用一个 logger，避免每处调用都新建 pino 实例。 */
export function loggerFor(config: ForgeLoopConfig): PluginLogger {
  let key: string
  try {
    key = pluginLogBase(config)
  } catch {
    return createPluginLogger(config)
  }
  const existing = loggerCache.get(key)
  if (existing) return existing
  const created = createPluginLogger(config)
  loggerCache.set(key, created)
  return created
}

function loggingOf(config: Partial<ForgeLoopConfig>): LoggingConfig {
  return config.logging ?? DEFAULT_LOGGING
}

function errorRecord(value: unknown): LogErrorRecord {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: redactText(value.stack ?? ''),
    }
  }
  return {
    name: 'Error',
    message: redactText(typeof value === 'string' ? value : String(value)),
    stack: '',
  }
}

interface DedupeEntry {
  count: number
  firstAt: number
  lastWriteAt: number
}

interface DedupeVerdict {
  readonly emit: boolean
  readonly repeated?: { count: number; firstAt: string; lastAt: string }
}

/** 相同错误在窗口内的重复写入合并计数；窗口外的首次写入带 repeated 字段说明被折叠的次数。 */
class DedupeGate {
  private readonly entries = new Map<string, DedupeEntry>()

  constructor(
    private readonly windowMs: number,
    private readonly maxEntries: number,
  ) {}

  admit(key: string, nowMs: number): DedupeVerdict {
    const existing = this.entries.get(key)
    if (!existing) {
      this.entries.set(key, { count: 1, firstAt: nowMs, lastWriteAt: nowMs })
      this.trim()
      return { emit: true }
    }
    this.entries.delete(key)
    this.entries.set(key, existing)
    if (nowMs - existing.lastWriteAt < this.windowMs) {
      existing.count += 1
      return { emit: false }
    }
    const repeated = {
      count: existing.count - 1,
      firstAt: new Date(existing.firstAt).toISOString(),
      lastAt: new Date(existing.lastWriteAt).toISOString(),
    }
    existing.count = 1
    existing.firstAt = nowMs
    existing.lastWriteAt = nowMs
    return repeated.count > 0 ? { emit: true, repeated } : { emit: true }
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      this.entries.delete(oldest)
    }
  }
}

function rotationSize(maxBytes: number): string | undefined {
  if (maxBytes <= 0) return undefined
  return `${Math.max(1, Math.round(maxBytes / (1024 * 1024)))}m`
}

function productionDestination(base: string, logging: LoggingConfig): DestinationStream {
  const size = rotationSize(logging.maxBytes)
  return pino.transport({
    target: 'pino-roll',
    options: {
      file: base,
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      mkdir: true,
      ...(size ? { size } : {}),
    },
  })
}

function compressOne(sourcePath: string, guardGrowth = false): boolean {
  const target = `${sourcePath}.gz`
  try {
    if (existsSync(target)) {
      if (guardGrowth) return false
      unlinkSync(sourcePath)
      return true
    }
    const before = guardGrowth ? statSync(sourcePath).size : 0
    writeFileSync(target, gzipSync(readFileSync(sourcePath)))
    if (guardGrowth && statSync(sourcePath).size !== before) return true
    unlinkSync(sourcePath)
    return true
  } catch {
    return false
  }
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`)
  const end = Date.parse(`${to}T00:00:00.000Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.round((end - start) / 86_400_000)
}

function datedPlainLog(name: string): string | undefined {
  return LOG_FILE.exec(name)?.[1] ?? LEGACY_LOG_FILE.exec(name)?.[1]
}

function datedGzipLog(name: string): string | undefined {
  return GZIP_FILE.exec(name)?.[1] ?? LEGACY_GZIP_FILE.exec(name)?.[1]
}

function staleActiveLog(directory: string, today: string, names: readonly string[]): boolean {
  const active = join(directory, 'plugin.log')
  if (!existsSync(active)) return false
  if (names.some((name) => LOG_FILE.test(name))) return true
  return isoDate(statSync(active).mtime) < today
}

function compressPastDays(directory: string, today: string): number {
  const names = readdirSync(directory)
  let compressed = 0
  for (const name of names) {
    if (name === 'plugin.log') continue
    const date = datedPlainLog(name)
    if (!date || date >= today) continue
    if (compressOne(join(directory, name))) compressed += 1
  }
  if (staleActiveLog(directory, today, names)) {
    if (compressOne(join(directory, 'plugin.log'), true)) compressed += 1
  }
  return compressed
}

function deleteExpired(directory: string, today: string, retentionDays: number): number {
  let deleted = 0
  for (const name of readdirSync(directory)) {
    const date = datedGzipLog(name)
    if (!date || daysBetween(date, today) <= retentionDays) continue
    try {
      unlinkSync(join(directory, name))
      deleted += 1
    } catch {
      // 删除失败留给下一次维护。
    }
  }
  return deleted
}

/** 把今天之前的按天日志压缩为 .log.gz，并按保留天数删除过期压缩文件。 */
export function maintainLogFiles(
  directory: string,
  options: { now?: Date; retentionDays?: number } = {},
): { compressed: number; deleted: number } {
  const today = isoDate(options.now ?? new Date())
  const retentionDays = options.retentionDays ?? DEFAULT_LOGGING.retentionDays
  try {
    return {
      compressed: compressPastDays(directory, today),
      deleted: deleteExpired(directory, today, retentionDays),
    }
  } catch {
    return { compressed: 0, deleted: 0 }
  }
}

function openDestination(
  path: string,
  logging: LoggingConfig,
  options: LoggerOptions,
  now: () => Date,
): DestinationStream | undefined {
  try {
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true })
    const retentionDays = options.retentionDays ?? logging.retentionDays
    maintainLogFiles(directory, { now: now(), retentionDays })
    const destination = productionDestination(path, logging)
    const timer = setInterval(
      () => maintainLogFiles(directory, { now: new Date(), retentionDays }),
      MAINTENANCE_INTERVAL_MS,
    )
    timer.unref()
    return destination
  } catch {
    return undefined
  }
}

function fieldsOf(context: LogContext | undefined): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const key of CONTEXT_KEYS) {
    const value = context?.[key]
    if (typeof value === 'string' && value !== '') record[key] = redactText(value)
  }
  for (const [key, value] of Object.entries(context ?? {})) {
    if (CONTEXT_KEYS.has(key) || key === 'error') continue
    record[key] = typeof value === 'string' ? redactText(value) : value
  }
  if (context && context.error !== undefined) record.error = errorRecord(context.error)
  return record
}

function dedupeKeyOf(level: LogLevelName, text: string, record: Record<string, unknown>): string {
  const event = typeof record.event === 'string' ? record.event : ''
  const reqId = typeof record.reqId === 'string' ? record.reqId : ''
  return `${level}|${event}|${text}|${reqId}`
}

function applyDedupe(
  dedupe: DedupeGate,
  entry: { level: LogLevelName; text: string; record: Record<string, unknown>; nowMs: number },
): boolean {
  const { level, text, record, nowMs } = entry
  if (level !== 'WARN' && level !== 'ERROR') return true
  const verdict = dedupe.admit(dedupeKeyOf(level, text, record), nowMs)
  if (!verdict.emit) return false
  if (verdict.repeated) {
    record.repeated = verdict.repeated.count
    record.firstAt = verdict.repeated.firstAt
    record.lastAt = verdict.repeated.lastAt
  }
  return true
}

export function createPluginLogger(
  config: ForgeLoopConfig,
  nowOrOptions: (() => Date) | LoggerOptions = {},
): PluginLogger {
  const options: LoggerOptions =
    typeof nowOrOptions === 'function' ? { now: nowOrOptions } : nowOrOptions
  const now = options.now ?? (() => new Date())
  const logging = loggingOf(config)
  const minRank = LEVEL_THRESHOLD[logging.level]
  const dedupe = new DedupeGate(
    options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS,
    options.dedupeMaxEntries ?? DEFAULT_DEDUPE_MAX_ENTRIES,
  )
  let path: string | undefined
  try {
    path = (options.pathOf ?? pluginLogBase)(config)
  } catch {
    path = undefined
  }
  const destination =
    options.destination ?? (path ? openDestination(path, logging, options, now) : undefined)
  const logger = pino(
    {
      level: logging.level,
      base: null,
      messageKey: 'message',
      timestamp: () => `,"ts":"${now().toISOString()}"`,
      formatters: { level: (label: string) => ({ level: label.toUpperCase() }) },
      redact: {
        paths: ['apiKey', 'api_key', 'token', 'secret', 'password', 'authorization'],
        censor: '[REDACTED]',
      },
    },
    destination ?? { write: () => {} },
  )

  const echo = options.echo ?? options.destination === undefined
  const emit = (level: LogLevelName, message: string, context?: LogContext): void => {
    if (LEVEL_RANK[level] < minRank) return
    const text = redactText(message)
    const record = fieldsOf(context)
    if (!applyDedupe(dedupe, { level, text, record, nowMs: now().getTime() })) return
    const method =
      level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : level === 'DEBUG' ? 'debug' : 'info'
    logger[method](record, text)
    if (!echo) return
    const line = `${level} ${text}`
    if (level === 'ERROR') console.error(line)
    else if (level === 'WARN') console.warn(line)
    else console.log(line)
  }

  return {
    debug: (message, context) => {
      emit('DEBUG', message, context)
    },
    info: (message, context) => {
      emit('INFO', message, context)
    },
    warn: (message, context) => {
      emit('WARN', message, context)
    },
    error: (message, context) => {
      emit('ERROR', message, context)
    },
  }
}

export function createHostLogger(
  config: ForgeLoopConfig,
  nowOrOptions: (() => Date) | LoggerOptions = {},
): PluginLogger {
  const options: LoggerOptions =
    typeof nowOrOptions === 'function' ? { now: nowOrOptions } : nowOrOptions
  return createPluginLogger(config, { ...options, pathOf: hostLogBase })
}
