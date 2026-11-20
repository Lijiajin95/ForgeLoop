import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { bestEffort } from './best-effort.js'
import { basename, dirname, join } from 'node:path'
import type { ForgeLoopConfig, LogFormat, LogLevel, LoggingConfig } from '../config.js'
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
}

export interface PluginLogger {
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
}

interface LogRecord {
  ts: string
  level: string
  message: string
  event?: string
  reqId?: string
  taskId?: string
  actionId?: string
  error?: LogErrorRecord
}

type LogLevelName = 'INFO' | 'WARN' | 'ERROR'

const LEVEL_RANK: Record<LogLevelName, number> = { INFO: 1, WARN: 2, ERROR: 3 }
const LEVEL_THRESHOLD: Record<LogLevel, number> = { info: 1, warn: 2, error: 3 }
const CONTEXT_KEYS = ['event', 'reqId', 'taskId', 'actionId'] as const
const DEFAULT_LOGGING: LoggingConfig = { level: 'info', format: 'json', maxBytes: 10 * 1024 * 1024 }

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]'],
  [
    /((?:api[_-]?key|access[_-]?token|secret|password)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
    '$1[REDACTED]',
  ],
]

function redact(text: string): string {
  let output = text
  for (const [pattern, replacement] of REDACTIONS) output = output.replace(pattern, replacement)
  return output
}

export function pluginLogPath(config: ForgeLoopConfig): string {
  return join(projectDir(config), 'logs', 'plugin.log')
}

export function hostLogPath(config: ForgeLoopConfig): string {
  return join(config.recordsRoot, 'logs', 'plugin.log')
}

function loggingOf(config: Partial<ForgeLoopConfig>): LoggingConfig {
  return config.logging ?? DEFAULT_LOGGING
}

function errorRecord(value: unknown): LogErrorRecord {
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message), stack: redact(value.stack ?? '') }
  }
  return {
    name: 'Error',
    message: redact(typeof value === 'string' ? value : String(value)),
    stack: '',
  }
}

function buildRecord(
  level: LogLevelName,
  message: string,
  context: LogContext | undefined,
  ts: string,
): LogRecord {
  const record: LogRecord = { ts, level, message }
  for (const key of CONTEXT_KEYS) {
    const value = context?.[key]
    if (typeof value === 'string' && value !== '') record[key] = redact(value)
  }
  if (context && context.error !== undefined) record.error = errorRecord(context.error)
  return record
}

function formatRecord(record: LogRecord, format: LogFormat): string {
  if (format === 'text') return `${record.ts} ${record.level} ${record.message}\n`
  return `${JSON.stringify(record)}\n`
}

function rotatedPath(path: string, stamp: string): string {
  const directory = dirname(path)
  const name = basename(path, '.log')
  const date = stamp.slice(0, 10)
  let candidate = join(directory, `${name}-${date}.log`)
  for (let index = 1; existsSync(candidate); index += 1) {
    candidate = join(directory, `${name}-${date}-${index}.log`)
  }
  return candidate
}

function rotateIfNeeded(
  path: string,
  maxBytes: number,
  incomingBytes: number,
  stamp: string,
): void {
  if (maxBytes <= 0 || !existsSync(path)) return
  if (statSync(path).size + incomingBytes <= maxBytes) return
  renameSync(path, rotatedPath(path, stamp))
}

export function createPluginLogger(
  config: ForgeLoopConfig,
  now: () => Date = () => new Date(),
  pathOf: (config: ForgeLoopConfig) => string = pluginLogPath,
): PluginLogger {
  let path: string | undefined
  try {
    path = pathOf(config)
  } catch {
    path = undefined
  }
  const logging = loggingOf(config)
  const minRank = LEVEL_THRESHOLD[logging.level]
  const format: LogFormat = logging.format === 'text' ? 'text' : 'json'
  const maxBytes = logging.maxBytes
  const emit = (level: LogLevelName, message: string, context?: LogContext): void => {
    if (LEVEL_RANK[level] < minRank) return
    const text = redact(message)
    const stamp = now().toISOString()
    const line = formatRecord(buildRecord(level, text, context, stamp), format)
    if (path) {
      bestEffort(() => {
        mkdirSync(dirname(path), { recursive: true })
        bestEffort(() => {
          rotateIfNeeded(path, maxBytes, Buffer.byteLength(line, 'utf8'), stamp)
        })
        appendFileSync(path, line, 'utf8')
      })
    }
    const consoleLine = `${level} ${text}`
    if (level === 'ERROR') console.error(consoleLine)
    else if (level === 'WARN') console.warn(consoleLine)
    else console.log(consoleLine)
  }
  return {
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
  now: () => Date = () => new Date(),
): PluginLogger {
  return createPluginLogger(config, now, hostLogPath)
}
