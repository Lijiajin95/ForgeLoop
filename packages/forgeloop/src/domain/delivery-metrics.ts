/**
 * 交付度量：按项目和受理时间归组的可安装交付率、人工介入耗时与受理到可用结果的用时。
 *
 * 口径只依赖权威记录：
 * - 受理记录（`requirements.created_at`）确定起始时刻与分母；
 * - 可安装交付记录确定“从什么时候起可以取得已验证安装包”；
 * - 人工处理记录说明谁在哪个事项上花了时间；没有结束时刻就显示「时长未知」。
 *
 * 交付结果按截止时生效的需求版本判定：交付记录绑定的版本必须等于需求当前版本，
 * 旧版本的交付不算当前需求的达成。失败、阻塞、取消和未完成都留在分母里。
 */

export const DELIVERY_METRICS_CUTOFF_SKEW_MS = 5 * 60 * 1000

export interface MetricsRequirement {
  readonly reqId: string
  readonly project: string
  /** 首次受理时间；文档修订、重复投递和重试沿用同一个受理时刻。 */
  readonly acceptedAt: string
  readonly status: string
  /** 需求当前版本；交付记录必须绑定它才算截止时的有效交付。 */
  readonly requirementVersion: number
}

export interface MetricsDelivery {
  readonly reqId: string
  readonly requirementVersion: number
  /** 六项材料同时可用、交付记录登记的时刻。 */
  readonly availableAt: string
}

export interface MetricsIntervention {
  readonly reqId: string
  readonly actor: string
  /** 介入原因；页面按此聚合展示“在哪个事项上花了时间”。 */
  readonly reason: string
  readonly startedAt: string
  /** 空串表示只记录了介入事实、没有可观测的处理时长。 */
  readonly endedAt: string
}

export interface RequirementStanding {
  readonly reqId: string
  readonly status: string
  /** 截至统计时点已等待的分钟数。 */
  readonly waitedMinutes: number
}

export interface DeliveryRateGroup {
  readonly project: string
  /** 受理日期（UTC，YYYY-MM-DD）；同一组使用同一个截止时点。 */
  readonly acceptedDate: string
  readonly cutoff: string
  readonly accepted: number
  readonly delivered: number
  readonly rate: number
  /** 未达成需求及其当前状态；失败、阻塞、取消和未完成都在这里。 */
  readonly undelivered: readonly RequirementStanding[]
}

export interface DeliveredDuration {
  readonly reqId: string
  readonly minutes: number
}

export interface DurationSummary {
  /** 已交付样本数；中位数与 P90 都基于它。 */
  readonly samples: number
  readonly medianMinutes: number | null
  readonly p90Minutes: number | null
  readonly delivered: readonly DeliveredDuration[]
  /** 未完成需求单独列示已等待时长，不混进交付样本。 */
  readonly pending: readonly RequirementStanding[]
}

export interface RequirementInterventionSummary {
  readonly reqId: string
  /** 已知处理分钟数合计；null 表示至少一项缺时长，页面显示「时长未知」。 */
  readonly minutes: number | null
  readonly unknown: boolean
  readonly reasons: readonly string[]
}

export interface InterventionSummary {
  readonly requirements: readonly RequirementInterventionSummary[]
  readonly totalRequirements: number
  /** 已知时长之和；有未知时仍给出已知部分，由页面同时显示未知数量。 */
  readonly totalMinutes: number
  readonly unknownCount: number
}

export interface DeliveryMetrics {
  readonly cutoff: string
  readonly groups: readonly DeliveryRateGroup[]
  readonly durations: DurationSummary
  readonly interventions: InterventionSummary
}

export interface DeliveryMetricsInput {
  readonly cutoff: string
  readonly requirements: readonly MetricsRequirement[]
  readonly deliveries: readonly MetricsDelivery[]
  readonly interventions: readonly MetricsIntervention[]
}

interface DeliveredRequirement {
  readonly requirement: MetricsRequirement
  readonly availableAt: string
}

function minutesBetween(from: string, to: string): number {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, Math.round(((end - start) / 60_000) * 10) / 10)
}

function valueAt(sorted: readonly number[], position: number): number {
  const [value = 0] = sorted.slice(position, position + 1)
  return value
}

/** 线性插值分位数：样本为空返回 null，单样本返回自身。调用方先排序。 */
export function percentileOf(sorted: readonly number[], fraction: number): number | null {
  const count = sorted.length
  if (count === 0) return null
  if (count === 1) return valueAt(sorted, 0)
  const index = (count - 1) * fraction
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const low = valueAt(sorted, lower)
  const high = valueAt(sorted, upper)
  return Math.round((low + (high - low) * (index - lower)) * 10) / 10
}

/**
 * 人工介入时长：同一人的重叠时段只计一次。
 * 任一记录缺结束时刻时整体为「时长未知」（null），但仍保留原因清单。
 */
export function interventionMinutes(entries: readonly MetricsIntervention[]): {
  minutes: number | null
  unknown: boolean
  reasons: readonly string[]
} {
  const reasons = [...new Set(entries.map((entry) => entry.reason))].sort()
  if (entries.length === 0) return { minutes: null, unknown: false, reasons }
  const byActor = new Map<string, Array<{ start: number; end: number }>>()
  let unknown = false
  for (const entry of entries) {
    const start = Date.parse(entry.startedAt)
    const end = entry.endedAt ? Date.parse(entry.endedAt) : Number.NaN
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      unknown = true
      continue
    }
    const list = byActor.get(entry.actor)
    if (list) list.push({ start, end })
    else byActor.set(entry.actor, [{ start, end }])
  }
  let totalMs = 0
  for (const list of byActor.values()) {
    list.sort((left, right) => left.start - right.start)
    let cursor = Number.NEGATIVE_INFINITY
    let end = Number.NEGATIVE_INFINITY
    for (const interval of list) {
      if (interval.start > end) {
        if (Number.isFinite(cursor)) totalMs += end - cursor
        cursor = interval.start
        end = interval.end
      } else {
        end = Math.max(end, interval.end)
      }
    }
    if (Number.isFinite(cursor)) totalMs += end - cursor
  }
  return {
    minutes: unknown ? null : Math.round((totalMs / 60_000) * 10) / 10,
    unknown,
    reasons,
  }
}

