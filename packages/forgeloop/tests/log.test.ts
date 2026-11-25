import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig, type RawLoggingConfig } from '../src/config.js'
import {
  clipText,
  createHostLogger,
  createPluginLogger,
  loggerFor,
  maintainLogFiles,
  pluginLogBase,
  pluginLogPath,
  redactText,
  redactValue,
} from '../src/runtime/log.js'

const dirs: string[] = []
const ISO = '2026-11-03T00:00:00.000Z'

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-log-'))
  dirs.push(dir)
  return dir
}

function configOf(root: string, logging?: RawLoggingConfig): ReturnType<typeof resolveConfig> {
  return resolveConfig(
    {
      project: 'p',
      projectPath: root,
      recordsRoot: join(root, 'records'),
      ...(logging ? { logging } : {}),
    },
    root,
  )
}

function jsonLogger(
  config: ReturnType<typeof resolveConfig>,
  now: () => Date = () => new Date(ISO),
) {
  const path = pluginLogBase(config)
  const destination = pino.destination({ dest: path, sync: true, mkdir: true })
  return { logger: createPluginLogger(config, { now, destination }), path }
}

function linesOf(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('plugin logger', () => {
  it('writes JSON lines with timestamp, uppercase level and message key', () => {
    const root = tempDir()
    const config = configOf(root)
    const { logger, path } = jsonLogger(config)
    logger.info('[forgeloop] hello')
    logger.warn('[forgeloop] warn')
    expect(linesOf(path)).toEqual([
      { ts: ISO, level: 'INFO', message: '[forgeloop] hello' },
      { ts: ISO, level: 'WARN', message: '[forgeloop] warn' },
    ])
  })

  it('records correlation fields, error stacks and redacts secrets', () => {
    const root = tempDir()
    const config = configOf(root)
    const { logger, path } = jsonLogger(config)
    logger.error('failed Bearer abcdefghijklmnop api_key=secretvalue', {
      event: 'coordinator.tick',
      reqId: 'req-1',
      taskId: 'task-a',
      actionId: 'act-1',
      error: new Error('provider failed sk-live-1234567890'),
    })
    const record = linesOf(path)[0] ?? {}
    expect(record.event).toBe('coordinator.tick')
    expect(record.reqId).toBe('req-1')
    expect(record.taskId).toBe('task-a')
    expect(record.actionId).toBe('act-1')
    expect(record.message).toContain('Bearer [REDACTED]')
    expect(record.message).toContain('api_key=[REDACTED]')
    const error = record.error as { name: string; message: string; stack: string }
    expect(error.message).toBe('provider failed sk-[REDACTED]')
    expect(error.name).toBe('Error')
    expect(error.stack).toContain('sk-[REDACTED]')
    expect(error.stack).not.toContain('1234567890')
  })

  it('normalizes a non-Error failure value into an error record', () => {
    const root = tempDir()
    const config = configOf(root)
    const { logger, path } = jsonLogger(config)
    logger.warn('plain failure', { error: 'disk full' })
    expect(linesOf(path)[0]?.error).toEqual({ name: 'Error', message: 'disk full', stack: '' })
  })

  it('keeps debug messages only when the level allows them', () => {
    const quiet = jsonLogger(configOf(tempDir(), { level: 'info' }))
    quiet.logger.debug('hidden detail')
    quiet.logger.info('kept')
    expect(linesOf(quiet.path).map((line) => line.level)).toEqual(['INFO'])

    const verbose = jsonLogger(configOf(tempDir(), { level: 'debug' }))
    verbose.logger.debug('agent.turn', { event: 'agent.turn', role: 'dev' })
    expect(linesOf(verbose.path)[0]).toMatchObject({ level: 'DEBUG', event: 'agent.turn' })
  })

  it('folds repeated identical errors and reports the folded count after the window', () => {
    const root = tempDir()
    const config = configOf(root)
    let clock = Date.parse(ISO)
    const { logger, path } = jsonLogger(config, () => new Date(clock))
    logger.error('spawn npm ENOENT', { event: 'coordinator.execute', reqId: 'req-1' })
    logger.error('spawn npm ENOENT', { event: 'coordinator.execute', reqId: 'req-1' })
    logger.error('spawn npm ENOENT', { event: 'coordinator.execute', reqId: 'req-1' })
    expect(linesOf(path)).toHaveLength(1)
    clock += 61_000
    logger.error('spawn npm ENOENT', { event: 'coordinator.execute', reqId: 'req-1' })
    const records = linesOf(path)
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({ repeated: 2, firstAt: ISO, lastAt: ISO })
  })

  it('keeps the dedupe table bounded', () => {
    const config = configOf(tempDir())
    const { logger, path } = jsonLogger(config)
    const bounded = createPluginLogger(config, {
      now: () => new Date(ISO),
      destination: pino.destination({ dest: path, sync: true, mkdir: true }),
      dedupeMaxEntries: 1,
    })
    bounded.error('first')
    bounded.error('second')
    bounded.error('third')
    expect(linesOf(path)).toHaveLength(3)
    logger.info('unused')
  })

  it('does not fold different messages or different requirements', () => {
    const root = tempDir()
    const config = configOf(root)
    const { logger, path } = jsonLogger(config)
    logger.error('first')
    logger.error('second')
    logger.error('first', { reqId: 'req-2' })
    expect(linesOf(path)).toHaveLength(3)
  })

  it('writes the host log under the records root instead of a project directory', () => {
    const root = tempDir()
    const config = configOf(root)
    const path = join(config.recordsRoot, 'logs', 'plugin.log')
    const destination = pino.destination({ dest: path, sync: true, mkdir: true })
    const logger = createHostLogger(config, { destination })
    logger.info('[forgeloop] host ready')
    expect(linesOf(path)[0]?.message).toBe('[forgeloop] host ready')
  })

  it('never throws when the log directory cannot be created', () => {
    const root = tempDir()
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const config = resolveConfig({ project: 'p', projectPath: root, recordsRoot: blocker }, root)
    const logger = createPluginLogger(config, { now: () => new Date(ISO) })
    expect(() => logger.info('[forgeloop] still alive')).not.toThrow()
  })
})

describe('log retention', () => {
  const today = new Date('2026-11-24T10:00:00.000Z')

  it('compresses earlier days and keeps the current day plain', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'plugin.2026-11-22.1.log'), 'old line\n', 'utf8')
    writeFileSync(join(dir, 'plugin.2026-11-24.1.log'), 'today line\n', 'utf8')
    const result = maintainLogFiles(dir, { now: today, retentionDays: 14 })
    expect(result.compressed).toBe(1)
    expect(readFileSync(join(dir, 'plugin.2026-11-22.1.log.gz'))).toEqual(gzipSync('old line\n'))
    expect(readFileSync(join(dir, 'plugin.2026-11-24.1.log'), 'utf8')).toBe('today line\n')
  })

  it('deletes compressed files older than the retention window', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'plugin.2026-01-01.1.log.gz'), gzipSync('ancient\n'))
    writeFileSync(join(dir, 'plugin.2026-11-20.1.log.gz'), gzipSync('recent\n'))
    const result = maintainLogFiles(dir, { now: today, retentionDays: 14 })
    expect(result.deleted).toBe(1)
    expect(() => readFileSync(join(dir, 'plugin.2026-01-01.1.log.gz'))).toThrow()
    expect(() => readFileSync(join(dir, 'plugin.2026-11-20.1.log.gz'))).not.toThrow()
  })

  it('ignores missing directories and unrelated files', () => {
    expect(maintainLogFiles(join(tempDir(), 'missing'))).toEqual({ compressed: 0, deleted: 0 })
    const dir = tempDir()
    writeFileSync(join(dir, 'other.log'), 'x')
    expect(maintainLogFiles(dir, { now: today })).toEqual({ compressed: 0, deleted: 0 })
  })

  it('compresses legacy rotated names from the previous scheme', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'plugin-2026-11-22.log'), 'legacy one\n')
    writeFileSync(join(dir, 'plugin-2026-11-22-1.log'), 'legacy two\n')
    const result = maintainLogFiles(dir, { now: today, retentionDays: 14 })
    expect(result.compressed).toBe(2)
    expect(readFileSync(join(dir, 'plugin-2026-11-22.log.gz'))).toEqual(gzipSync('legacy one\n'))
    expect(readFileSync(join(dir, 'plugin-2026-11-22-1.log.gz'))).toEqual(gzipSync('legacy two\n'))
  })

  it('compresses a stale active plugin.log and keeps a fresh one', () => {
    const stale = tempDir()
    const stalePath = join(stale, 'plugin.log')
    writeFileSync(stalePath, 'yesterday\n')
    utimesSync(
      stalePath,
      new Date('2026-11-23T08:00:00.000Z'),
      new Date('2026-11-23T08:00:00.000Z'),
    )
    expect(maintainLogFiles(stale, { now: today }).compressed).toBe(1)
    expect(readFileSync(join(stale, 'plugin.log.gz'))).toEqual(gzipSync('yesterday\n'))

    const fresh = tempDir()
    writeFileSync(join(fresh, 'plugin.log'), 'today\n')
    expect(maintainLogFiles(fresh, { now: today })).toEqual({ compressed: 0, deleted: 0 })
    expect(readFileSync(join(fresh, 'plugin.log'), 'utf8')).toBe('today\n')
  })

  it('compresses plugin.log once the current naming scheme exists', () => {
    const dir = tempDir()
    const active = join(dir, 'plugin.log')
    writeFileSync(active, 'old active\n')
    const stamp = new Date('2026-11-24T09:00:00.000Z')
    utimesSync(active, stamp, stamp)
    writeFileSync(join(dir, 'plugin.2026-11-24.1.log'), 'current\n')
    expect(maintainLogFiles(dir, { now: today }).compressed).toBe(1)
    expect(readFileSync(join(dir, 'plugin.log.gz'))).toEqual(gzipSync('old active\n'))
    expect(readFileSync(join(dir, 'plugin.2026-11-24.1.log'), 'utf8')).toBe('current\n')
  })

  it('removes expired legacy compressed files', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'plugin-2026-01-01.log.gz'), gzipSync('ancient\n'))
    expect(maintainLogFiles(dir, { now: today, retentionDays: 14 }).deleted).toBe(1)
    expect(() => readFileSync(join(dir, 'plugin-2026-01-01.log.gz'))).toThrow()
  })
})

