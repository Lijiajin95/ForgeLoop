import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runFormalTest } from '../src/runtime/formal-test.js'
import { runCommand } from '../src/runtime/workspace.js'

const dir = mkdtempSync(join(tmpdir(), 'forgeloop-launch-'))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('command launch on the host platform', () => {
  it('runs a PATH wrapper such as npm through the formal test runner', async () => {
    const result = await runFormalTest({
      cwd: dir,
      argv: ['npm', '--version'],
      timeoutMs: 120_000,
      logPath: join(dir, 'npm-version.log'),
    })

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.output).toMatch(/\d+\.\d+\.\d+/)
  })

  it('runs a PATH wrapper through the workspace command runner', async () => {
    const result = await runCommand('npm', ['--version'], dir)

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/)
  })
})
