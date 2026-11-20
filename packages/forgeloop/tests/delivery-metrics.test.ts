import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { createBoardFetch } from '../src/runtime/board-route.js'
import type { Coordinator } from '../src/runtime/coordinator.js'
import type { ForgeLoopConfig } from '../src/config.js'
import {
  buildDeliveryMetrics,
  interventionMinutes,
  percentileOf,
  type DeliveryMetricsInput,
} from '../src/domain/delivery-metrics.js'
import {
  deliveryMetricsSnapshot,
  recordHumanIntervention,
} from '../src/runtime/delivery-metrics.js'
import { asRecord } from '../src/domain/json.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function baseInput(overrides: Partial<DeliveryMetricsInput> = {}): DeliveryMetricsInput {
  return {
    cutoff: '2026-11-16T23:59:59.000Z',
    requirements: [],
    deliveries: [],
    interventions: [],
    ...overrides,
  }
}

function requirement(reqId: string, acceptedAt: string, status: string, requirementVersion = 1) {
  return { reqId, project: 'demo', acceptedAt, status, requirementVersion }
}

describe('delivery metrics domain', () => {
  it('groups by acceptance date and keeps failed, blocked and cancelled requirements in the denominator', () => {
    const metrics = buildDeliveryMetrics(
      baseInput({
        requirements: [
          requirement('req-a', '2026-11-15T01:00:00.000Z', 'committed'),
          requirement('req-b', '2026-11-15T02:00:00.000Z', 'blocked'),
          requirement('req-c', '2026-11-15T03:00:00.000Z', 'cancelled'),
          requirement('req-d', '2026-11-16T04:00:00.000Z', 'accepted'),
        ],
        deliveries: [
          { reqId: 'req-a', requirementVersion: 1, availableAt: '2026-11-15T05:00:00.000Z' },
        ],
      }),
    )

    expect(metrics.groups).toHaveLength(2)
    const [first, second] = metrics.groups
    expect(first).toMatchObject({ acceptedDate: '2026-11-15', accepted: 3, delivered: 1 })
    expect(first?.rate).toBeCloseTo(1 / 3, 6)
    expect(first?.undelivered.map((item) => item.status).sort()).toEqual(['blocked', 'cancelled'])
    expect(second).toMatchObject({ acceptedDate: '2026-11-16', accepted: 1, delivered: 0, rate: 0 })
    expect(second?.undelivered[0]?.reqId).toBe('req-d')
  })

  it('does not count a delivery bound to an older requirement version or one after the cutoff', () => {
    const metrics = buildDeliveryMetrics(
      baseInput({
        requirements: [
          requirement('req-a', '2026-11-15T01:00:00.000Z', 'developing', 2),
          requirement('req-b', '2026-11-15T02:00:00.000Z', 'committed', 1),
        ],
        deliveries: [
          // req-a 的交付绑定旧版本 1，当前需求已是版本 2。
          { reqId: 'req-a', requirementVersion: 1, availableAt: '2026-11-15T05:00:00.000Z' },
          // req-b 的交付晚于统计截止时点。
          { reqId: 'req-b', requirementVersion: 1, availableAt: '2026-11-17T05:00:00.000Z' },
        ],
      }),
    )
    expect(metrics.groups[0]).toMatchObject({ accepted: 2, delivered: 0, rate: 0 })
    expect(metrics.durations.samples).toBe(0)
    expect(metrics.durations.pending.map((item) => item.reqId).sort()).toEqual(['req-a', 'req-b'])
  })

  it('summarises acceptance-to-usable minutes with median, P90 and separate pending waits', () => {
    const accepted = '2026-11-15T00:00:00.000Z'
    const metrics = buildDeliveryMetrics(
      baseInput({
        requirements: [
          requirement('req-1', accepted, 'committed'),
          requirement('req-2', accepted, 'committed'),
          requirement('req-3', accepted, 'committed'),
          requirement('req-4', accepted, 'committed'),
          requirement('req-5', accepted, 'blocked'),
        ],
        deliveries: [
          // 10、20、30、100 分钟四个已交付样本。
          { reqId: 'req-1', requirementVersion: 1, availableAt: '2026-11-15T00:10:00.000Z' },
          { reqId: 'req-2', requirementVersion: 1, availableAt: '2026-11-15T00:20:00.000Z' },
          { reqId: 'req-3', requirementVersion: 1, availableAt: '2026-11-15T00:30:00.000Z' },
          { reqId: 'req-4', requirementVersion: 1, availableAt: '2026-11-15T01:40:00.000Z' },
        ],
      }),
    )
    expect(metrics.durations.samples).toBe(4)
    expect(metrics.durations.delivered).toEqual([
      { reqId: 'req-1', minutes: 10 },
      { reqId: 'req-2', minutes: 20 },
      { reqId: 'req-3', minutes: 30 },
      { reqId: 'req-4', minutes: 100 },
    ])
    // 线性插值：中位数 = 25，P90 = 79。
    expect(metrics.durations.medianMinutes).toBe(25)
    expect(metrics.durations.p90Minutes).toBe(79)
    expect(metrics.durations.pending).toEqual([
      { reqId: 'req-5', status: 'blocked', waitedMinutes: 2880 },
    ])
  })

  it('merges overlapping handling intervals per actor and reports unknown durations', () => {
    expect(percentileOf([], 0.5)).toBeNull()
    expect(percentileOf([7], 0.9)).toBe(7)

    const merged = interventionMinutes([
      {
        reqId: 'req-1',
        actor: 'owner',
        reason: '人工澄清',
        startedAt: '2026-11-15T10:00:00.000Z',
        endedAt: '2026-11-15T10:10:00.000Z',
      },
      {
        reqId: 'req-1',
        actor: 'owner',
        reason: '业务决定',
        startedAt: '2026-11-15T10:05:00.000Z',
        endedAt: '2026-11-15T10:20:00.000Z',
      },
      {
        reqId: 'req-1',
        actor: 'owner',
        reason: '人工补救',
        startedAt: '2026-11-15T11:00:00.000Z',
        endedAt: '2026-11-15T11:05:00.000Z',
      },
    ])
    // 重叠的 10 分钟与 5 分钟合计 25 分钟；不同人之间不合并。
    expect(merged).toEqual({
      minutes: 25,
      unknown: false,
      reasons: ['业务决定', '人工澄清', '人工补救'],
    })

    const unknown = interventionMinutes([
      {
        reqId: 'req-1',
        actor: 'owner',
        reason: '人工澄清',
        startedAt: '2026-11-15T10:00:00.000Z',
        endedAt: null,
      },
    ])
    expect(unknown.minutes).toBeNull()
    expect(unknown.unknown).toBe(true)
    expect(unknown.reasons).toEqual(['人工澄清'])
  })

  it('reports per-requirement intervention minutes and unknown counts', () => {
    const metrics = buildDeliveryMetrics(
      baseInput({
        requirements: [
          requirement('req-1', '2026-11-15T01:00:00.000Z', 'committed'),
          requirement('req-2', '2026-11-15T02:00:00.000Z', 'blocked'),
        ],
        interventions: [
          {
            reqId: 'req-1',
            actor: 'owner',
            reason: '人工澄清',
            startedAt: '2026-11-15T10:00:00.000Z',
            endedAt: '2026-11-15T10:30:00.000Z',
          },
          {
            reqId: 'req-2',
            actor: '',
            reason: '停止需求',
            startedAt: '2026-11-15T11:00:00.000Z',
            endedAt: null,
          },
        ],
      }),
    )
    expect(metrics.interventions.requirements).toEqual([
      { reqId: 'req-1', minutes: 30, unknown: false, reasons: ['人工澄清'] },
      { reqId: 'req-2', minutes: null, unknown: true, reasons: ['停止需求'] },
    ])
    expect(metrics.interventions).toMatchObject({
      totalRequirements: 2,
      totalMinutes: 30,
      unknownCount: 1,
    })
  })
})

