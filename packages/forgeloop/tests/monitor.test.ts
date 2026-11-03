import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, type ForgeLoopConfig, type RawConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { monitorSignatureOf, parseMonitorReport } from '../src/domain/monitor.js'
import { OPS_PROVIDER_VERSION } from '../src/domain/ops-provider.js'
import { collectMonitorSnapshot } from '../src/runtime/monitor.js'

const psAvailable = (() => {
  try {
    execFileSync('ps', ['-axo', 'pid='], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let dir = ''
let repository: Repository
let servers: Server[] = []
const clock = new Date('2026-11-02T10:00:00.000Z')

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'web-latency',
    resource_id: 'web',
    severity: 'major',
    title: '天工页面响应变慢',
    impact: '用户打开页面需要等待',
    facts: ['健康探测 3 秒未返回'],
    hypotheses: [{ statement: '上游连接池耗尽', confidence: 'medium' }],
    proposed_action: null,
    decision_required: true,
    fix_required: false,
    summary: '页面响应变慢，需要人工确认',
    ...overrides,
  }
}

function report(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'degraded',
    summary: '发现一个缓慢问题',
    issues: [issue()],
    ...overrides,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-monitor-domain-'))
  repository = new Repository(Database.open(join(dir, '.forgeloop', 'records.sqlite')))
})

afterEach(() => {
  repository.close()
  for (const server of servers) server.close()
  servers = []
  rmSync(dir, { recursive: true, force: true })
})

describe('monitor report parsing', () => {
  it('accepts a healthy report without issues', () => {
    const parsed = parseMonitorReport(
      JSON.stringify({ status: 'healthy', summary: '各项指标正常', issues: [] }),
    )
    expect(parsed.status).toBe('healthy')
    expect(parsed.issues).toEqual([])
  })

  it('accepts a degraded issue and keeps the diagnosis fields', () => {
    const parsed = parseMonitorReport(report())
    expect(parsed.status).toBe('degraded')
    expect(parsed.issues[0]?.key).toBe('web-latency')
    expect(parsed.issues[0]?.resourceId).toBe('web')
    expect(parsed.issues[0]?.alert).toBe(true)
    expect(parsed.issues[0]?.facts).toEqual(['健康探测 3 秒未返回'])
    expect(parsed.issues[0]?.decisionRequired).toBe(true)
  })

  it('derives the alert default from severity but accepts an explicit flag', () => {
    const minor = parseMonitorReport(
      report({ issues: [issue({ severity: 'minor', decision_required: false })] }),
    )
    expect(minor.issues[0]?.alert).toBe(false)
    const explicit = parseMonitorReport(report({ issues: [issue({ alert: false })] }))
    expect(explicit.issues[0]?.alert).toBe(false)
  })

  it('requires status and issues to agree', () => {
    expect(() => parseMonitorReport(report({ status: 'healthy' }))).toThrow('healthy 时不能带问题')
    expect(() => parseMonitorReport(report({ status: 'degraded', issues: [] }))).toThrow(
      '至少需要一条问题',
    )
    expect(() =>
      parseMonitorReport(report({ status: 'degraded', issues: [issue({ severity: 'critical' })] })),
    ).toThrow('degraded 时不能包含严重问题')
    expect(() =>
      parseMonitorReport(report({ status: 'critical', issues: [issue({ severity: 'major' })] })),
    ).toThrow('至少要有一条严重问题')
  })

  it('rejects malformed keys, unknown resources, severities and missing diagnosis fields', () => {
    expect(() => parseMonitorReport(report({ issues: [issue({ key: 'Web Latency' })] }))).toThrow(
      '小写字母开头',
    )
    expect(() => parseMonitorReport(report({ issues: [issue({ resource_id: '' })] }))).toThrow(
      'resource_id必须是非空字符串',
    )
    expect(() => parseMonitorReport(report({ issues: [issue({ severity: 'fatal' })] }))).toThrow(
      'severity 必须是',
    )
    expect(() =>
      parseMonitorReport(report({ issues: [issue({ decision_required: undefined })] })),
    ).toThrow('decision_required')
    expect(() => parseMonitorReport('不是 JSON')).toThrow()
    expect(() => parseMonitorReport(report({ status: 'unknown' }))).toThrow('status 必须是')
    expect(() => parseMonitorReport(report({ issues: [issue({ alert: 'yes' })] }))).toThrow(
      'alert 必须是布尔值',
    )
    expect(() =>
      parseMonitorReport(report({ issues: [issue({ impact: '长'.repeat(1001) })] })),
    ).toThrow('影响超过 1000')
    expect(() =>
      parseMonitorReport(
        report({ issues: [issue({ facts: Array.from({ length: 21 }, () => '事实') })] }),
      ),
    ).toThrow('事实超过 20 条')
  })

  it('bounds the report and rejects an inconsistent array', () => {
    const eleven = Array.from({ length: 11 }, (_, index) =>
      issue({ key: `problem-${index}`, title: `问题 ${index}` }),
    )
    expect(() => parseMonitorReport(report({ issues: eleven }))).toThrow('超过 10 条')
    expect(() => parseMonitorReport(report({ issues: {} }))).toThrow('issues 必须是数组')
    expect(() =>
      parseMonitorReport(report({ issues: [issue({ title: '长'.repeat(201) })] })),
    ).toThrow('超过 200 字符上限')
  })

  it('builds a stable signature from resource and key', () => {
    expect(monitorSignatureOf('web', 'web-latency')).toBe('monitor/web/web-latency')
  })
})

type RawOps = NonNullable<RawConfig['ops']>

function collectorConfig(
  monitor: NonNullable<RawOps['monitor']>,
  catalog: Omit<RawOps, 'monitor'> = {},
): ForgeLoopConfig {
  const raw: RawConfig = {
    project: 'forgeloop',
    ops: {
      enabled: true,
      ...catalog,
      monitor: { enabled: true, intervalSeconds: 60, logLines: 20, ...monitor },
    },
  }
  return resolveConfig(raw, dir)
}

async function listen(
  handler: (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) => void,
): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
  return `http://127.0.0.1:${address.port}/health`
}

