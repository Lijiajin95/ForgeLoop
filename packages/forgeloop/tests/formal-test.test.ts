import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { runFormalTest } from '../src/runtime/formal-test.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-formal-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function logPath(name: string): string {
  return join(dir, 'logs', `${name}.log`)
}

describe('formal test runner without a subprocess service', () => {
  it('runs the approved argv, captures output and records the exit code', async () => {
    const result = await runFormalTest({
      cwd: dir,
      argv: ['node', '-e', 'console.log("ok")'],
      timeoutMs: 5000,
      logPath: logPath('success'),
    })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.output).toContain('ok')
    expect(existsSync(result.logPath)).toBe(true)
    const log = readFileSync(result.logPath, 'utf8')
    expect(log).toContain('exit_code: 0')
    expect(log).toContain('--- output ---')
    expect(result.logSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records a non-zero exit code without inventing success', async () => {
    const result = await runFormalTest({
      cwd: dir,
      argv: ['node', '-e', 'process.exit(3)'],
      timeoutMs: 5000,
      logPath: logPath('failure'),
    })
    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
  })

  it('records a missing executable as an error instead of throwing', async () => {
    const result = await runFormalTest({
      cwd: dir,
      argv: ['fl-command-that-does-not-exist'],
      timeoutMs: 2000,
      logPath: logPath('missing'),
    })
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(false)
  })

  it('terminates a test that exceeds its timeout', async () => {
    const result = await runFormalTest({
      cwd: dir,
      argv: ['node', '-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 100,
      logPath: logPath('timeout'),
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('terminates a test when its signal aborts', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await runFormalTest({
      cwd: dir,
      argv: ['node', '-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 5000,
      logPath: logPath('aborted'),
      signal: controller.signal,
    })
    expect(result.aborted).toBe(true)
    expect(result.exitCode).toBeNull()
  })
})

interface FakeHandle {
  stdout: PassThrough
  stderr: PassThrough
  done: Promise<{ exitCode: number | null }>
  terminate(): void
}

function fakeSubprocess(options: { terminateExit?: number | null } = {}) {
  let resolveDone: (value: { exitCode: number | null }) => void = () => undefined
  let terminated = false
  const handle: FakeHandle = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    done: new Promise((resolve) => {
      resolveDone = resolve
    }),
    terminate() {
      terminated = true
      resolveDone({ exitCode: options.terminateExit ?? null })
    },
  }
  return {
    ctx: {
      get: (name: string) => (name === 'subprocess' ? { spawn: () => handle } : undefined),
    },
    handle,
    finish(exitCode: number) {
      resolveDone({ exitCode })
    },
    terminated: () => terminated,
  }
}

describe('formal test runner through the subprocess service', () => {
  it('uses the injected subprocess service and streams both pipes into the log', async () => {
    const fake = fakeSubprocess()
    const run = runFormalTest({
      ctx: fake.ctx,
      cwd: dir,
      argv: ['node', '-e', 'process.exit(0)'],
      timeoutMs: 5000,
      logPath: logPath('service'),
    })
    fake.handle.stdout.write('out-line\n')
    fake.handle.stderr.write('err-line\n')
    fake.finish(0)
    const result = await run
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('out-line')
    expect(result.output).toContain('err-line')
    expect(fake.terminated()).toBe(false)
  })

  it('asks the service to terminate on timeout', async () => {
    const fake = fakeSubprocess()
    const result = await runFormalTest({
      ctx: fake.ctx,
      cwd: dir,
      argv: ['node', '-e', 'process.exit(0)'],
      timeoutMs: 20,
      logPath: logPath('service-timeout'),
    })
    expect(result.timedOut).toBe(true)
    expect(fake.terminated()).toBe(true)
  })

  it('asks the service to terminate when aborted', async () => {
    const fake = fakeSubprocess()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const result = await runFormalTest({
      ctx: fake.ctx,
      cwd: dir,
      argv: ['node', '-e', 'process.exit(0)'],
      timeoutMs: 5000,
      logPath: logPath('service-abort'),
      signal: controller.signal,
    })
    expect(result.aborted).toBe(true)
    expect(fake.terminated()).toBe(true)
  })
})
