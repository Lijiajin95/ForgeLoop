import { randomUUID } from 'node:crypto'
import type { ForgeLoopConfig } from '../config.js'
import { buildDeliveryMetrics, type DeliveryMetrics } from '../domain/delivery-metrics.js'
import { DELIVERY_METRICS_CUTOFF_SKEW_MS } from '../domain/delivery-metrics.js'
import type { Repository } from '../records/repository.js'
import { fail, ok, type OperationResult } from './operation-result.js'

export const MAX_HANDLING_MINUTES = 24 * 60

export interface DeliveryMetricsRuntime {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
}

export interface DeliveryMetricsOptions {
  readonly now?: (() => string) | undefined
  readonly cutoff?: string | undefined
}

function clockOf(options: { readonly now?: (() => string) | undefined }): () => string {
  return options.now ?? (() => new Date().toISOString())
}

export function deliveryMetricsSnapshot(
  runtime: DeliveryMetricsRuntime,
  options: DeliveryMetricsOptions = {},
): OperationResult {
  const now = clockOf(options)()
  const cutoff = (options.cutoff ?? now).trim() || now
  const cutoffMs = Date.parse(cutoff)
  if (!Number.isFinite(cutoffMs)) return fail('bad_request', '统计截止时点不是合法时间')
  if (cutoffMs > Date.parse(now) + DELIVERY_METRICS_CUTOFF_SKEW_MS) {
    return fail('bad_request', '统计截止时点不能晚于当前时刻')
  }
  const store = runtime.repo.metricsStore
  const metrics: DeliveryMetrics = buildDeliveryMetrics({
    cutoff,
    requirements: store.requirements(runtime.config.project),
    deliveries: store.deliveries(runtime.config.project),
    interventions: store.interventions(),
  })
  return ok(`交付度量：截止 ${cutoff}；${metrics.groups.length} 组受理日期`, metrics)
}

export interface HumanInterventionInput {
  readonly reqId: string
  readonly actor: string
  readonly reason: string
  readonly startedAt: string
  readonly endedAt?: string | undefined
  readonly source: string
  readonly now?: (() => string) | undefined
}

export function recordHumanIntervention(
  runtime: DeliveryMetricsRuntime,
  input: HumanInterventionInput,
): OperationResult {
  const reqId = input.reqId.trim()
  const actor = input.actor.trim()
  const reason = input.reason.trim()
  if (!reqId) return fail('bad_request', '人工处理记录需要需求编号')
  if (!actor) return fail('bad_request', '人工处理记录需要执行者身份')
  if (!reason) return fail('bad_request', '人工处理记录需要介入原因')
  if (reason.length > 200) return fail('bad_request', '介入原因不能超过 200 字符')
  const requirement = runtime.repo.getRequirement(reqId)
  if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
  const now = clockOf(input)()
  const nowMs = Date.parse(now)
  const startedMs = Date.parse(input.startedAt)
  const endedMs = input.endedAt === undefined ? nowMs : Date.parse(input.endedAt)
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) {
    return fail('bad_request', '人工处理区间的时间不是合法时间')
  }
  if (endedMs < startedMs) return fail('bad_request', '人工处理区间结束早于开始')
  if (endedMs > nowMs + DELIVERY_METRICS_CUTOFF_SKEW_MS) {
    return fail('bad_request', '人工处理区间不能晚于当前时刻')
  }
  if (endedMs - startedMs > MAX_HANDLING_MINUTES * 60_000) {
    return fail('bad_request', `单次人工处理区间不能超过 ${MAX_HANDLING_MINUTES} 分钟`)
  }
  const record = {
    interventionId: `hi-${now.replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    reqId,
    project: runtime.config.project,
    actor,
    reason,
    startedAt: input.startedAt,
    endedAt: new Date(endedMs).toISOString(),
    source: input.source,
    recordedAt: now,
  }
  runtime.repo.metricsStore.recordIntervention(record)
  return ok(`已记录需求 ${reqId} 的人工处理区间：${reason}`, record)
}
