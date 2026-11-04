import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runFormalTest } from '../src/runtime/formal-test.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-formal-gap-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface FakeHandle {
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly done: Promise<{ exitCode: number | null }>
  terminate(): void
}

function fake(
  opts: { exitCode?: number | null; output?: string; stderr?: string; hang?: boolean } = {},
) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let resolveDone!: (value: { exitCode: number | null }) => void
  const done = new Promise<{ exitCode: number | null }>((resolve) => {
    resolveDone = resolve
  })
  let terminated = false
  const handle: FakeHandle = {
    stdout,
    stderr,
    done,
    terminate() {
      terminated = true
      resolveDone({ exitCode: null })
    },
  }
  const spawn = () => {
    if (!opts.hang) {
      queueMicrotask(() => {
        if (opts.output) stdout.write(opts.output)
        if (opts.stderr) stderr.write(opts.stderr)
        resolveDone({ exitCode: opts.exitCode ?? 0 })
      })
    }
    return handle
  }
  return { handle, spawn, terminated: () => terminated }
}

describe('formal test with injected subprocess', () => {
  it('passes the approved argv and captures stdout/stderr', async () => {
    const f = fake({ output: 'out line', stderr: 'err line', exitCode: 2 })
    let spec: Record<string, unknown> | null = null
    const result = await runFormalTest({
      ctx: {
        subprocess: {
          spawn: (value: Record<string, unknown>) => {
            spec = value
            return f.spawn()
          },
        },
      },
      cwd: dir,
      argv: ['node', 'test.js'],
      timeoutMs: 5000,
      logPath: join(dir, 'logs', 'a.log'),
    })
    expect(spec).toMatchObject({ argv: ['node', 'test.js'], cwd: dir, graceMs: 2000 })
    expect(result.exitCode).toBe(2)
    expect(result.output).toContain('out line')
    expect(result.output).toContain('err line')
    expect(readFileSync(result.logPath, 'utf8')).toContain('exit_code: 2')
  })

  it('terminates on timeout and records it', async () => {
    const f = fake({ hang: true })
    const result = await runFormalTest({
      ctx: { get: () => ({ spawn: () => f.handle }) },
      cwd: dir,
      argv: ['node'],
      timeoutMs: 20,
      logPath: join(dir, 'logs', 'timeout.log'),
    })
    expect(f.terminated()).toBe(true)
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(readFileSync(result.logPath, 'utf8')).toContain('timed_out: true')
  })

  it('terminates on abort without marking timeout', async () => {
    const f = fake({ hang: true })
    const controller = new AbortController()
    const promise = runFormalTest({
      ctx: { subprocess: { spawn: () => f.handle } },
      cwd: dir,
      argv: ['node'],
      timeoutMs: -1,
      logPath: join(dir, 'logs', 'abort.log'),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 10)
    const result = await promise
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(readFileSync(result.logPath, 'utf8')).toContain('aborted: true')
  })
})