const runner: AgentLike = {
  async run(request) {
    return {
      status: 'completed',
      text: '',
      sessionId: 'metrics-test',
      reason: '',
      transcriptPath: request.transcriptPath,
      durationMs: 1,
      toolCalls: [],
    }
  },
}

function runtimeWith(root: string) {
  return new ForgeLoopRuntime({
    ctx: {},
    config: resolveConfig(
      {
        project: 'demo',
        projectPath: root,
        recordsRoot: join(root, '.forgeloop'),
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      },
      root,
    ),
    runner,
    now: () => new Date('2026-11-16T10:00:00.000Z'),
  })
}

function submit(runtime: ForgeLoopRuntime, text: string): string {
  const result = runtime.submit({ text, by: 'owner', source: 'test', analyze: false })
  const reqId = asRecord(result.data)?.reqId
  if (typeof reqId !== 'string') throw new Error('测试需求没有身份')
  return reqId
}

function recordDelivery(runtime: ForgeLoopRuntime, reqId: string, availableAt: string): void {
  runtime.repo.installableDeliveryStore.record({
    deliveryId: `${reqId}-d1`,
    reqId,
    deliveryVersion: 1,
    project: 'demo',
    requirementVersion: 1,
    planVersion: 1,
    candidateSha256: 'c'.repeat(64),
    commitSha: 'a'.repeat(40),
    packageVersion: '0.0.2',
    artifactSha256: 'p'.repeat(64),
    tarball: '/artifacts/demo.tgz',
    instructionsPath: '/evidence/INSTALL.md',
    instructionsSha256: 'i'.repeat(64),
    instructionsBytes: 100,
    verificationSha256: 'v'.repeat(64),
    businessReviewSha256: 'r'.repeat(64),
    trialTarget: 'trial',
    trialRuntimeVersion: '0.0.2',
    trialArtifactSha256: 'p'.repeat(64),
    availableAt,
    recordedAt: availableAt,
    evidenceDir: '/evidence',
  })
}

