import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { createPluginLogger, pluginLogPath } from '../src/runtime/log.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-log-'))
  dirs.push(dir)
  return dir
}

function configOf(root: string): ReturnType<typeof resolveConfig> {
  return resolveConfig(
    { project: 'p', projectPath: root, recordsRoot: join(root, 'records') },
    root,
  )
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('plugin logger', () => {
  it('appends info/warn/error lines to <recordsRoot>/projects/<project>/logs/plugin.log', () => {
    const root = tempDir()
    const config = configOf(root)
    const logger = createPluginLogger(config, () => new Date('2026-11-03T00:00:00.000Z'))
    logger.info('[forgeloop] hello')
    logger.warn('[forgeloop] warn')
    logger.error('[forgeloop] boom')
    const lines = readFileSync(pluginLogPath(config), 'utf8').trim().split('\n')
    expect(lines).toEqual([
      '2026-11-03T00:00:00.000Z INFO [forgeloop] hello',
      '2026-11-03T00:00:00.000Z WARN [forgeloop] warn',
      '2026-11-03T00:00:00.000Z ERROR [forgeloop] boom',
    ])
  })

  it('never throws when the log directory cannot be created', () => {
    const root = tempDir()
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const config = resolveConfig({ project: 'p', projectPath: root, recordsRoot: blocker }, root)
    const logger = createPluginLogger(config)
    expect(() => logger.info('[forgeloop] still alive')).not.toThrow()
  })
})
