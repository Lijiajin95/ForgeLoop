import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sha256OfText } from '../src/domain/delivery.js'
import { blockingOf, reviewFacts, runStatusLabel } from '../src/runtime/review-facts.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-review-facts-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content, 'utf8')
  return path
}

describe('review facts', () => {
  it('collects command facts and hashes the log when a digest is present', () => {
    const log = write('smoke.log', 'verified ok\n')
    const report = write(
      'verification.json',
      JSON.stringify({
        commands: [
          {
            label: 'smoke',
            argv: ['node', '--test', 1],
            exitCode: 0,
            logPath: log,
            logSha256: sha256OfText('verified ok\n'),
          },
        ],
      }),
    )
    const outcome = reviewFacts(report)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.facts).toEqual([
        {
          label: 'smoke',
          argv: ['node', '--test', '1'],
          exitCode: 0,
          logTail: expect.stringContaining('verified ok'),
        },
      ])
    }
  })

  it('accepts a command without a digest and with missing optional fields', () => {
    const log = write('smoke.log', 'ok\n')
    const report = write(
      'verification.json',
      JSON.stringify({ commands: [{ label: 'smoke', logPath: log }] }),
    )
    const outcome = reviewFacts(report)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.facts[0]?.argv).toEqual([])
      expect(outcome.facts[0]?.exitCode).toBeNull()
    }
  })

  it('rejects an unparseable report', () => {
    const report = write('verification.json', 'not json')
    expect(reviewFacts(report)).toEqual({
      ok: false,
      detail: '独立验证报告无法解析；不能做业务终审',
    })
    expect(reviewFacts(join(dir, 'missing.json'))).toEqual({
      ok: false,
      detail: '独立验证报告无法解析；不能做业务终审',
    })
  })

  it('skips malformed commands and rejects an empty command set', () => {
    const report = write(
      'verification.json',
      JSON.stringify({
        commands: [null, 'text', {}, { label: 'no-log' }, { logPath: join(dir, 'x.log') }],
      }),
    )
    expect(reviewFacts(report)).toEqual({
      ok: false,
      detail: '独立验证没有可核对的命令输出；不能做业务终审',
    })
    const missingCommands = write('empty.json', JSON.stringify({}))
    expect(reviewFacts(missingCommands)).toEqual({
      ok: false,
      detail: '独立验证没有可核对的命令输出；不能做业务终审',
    })
  })

  it('rejects a missing log file', () => {
    const report = write(
      'verification.json',
      JSON.stringify({
        commands: [{ label: 'smoke', logPath: join(dir, 'missing.log') }],
      }),
    )
    expect(reviewFacts(report)).toEqual({
      ok: false,
      detail: '验证命令 smoke 的日志缺失；不能做业务终审',
    })
  })

  it('rejects a log whose digest no longer matches', () => {
    const log = write('smoke.log', 'changed\n')
    const report = write(
      'verification.json',
      JSON.stringify({
        commands: [{ label: 'smoke', logPath: log, logSha256: sha256OfText('original\n') }],
      }),
    )
    expect(reviewFacts(report)).toEqual({
      ok: false,
      detail: '验证命令 smoke 的日志摘要不一致；不能做业务终审',
    })
  })
})

describe('review labels', () => {
  it('labels every terminal run status', () => {
    expect(runStatusLabel('aborted')).toBe('被停止')
    expect(runStatusLabel('timeout')).toBe('超时')
    expect(runStatusLabel('failed')).toBe('未完成')
  })

  it('returns blocking items only for a block verdict', () => {
    expect(blockingOf('pass', ['issue'], ['blocking'])).toEqual([])
    expect(blockingOf('block', ['issue'], ['blocking'])).toEqual(['issue'])
    expect(blockingOf('block', [], ['blocking'])).toEqual(['blocking'])
  })
})
