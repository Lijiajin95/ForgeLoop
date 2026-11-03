/**
 * 插件运行记录：同时写宿主 console 与项目日志文件。
 *
 * 默认位置：`<recordsRoot>/projects/<project>/logs/plugin.log`。
 * 日志写盘失败不影响业务；调用方仍能从宿主 console 看到原文。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { projectDir } from '../config.js'

type LogLevel = 'INFO' | 'WARN' | 'ERROR'

export interface PluginLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 项目日志文件路径（供测试与运维定位，不负责创建）。 */
export function pluginLogPath(config: ForgeLoopConfig): string {
  return join(projectDir(config), 'logs', 'plugin.log')
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
  const emit = (level: LogLevel, message: string): void => {
    if (path) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        appendFileSync(path, `${now().toISOString()} ${level} ${message}\n`, 'utf8')
      } catch {
        // 只读或空间不足时不阻断业务；宿主 console 仍保留输出。
      }
    }
    if (level === 'ERROR') console.error(message)
    else if (level === 'WARN') console.warn(message)
    else console.log(message)
  }
  return {
    info: (message) => {
      emit('INFO', message)
    },
    warn: (message) => {
      emit('WARN', message)
    },
    error: (message) => {
      emit('ERROR', message)
    },
  }
}
