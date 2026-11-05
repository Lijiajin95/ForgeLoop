import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, type ForgeLoopConfig, type RawConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { collectMonitorSnapshot } from '../src/runtime/monitor.js'
import { OPS_CLOSED } from '../src/domain/ops.js'

/**
 * 监控采集器的封闭测试：主机、进程、延迟、告警与检查全部用固定输入驱动，
 * 不读取宿主真实进程表或网络。它固定“采集失败只记录、不中断整轮”的边界，
 * 并让 monitor.ts 的异常分支在变异测试里可被杀伤。
 */

const control = vi.hoisted(() => ({
  cpuSamples: [] as Array<Array<{ times: Record<string, number> }>>,
  cpuCalls: 0,
  totalMem: 0,
  freeMem: 0,
  load: [0, 0, 0] as number[],
  uptime: 0,
  psTable: '',
  psError: null as Error | null,
  execThrows: false,
  execCalls: 0,
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    cpus: () => {
      const sample = control.cpuSamples[Math.min(control.cpuCalls, control.cpuSamples.length - 1)]
      control.cpuCalls += 1
      return (sample ?? [{ times: { idle: 0, user: 0 } }]) as unknown as ReturnType<
        typeof actual.cpus
      >
    },
    totalmem: () => control.totalMem,
    freemem: () => control.freeMem,
    loadavg: () => control.load,
    uptime: () => control.uptime,
  }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      control.execCalls += 1
      if (control.execThrows) throw new Error('spawn EPERM')
      if (control.psError) callback(control.psError, '')
      else callback(null, control.psTable)
    },
  }
})

const clock = new Date('2026-11-04T00:00:00.000Z')
const PROJECT = 'forgeloop'

let dir = ''
let repository: Repository

type RawOps = NonNullable<RawConfig['ops']>

function collectorConfig(
  monitor: NonNullable<RawOps['monitor']>,
  catalog: Omit<RawOps, 'monitor'> = {},
): ForgeLoopConfig {
  const raw: RawConfig = {
    project: PROJECT,
    ops: {
      enabled: true,
      resources: [{ id: 'web', kind: 'app', label: '页面' }],
      ...catalog,
      monitor: { enabled: true, intervalSeconds: 60, logLines: 20, ...monitor },
    },
  }
  return resolveConfig(raw, dir)
}

function resetHost(): void {
  control.cpuSamples = [
    [{ times: { idle: 1000, user: 500 } }, { times: { idle: 500, user: 1000 } }],
    [{ times: { idle: 1100, user: 800 } }, { times: { idle: 500, user: 1000 } }],
  ]
  control.cpuCalls = 0
  control.totalMem = 1000
  control.freeMem = 250
  control.load = [1.24, 2.25, 3.06]
  control.uptime = 12345.6
  control.psTable = ''
  control.psError = null
  control.execThrows = false
  control.execCalls = 0
}

