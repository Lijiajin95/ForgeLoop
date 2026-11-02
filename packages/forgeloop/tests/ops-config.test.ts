import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveConfig, type RawConfig } from '../src/config.js'

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
      monitor: {
        enabled: false,
        intervalSeconds: 300,
        logLines: 80,
        providers: ['builtin'],
        processes: [],
        latency: [],
        logs: [],
        alertFiles: [],
        heartbeat: { url: '', method: 'GET', timeoutSeconds: 5 },
      },
      alerts: { webhook: '', timeoutSeconds: 10 },
    })
  })

  it('parses a registered resource, check and action with defaults', () => {
    const config = resolveConfig(
      {
        ops: {
          enabled: true,
          intervalSeconds: 120,
          resources: [{ id: 'web', kind: 'app', label: '天工页面' }],
          checks: [
            { id: 'web-health', resourceId: 'web', command: ['node', '-e', 'process.exit(0)'] },
          ],
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

  it('parses a monitor catalog that points at registered resources', () => {
    const config = resolveConfig(
      {
        ops: {
          enabled: true,
          resources: [{ id: 'web', kind: 'app', label: '天工页面' }],
          checks: [{ id: 'web-health', resourceId: 'web', command: ['true'] }],
          monitor: {
            enabled: true,
            intervalSeconds: 90,
            logLines: 50,
            processes: [{ id: 'node', resourceId: 'web', match: 'node' }],
            latency: [{ id: 'health', resourceId: 'web', url: 'http://127.0.0.1:3080/health' }],
            logs: [{ id: 'app', resourceId: 'web', path: 'logs/app.log', errorPattern: 'ERROR' }],
            alertFiles: [{ id: 'external', path: 'alerts.json' }],
          },
          alerts: { webhook: 'https://example.com/hook' },
        },
      },
      cwd,
    )
    expect(config.ops.monitor).toEqual({
      enabled: true,
      intervalSeconds: 90,
      logLines: 50,
      providers: ['builtin'],
      processes: [{ id: 'node', resourceId: 'web', match: 'node' }],
      latency: [
        { id: 'health', resourceId: 'web', url: 'http://127.0.0.1:3080/health', timeoutSeconds: 5 },
      ],
      logs: [{ id: 'app', resourceId: 'web', path: 'logs/app.log', errorPattern: 'ERROR' }],
      alertFiles: [{ id: 'external', path: 'alerts.json' }],
      heartbeat: { url: '', method: 'GET', timeoutSeconds: 5 },
    })
    expect(config.ops.alerts).toEqual({ webhook: 'https://example.com/hook', timeoutSeconds: 10 })
  })

  it('allows ops to run with monitoring only and rejects monitor without ops', () => {
    const monitorOnly = resolveConfig(
      {
        ops: {
          enabled: true,
          monitor: { enabled: true, logs: [] },
        },
      },
      cwd,
    )
    expect(monitorOnly.ops.checks).toEqual([])
    expect(monitorOnly.ops.monitor.enabled).toBe(true)
    expect(() => resolveConfig({ ops: { monitor: { enabled: true } } }, cwd)).toThrow(
      '需要同时启用 ops',
    )
  })

  it('rejects unsafe monitor sources at load time', () => {
    const base = {
      ops: {
        resources: [{ id: 'web' }],
      },
    }
    expect(() =>
      resolveConfig(
        {
          ops: {
            ...base.ops,
            monitor: { enabled: true, latency: [{ id: 'x', resourceId: 'db', url: 'http://a' }] },
          },
        },
        cwd,
      ),
    ).toThrow('未登记的资源')
    expect(() =>
      resolveConfig(
        {
          ops: {
            ...base.ops,
            monitor: { enabled: true, latency: [{ id: 'x', resourceId: 'web', url: 'ftp://a' }] },
          },
        },
        cwd,
      ),
    ).toThrow('只接受 http(s) URL')
    expect(() =>
      resolveConfig(
        {
          ops: {
            ...base.ops,
            monitor: {
              enabled: true,
              logs: [{ id: 'x', resourceId: 'web', path: 'a.log', errorPattern: '(' }],
            },
          },
        },
        cwd,
      ),
    ).toThrow('不是合法正则')
    expect(() =>
      resolveConfig(
        {
          ops: {
            ...base.ops,
            monitor: {
              enabled: true,
              processes: [{ id: 'same', resourceId: 'web', match: 'node' }],
              logs: [{ id: 'same', resourceId: 'web', path: 'a.log', errorPattern: 'ERROR' }],
            },
          },
        },
        cwd,
      ),
    ).toThrow('重复')
    expect(() =>
      resolveConfig({ ops: { ...base.ops, monitor: { enabled: false, intervalSeconds: 5 } } }, cwd),
    ).toThrow('不能小于 30 秒')
    expect(() =>
      resolveConfig({ ops: { ...base.ops, monitor: { enabled: false, logLines: 501 } } }, cwd),
    ).toThrow('不能大于 500')
    expect(() =>
      resolveConfig({ ops: { ...base.ops, alerts: { webhook: 'file:///tmp/hook' } } }, cwd),
    ).toThrow('只接受 http(s) URL')
    expect(() =>
      resolveConfig({ ops: { ...base.ops, alerts: { timeoutSeconds: 61 } } }, cwd),
    ).toThrow('不能大于 60 秒')
  })

  it('accepts only registered monitor providers and normalizes heartbeat settings', () => {
    const config = resolveConfig(
      {
        ops: {
          enabled: true,
          monitor: {
            enabled: true,
            providers: ['builtin'],
            heartbeat: {
              url: 'https://hc.example.com/ping/abc',
              method: 'post',
              timeoutSeconds: 8,
            },
          },
        },
      },
      cwd,
    )
    expect(config.ops.monitor.providers).toEqual(['builtin'])
    expect(config.ops.monitor.heartbeat).toEqual({
      url: 'https://hc.example.com/ping/abc',
      method: 'POST',
      timeoutSeconds: 8,
    })
    expect(resolveConfig({}, cwd).ops.monitor.heartbeat).toEqual({
      url: '',
      method: 'GET',
      timeoutSeconds: 5,
    })
  })

  it('rejects unregistered providers and unsafe heartbeat settings', () => {
    const monitor = (extra: Record<string, unknown>) => ({
      ops: { enabled: true, monitor: { enabled: true, ...extra } },
    })
    expect(() => resolveConfig(monitor({ providers: ['glances'] }), cwd)).toThrow(
      '未登记的监控提供方',
    )
    expect(() => resolveConfig(monitor({ providers: [] }), cwd)).toThrow('至少需要一个监控提供方')
    expect(() => resolveConfig(monitor({ providers: ['builtin', 'builtin'] }), cwd)).toThrow('重复')
    expect(() => resolveConfig(monitor({ providers: 'builtin' as never }), cwd)).toThrow(
      '必须是字符串数组',
    )
    expect(() => resolveConfig(monitor({ heartbeat: { method: 'PUT' } }), cwd)).toThrow(
      '只能是 GET 或 POST',
    )
    expect(() => resolveConfig(monitor({ heartbeat: { timeoutSeconds: 60 } }), cwd)).toThrow(
      '不能大于 30 秒',
    )
    expect(() => resolveConfig(monitor({ heartbeat: { url: 'ftp://host/ping' } }), cwd)).toThrow(
      '只接受 http(s) URL',
    )
  })

  it('ships a minimal example config that loads as-is', () => {
    const raw: RawConfig = JSON.parse(
      readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'),
    )
    const config = resolveConfig(raw, cwd)
    expect(config.ops.enabled).toBe(true)
    expect(config.ops.monitor.enabled).toBe(true)
    expect(config.ops.monitor.providers).toEqual(['builtin'])
    expect(config.ops.monitor.heartbeat.url).toBe('')
    expect(config.ops.alerts.webhook).toBe('')
    expect(config.ops.checks.map((check) => check.id)).toEqual(['host-http'])
  })
})