const NOON = '2026-11-16T12:00:00.000Z'

describe('delivery metrics runtime', () => {
  it('returns rate, duration and intervention metrics from authoritative records', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-metrics-'))
    roots.push(root)
    const runtime = runtimeWith(root)
    const delivered = submit(runtime, '需求 A')
    const blocked = submit(runtime, '需求 B')
    recordDelivery(runtime, delivered, '2026-11-16T11:00:00.000Z')
    runtime.repo.setStatus(blocked, 'blocked', '等待决定')
    // 既有权威记录只有时刻、没有处理时长：延长工时是一条人工介入事实。
    runtime.repo.recordBudgetExtension({
      reqId: blocked,
      seconds: 600,
      extendedBy: 'owner',
      source: 'test',
      extendedAt: '2026-11-16T09:00:00.000Z',
    })

    const result = deliveryMetricsSnapshot(runtime, { now: () => NOON, cutoff: NOON })
    expect(result.ok, result.message).toBe(true)
    const metrics = result.data as ReturnType<typeof buildDeliveryMetrics>
    expect(metrics.groups).toEqual([
      expect.objectContaining({ acceptedDate: '2026-11-16', accepted: 2, delivered: 1, rate: 0.5 }),
    ])
    expect(metrics.durations.delivered).toEqual([{ reqId: delivered, minutes: 60 }])
    expect(metrics.durations.samples).toBe(1)
    expect(metrics.interventions.requirements).toEqual([
      expect.objectContaining({ reqId: blocked, minutes: null, unknown: true }),
    ])
    runtime.close()
  })

  it('records an observable handling interval and counts it after merging', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-metrics-'))
    roots.push(root)
    const runtime = runtimeWith(root)
    const reqId = submit(runtime, '需求 A')
    for (const [startedAt, endedAt] of [
      ['2026-11-16T09:00:00.000Z', '2026-11-16T09:10:00.000Z'],
      ['2026-11-16T09:05:00.000Z', '2026-11-16T09:20:00.000Z'],
    ] as const) {
      const recorded = recordHumanIntervention(runtime, {
        reqId,
        actor: 'owner',
        reason: '人工补救',
        startedAt,
        endedAt,
        source: 'test',
      })
      expect(recorded.ok, recorded.message).toBe(true)
    }
    const result = deliveryMetricsSnapshot(runtime, { now: () => NOON, cutoff: NOON })
    const metrics = result.data as ReturnType<typeof buildDeliveryMetrics>
    expect(metrics.interventions.requirements).toEqual([
      { reqId, minutes: 20, unknown: false, reasons: ['人工补救'] },
    ])
    runtime.close()
  })

  it('rejects unusable handling intervals without writing a record', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-metrics-'))
    roots.push(root)
    const runtime = runtimeWith(root)
    const reqId = submit(runtime, '需求 A')

    expect(
      recordHumanIntervention(runtime, {
        reqId: '',
        actor: 'owner',
        reason: '人工澄清',
        startedAt: '2026-11-16T09:00:00.000Z',
        source: 'test',
      }).message,
    ).toContain('需求编号')
    expect(
      recordHumanIntervention(runtime, {
        reqId,
        actor: 'owner',
        reason: '',
        startedAt: '2026-11-16T09:00:00.000Z',
        source: 'test',
      }).message,
    ).toContain('介入原因')
    expect(
      recordHumanIntervention(runtime, {
        reqId,
        actor: 'owner',
        reason: '长'.repeat(201),
        startedAt: '2026-11-16T09:00:00.000Z',
        source: 'test',
      }).message,
    ).toContain('200')
    expect(
      recordHumanIntervention(runtime, {
        reqId: 'req-missing',
        actor: 'owner',
        reason: '人工澄清',
        startedAt: '2026-11-16T09:00:00.000Z',
        source: 'test',
      }),
    ).toMatchObject({ ok: false, code: 'not_found' })
    expect(
      recordHumanIntervention(runtime, {
        reqId,
        actor: '',
        reason: '人工澄清',
        startedAt: '2026-11-16T09:00:00.000Z',
        source: 'test',
      }).code,
    ).toBe('bad_request')
    expect(
      recordHumanIntervention(runtime, {
        reqId,
        actor: 'owner',
        reason: '人工澄清',
        startedAt: '2026-11-16T09:30:00.000Z',
        endedAt: '2026-11-16T09:00:00.000Z',
        source: 'test',
      }).code,
    ).toBe('bad_request')
    expect(
      recordHumanIntervention(runtime, {
        reqId,
        actor: 'owner',
        reason: '人工澄清',
        startedAt: '2026-11-14T09:00:00.000Z',
        endedAt: '2026-11-16T09:00:00.000Z',
        source: 'test',
      }).message,
    ).toContain('1440')
    expect(runtime.repo.metricsStore.interventionsFor(reqId)).toEqual([])
    runtime.close()
  })

  it('rejects unparseable or future handling intervals', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-metrics-'))
    roots.push(root)
    const runtime = runtimeWith(root)
    const reqId = submit(runtime, '需求 A')
    expect(
      recordHumanIntervention(runtime, {
        reqId,
        actor: 'owner',
        reason: '人工澄清',
        startedAt: 'not-a-time',
        source: 'test',
        now: () => NOON,
      }).code,
    ).toBe('bad_request')
    expect(
      recordHumanIntervention(runtime, {
        reqId,
        actor: 'owner',
        reason: '人工澄清',
        startedAt: '2026-11-16T09:00:00.000Z',
        endedAt: '2026-11-16T13:00:00.000Z',
        source: 'test',
        now: () => NOON,
      }).code,
    ).toBe('bad_request')
    expect(runtime.repo.metricsStore.interventionsFor(reqId)).toEqual([])
    runtime.close()
  })

  it('defaults the cutoff to now for the read-only snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-metrics-'))
    roots.push(root)
    const runtime = runtimeWith(root)
    submit(runtime, '需求 A')
    const result = deliveryMetricsSnapshot(runtime, { now: () => NOON })
    expect(result.ok, result.message).toBe(true)
    expect((result.data as ReturnType<typeof buildDeliveryMetrics>).cutoff).toBe(NOON)
    runtime.close()
  })

  it('refuses a cutoff later than now', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-metrics-'))
    roots.push(root)
    const runtime = runtimeWith(root)
    expect(
      deliveryMetricsSnapshot(runtime, {
        now: () => NOON,
        cutoff: '2026-11-16T13:00:00.000Z',
      }).code,
    ).toBe('bad_request')
    runtime.close()
  })
})