async function snapshot(
  config: ForgeLoopConfig,
  input: { signal?: AbortSignal } = {},
): Promise<Awaited<ReturnType<typeof collectMonitorSnapshot>>> {
  return collectMonitorSnapshot({
    config,
    repo: repository,
    now: clock,
    ...(input.signal ? { signal: input.signal } : {}),
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-monitor-hermetic-'))
  repository = new Repository(Database.open(join(dir, 'records.sqlite')))
  resetHost()
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('host facts', () => {
  it('computes CPU, load, memory and uptime from the fixed sample', async () => {
    const result = await snapshot(collectorConfig({}))
    expect(result.host).toEqual({
      load1: 1.2,
      load5: 2.3,
      load15: 3.1,
      cpuCount: 2,
      cpuPercent: 75,
      memoryTotalBytes: 1000,
      memoryFreeBytes: 250,
      memoryUsedPercent: 75,
      uptimeSeconds: 12346,
    })
  })

  it('falls back to cumulative CPU when the sample window does not advance', async () => {
    const sameSample = [{ times: { idle: 1000, user: 3000 } }]
    control.cpuSamples = [sameSample, sameSample]
    const cumulative = await snapshot(collectorConfig({}))
    expect(cumulative.host.cpuPercent).toBe(75)

    control.cpuCalls = 0
    control.cpuSamples = [[{ times: { idle: 0, user: 0 } }], [{ times: { idle: 0, user: 0 } }]]
    const idle = await snapshot(collectorConfig({}))
    expect(idle.host.cpuPercent).toBe(0)
  })

  it('clamps a negative busy ratio to zero and rounds memory for an empty host', async () => {
    control.cpuSamples = [
      [{ times: { idle: 100, user: 100 } }],
      [{ times: { idle: 400, user: 0 } }],
    ]
    const clamped = await snapshot(collectorConfig({}))
    expect(clamped.host.cpuPercent).toBe(0)

    control.cpuCalls = 0
    control.totalMem = 0
    control.freeMem = 0
    const empty = await snapshot(collectorConfig({}))
    expect(empty.host.memoryUsedPercent).toBe(0)
  })
})

describe('process facts', () => {
  it('parses well-formed ps rows, matches case-insensitively and ignores junk', async () => {
    control.psTable = [
      '  123  2.5  1024 node app.js',
      '  456  0.5  512 Node worker',
      '  789  1.5   256 postgres',
      'not a process row',
      '  111  abc    12 node broken',
      '  222  1.0     0 ',
    ].join('\n')
    const config = collectorConfig({
      processes: [
        { id: 'node', resourceId: 'web', match: 'node' },
        { id: 'db', resourceId: 'web', match: 'POSTGRES' },
        { id: 'none', resourceId: 'web', match: 'nginx' },
      ],
    })
    const result = await snapshot(config)
    expect(result.processes).toEqual([
      {
        id: 'node',
        resourceId: 'web',
        match: 'node',
        count: 2,
        cpuPercent: 3,
        rssBytes: (1024 + 512) * 1024,
        error: '',
      },
      {
        id: 'db',
        resourceId: 'web',
        match: 'POSTGRES',
        count: 1,
        cpuPercent: 1.5,
        rssBytes: 256 * 1024,
        error: '',
      },
      {
        id: 'none',
        resourceId: 'web',
        match: 'nginx',
        count: 0,
        cpuPercent: 0,
        rssBytes: 0,
        error: '',
      },
    ])
    expect(result.errors).toEqual([])
  })

  it('records a process table error on every source', async () => {
    control.psError = new Error('ps down')
    const result = await snapshot(
      collectorConfig({
        processes: [
          { id: 'a', resourceId: 'web', match: 'node' },
          { id: 'b', resourceId: 'web', match: 'postgres' },
        ],
      }),
    )
    expect(result.processes.map((process) => process.error)).toEqual(['ps down', 'ps down'])
    expect(result.processes.map((process) => process.count)).toEqual([0, 0])
    expect(result.errors).toEqual(['进程采集失败：ps down'])
  })

  it('degrades to an empty table when spawn itself is denied', async () => {
    control.execThrows = true
    const result = await snapshot(
      collectorConfig({ processes: [{ id: 'a', resourceId: 'web', match: 'node' }] }),
    )
    expect(result.processes[0]?.error).toBe('spawn EPERM')
    expect(result.errors).toEqual(['进程采集失败：spawn EPERM'])
  })

  it('rejects rows whose numbers are not finite', async () => {
    control.psTable = [
      '  1  1..2  10 node broken-cpu',
      `  2  1.0  ${'9'.repeat(400)} node broken-rss`,
      '  3  0.5  2048 node ok',
    ].join('\n')
    const result = await snapshot(
      collectorConfig({ processes: [{ id: 'a', resourceId: 'web', match: 'node' }] }),
    )
    expect(result.processes[0]).toMatchObject({ count: 1, cpuPercent: 0.5, rssBytes: 2048 * 1024 })
  })

  it('bounds a process table message at exactly 300 characters', async () => {
    control.psError = new Error('e'.repeat(300))
    const result = await snapshot(
      collectorConfig({ processes: [{ id: 'a', resourceId: 'web', match: 'node' }] }),
    )
    expect(result.processes[0]?.error).toHaveLength(300)
    expect(result.processes[0]?.error.endsWith('…')).toBe(false)
  })

  it('leaves an absolute process error untouched by project-relative resolution', async () => {
    control.psError = new Error('absolute')
    const result = await snapshot(
      collectorConfig({ processes: [{ id: 'a', resourceId: 'web', match: 'node' }] }),
    )
    expect(result.processes[0]?.error).toBe('absolute')
  })

  it('does not run ps when no process source is configured', async () => {
    const result = await snapshot(collectorConfig({}))
    expect(result.processes).toEqual([])
    expect(control.execCalls).toBe(0)
  })
})

describe('latency probes', () => {
  it('records status and cancels the response body', async () => {
    vi.stubGlobal('fetch', async () => new Response('ok', { status: 200 }))
    const config = collectorConfig({
      latency: [
        { id: 'health', resourceId: 'web', url: 'http://example.test/health', timeoutSeconds: 2 },
      ],
    })
    const result = await snapshot(config)
    expect(result.latency[0]).toEqual({
      id: 'health',
      resourceId: 'web',
      url: 'http://example.test/health',
      ok: true,
      status: 200,
      ms: expect.any(Number),
      error: '',
    })
    expect(result.errors).toEqual([])
  })

  it('accepts a probe response without a body', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }))
    const result = await snapshot(
      collectorConfig({
        latency: [
          { id: 'health', resourceId: 'web', url: 'http://example.test', timeoutSeconds: 1 },
        ],
      }),
    )
    expect(result.latency[0]).toMatchObject({ ok: true, status: 204, error: '' })
    expect(result.errors).toEqual([])
  })

  it('keeps a non-2xx probe as ok=false without inventing an error message', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }))
    const result = await snapshot(
      collectorConfig({
        latency: [
          { id: 'health', resourceId: 'web', url: 'http://example.test/health', timeoutSeconds: 2 },
        ],
      }),
    )
    expect(result.latency[0]).toMatchObject({ ok: false, status: 503, error: '' })
    expect(result.errors).toEqual([])
  })

  it('records a thrown probe as a bounded error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('  boom \n now ')
    })
    const result = await snapshot(
      collectorConfig({
        latency: [
          { id: 'health', resourceId: 'web', url: 'http://example.test/health', timeoutSeconds: 2 },
        ],
      }),
    )
    expect(result.latency[0]).toMatchObject({ ok: false, status: 0, error: 'boom now' })
    expect(result.errors).toEqual(['延迟探测 health 失败：boom now'])
  })

  it('ignores a body that cannot be cancelled', async () => {
    vi.stubGlobal('fetch', async () => {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          throw new Error('cancel failed')
        },
      })
      return new Response(body, { status: 200 })
    })
    const result = await snapshot(
      collectorConfig({
        latency: [
          { id: 'health', resourceId: 'web', url: 'http://example.test', timeoutSeconds: 1 },
        ],
      }),
    )
    expect(result.latency[0]?.ok).toBe(true)
    expect(result.errors).toEqual([])
  })
})

