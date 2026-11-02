import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveConfig,
  type ForgeLoopConfig,
  type RawConfig,
  type RawOpsAction,
  type RawOpsAlertConfig,
  type RawOpsCheck,
  type RawOpsMonitorConfig,
  type RawOpsResource,
} from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { OpsRuntime } from '../src/runtime/ops.js'
import type { AgentLike } from '../src/runtime/service.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { OPS_AWAITING_DECISION, OPS_RECOVERED } from '../src/domain/ops.js'

const PROJECT = 'forgeloop'
let dir = ''
let repository: Repository
let clock = new Date('2026-11-02T10:00:00.000Z')
let server: Server | null = null
let webhookUrl = ''
let latencyUrl = ''
let heartbeatUrl = ''
let heartbeats: string[] = []
let received: Record<string, unknown>[] = []

function result(
  request: AgentRunRequest,
  text: string,
  status: AgentRunResult['status'] = 'completed',
): AgentRunResult {
  return {
    status,
    text,
    sessionId: `session-fake-${request.role}`,
    reason: status === 'completed' ? '' : 'fake failure',
    transcriptPath: request.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  }
}

function runnerOf(handler: (prompt: string) => string): AgentLike & { prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    async run(request) {
      prompts.push(request.prompt)
      return result(request, handler(request.prompt))
    },
  }
}

function diagnosisText(): string {
  return JSON.stringify({
    impact: '检查持续失败',
    facts: ['检查退出码 1'],
    hypotheses: [{ statement: '进程已退出', confidence: 'medium' }],
    proposed_action: { action_id: 'restart-web', params: {} },
    decision_required: false,
    fix_required: false,
    summary: '重启并复核',
  })
}

function monitorText(
  issues: Array<Record<string, unknown>>,
  status = issues.some((item) => item.severity === 'critical') ? 'critical' : 'degraded',
): string {
  return JSON.stringify({
    status: issues.length === 0 ? 'healthy' : status,
    summary: '巡检结论',
    issues,
  })
}

function monitorIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'web-latency',
    resource_id: 'web',
    severity: 'major',
    title: '天工页面响应变慢',
    impact: '用户打开页面需要等待',
    facts: ['健康探测超过 3 秒'],
    hypotheses: [{ statement: '上游连接池耗尽', confidence: 'medium' }],
    proposed_action: { action_id: 'restart-web', params: {} },
    decision_required: false,
    fix_required: false,
    summary: '按登记动作重启 Web 并复核健康检查',
    ...overrides,
  }
}

function opsRaw(
  options: {
    monitor?: RawOpsMonitorConfig
    alerts?: RawOpsAlertConfig
    checkCommand?: string[]
    action?: RawOpsAction
    extraResources?: RawOpsResource[]
    extraChecks?: RawOpsCheck[]
    extraActions?: RawOpsAction[]
  } = {},
): RawConfig {
  const monitor: RawOpsMonitorConfig = options.monitor ?? {
    enabled: true,
    intervalSeconds: 60,
    logLines: 20,
    logs: [{ id: 'app', resourceId: 'web', path: 'app.log', errorPattern: 'ERROR' }],
    latency: [{ id: 'health', resourceId: 'web', url: latencyUrl, timeoutSeconds: 2 }],
    alertFiles: [{ id: 'external', path: 'alerts.json' }],
  }
  return {
    project: PROJECT,
    ops: {
      enabled: true,
      intervalSeconds: 60,
      resources: [{ id: 'web', kind: 'app', label: '天工页面' }, ...(options.extraResources ?? [])],
      checks: [
        {
          id: 'web-health',
          resourceId: 'web',
          command: options.checkCommand ?? ['node', '-e', 'process.exit(0)'],
          timeoutSeconds: 10,
          severity: 'major',
        },
        ...(options.extraChecks ?? []),
      ],
      actions: [
        {
          id: 'restart-web',
          resourceId: 'web',
          command: ['node', '-e', 'process.exit(0)'],
          timeoutSeconds: 10,
          auto: true,
          verifyCheckId: 'web-health',
          ...(options.action ?? {}),
        },
        ...(options.extraActions ?? []),
      ],
      monitor,
      alerts: options.alerts ?? { webhook: webhookUrl, timeoutSeconds: 2 },
    },
  }
}

