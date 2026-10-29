import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

const cwd = '/tmp/ops-config-fixture'

describe('ops configuration', () => {
  it('is disabled by default with an empty catalog', () => {
    const config = resolveConfig({}, cwd)
    expect(config.ops).toEqual({
      enabled: false,
      intervalSeconds: 300,
      resources: [],
      checks: [],
      actions: [],
    })
  })

  it('parses a registered resource, check and action with defaults', () => {
    const config = resolveConfig(
      {
        ops: {
          enabled: true,
          intervalSeconds: 120,
          resources: [{ id: 'web', kind: 'app', label: '天工页面' }],
          checks: [{ id: 'web-health', resourceId: 'web', command: ['node', '-e', 'process.exit(0)'] }],
          actions: [
            {
              id: 'restart-web',
              resourceId: 'web',
              command: ['node', '-e', 'process.exit(0)'],
              auto: true,
            },
          ],
        },
      },
      cwd,
    )
    expect(config.ops.enabled).toBe(true)
    expect(config.ops.intervalSeconds).toBe(120)
    expect(config.ops.checks[0]).toEqual({
      id: 'web-health',
      resourceId: 'web',
      command: ['node', '-e', 'process.exit(0)'],
      timeoutSeconds: 60,
      severity: 'major',
    })
    expect(config.ops.actions[0]?.verifyCheckId).toBe('web-health')
    expect(config.ops.actions[0]?.auto).toBe(true)
  })

  it('rejects an enabled catalog without checks', () => {
    expect(() => resolveConfig({ ops: { enabled: true } }, cwd)).toThrow('启用时至少要登记一个检查')
  })

  it('rejects an unsafe interval, an empty command and a cross-resource verification check', () => {
    expect(() => resolveConfig({ ops: { intervalSeconds: 10 } }, cwd)).toThrow('不能小于 30 秒')
    expect(() =>
      resolveConfig(
        {
          ops: {
            resources: [{ id: 'web' }],
            checks: [{ id: 'web-health', resourceId: 'web' }],
          },
        },
        cwd,
      ),
    ).toThrow('命令不能为空')
    expect(() =>
      resolveConfig(
        {
          ops: {
            resources: [{ id: 'web' }, { id: 'db', kind: 'database' }],
            checks: [
              { id: 'web-health', resourceId: 'web', command: ['true'] },
              { id: 'db-ping', resourceId: 'db', command: ['true'] },
            ],
            actions: [
              { id: 'restart-web', resourceId: 'web', command: ['true'], verifyCheckId: 'db-ping' },
            ],
          },
        },
        cwd,
      ),
    ).toThrow('属于另一资源')
  })

  it('rejects non-object catalogs and non-boolean switches', () => {
    expect(() => resolveConfig({ ops: { resources: 'web' as never } }, cwd)).toThrow('必须是数组')
    expect(() => resolveConfig({ ops: { enabled: 'yes' as never } }, cwd)).toThrow('必须是布尔值')
  })
})
