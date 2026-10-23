import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { routeStage, type RoutingInput } from '../src/domain/work.js'
import { runFormalTest } from '../src/runtime/formal-test.js'

function route(overrides: Partial<RoutingInput>) {
  return routeStage({
    stage: 'dev',
    passed: true,
    blockingReview: false,
    attempts: 0,
    maxAttempts: 3,
    grantAvailable: true,
    stopped: false,
    ...overrides,
  })
}

describe('stage routing branches', () => {
  it('routes a usable development result to review and a failed one back to dev', () => {
    expect(route({ stage: 'dev', passed: true }).next).toBe('review')
    expect(route({ stage: 'dev', passed: false }).next).toBe('retry_dev')
  })

  it('routes a passing review to test and an unusable review to blocked', () => {
    expect(route({ stage: 'review', passed: true }).next).toBe('test')
    expect(route({ stage: 'review', passed: false }).next).toBe('blocked')
  })

  it('routes a failing deliver stage to blocked and a passing one to delivered', () => {
    expect(route({ stage: 'deliver', passed: true }).state).toBe('delivered')
    expect(route({ stage: 'deliver', passed: false }).state).toBe('blocked')
  })

  it('stops when attempts are exhausted regardless of stage', () => {
    const outcome = route({ stage: 'test', passed: false, attempts: 3 })
    expect(outcome.state).toBe('failed')
    expect(outcome.reason).toContain('等待人工决定')
  })
})

describe('formal test execution', () => {
  it('records a passing command with its log and digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeloop-test-'))
    try {
      const result = await runFormalTest({
        cwd: dir,
        argv: ['node', '-e', "console.log('ok')"],
        timeoutMs: 10_000,
        logPath: join(dir, 'log.txt'),
      })
      expect(result.exitCode).toBe(0)
      expect(result.logSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(readFileSync(result.logPath, 'utf8')).toContain('ok')
      expect(readFileSync(result.logPath, 'utf8')).toContain('exit_code: 0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records a failing command and never reports success from output text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeloop-test-'))
    try {
      const result = await runFormalTest({
        cwd: dir,
        argv: ['node', '-e', "console.log('all tests passed'); process.exit(3)"],
        timeoutMs: 10_000,
        logPath: join(dir, 'log.txt'),
      })
      expect(result.exitCode).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('terminates a timed-out command and marks it timed out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeloop-test-'))
    try {
      const result = await runFormalTest({
        cwd: dir,
        argv: ['node', '-e', 'setTimeout(() => {}, 10_000)'],
        timeoutMs: 100,
        logPath: join(dir, 'log.txt'),
      })
      expect(result.timedOut).toBe(true)
      expect(readFileSync(result.logPath, 'utf8')).toContain('timed_out: true')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
