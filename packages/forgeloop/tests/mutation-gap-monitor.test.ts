import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { collectMonitorSnapshot } from '../src/runtime/monitor.js'

let dir = ''
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-monitor-gap-'))
  repository = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function stable(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TIME')
      .split(dir)
      .join('DIR')
      .replaceAll('\\', '/')
      .replace(/\b\d+(?:\.\d+)?\b/g, 'N')
  }
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key === 'host' && item && typeof item === 'object' && !Array.isArray(item)) {
          return [key, Object.fromEntries(Object.keys(item).map((hostKey) => [hostKey, 'N']))]
        }
        return [key, stable(item)]
      }),
    )
  }
  return value
}

describe('monitor snapshot collection', () => {
  it('keeps the snapshot shape stable without process probes', async () => {
    const log = join(dir, 'app.log')
    writeFileSync(log, 'line one\nline two\n')
    const config = resolveConfig(
      {
        project: 'demo',
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        ops: {
          enabled: true,
          resources: [{ id: 'web', kind: 'app', label: '页面' }],
          monitor: {
            enabled: true,
            intervalSeconds: 30,
            logs: [{ id: 'app-log', resourceId: 'web', path: log, errorPattern: 'ERROR' }],
          },
        },
      },
      dir,
    )
    const snapshot = await collectMonitorSnapshot({
      config,
      repo: repository,
      now: new Date('2026-11-04T00:00:00.000Z'),
    })
    expect(stable(snapshot)).toMatchSnapshot()
  })
})