describe('log facts', () => {
  it('reads a bounded tail, counts matches and bounds long lines', async () => {
    mkdirSync(join(dir, 'logs'), { recursive: true })
    writeFileSync(
      join(dir, 'logs', 'app.log'),
      ['INFO start', 'ERROR bad', '', 'ERROR worse', `${'x'.repeat(600)}`].join('\n'),
    )
    const config = collectorConfig({
      logLines: 2,
      logs: [{ id: 'app', resourceId: 'web', path: 'logs/app.log', errorPattern: 'ERROR' }],
    })
    const result = await snapshot(config)
    const log = result.logs[0]
    expect(log?.path).toBe(join(dir, 'logs', 'app.log'))
    expect(log?.lines).toBe(2)
    expect(log?.matches).toBe(2)
    expect(log?.samples).toEqual(['ERROR bad', 'ERROR worse'])
    expect(log?.tail).toHaveLength(2)
    expect(log?.error).toBe('')
  })

  it('truncates oversized matched lines and tails in the snapshot', async () => {
    const longLine = `ERROR ${'y'.repeat(600)}`
    writeFileSync(join(dir, 'big.log'), `${longLine}\n`)
    const result = await snapshot(
      collectorConfig({
        logs: [{ id: 'app', resourceId: 'web', path: 'big.log', errorPattern: 'ERROR' }],
      }),
    )
    const log = result.logs[0]
    expect(log?.samples[0]).toHaveLength(501)
    expect(log?.samples[0]?.endsWith('…')).toBe(true)
    expect(log?.tail[0]).toHaveLength(501)
  })

  it('caps matched samples at three while counting every match', async () => {
    writeFileSync(
      join(dir, 'many.log'),
      ['ERROR one', 'ERROR two', 'ERROR three', 'ERROR four'].join('\n'),
    )
    const result = await snapshot(
      collectorConfig({
        logs: [{ id: 'app', resourceId: 'web', path: 'many.log', errorPattern: 'ERROR' }],
      }),
    )
    expect(result.logs[0]?.matches).toBe(4)
    expect(result.logs[0]?.samples).toEqual(['ERROR one', 'ERROR two', 'ERROR three'])
  })

  it('returns empty facts for an unreadable absolute log path', async () => {
    const missing = join(dir, 'missing.log')
    const result = await snapshot(
      collectorConfig({
        logs: [{ id: 'missing', resourceId: 'web', path: missing, errorPattern: 'ERROR' }],
      }),
    )
    expect(result.logs[0]).toEqual({
      id: 'missing',
      resourceId: 'web',
      path: missing,
      lines: 0,
      matches: 0,
      samples: [],
      tail: [],
      error: expect.stringContaining('ENOENT'),
    })
  })

  it('reports missing files and invalid patterns without failing the round', async () => {
    const base = collectorConfig({
      logs: [{ id: 'missing', resourceId: 'web', path: 'logs/missing.log', errorPattern: 'ERROR' }],
    })
    const forged: ForgeLoopConfig = {
      ...base,
      ops: {
        ...base.ops,
        monitor: {
          ...base.ops.monitor,
          logs: [
            { id: 'missing', resourceId: 'web', path: 'logs/missing.log', errorPattern: 'ERROR' },
            { id: 'bad-pattern', resourceId: 'web', path: 'logs/missing.log', errorPattern: '[' },
          ],
        },
      },
    }
    const result = await snapshot(forged)
    expect(result.logs[0]?.error).toContain('ENOENT')
    expect(result.logs[1]?.error).not.toBe('')
    expect(result.errors[0]).toContain('日志 missing 不可读：')
    expect(result.errors[1]).toContain('日志 bad-pattern 不可读：')
  })
})

