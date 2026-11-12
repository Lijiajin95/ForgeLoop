/**
 * 插件运行记录：同时写宿主 console 与项目日志文件。
 *
 * 默认位置：`<recordsRoot>/projects/<project>/logs/plugin.log`。
 * 默认 JSON Lines（`ts`/`level`/`message` 与可选关联字段、错误栈），可配置纯文本；
 * 按 `logging.maxBytes` 轮转为带日期后缀的文件（如 `plugin-2026-11-12.log`），
 * 同日多次轮转追加序号，历史文件不删除、不覆盖。
 * 日志写盘失败不影响业务；调用方仍能从宿主 console 看到原文。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ForgeLoopConfig, LogFormat, LogLevel, LoggingConfig } from '../config.js'
import { projectDir } from '../config.js'

export interface LogErrorRecord {
  readonly name: string
  readonly message: string
  readonly stack: string
}

/** 结构化关联字段：事件名与需求/任务/动作身份；error 记录完整栈。 */
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

/** 常见凭据形态：只替换值，保留键名与协议头，便于定位又不把秘密写进日志。 */
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

/** 项目日志文件路径（供测试与运维定位，不负责创建）。 */
export function pluginLogPath(config: ForgeLoopConfig): string {
  return join(projectDir(config), 'logs', 'plugin.log')
}

/** 宿主或测试可能只构造部分配置；缺 logging 时退回默认，而不是让装载失败。 */
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

/**
 * 轮转文件名：日期后缀（UTC，与日志 `ts` 一致）。同日多次轮转追加序号，
 * 先探测再改名，绝不覆盖已有文件。历史文件永久保留。
 */
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

/**
 * 文件达到上限后改名为带日期的文件，再写新行；失败由调用方吞掉并继续追加，
 * 轮转不是业务前置条件。这里不删除任何历史文件。
 */
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
): PluginLogger {
  let path: string | undefined
  try {
    path = pluginLogPath(config)
  } catch {
    // 宿主或测试可能只提供部分配置；此时退回纯 console。
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
      try {
        mkdirSync(dirname(path), { recursive: true })
        try {
          rotateIfNeeded(path, maxBytes, Buffer.byteLength(line, 'utf8'), stamp)
        } catch {
          // 轮转失败只保留现有文件，不阻断本次写入。
        }
        appendFileSync(path, line, 'utf8')
      } catch {
        // 只读或空间不足时不阻断业务；宿主 console 仍保留输出。
      }
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