function makeOps(raw: RawConfig, runner: AgentLike): { ops: OpsRuntime; config: ForgeLoopConfig } {
  const config = resolveConfig(raw, dir)
  return {
    config,
    ops: new OpsRuntime({ config, repo: repository, runner, now: () => clock }),
  }
}

async function listen(): Promise<void> {
  const next = createServer((request, response) => {
    if (request.method === 'POST') {
      let raw = ''
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8')
      })
      request.on('end', () => {
        if (request.url === '/heartbeat') heartbeats.push(request.url)
        else received.push(JSON.parse(raw) as Record<string, unknown>)
        response.writeHead(204)
        response.end()
      })
      return
    }
    if (request.url === '/heartbeat') heartbeats.push(request.url)
    response.writeHead(204)
    response.end()
  })
  server = next
  await new Promise<void>((resolve) => next.listen(0, '127.0.0.1', resolve))
  const address = next.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
  webhookUrl = `http://127.0.0.1:${address.port}/hook`
  latencyUrl = `http://127.0.0.1:${address.port}/health`
  heartbeatUrl = `http://127.0.0.1:${address.port}/heartbeat`
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-ops-monitor-'))
  repository = new Repository(Database.open(join(dir, '.forgeloop', 'records.sqlite')))
  clock = new Date('2026-11-02T10:00:00.000Z')
  received = []
  heartbeats = []
  writeFileSync(join(dir, 'app.log'), 'INFO start\nERROR disk full\n')
  writeFileSync(
    join(dir, 'alerts.json'),
    JSON.stringify([{ severity: 'critical', summary: '磁盘使用率 98%', resourceId: 'web' }]),
  )
  await listen()
})

