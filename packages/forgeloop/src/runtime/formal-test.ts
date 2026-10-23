/**
 * 正式测试执行：由程序实际运行批准过的测试命令，保存命令、退出码、耗时与完整日志。
 * 模型声称“测试通过”不能替代这里的退出码和日志摘要。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sha256OfText } from '../domain/delivery.js'

export interface TestRunRequest {
  readonly ctx?: Record<string, unknown>
  readonly cwd: string
  readonly argv: readonly string[]
  readonly timeoutMs: number
  readonly logPath: string
  readonly signal?: AbortSignal
}

export interface TestRunResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly logPath: string
  readonly logSha256: string
  readonly durationMs: number
  readonly output: string
}

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024

interface SubprocessLike {
  stdout?: NodeJS.ReadableStream
  stderr?: NodeJS.ReadableStream
  done: Promise<{ exitCode: number | null }>
  terminate(): void
}

export async function runFormalTest(request: TestRunRequest): Promise<TestRunResult> {
  const started = Date.now()
  const collected: Buffer[] = []
  let captured = 0
  let timedOut = false
  let aborted = false

  const collect = (chunk: Buffer) => {
    if (captured >= MAX_CAPTURE_BYTES) return
    const room = MAX_CAPTURE_BYTES - captured
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
    collected.push(slice)
    captured += slice.length
  }

  const subprocess = (
    typeof request.ctx?.get === 'function'
      ? (request.ctx.get as (key: string) => unknown)('subprocess')
      : request.ctx?.subprocess
  ) as
    | {
        spawn(spec: Record<string, unknown>): SubprocessLike
      }
    | undefined

  let exitCode: number | null = null
  if (subprocess) {
    const handle = subprocess.spawn({
      argv: request.argv,
      cwd: request.cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 2000,
      env: { ...process.env },
      signal: request.signal,
    })
    handle.stdout?.on('data', (chunk: Buffer) => collect(Buffer.from(chunk)))
    handle.stderr?.on('data', (chunk: Buffer) => collect(Buffer.from(chunk)))
    const timer = setTimeout(() => {
      timedOut = true
      handle.terminate()
    }, request.timeoutMs)
    timer.unref?.()
    const onAbort = () => {
      aborted = true
      handle.terminate()
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      exitCode = (await handle.done).exitCode
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  } else {
    const child = spawn(request.argv[0]!, request.argv.slice(1), {
      cwd: request.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (chunk: Buffer) => collect(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => collect(Buffer.from(chunk)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, request.timeoutMs)
    timer.unref?.()
    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    exitCode = await new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code))
      child.once('error', () => resolve(null))
    }).finally(() => {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    })
  }

  const durationMs = Date.now() - started
  const output = Buffer.concat(collected).toString('utf8')
  const log = [
    `command: ${request.argv.map((part) => JSON.stringify(part)).join(' ')}`,
    `cwd: ${request.cwd}`,
    `started: ${new Date(started).toISOString()}`,
    `duration_ms: ${durationMs}`,
    `timed_out: ${timedOut}`,
    `aborted: ${aborted}`,
    `exit_code: ${exitCode === null ? 'null' : exitCode}`,
    '--- output ---',
    output,
  ].join('\n')
  mkdirSync(dirname(request.logPath), { recursive: true })
  writeFileSync(request.logPath, log, 'utf8')
  return {
    exitCode,
    timedOut,
    aborted,
    logPath: request.logPath,
    logSha256: sha256OfText(log),
    durationMs,
    output,
  }
}