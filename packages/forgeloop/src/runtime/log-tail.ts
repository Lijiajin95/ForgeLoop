import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

export function readLogTail(path: string, maxBytes: number): string[] {
  const fd = openSync(path, 'r')
  try {
    const stats = fstatSync(fd)
    // Windows 允许对目录 open/fstat，但读出来是空内容；统一按“不可读”处理，
    // 让把目录登记成日志的配置得到明确错误，而不是静默记成空日志。
    if (!stats.isFile()) throw new Error('日志路径不是普通文件')
    const size = stats.size
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
    if (start > 0) lines.shift()
    return lines
  } finally {
    closeSync(fd)
  }
}