describe('monitor snapshot collection', () => {
  it.skipIf(!psAvailable)(
    'collects host metrics, process aggregates, latency and registered sources',
    async () => {
      const url = await listen((_request, response) => {
        response.writeHead(200)
        response.end('ok')
      })
      writeFileSync(join(dir, 'app.log'), 'INFO start\nERROR boom\nWARN slow\nERROR again\n')
      writeFileSync(
        join(dir, 'alerts.json'),
        JSON.stringify([
          {
            severity: 'critical',
            summary: '磁盘已满',
            resourceId: 'web',
            at: '2026-11-02T09:00:00Z',
          },
          { severity: 'unknown', summary: '队列积压' },
        ]),
      )
      const config = collectorConfig(
        {
          processes: [{ id: 'node', resourceId: 'web', match: 'node' }],
          latency: [{ id: 'web-health-url', resourceId: 'web', url, timeoutSeconds: 2 }],
          logs: [{ id: 'app', resourceId: 'web', path: 'app.log', errorPattern: 'ERROR' }],
          alertFiles: [{ id: 'external', path: 'alerts.json' }],
        },
        {
          resources: [{ id: 'web', kind: 'app', label: '天工页面' }],
          checks: [
            { id: 'web-health', resourceId: 'web', command: ['node', '-e', 'process.exit(0)'] },
          ],
        },
      )
      repository.setMeta(
        'ops_check_last:web-health',
        JSON.stringify({
          at: clock.toISOString(),
          code: 1,
          timedOut: false,
          aborted: false,
          output: 'boom',
        }),
      )
      repository.createOpsEvent({
        eventId: 'ops-existing',
        project: config.project,
        resourceId: 'web',
        checkId: 'web-health',
        signature: 'web/web-health/1/x',
        severity: 'major',
        state: 'open',
        title: '已有事件',
        openedAt: clock.toISOString(),
        updatedAt: clock.toISOString(),
      })

      const snapshot = await collectMonitorSnapshot({ config, repo: repository, now: clock })
      expect(snapshot.at).toBe(clock.toISOString())
      expect(snapshot.host.cpuPercent).toBeGreaterThanOrEqual(0)
      expect(snapshot.host.memoryUsedPercent).toBeGreaterThan(0)
      expect(snapshot.processes[0]?.count).toBeGreaterThan(0)
      expect(snapshot.latency[0]?.ok).toBe(true)
      expect(snapshot.latency[0]?.status).toBe(200)
      expect(snapshot.logs[0]?.matches).toBe(2)
      expect(snapshot.logs[0]?.samples).toHaveLength(2)
      expect(snapshot.logs[0]?.tail).toContain('ERROR again')
      expect(snapshot.alerts).toHaveLength(2)
      expect(snapshot.alerts[1]?.severity).toBe('major')
      expect(snapshot.checks[0]?.output).toBe('boom')
      expect(snapshot.events.map((event) => event.eventId)).toEqual(['ops-existing'])
      expect(snapshot.errors).toEqual([])
    },
  )

  it('records unreachable latency, missing logs and malformed alert files without throwing', async () => {
    writeFileSync(join(dir, 'broken.json'), 'not-json')
    const config = collectorConfig(
      {
        latency: [
          { id: 'closed', resourceId: 'web', url: 'http://127.0.0.1:1/health', timeoutSeconds: 1 },
        ],
        logs: [{ id: 'missing', resourceId: 'web', path: 'missing.log', errorPattern: 'ERROR' }],
        alertFiles: [{ id: 'broken', path: 'broken.json' }],
      },
      { resources: [{ id: 'web', kind: 'app', label: '天工页面' }] },
    )

    const snapshot = await collectMonitorSnapshot({ config, repo: repository, now: clock })
    expect(snapshot.latency[0]?.ok).toBe(false)
    expect(snapshot.latency[0]?.error).not.toBe('')
    expect(snapshot.logs[0]?.error).not.toBe('')
    expect(snapshot.logs[0]?.tail).toEqual([])
    expect(snapshot.alertFiles[0]?.error).not.toBe('')
    expect(snapshot.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('handles empty and truncated logs, alert caps and malformed check status', async () => {
    writeFileSync(join(dir, 'empty.log'), '')
    writeFileSync(join(dir, 'big.log'), `${'x'.repeat(70 * 1024)}\nERROR tail\n`)
    const many: Array<Record<string, unknown>> = Array.from({ length: 25 }, (_, index) => ({
      severity: 'major',
      summary: `告警 ${index}`,
    }))
    many.push({ severity: 'minor' })
    writeFileSync(join(dir, 'many.json'), JSON.stringify(many))
    writeFileSync(join(dir, 'object.json'), '{}')
    writeFileSync(join(dir, 'huge.json'), JSON.stringify([{ summary: 'x'.repeat(70 * 1024) }]))
    const config = collectorConfig(
      {
        logLines: 5,
        logs: [
          { id: 'empty', resourceId: 'web', path: 'empty.log', errorPattern: 'ERROR' },
          { id: 'big', resourceId: 'web', path: 'big.log', errorPattern: 'ERROR' },
        ],
        alertFiles: [
          { id: 'many', path: 'many.json' },
          { id: 'object', path: 'object.json' },
          { id: 'huge', path: 'huge.json' },
        ],
      },
      {
        resources: [{ id: 'web', kind: 'app', label: '天工页面' }],
        checks: [
          { id: 'web-health', resourceId: 'web', command: ['node', '-e', 'process.exit(0)'] },
        ],
      },
    )
    repository.setMeta('ops_check_last:web-health', '{bad')

    const snapshot = await collectMonitorSnapshot({ config, repo: repository, now: clock })
    expect(snapshot.logs.find((log) => log.id === 'empty')?.lines).toBe(0)
    const big = snapshot.logs.find((log) => log.id === 'big')
    expect(big?.matches).toBe(1)
    expect(big?.tail).toContain('ERROR tail')
    expect(snapshot.alerts).toHaveLength(20)
    expect(snapshot.alertFiles.find((file) => file.id === 'many')?.count).toBe(20)
    expect(snapshot.alertFiles.find((file) => file.id === 'object')?.error).toContain('数组')
    expect(snapshot.alertFiles.find((file) => file.id === 'huge')?.error).toContain('超过')
    expect(snapshot.checks).toEqual([])
    expect(snapshot.errors.some((error) => error.includes('最后状态不可读'))).toBe(true)
  })

  it('skips malformed alert entries and truncates oversized summaries', async () => {
    writeFileSync(
      join(dir, 'entries.json'),
      JSON.stringify([
        null,
        42,
        {},
        { summary: 42 },
        { summary: '   ' },
        { summary: '长'.repeat(1000) },
      ]),
    )
    const config = collectorConfig({ alertFiles: [{ id: 'entries', path: 'entries.json' }] })

    const snapshot = await collectMonitorSnapshot({ config, repo: repository, now: clock })
    expect(snapshot.alerts).toHaveLength(1)
    expect(snapshot.alerts[0]).toMatchObject({
      source: 'entries',
      severity: 'major',
      at: '',
      resourceId: '',
    })
    expect(snapshot.alerts[0]?.summary).toHaveLength(301)
    expect(snapshot.alerts[0]?.summary.endsWith('…')).toBe(true)
    expect(snapshot.alertFiles[0]).toMatchObject({ id: 'entries', count: 1, error: '' })
  })

  it('records a process collection error when ps cannot run', async () => {
    const config = collectorConfig(
      { processes: [{ id: 'node', resourceId: 'web', match: 'node' }] },
      { resources: [{ id: 'web', kind: 'app', label: '天工页面' }] },
    )
    const previous = process.env.PATH
    process.env.PATH = ''
    try {
      const snapshot = await collectMonitorSnapshot({ config, repo: repository, now: clock })
      expect(snapshot.processes[0]?.error).not.toBe('')
      expect(snapshot.errors.some((error) => error.includes('进程采集失败'))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
    }
  })

  it('returns a bounded cancelled snapshot when the host already aborted', async () => {
    const config = collectorConfig(
      { logs: [{ id: 'app', resourceId: 'web', path: 'app.log', errorPattern: 'ERROR' }] },
      { resources: [{ id: 'web', kind: 'app', label: '天工页面' }] },
    )
    const snapshot = await collectMonitorSnapshot({
      config,
      repo: repository,
      now: clock,
      signal: AbortSignal.abort(),
    })
    expect(snapshot.errors).toEqual(['采集已取消'])
    expect(snapshot.logs).toEqual([])
  })

  it('uses a caller signal for latency and ignores a body that cannot be cancelled', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
      expect(init.signal).toBeDefined()
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            throw new Error('cancel failed')
          },
        }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const config = collectorConfig(
        {
          latency: [
            {
              id: 'web-health-url',
              resourceId: 'web',
              url: 'http://example.test/health',
              timeoutSeconds: 1,
            },
          ],
        },
        { resources: [{ id: 'web', kind: 'app', label: '天工页面' }] },
      )
      const snapshot = await collectMonitorSnapshot({
        config,
        repo: repository,
        now: clock,
        signal: new AbortController().signal,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(snapshot.latency[0]).toMatchObject({ ok: true, status: 200 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('records which monitoring provider produced the snapshot', async () => {
    const config = collectorConfig()
    const snapshot = await collectMonitorSnapshot({ config, repo: repository, now: clock })
    expect(snapshot.providers).toEqual([
      { id: 'builtin', kind: 'builtin', version: OPS_PROVIDER_VERSION },
    ])
    const aborted = await collectMonitorSnapshot({
      config,
      repo: repository,
      now: clock,
      signal: AbortSignal.abort(),
    })
    expect(aborted.providers).toEqual(snapshot.providers)
  })

  it('reports a provider it cannot resolve instead of inventing facts', async () => {
    const config = collectorConfig()
    const forged: ForgeLoopConfig = {
      ...config,
      ops: {
        ...config.ops,
        monitor: { ...config.ops.monitor, providers: ['glances'] },
      },
    }
    const snapshot = await collectMonitorSnapshot({ config: forged, repo: repository, now: clock })
    expect(snapshot.providers).toEqual([])
    expect(snapshot.errors).toContain('监控提供方 glances 未登记')
    expect(snapshot.errors).toContain('没有可用的监控提供方')
    expect(snapshot.host.cpuPercent).toBe(0)
    expect(snapshot.processes).toEqual([])
  })
})