/** 截止时的有效交付：绑定当前需求版本且可用时间不晚于截止时点；同一需求取最早一次。 */
function deliveredAtByRequirement(
  input: DeliveryMetricsInput,
  requirement: MetricsRequirement,
): string | null {
  const candidates = input.deliveries
    .filter(
      (delivery) =>
        delivery.reqId === requirement.reqId &&
        delivery.requirementVersion === requirement.requirementVersion &&
        delivery.availableAt <= input.cutoff,
    )
    .map((delivery) => delivery.availableAt)
    .sort()
  return candidates[0] ?? null
}

function rateGroups(
  accepted: readonly MetricsRequirement[],
  delivered: ReadonlySet<string>,
  cutoff: string,
): DeliveryRateGroup[] {
  const groups = new Map<string, { project: string; requirements: MetricsRequirement[] }>()
  for (const requirement of accepted) {
    const date = requirement.acceptedAt.slice(0, 10)
    const group = groups.get(date)
    if (group) group.requirements.push(requirement)
    else groups.set(date, { project: requirement.project, requirements: [requirement] })
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([acceptedDate, group]) => {
      const undelivered = group.requirements
        .filter((requirement) => !delivered.has(requirement.reqId))
        .map((requirement) => ({
          reqId: requirement.reqId,
          status: requirement.status,
          waitedMinutes: minutesBetween(requirement.acceptedAt, cutoff),
        }))
        .sort((left, right) => left.reqId.localeCompare(right.reqId))
      const deliveredCount = group.requirements.length - undelivered.length
      return {
        project: group.project,
        acceptedDate,
        cutoff,
        accepted: group.requirements.length,
        delivered: deliveredCount,
        rate: deliveredCount / group.requirements.length,
        undelivered,
      }
    })
}

function durationSummary(
  delivered: readonly DeliveredRequirement[],
  accepted: readonly MetricsRequirement[],
  cutoff: string,
): DurationSummary {
  const samples = delivered
    .map((entry) => ({
      reqId: entry.requirement.reqId,
      minutes: minutesBetween(entry.requirement.acceptedAt, entry.availableAt),
    }))
    .sort((left, right) => left.reqId.localeCompare(right.reqId))
  const deliveredIds = new Set(delivered.map((entry) => entry.requirement.reqId))
  const sorted = samples.map((sample) => sample.minutes).sort((left, right) => left - right)
  const pending = accepted
    .filter((requirement) => !deliveredIds.has(requirement.reqId))
    .map((requirement) => ({
      reqId: requirement.reqId,
      status: requirement.status,
      waitedMinutes: minutesBetween(requirement.acceptedAt, cutoff),
    }))
    .sort((left, right) => left.reqId.localeCompare(right.reqId))
  return {
    samples: sorted.length,
    medianMinutes: percentileOf(sorted, 0.5),
    p90Minutes: percentileOf(sorted, 0.9),
    delivered: samples,
    pending,
  }
}

function interventionSummary(
  entries: readonly MetricsIntervention[],
  accepted: readonly MetricsRequirement[],
): InterventionSummary {
  const allowed = new Set(accepted.map((requirement) => requirement.reqId))
  const byRequirement = new Map<string, MetricsIntervention[]>()
  for (const entry of entries) {
    if (!allowed.has(entry.reqId)) continue
    const list = byRequirement.get(entry.reqId)
    if (list) list.push(entry)
    else byRequirement.set(entry.reqId, [entry])
  }
  let totalMinutes = 0
  let unknownCount = 0
  const requirements: RequirementInterventionSummary[] = []
  for (const requirement of accepted) {
    const list = byRequirement.get(requirement.reqId)
    if (!list) continue
    const merged = interventionMinutes(list)
    if (merged.minutes === null) unknownCount += 1
    else totalMinutes += merged.minutes
    requirements.push({
      reqId: requirement.reqId,
      minutes: merged.minutes,
      unknown: merged.unknown,
      reasons: merged.reasons,
    })
  }
  requirements.sort((left, right) => left.reqId.localeCompare(right.reqId))
  return {
    requirements,
    totalRequirements: requirements.length,
    totalMinutes: Math.round(totalMinutes * 10) / 10,
    unknownCount,
  }
}

/** 计算截止时点上的三项指标；所有输入都是记录事实，函数不访问文件或数据库。 */
export function buildDeliveryMetrics(input: DeliveryMetricsInput): DeliveryMetrics {
  const accepted = input.requirements.filter(
    (requirement) => requirement.acceptedAt && requirement.acceptedAt <= input.cutoff,
  )
  const delivered: DeliveredRequirement[] = []
  for (const requirement of accepted) {
    const availableAt = deliveredAtByRequirement(input, requirement)
    if (availableAt) delivered.push({ requirement, availableAt })
  }
  return {
    cutoff: input.cutoff,
    groups: rateGroups(
      accepted,
      new Set(delivered.map((entry) => entry.requirement.reqId)),
      input.cutoff,
    ),
    durations: durationSummary(delivered, accepted, input.cutoff),
    interventions: interventionSummary(input.interventions, accepted),
  }
}
