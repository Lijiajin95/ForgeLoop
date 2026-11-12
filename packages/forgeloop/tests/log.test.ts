import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig, type RawLoggingConfig } from '../src/config.js'
import { createPluginLogger, pluginLogPath } from '../src/runtime/log.js'

const dirs: string[] = []
const NOW = () => new Date('2026-11-03T00:00:00.000Z')
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

function logLines(config: ReturnType<typeof resolveConfig>): string[] {
  return readFileSync(pluginLogPath(config), 'utf8').trim().split('\n')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('plugin logger', () => {
  it('appends structured JSON lines with timestamp, level and message by default', () => {
    const root = tempDir()
    const config = configOf(root)
    const logger = createPluginLogger(config, NOW)
    logger.info('[forgeloop] hello')
    logger.warn('[forgeloop] warn')
    logger.error('[forgeloop] boom')
    const lines = logLines(config)
    expect(lines).toHaveLength(3)
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { ts: ISO, level: 'INFO', message: '[forgeloop] hello' },
      { ts: ISO, level: 'WARN', message: '[forgeloop] warn' },
      { ts: ISO, level: 'ERROR', message: '[forgeloop] boom' },
    ])
  })

  it('records correlation fields, error stacks and redacts secrets', () => {
    const root = tempDir()
    const config = configOf(root)
    const logger = createPluginLogger(config, NOW)
    const error = new Error('provider failed sk-live-1234567890')
    logger.error('failed Bearer abcdefghijklmnop api_key=secretvalue', {
      event: 'coordinator.tick',
      reqId: 'req-1',
      taskId: 'task-a',
      actionId: 'act-1',
      error,
    })
    const record = JSON.parse(logLines(config)[0] ?? '{}') as {
      message: string
      event: string
      reqId: string
      taskId: string
      actionId: string
      error: { name: string; message: string; stack: string }
    }
    expect(record.event).toBe('coordinator.tick')
    expect(record.reqId).toBe('req-1')
    expect(record.taskId).toBe('task-a')
    expect(record.actionId).toBe('act-1')
    expect(record.message).toContain('Bearer [REDACTED]')
    expect(record.message).toContain('api_key=[REDACTED]')
    expect(record.error.message).toBe('provider failed sk-[REDACTED]')
    expect(record.error.name).toBe('Error')
    expect(record.error.stack).toContain('sk-[REDACTED]')
    expect(record.error.stack).not.toContain('1234567890')
  })

  it('normalizes a non-Error failure value into an error record', () => {
    const root = tempDir()
    const config = configOf(root)
    const logger = createPluginLogger(config, NOW)
    logger.warn('plain failure', { error: 'disk full' })
    const record = JSON.parse(logLines(config)[0] ?? '{}') as {
      error: { name: string; message: string; stack: string }
    }
    expect(record.error).toEqual({ name: 'Error', message: 'disk full', stack: '' })
  })

  it('filters messages below the configured level', () => {
    const root = tempDir()
    const config = configOf(root, { level: 'warn' })
    const logger = createPluginLogger(config, NOW)
    logger.info('[forgeloop] hidden')
    logger.warn('[forgeloop] kept')
    const levels = logLines(config).map((line) => (JSON.parse(line) as { level: string }).level)
    expect(levels).toEqual(['WARN'])
  })

  it('writes the legacy text format when configured', () => {
    const root = tempDir()
    const config = configOf(root, { format: 'text' })
    const logger = createPluginLogger(config, NOW)
    logger.info('[forgeloop] hello')
    expect(logLines(config)).toEqual([`${ISO} INFO [forgeloop] hello`])
  })

  it('rotates the log once the next line would exceed maxBytes', () => {
    const root = tempDir()
    const config = configOf(root, { maxBytes: 120 })
    const logger = createPluginLogger(config, NOW)
    const padding = 'x'.repeat(40)
    logger.info(`first ${padding}`)
    const firstSize = readFileSync(pluginLogPath(config), 'utf8').length
    expect(firstSize).toBeLessThanOrEqual(120)
    logger.info(`second ${padding}`)
    const backup = `${pluginLogPath(config)}.1`
    expect(existsSync(backup)).toBe(true)
    expect(readFileSync(backup, 'utf8')).toContain('first')
    expect(readFileSync(pluginLogPath(config), 'utf8')).toContain('second')
    expect(readFileSync(pluginLogPath(config), 'utf8')).not.toContain('first')
  })

  it('replaces the single backup file on the next rotation', () => {
    const root = tempDir()
    const config = configOf(root, { maxBytes: 120 })
    const logger = createPluginLogger(config, NOW)
    const padding = 'x'.repeat(40)
    logger.info(`first ${padding}`)
    logger.info(`second ${padding}`)
    logger.info(`third ${padding}`)
    expect(readFileSync(`${pluginLogPath(config)}.1`, 'utf8')).toContain('second')
    expect(readFileSync(`${pluginLogPath(config)}.1`, 'utf8')).not.toContain('first')
    expect(readFileSync(pluginLogPath(config), 'utf8')).toContain('third')
    expect(existsSync(`${pluginLogPath(config)}.2`)).toBe(false)
  })

  it('never rotates when maxBytes is zero', () => {
    const root = tempDir()
    const config = configOf(root, { maxBytes: 0 })
    const logger = createPluginLogger(config, NOW)
    logger.info('a'.repeat(200))
    logger.info('b'.repeat(200))
    expect(existsSync(`${pluginLogPath(config)}.1`)).toBe(false)
    expect(logLines(config)).toHaveLength(2)
  })

  it('keeps appending when the rotation target cannot be replaced', () => {
    const root = tempDir()
    const config = configOf(root, { maxBytes: 120 })
    const backup = `${pluginLogPath(config)}.1`
    mkdirSync(backup, { recursive: true })
    writeFileSync(join(backup, 'keep'), 'x')
    const logger = createPluginLogger(config, NOW)
    expect(() => logger.info('a'.repeat(80))).not.toThrow()
    expect(() => logger.info('b'.repeat(80))).not.toThrow()
    expect(logLines(config)).toHaveLength(2)
    expect(existsSync(join(backup, 'keep'))).toBe(true)
  })

  it('never throws when the log directory cannot be created', () => {
    const root = tempDir()
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const config = resolveConfig({ project: 'p', projectPath: root, recordsRoot: blocker }, root)
    const logger = createPluginLogger(config, NOW)
    expect(() => logger.info('[forgeloop] still alive')).not.toThrow()
  })
})