afterEach(async () => {
  repository.close()
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

describe('ops active monitoring', () => {
  it('records a healthy scan without opening events and respects the scan interval', async () => {
    const runner = runnerOf(() => monitorText([]))
    const { ops } = makeOps(opsRaw(), runner)

    const outcome = await ops.tick()
    expect(outcome.monitored).toBe(true)
    expect(outcome.issues).toBe(0)
    expect(outcome.alerted).toBe(0)
    expect(outcome.errors).toEqual([])
    expect(ops.list()).toEqual([])
    const summary = ops.summary()
    expect(summary.monitor.status).toBe('healthy')
    expect(summary.monitor.lastScanAt).toBe(clock.toISOString())
    expect(summary.monitor.sources).toEqual({
      processes: 0,
      latency: 1,
      logs: 1,
      alerts: 1,
      checks: 1,
    })
    expect(summary.monitor.host.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(summary.alerts.webhook).toBe(true)
    expect(received).toEqual([])

    await ops.tick()
    expect(runner.prompts).toHaveLength(1)

    const prompt = runner.prompts[0] ?? ''
    expect(prompt).toContain('定时评审程序运行快照')
    expect(prompt).toContain('ERROR disk full')
    expect(prompt).toContain('磁盘使用率 98%')
    expect(prompt).toContain('restart-web')
  })

  it('opens an event, executes the catalog-authorized action and alerts the webhook once', async () => {
    const runner = runnerOf(() => monitorText([monitorIssue()]))
    const { ops } = makeOps(opsRaw(), runner)

    const outcome = await ops.tick()
    expect(outcome.monitored).toBe(true)
    expect(outcome.issues).toBe(1)
    expect(outcome.executed).toBe(1)
    expect(outcome.recovered).toBe(1)
    expect(outcome.alerted).toBe(1)

    const event = ops.list()[0]!
    expect(event.checkId).toBe('monitor')
    expect(event.state).toBe(OPS_RECOVERED)
    expect(event.impact).toBe('用户打开页面需要等待')
    const detail = ops.detail(event.eventId)!
    expect(detail.attempts).toHaveLength(1)
    expect(detail.attempts[0]?.authorizationSource).toBe('ops-action:auto:restart-web')
    expect(detail.observations.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['monitor', 'authorization', 'action', 'recovery', 'alert']),
    )
    expect(detail.diagnosis?.proposedAction?.actionId).toBe('restart-web')

    expect(received).toHaveLength(1)
    expect(received[0]?.eventId).toBe(event.eventId)
    expect(received[0]?.severity).toBe('major')
    expect(received[0]?.source).toBe('monitor')
    expect(received[0]?.title).toBe('天工页面响应变慢')
  })

  it('merges a repeated issue into the active event without a second event or alert', async () => {
    const runner = runnerOf(() => monitorText([monitorIssue({ decision_required: true })]))
    const { ops } = makeOps(opsRaw(), runner)

    await ops.tick()
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(received).toHaveLength(1)

    clock = new Date(clock.getTime() + 61_000)
    const outcome = await ops.tick()
    expect(outcome.merged).toBe(1)
    expect(ops.list()).toHaveLength(1)
    const observations = ops.detail(event.eventId)!.observations
    expect(observations.filter((item) => item.kind === 'monitor')).toHaveLength(2)
    expect(received).toHaveLength(1)
    expect(ops.stats().humanInvolved).toBe(0)
  })

  it('records a malformed report as an error and retries only after the interval', async () => {
    let reply = '不是 JSON'
    const runner = runnerOf(() => reply)
    const { ops } = makeOps(opsRaw(), runner)

    const failed = await ops.tick()
    expect(failed.monitored).toBe(true)
    expect(failed.errors[0]).toContain('报告不可用')
    expect(ops.list()).toEqual([])
    expect(ops.summary().monitor.status).toBe('error')

    await ops.tick()
    expect(runner.prompts).toHaveLength(1)

    reply = monitorText([])
    clock = new Date(clock.getTime() + 61_000)
    await ops.tick()
    expect(runner.prompts).toHaveLength(2)
    expect(ops.summary().monitor.status).toBe('healthy')
  })

  it('rejects an issue for an unregistered resource instead of inventing a resource', async () => {
    const runner = runnerOf(() =>
      monitorText([monitorIssue({ resource_id: 'ghost', proposed_action: null })]),
    )
    const { ops } = makeOps(opsRaw(), runner)

    const outcome = await ops.tick()
    expect(outcome.issues).toBe(1)
    expect(ops.list()).toEqual([])
    expect(outcome.errors[0]).toContain('未登记资源')
  })

  it('keeps an event waiting when the proposed action is not registered', async () => {
    const runner = runnerOf(() =>
      monitorText([monitorIssue({ proposed_action: { action_id: 'shell-any', params: {} } })]),
    )
    const { ops } = makeOps(opsRaw(), runner)

    await ops.tick()
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(ops.detail(event.eventId)?.attempts).toHaveLength(0)
    const decision = ops
      .detail(event.eventId)!
      .observations.find((item) => item.kind === 'decision_required')
    expect(decision?.summary).toContain('未登记')
  })

  it('does not alert when the issue opts out or monitoring is disabled', async () => {
    const quiet = runnerOf(() => monitorText([monitorIssue({ alert: false })]))
    const { ops } = makeOps(opsRaw(), quiet)
    await ops.tick()
    expect(ops.list()).toHaveLength(1)
    expect(received).toEqual([])

    const disabledRunner = runnerOf(() => monitorText([monitorIssue()]))
    const disabled = makeOps(
      opsRaw({
        monitor: {
          enabled: false,
          intervalSeconds: 60,
          logLines: 20,
          logs: [],
          latency: [],
          alertFiles: [],
        },
      }),
      disabledRunner,
    ).ops
    const outcome = await disabled.tick()
    expect(outcome.monitored).toBe(false)
    expect(disabledRunner.prompts).toEqual([])
    expect(disabled.list().map((event) => event.eventId)).toEqual(
      ops.list().map((event) => event.eventId),
    )
    expect(received).toEqual([])
  })

  it('alerts a new check-failure event and keeps the last check status for monitoring', async () => {
    const runner = runnerOf((prompt) =>
      prompt.includes('定时评审程序运行快照') ? monitorText([]) : diagnosisText(),
    )
    const { ops } = makeOps(opsRaw({ checkCommand: ['node', '-e', 'process.exit(1)'] }), runner)

    const outcome = await ops.tick()
    const event = ops.list()[0]!
    expect(event.checkId).toBe('web-health')
    expect(outcome.alerted).toBe(1)
    expect(received).toHaveLength(1)
    expect(received[0]?.source).toBe('check:web-health')
    expect(received[0]?.eventId).toBe(event.eventId)
    expect(received[0]?.title).toContain('检查失败')

    const checkStatus = repository.getMeta('ops_check_last:web-health')
    expect(checkStatus).not.toBeNull()
    expect(JSON.parse(checkStatus ?? '{}')).toMatchObject({
      code: 1,
      timedOut: false,
      aborted: false,
    })
    const prompt = runner.prompts.find((item) => item.includes('定时评审程序运行快照')) ?? ''
    expect(prompt).toContain('"checkId": "web-health"')

    const alertObservation = ops
      .detail(event.eventId)!
      .observations.find((item) => item.kind === 'alert')
    expect(alertObservation?.summary).toContain('HTTP 204')
  })

  it('records model failure, thrown errors and cancellation without opening events', async () => {
    const failedRunner: AgentLike = {
      async run(request) {
        return result(request, '', 'failed')
      },
    }
    const { ops } = makeOps(opsRaw(), failedRunner)
    const outcome = await ops.tick()
    expect(outcome.monitored).toBe(true)
    expect(outcome.errors[0]).toContain('未完成')
    expect(ops.list()).toEqual([])
    expect(ops.summary().monitor.status).toBe('error')

    const thrown = makeOps(opsRaw(), {
      async run() {
        throw new Error('boom')
      },
    }).ops
    clock = new Date(clock.getTime() + 61_000)
    const failed = await thrown.tick()
    expect(failed.errors[0]).toContain('未完成')
    expect(thrown.list()).toEqual([])

    const aborted = makeOps(
      opsRaw(),
      runnerOf(() => monitorText([])),
    ).ops
    clock = new Date(clock.getTime() + 61_000)
    const cancelled = await aborted.tick(AbortSignal.abort())
    expect(cancelled.monitored).toBe(false)
    expect(aborted.list()).toEqual([])
  })

  it('waits for a decision when the monitor report proposes no action', async () => {
    const runner = runnerOf(() =>
      monitorText([monitorIssue({ proposed_action: null, decision_required: true })]),
    )
    const { ops } = makeOps(opsRaw(), runner)
    await ops.tick()
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    const decision = ops
      .detail(event.eventId)!
      .observations.find((item) => item.kind === 'decision_required')
    expect(decision?.summary).toContain('没有给出处置动作')
  })

  it('rejects a monitor action that belongs to another resource', async () => {
    const raw = opsRaw({
      extraResources: [{ id: 'db', kind: 'database', label: '业务库' }],
      extraChecks: [
        {
          id: 'db-health',
          resourceId: 'db',
          command: ['node', '-e', 'process.exit(0)'],
          severity: 'minor',
        },
      ],
      extraActions: [
        {
          id: 'restart-db',
          resourceId: 'db',
          command: ['node', '-e', 'process.exit(0)'],
          auto: true,
          verifyCheckId: 'db-health',
        },
      ],
    })
    const runner = runnerOf(() =>
      monitorText([monitorIssue({ proposed_action: { action_id: 'restart-db', params: {} } })]),
    )
    const { ops } = makeOps(raw, runner)
    await ops.tick()
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(ops.detail(event.eventId)?.attempts).toHaveLength(0)
    const decision = ops
      .detail(event.eventId)!
      .observations.find((item) => item.kind === 'decision_required')
    expect(decision?.summary).toContain('不属于资源')
  })

  it('rejects monitor parameters outside the catalog and non-auto actions', async () => {
    const params = opsRaw({
      action: {
        command: ['node', '-e', 'process.exit(0)', '{mode}'],
        params: [{ name: 'mode', values: ['graceful'] }],
      },
    })
    const paramOps = makeOps(
      params,
      runnerOf(() =>
        monitorText([
          monitorIssue({
            proposed_action: { action_id: 'restart-web', params: { mode: 'force' } },
          }),
        ]),
      ),
    ).ops
    await paramOps.tick()
    const paramEvent = paramOps.list()[0]!
    expect(paramEvent.state).toBe(OPS_AWAITING_DECISION)
    expect(
      paramOps
        .detail(paramEvent.eventId)!
        .observations.find((item) => item.kind === 'decision_required')?.summary,
    ).toContain('不在允许值内')

    const manual = makeOps(
      opsRaw({ action: { auto: false } }),
      runnerOf(() => monitorText([monitorIssue({ key: 'web-manual' })])),
    ).ops
    clock = new Date(clock.getTime() + 61_000)
    await manual.tick()
    const manualEvent = manual.list().find((item) => item.eventId !== paramEvent.eventId)!
    expect(manualEvent.state).toBe(OPS_AWAITING_DECISION)
    expect(
      manual
        .detail(manualEvent.eventId)!
        .observations.find((item) => item.kind === 'decision_required')?.summary,
    ).toContain('未获目录自动授权')
  })

  it('escalates the severity of an active monitor event on a repeated critical issue', async () => {
    let reply = monitorText([monitorIssue({ decision_required: true })])
    const { ops } = makeOps(
      opsRaw(),
      runnerOf(() => reply),
    )
    await ops.tick()
    expect(ops.list()[0]?.severity).toBe('major')

    reply = monitorText(
      [monitorIssue({ severity: 'critical', decision_required: true })],
      'critical',
    )
    clock = new Date(clock.getTime() + 61_000)
    const outcome = await ops.tick()
    expect(outcome.merged).toBe(1)
    expect(ops.list()[0]?.severity).toBe('critical')
  })

  it('reads monitor summary defensively from runtime metadata', async () => {
    const { ops } = makeOps(
      opsRaw(),
      runnerOf(() => monitorText([])),
    )
    expect(ops.summary().monitor.status).toBe('')
    expect(ops.summary().monitor.lastScanAt).toBe('')

    repository.setMeta('ops_monitor_last', '{bad')
    expect(ops.summary().monitor.status).toBe('error')
    expect(ops.summary().monitor.error).toContain('不可读')

    repository.setMeta(
      'ops_monitor_last',
      JSON.stringify({ status: 'degraded', host: 'broken', sources: { latency: 2 } }),
    )
    const summary = ops.summary().monitor
    expect(summary.status).toBe('degraded')
    expect(summary.host.cpuPercent).toBe(0)
    expect(summary.sources.latency).toBe(2)
    expect(summary.sources.checks).toBe(0)
  })

  it('reports one heartbeat per scan and exposes it in the summary', async () => {
    const runner = runnerOf(() => monitorText([]))
    const { ops } = makeOps(
      opsRaw({
        monitor: {
          enabled: true,
          intervalSeconds: 60,
          heartbeat: { url: heartbeatUrl, method: 'POST', timeoutSeconds: 2 },
        },
      }),
      runner,
    )
    expect(ops.summary().monitor.heartbeat).toEqual({ configured: true, at: '', ok: false })

    const outcome = await ops.tick()
    expect(outcome.monitored).toBe(true)
    expect(outcome.errors).toEqual([])
    expect(heartbeats).toEqual(['/heartbeat'])
    expect(ops.list()).toEqual([])

    const summary = ops.summary().monitor
    expect(summary.providers).toEqual(['builtin'])
    expect(summary.heartbeat.configured).toBe(true)
    expect(summary.heartbeat.ok).toBe(true)
    expect(summary.heartbeat.at).toBe(clock.toISOString())

    // 未到扫描周期时不再扫描，也不额外上报。
    await ops.tick()
    expect(heartbeats).toHaveLength(1)
  })

  it('records a failed heartbeat without changing the scan outcome', async () => {
    const runner = runnerOf(() => monitorText([]))
    const { ops } = makeOps(
      opsRaw({
        monitor: {
          enabled: true,
          intervalSeconds: 60,
          heartbeat: { url: 'http://127.0.0.1:1/ping', timeoutSeconds: 1 },
        },
      }),
      runner,
    )
    const outcome = await ops.tick()
    expect(outcome.monitored).toBe(true)
    expect(outcome.errors.some((error) => error.includes('心跳上报失败'))).toBe(true)
    const summary = ops.summary().monitor
    expect(summary.status).toBe('healthy')
    expect(summary.heartbeat.ok).toBe(false)
  })

  it('does not send a heartbeat when monitoring is disabled or the tick is aborted', async () => {
    const disabled = makeOps(
      opsRaw({ monitor: { enabled: false, heartbeat: { url: heartbeatUrl } } }),
      runnerOf(() => monitorText([])),
    )
    await disabled.ops.tick()
    expect(heartbeats).toEqual([])

    const aborted = makeOps(
      opsRaw({ monitor: { enabled: true, heartbeat: { url: heartbeatUrl } } }),
      runnerOf(() => monitorText([])),
    )
    await aborted.ops.tick(AbortSignal.abort())
    expect(heartbeats).toEqual([])
  })
})