describe('alert files', () => {
  it('parses alerts, defaults severity and truncates oversized summaries', async () => {
    writeFileSync(
      join(dir, 'alerts.json'),
      JSON.stringify([
        {
          severity: 'critical',
          summary: '  磁盘已满  ',
          resourceId: 'web',
          at: '2026-11-04T00:00:00Z',
        },
        { severity: 'fatal', summary: '队列积压' },
        null,
        42,
        {},
        { summary: 42 },
        { summary: '   ' },
        { summary: 'z'.repeat(400) },
      ]),
    )
    const result = await snapshot(
      collectorConfig({ alertFiles: [{ id: 'external', path: 'alerts.json' }] }),
    )
    expect(result.alerts).toHaveLength(3)
    expect(result.alerts[0]).toEqual({
      source: 'external',
      severity: 'critical',
      summary: '磁盘已满',
      at: '2026-11-04T00:00:00Z',
      resourceId: 'web',
    })
    expect(result.alerts[1]).toMatchObject({ severity: 'major', at: '', resourceId: '' })
    expect(result.alerts[2]?.summary).toHaveLength(301)
    expect(result.alerts[2]?.summary.endsWith('…')).toBe(true)
    expect(result.alertFiles[0]).toMatchObject({ id: 'external', count: 3, error: '' })
    expect(result.errors).toEqual([])
  })

  it('caps alerts across files and reports the remaining count as zero', async () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      severity: 'major',
      summary: `告警 ${index}`,
    }))
    writeFileSync(join(dir, 'many.json'), JSON.stringify(many))
    writeFileSync(join(dir, 'more.json'), JSON.stringify(many.slice(0, 5)))
    const result = await snapshot(
      collectorConfig({
        alertFiles: [
          { id: 'many', path: 'many.json' },
          { id: 'more', path: 'more.json' },
        ],
      }),
    )
    expect(result.alerts).toHaveLength(20)
    expect(result.alertFiles).toEqual([
      { id: 'many', path: join(dir, 'many.json'), count: 20, error: '' },
      { id: 'more', path: join(dir, 'more.json'), count: 0, error: '' },
    ])
  })

  it('keeps known severities and defaults unknown ones to major', async () => {
    writeFileSync(
      join(dir, 'severity.json'),
      JSON.stringify([
        { severity: 'minor', summary: '轻微' },
        { severity: 'major', summary: '重要' },
        { severity: 'critical', summary: '严重' },
        { severity: 7, summary: '未知' },
        { severity: 'fatal', summary: '不支持' },
      ]),
    )
    const result = await snapshot(
      collectorConfig({ alertFiles: [{ id: 'severity', path: 'severity.json' }] }),
    )
    expect(result.alerts.map((alert) => alert.severity)).toEqual([
      'minor',
      'major',
      'critical',
      'major',
      'major',
    ])
  })

  it('reports unreadable, non-array and oversized alert files', async () => {
    writeFileSync(join(dir, 'object.json'), '{}')
    writeFileSync(join(dir, 'broken.json'), 'not-json')
    writeFileSync(join(dir, 'huge.json'), JSON.stringify([{ summary: 'x'.repeat(70 * 1024) }]))
    const result = await snapshot(
      collectorConfig({
        alertFiles: [
          { id: 'missing', path: 'missing.json' },
          { id: 'object', path: 'object.json' },
          { id: 'broken', path: 'broken.json' },
          { id: 'huge', path: 'huge.json' },
        ],
      }),
    )
    expect(result.alerts).toEqual([])
    expect(result.alertFiles.map((file) => file.count)).toEqual([0, 0, 0, 0])
    expect(result.alertFiles[0]?.error).toContain('ENOENT')
    expect(result.alertFiles[1]?.error).toContain('数组')
    expect(result.alertFiles[2]?.error).not.toBe('')
    expect(result.alertFiles[3]?.error).toContain('超过')
    expect(result.errors).toHaveLength(4)
  })
})