describe('redaction helpers', () => {
  it('redacts token-like text and secret-shaped keys recursively', () => {
    expect(redactText('token=abc123')).toBe('token=[REDACTED]')
    expect(
      redactValue({
        api_key: 'abc',
        nested: { authorization: 'Bearer zzzzzzzz', text: 'sk-abcdefgh' },
        list: ['password=hunter2'],
      }),
    ).toEqual({
      api_key: '[REDACTED]',
      nested: { authorization: '[REDACTED]', text: 'sk-[REDACTED]' },
      list: ['password=[REDACTED]'],
    })
  })

  it('clips oversized debug text without throwing on unstringifiable values', () => {
    expect(clipText('x'.repeat(20), 5)).toBe('xxxxx…[truncated]')
    expect(clipText({ a: 1 })).toBe('{"a":1}')
  })

  it('caches one logger per records root', () => {
    const first = loggerFor(configOf(tempDir()))
    const second = loggerFor(configOf(tempDir()))
    expect(first).not.toBe(second)
    const root = tempDir()
    const config = configOf(root)
    expect(loggerFor(config)).toBe(loggerFor(config))
  })

  it('resolves the current active log file and writes through pino-roll in production mode', async () => {
    const root = tempDir()
    const config = configOf(root)
    const logger = createPluginLogger(config, { echo: false })
    logger.info('[forgeloop] production mode')
    const directory = join(pluginLogBase(config), '..')
    const deadline = Date.now() + 5_000
    let names: string[] = []
    while (Date.now() < deadline) {
      names = readdirSync(directory).filter((name) => /^plugin\..*\.log$/.test(name))
      if (names.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(names.length).toBeGreaterThan(0)
    expect(pluginLogPath(config)).toContain('plugin.')
  })
})