describe('delivery metrics board endpoints', () => {
  function boardWith(overrides: Record<string, unknown> = {}) {
    const records: Array<Record<string, unknown>> = []
    const repo = {
      metricsStore: {
        requirements: () => [],
        deliveries: () => [],
        interventions: () => [],
        recordIntervention: (record: Record<string, unknown>) => records.push(record),
        interventionsFor: () => [],
      },
      getRequirement: (reqId: string) =>
        reqId === 'req-1'
          ? {
              reqId,
              project: 'demo',
              status: 'draft',
              blockedReason: '',
              submittedBy: 'owner',
              source: 'test',
              versions: [
                { version: 1, text: '需求', createdAt: NOON, revisedBy: 'owner', source: 'test' },
              ],
            }
          : null,
      ...overrides,
    }
    const runtime = { config: { project: 'demo', owner: 'owner' }, repo }
    const config = { owner: 'owner' } as ForgeLoopConfig
    const coordinator = {} as Coordinator
    return {
      fetch: createBoardFetch(runtime as never, config, coordinator),
      records,
    }
  }

  async function post(fetch: (request: Request) => Promise<Response>, body: unknown) {
    const response = await fetch(
      new Request('http://127.0.0.1/board', { method: 'POST', body: JSON.stringify(body) }),
    )
    return { status: response.status, body: await response.json() }
  }

  it('serves the delivery metrics snapshot and validates the cutoff', async () => {
    const { fetch } = boardWith()
    const ok = await post(fetch, {
      endpoint: 'delivery-metrics',
      cutoff: '2026-11-16T10:00:00.000Z',
    })
    expect(ok.status).toBe(200)
    expect(ok.body.value).toMatchObject({ cutoff: '2026-11-16T10:00:00.000Z', groups: [] })
    expect((await post(fetch, { endpoint: 'delivery-metrics', cutoff: 'not-a-time' })).status).toBe(
      400,
    )
  })

  it('records an owner handling interval and rejects missing fields or unknown requirements', async () => {
    const { fetch, records } = boardWith()
    // 未传 endedAt 时区间终点取当前时刻，因此起点必须相对 now，不能钉死日期。
    const startedAt = new Date(Date.now() - 30 * 60_000).toISOString()
    expect((await post(fetch, { endpoint: 'intervention', reqId: 'req-1' })).status).toBe(400)
    expect(
      (
        await post(fetch, {
          endpoint: 'intervention',
          reqId: 'req-missing',
          reason: '人工澄清',
          startedAt,
        })
      ).status,
    ).toBe(404)
    const ok = await post(fetch, {
      endpoint: 'intervention',
      reqId: 'req-1',
      reason: '人工澄清',
      startedAt,
      sessionId: 'session-1',
    })
    expect(ok.status).toBe(200)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      reqId: 'req-1',
      actor: 'owner',
      reason: '人工澄清',
      source: 'web-decision:session-1',
    })
  })
})

describe('delivery metrics records boundary', () => {
  it('maps the empty duration sentinel to null', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-metrics-'))
    roots.push(root)
    const runtime = runtimeWith(root)
    const reqId = submit(runtime, '需求 C')
    runtime.repo.metricsStore.recordIntervention({
      interventionId: 'hi-boundary',
      reqId,
      project: 'demo',
      actor: 'owner',
      reason: '人工澄清',
      startedAt: '2026-11-16T09:00:00.000Z',
      endedAt: null,
      source: 'test',
      recordedAt: '2026-11-16T09:10:00.000Z',
    })

    const [row] = runtime.repo.metricsStore.interventionsFor(reqId)
    expect(row?.endedAt).toBeNull()
    runtime.close()
  })
})