describe('check and event facts', () => {
  it('exposes the last check state with bounded output and strict flags', async () => {
    repository.setMeta(
      'ops_check_last:web-health',
      JSON.stringify({
        at: '2026-11-04T00:00:00Z',
        code: 3,
        timedOut: true,
        aborted: false,
        output: 'o'.repeat(600),
      }),
    )
    const result = await snapshot(
      collectorConfig(
        {},
        {
          checks: [
            { id: 'web-health', resourceId: 'web', command: ['node', '-e', 'process.exit(0)'] },
          ],
        },
      ),
    )
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]).toMatchObject({
      checkId: 'web-health',
      resourceId: 'web',
      at: '2026-11-04T00:00:00Z',
      code: 3,
      timedOut: true,
      aborted: false,
    })
    expect(result.checks[0]?.output).toHaveLength(501)
    expect(result.checks[0]?.output.endsWith('…')).toBe(true)
  })

  it('reports malformed last check state but keeps the snapshot', async () => {
    repository.setMeta('ops_check_last:web-health', '{bad')
    const malformed = await snapshot(
      collectorConfig(
        {},
        {
          checks: [
            { id: 'web-health', resourceId: 'web', command: ['node', '-e', 'process.exit(0)'] },
          ],
        },
      ),
    )
    expect(malformed.checks).toEqual([])
    expect(malformed.errors).toEqual([
      expect.stringContaining('检查 web-health 的最后状态不可读：'),
    ])

    repository.setMeta('ops_check_last:web-health', '[]')
    const nonObject = await snapshot(
      collectorConfig(
        {},
        {
          checks: [
            { id: 'web-health', resourceId: 'web', command: ['node', '-e', 'process.exit(0)'] },
          ],
        },
      ),
    )
    expect(nonObject.checks).toEqual([])
    expect(nonObject.errors[0]).toContain('最后状态不是对象')
  })

  it('defaults optional check fields when their types disagree', async () => {
    repository.setMeta(
      'ops_check_last:web-health',
      JSON.stringify({ at: 1, code: '3', timedOut: 'yes', aborted: 0, output: 42 }),
    )
    const result = await snapshot(
      collectorConfig(
        {},
        {
          checks: [
            { id: 'web-health', resourceId: 'web', command: ['node', '-e', 'process.exit(0)'] },
          ],
        },
      ),
    )
    expect(result.checks).toEqual([
      {
        checkId: 'web-health',
        resourceId: 'web',
        at: '',
        code: null,
        timedOut: false,
        aborted: false,
        output: '',
      },
    ])
  })

  it('returns only active events and maps their identity fields', async () => {
    const at = clock.toISOString()
    const states = ['open', 'diagnosed', 'awaiting_decision', 'recovering', OPS_CLOSED]
    for (const [index, state] of states.entries()) {
      repository.createOpsEvent({
        eventId: `evt-${index}`,
        project: PROJECT,
        resourceId: 'web',
        checkId: 'web-health',
        signature: `sig-${index}`,
        severity: 'major',
        state,
        title: `事件 ${index}`,
        openedAt: new Date(clock.getTime() + index * 1000).toISOString(),
        updatedAt: at,
      })
    }
    const result = await snapshot(collectorConfig({}))
    expect(result.events.map((event) => event.eventId)).toEqual([
      'evt-3',
      'evt-2',
      'evt-1',
      'evt-0',
    ])
    expect(result.events[0]).toEqual({
      eventId: 'evt-3',
      resourceId: 'web',
      checkId: 'web-health',
      severity: 'major',
      state: 'recovering',
      title: '事件 3',
      signature: 'sig-3',
      openedAt: new Date(clock.getTime() + 3000).toISOString(),
    })
  })
})

describe('snapshot composition', () => {
  it('returns the bounded cancelled snapshot when the host already aborted', async () => {
    const result = await snapshot(collectorConfig({}), { signal: AbortSignal.abort() })
    expect(result).toEqual({
      at: clock.toISOString(),
      project: PROJECT,
      providers: [{ id: 'builtin', kind: 'builtin', version: expect.any(String) }],
      host: {
        load1: 0,
        load5: 0,
        load15: 0,
        cpuCount: 0,
        cpuPercent: 0,
        memoryTotalBytes: 0,
        memoryFreeBytes: 0,
        memoryUsedPercent: 0,
        uptimeSeconds: 0,
      },
      processes: [],
      latency: [],
      logs: [],
      alertFiles: [],
      alerts: [],
      checks: [],
      events: [],
      errors: ['采集已取消'],
    })
  })

  it('reports an unregistered provider instead of inventing facts', async () => {
    const config = collectorConfig({})
    const forged: ForgeLoopConfig = {
      ...config,
      ops: {
        ...config.ops,
        monitor: { ...config.ops.monitor, providers: ['glances'] },
      },
    }
    const result = await snapshot(forged)
    expect(result.providers).toEqual([])
    expect(result.errors).toEqual(['监控提供方 glances 未登记', '没有可用的监控提供方'])
    expect(result.host.cpuPercent).toBe(0)
  })

  it('falls back to a registered provider later in the list', async () => {
    const config = collectorConfig({})
    const forged: ForgeLoopConfig = {
      ...config,
      ops: {
        ...config.ops,
        monitor: { ...config.ops.monitor, providers: ['glances', 'builtin'] },
      },
    }
    const result = await snapshot(forged)
    expect(result.providers.map((provider) => provider.id)).toEqual(['builtin'])
    expect(result.errors).toEqual(['监控提供方 glances 未登记'])
  })

  it('combines provider errors with check and event facts', async () => {
    writeFileSync(join(dir, 'alerts.json'), '{}')
    repository.setMeta('ops_check_last:web-health', '{bad')
    repository.createOpsEvent({
      eventId: 'evt-open',
      project: PROJECT,
      resourceId: 'web',
      checkId: 'web-health',
      signature: 'sig',
      severity: 'major',
      state: 'open',
      title: '事件',
      openedAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    })
    const result = await snapshot(
      collectorConfig(
        { alertFiles: [{ id: 'external', path: 'alerts.json' }], logs: [] },
        {
          checks: [
            { id: 'web-health', resourceId: 'web', command: ['node', '-e', 'process.exit(0)'] },
          ],
        },
      ),
    )
    expect(result.alertFiles[0]?.error).toContain('数组')
    expect(result.checks).toEqual([])
    expect(result.events.map((event) => event.eventId)).toEqual(['evt-open'])
    expect(result.errors).toHaveLength(2)
  })

  it('keeps at most twenty errors and truncates long messages', async () => {
    control.psError = new Error('p'.repeat(400))
    const alertFiles = Array.from({ length: 21 }, (_, index) => ({
      id: `file-${index}`,
      path: `missing-${index}.json`,
    }))
    const result = await snapshot(
      collectorConfig({
        processes: [{ id: 'web', resourceId: 'web', match: 'node' }],
        alertFiles,
      }),
    )
    expect(result.errors).toHaveLength(20)
    expect(result.errors[0]).toHaveLength(301)
    expect(result.errors[0]?.endsWith('…')).toBe(true)
  })
})
