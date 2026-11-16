/**
 * 代码可靠性看板的运行时视图：读取质量快照、组合只读业务记录与最近事件。
 *
 * 快照是本地登记材料；文件缺失或损坏不抛到整页，而是作为快照状态返回。
 * 运行指标只使用追加型记录；任务运行是当前状态，不参与历史趋势。
 * 指标历史由协调器按“变化或心跳”追加到 reliability_metric_samples，只增不改。
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { errorMessage } from '../domain/errors.js'
import { asRecord } from '../domain/json.js'
import {
  RELIABILITY_SAMPLE_HEARTBEAT_MS,
  RELIABILITY_SAMPLE_HISTORY_LIMIT,
  RELIABILITY_SAMPLE_MIN_INTERVAL_MS,
  SNAPSHOT_HISTORY_LIMIT,
  SNAPSHOT_MAX_BYTES,
  deploymentFailures,
  deploymentRate,
  failureSummary,
  firstPassVerificationRate,
  keyCoverage,
  opsRecoverySummary,
  parseReliabilitySnapshot,
  rateOf,
  reliabilityWindowRange,
  reviewRate,
  snapshotHistoryPoint,
  snapshotStaleness,
  taskRunSummary,
  unresolvedOpsAsOf,
  weeklyReliability,
  withinWindow,
  type CandidateBuildFact,
  type DeploymentFact,
  type FailureRoundFact,
  type KeyCoverageSummary,
  type OpsEventFact,
  type ReliabilityBudgets,
  type ReliabilityCoverage,
  type ReliabilityGate,
  type ReliabilityMutation,
  type ReliabilityRate,
  type ReliabilitySample,
  type ReliabilitySamplePayload,
  type ReliabilitySnapshot,
  type ReliabilityTests,
  type ReliabilityWindow,
  type ReliabilityWindowRange,
  type ReviewFact,
  type SnapshotHistoryPoint,
  type TaskRunFact,
  type VerificationFact,
} from '../domain/reliability.js'
import type { Repository } from '../records/repository.js'
import { git, headCommit } from './workspace.js'

export type { ReliabilityWindow } from '../domain/reliability.js'

export interface ReliabilityRateView {
  readonly pass: number
  readonly total: number
  readonly rate: number | null
}

export interface ReliabilitySnapshotView {
  readonly availability: 'fresh' | 'stale' | 'missing' | 'invalid'
  readonly path: string
  readonly generatedAt: string
  readonly commit: string
  readonly branch: string
  readonly dirty: boolean
  readonly behindCommits: number | null
  readonly ageSeconds: number | null
  readonly packageVersion: string
  readonly gates: readonly ReliabilityGate[]
  readonly tests: ReliabilityTests | null
  readonly coverage: ReliabilityCoverage | null
  readonly keyCoverage: KeyCoverageSummary | null
  readonly mutation: ReliabilityMutation | null
  readonly budgets: ReliabilityBudgets | null
  readonly suppressions: number
  readonly error: string
  readonly warnings: readonly string[]
}

export interface ReliabilityOpsView {
  readonly opened: number
  readonly closed: number
  readonly recovered: number
  readonly unresolved: number
  readonly mttrSeconds: number | null
}

export interface ReliabilityEventView {
  readonly kind: 'verification' | 'deployment' | 'ops'
  readonly at: string
  readonly reqId: string
  readonly title: string
  readonly detail: string
}

export interface ReliabilityRuntimeView {
  readonly verification: ReliabilityRateView
  readonly firstPassVerification: ReliabilityRateView
  readonly businessReview: ReliabilityRateView
  readonly deployment: ReliabilityRateView
  readonly failureRounds: {
    readonly total: number
    readonly requirements: number
    readonly perRequirement: number | null
    readonly byStage: Record<string, number>
  }
  readonly tasks: {
    readonly total: number
    readonly delivered: number
    readonly failed: number
    readonly blocked: number
    readonly awaitingUser: number
    readonly running: number
  }
  readonly ops: ReliabilityOpsView
  readonly candidateBuilds: number
  readonly deploymentFailures: readonly { readonly checkId: string; readonly count: number }[]
  /**
   * 新部署通道（deployment_intents）的完成情况，与上面的 legacy 上线核对分开统计，
   * 两套记录不合并分母，避免漏计或重复计数。
   */
  readonly deploymentIntents: {
    readonly verified: number
    readonly failed: number
    readonly rolledBack: number
    readonly pending: number
    readonly total: number
    readonly rate: ReliabilityRate
    readonly byState: Record<string, number>
  }
  readonly trend: readonly {
    readonly weekStart: string
    readonly verificationPass: number
    readonly verificationBlock: number
    readonly failureRounds: number
    readonly deploymentsVerified: number
    readonly deploymentsFailed: number
  }[]
  readonly recentEvents: readonly ReliabilityEventView[]
}

/** 运行指标中可被历史样本记录的部分；趋势与事件每次按需计算。 */
export type ReliabilityRuntimeCore = Omit<ReliabilityRuntimeView, 'trend' | 'recentEvents'>

export interface ReliabilityHistoryView {
  /** 最近若干条指标样本，从新到旧。 */
  readonly samples: readonly ReliabilitySample[]
  /** 最近若干份质量快照的压缩记录，从新到旧。 */
  readonly snapshots: readonly SnapshotHistoryPoint[]
  readonly sampleLimit: number
  readonly snapshotHistoryLimit: number
}

/**
 * 页面测量点：所有门禁与运行指标都对应这一个时刻与提交。
 * 有质量快照时取快照生成时间；没有可用快照时退回当前时刻并显式标记未绑定。
 */
export interface ReliabilityMeasurement {
  readonly asOf: string
  readonly commit: string
  readonly branch: string
  readonly source: 'snapshot' | 'current'
}

export interface ReliabilityReportView {
  readonly project: string
  readonly generatedAt: string
  /** 指标版本：快照、业务记录或历史采样变化时改变，供页面做变更检测。 */
  readonly revision: string
  readonly measurement: ReliabilityMeasurement
  readonly window: {
    readonly key: ReliabilityWindow
    readonly from: string | null
    readonly to: string
  }
  readonly snapshot: ReliabilitySnapshotView
  readonly runtime: ReliabilityRuntimeView
  readonly history: ReliabilityHistoryView
  readonly warnings: readonly string[]
}

type SnapshotRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly error: string }
  | { readonly kind: 'ok'; readonly snapshot: ReliabilitySnapshot }

interface CachedSnapshot {
  readonly mtimeMs: number
  readonly size: number
  readonly read: SnapshotRead
}

export interface ReliabilityDashboardOptions {
  readonly repository: Repository
  readonly project: string
  readonly projectPath: string
  readonly now: () => Date
  /** 测试可注入；默认读取项目根 HEAD。 */
  readonly currentHead?: () => string | null
  /** 默认 `<projectPath>/reports/reliability/latest.json`。 */
  readonly snapshotPath?: string
  /** 页面展示的样本条数；只影响读取，不删除已有历史。 */
  readonly sampleLimit?: number
  /** 页面展示的快照历史份数。 */
  readonly snapshotHistoryLimit?: number
  /** 两次“变化采样”之间的最小间隔。 */
  readonly minSampleIntervalMs?: number
  /** 无变化时保留心跳样本的间隔。 */
  readonly sampleHeartbeatMs?: number
}

interface ReliabilityFacts {
  readonly verifications: readonly VerificationFact[]
  readonly reviews: readonly ReviewFact[]
  readonly deployments: readonly DeploymentFact[]
  readonly rounds: readonly FailureRoundFact[]
  readonly opsEvents: readonly OpsEventFact[]
  readonly taskRuns: readonly TaskRunFact[]
  readonly builds: readonly CandidateBuildFact[]
}

interface CachedSnapshotHistory {
  readonly key: string
  readonly points: readonly SnapshotHistoryPoint[]
}

/** 从运行指标中挑出需要进入历史样本的字段；趋势事件不进样本。 */
function samplePayloadOf(
  core: ReliabilityRuntimeCore,
  measurement: ReliabilityMeasurement,
): ReliabilitySamplePayload {
  return {
    asOf: measurement.asOf,
    commit: measurement.commit,
    verification: core.verification,
    firstPassVerification: core.firstPassVerification,
    businessReview: core.businessReview,
    deployment: core.deployment,
    failureRounds: {
      total: core.failureRounds.total,
      requirements: core.failureRounds.requirements,
    },
    tasks: core.tasks,
    ops: core.ops,
    candidateBuilds: core.candidateBuilds,
    deploymentIntents: {
      verified: core.deploymentIntents.verified,
      failed: core.deploymentIntents.failed,
      rolledBack: core.deploymentIntents.rolledBack,
      pending: core.deploymentIntents.pending,
    },
  }
}

export class ReliabilityDashboard {
  private readonly repository: Repository
  private readonly project: string
  private readonly projectPath: string
  private readonly now: () => Date
  private readonly snapshotPath: string
  private readonly currentHead: () => string | null
  private readonly sampleLimit: number
  private readonly snapshotHistoryLimit: number
  private readonly minSampleIntervalMs: number
  private readonly sampleHeartbeatMs: number
  private snapshotCache: CachedSnapshot | null = null
  private historyCache: CachedSnapshotHistory | null = null
  private headValue: string | null = null
  private headLoaded = false
  private headAt = 0
  private readonly behindCache = new Map<string, number | null>()

  constructor(options: ReliabilityDashboardOptions) {
    this.repository = options.repository
    this.project = options.project
    this.projectPath = options.projectPath
    this.now = options.now
    this.snapshotPath =
      options.snapshotPath ?? join(options.projectPath, 'reports', 'reliability', 'latest.json')
    this.currentHead = options.currentHead ?? (() => this.readCurrentHead())
    this.sampleLimit = options.sampleLimit ?? RELIABILITY_SAMPLE_HISTORY_LIMIT
    this.snapshotHistoryLimit = options.snapshotHistoryLimit ?? SNAPSHOT_HISTORY_LIMIT
    this.minSampleIntervalMs = options.minSampleIntervalMs ?? RELIABILITY_SAMPLE_MIN_INTERVAL_MS
    this.sampleHeartbeatMs = options.sampleHeartbeatMs ?? RELIABILITY_SAMPLE_HEARTBEAT_MS
  }

  report(window: ReliabilityWindow): ReliabilityReportView {
    const now = this.now()
    // 先确定测量点，再让所有指标以它为终点；不允许把旧快照和当前指标混在一页。
    const snapshot = this.snapshotView(now)
    const measurement = this.measurementOf(snapshot, now)
    const asOf = new Date(measurement.asOf)
    const range = reliabilityWindowRange(window, asOf)
    const facts = this.facts()
    const core = this.runtimeCore(facts, range)
    const samples = this.repository.reliabilitySamples(this.project, this.sampleLimit)
    const snapshots = this.snapshotHistory()
    const runtime: ReliabilityRuntimeView = {
      ...core,
      trend: weeklyReliability({
        verifications: facts.verifications,
        failureRounds: facts.rounds,
        deployments: facts.deployments,
        now: asOf,
        weeks: 8,
      }),
      recentEvents: this.recentEvents({
        verifications: facts.verifications,
        deployments: facts.deployments,
        opsEvents: facts.opsEvents,
        from: range.from,
        to: asOf,
      }),
    }
    const warnings = this.warnings(snapshot, runtime, measurement)
    return {
      project: this.project,
      generatedAt: now.toISOString(),
      revision: this.revisionOf(facts, measurement),
      measurement,
      window: {
        key: window,
        from: range.from?.toISOString() ?? null,
        to: range.to.toISOString(),
      },
      snapshot,
      runtime,
      history: {
        samples,
        snapshots,
        sampleLimit: this.sampleLimit,
        snapshotHistoryLimit: this.snapshotHistoryLimit,
      },
      warnings,
    }
  }

  /**
   * 指标变化（或心跳到期）时追加一条历史样本；只写历史表，不改业务状态。
   * 样本记录当时的测量点，历史里的每个数字都能回指同一份快照。
   */
  recordSampleIfDue(): boolean {
    const now = this.now()
    const latest = this.repository.latestReliabilitySample(this.project)
    const measurement = this.measurementOf(this.snapshotView(now), now)
    const facts = this.facts()
    const revision = this.revisionOf(facts, measurement)
    const lastAt = latest ? Date.parse(latest.sampledAt) : Number.NaN
    const elapsed = Number.isFinite(lastAt) ? now.getTime() - lastAt : Number.POSITIVE_INFINITY
    const changed = latest === null || latest.revision !== revision
    const due =
      latest === null ||
      (changed && elapsed >= this.minSampleIntervalMs) ||
      elapsed >= this.sampleHeartbeatMs
    if (!due) return false
    const range = reliabilityWindowRange('all', new Date(measurement.asOf))
    this.repository.recordReliabilitySample({
      project: this.project,
      sampledAt: now.toISOString(),
      revision,
      payload: samplePayloadOf(this.runtimeCore(facts, range), measurement),
    })
    return true
  }

  /** 有可用快照时以快照生成时间为测量点；否则退回当前时刻并标记未绑定。 */
  private measurementOf(snapshot: ReliabilitySnapshotView, now: Date): ReliabilityMeasurement {
    const generated = Date.parse(snapshot.generatedAt)
    const hasSnapshot =
      (snapshot.availability === 'fresh' || snapshot.availability === 'stale') &&
      Number.isFinite(generated)
    if (hasSnapshot) {
      return {
        asOf: snapshot.generatedAt,
        commit: snapshot.commit,
        branch: snapshot.branch,
        source: 'snapshot',
      }
    }
    return { asOf: now.toISOString(), commit: '', branch: '', source: 'current' }
  }

  private facts(): ReliabilityFacts {
    return {
      verifications: this.repository.reliabilityVerifications(),
      reviews: this.repository.reliabilityBusinessReviews(),
      deployments: this.repository.reliabilityDeployments(),
      rounds: this.repository.reliabilityFailureRounds(),
      opsEvents: this.repository.reliabilityOpsEvents(this.project),
      taskRuns: this.repository.reliabilityTaskRuns(),
      builds: this.repository.reliabilityCandidateBuilds(),
    }
  }

  private runtimeCore(
    facts: ReliabilityFacts,
    range: ReliabilityWindowRange,
  ): ReliabilityRuntimeCore {
    const windowedVerifications = facts.verifications.filter((fact) =>
      withinWindow(fact.verifiedAt, range.from, range.to),
    )
    const windowedRounds = facts.rounds.filter((fact) =>
      withinWindow(fact.occurredAt, range.from, range.to),
    )
    const ops = opsRecoverySummary(facts.opsEvents, range.from, range.to)
    return {
      verification: rateOf(
        windowedVerifications.filter((fact) => fact.verdict === 'pass').length,
        windowedVerifications.length,
      ),
      firstPassVerification: firstPassVerificationRate(facts.verifications, range.from, range.to),
      businessReview: reviewRate(facts.reviews, range.from, range.to),
      deployment: deploymentRate(facts.deployments, range.from, range.to),
      failureRounds: failureSummary(windowedRounds),
      tasks: taskRunSummary(facts.taskRuns),
      ops: { ...ops, unresolved: unresolvedOpsAsOf(facts.opsEvents, range.to) },
      candidateBuilds: facts.builds.filter((fact) =>
        withinWindow(fact.builtAt, range.from, range.to),
      ).length,
      deploymentFailures: deploymentFailures(facts.deployments, range.from, range.to),
      deploymentIntents: this.deploymentIntentSummary(range.from, range.to),
    }
  }

  /**
   * 指标版本：快照文件、测量点或测量点之前的业务事实变化时改变。
   * 测量点之后新增的记录不改变整页数值，也不应触发样本；任务当前状态除外。
   */
  private revisionOf(facts: ReliabilityFacts, measurement: ReliabilityMeasurement): string {
    const snapshot = this.statSnapshot()
    const asOf = new Date(measurement.asOf)
    const upTo = (at: string): boolean => withinWindow(at, null, asOf)
    const hash = createHash('sha1')
    hash.update(`${snapshot?.mtimeMs ?? 0}:${snapshot?.size ?? 0}`)
    if (measurement.source === 'snapshot') {
      hash.update(`|${measurement.asOf}|${measurement.commit}`)
    }
    hash.update(
      [
        facts.verifications.filter((fact) => upTo(fact.verifiedAt)).length,
        facts.verifications.filter((fact) => upTo(fact.verifiedAt)).at(-1)?.verifiedAt ?? '',
        facts.reviews.filter((fact) => upTo(fact.reviewedAt)).length,
        facts.deployments.filter((fact) => upTo(fact.recordedAt)).length,
        facts.rounds.filter((fact) => upTo(fact.occurredAt)).length,
        facts.opsEvents.filter((fact) => upTo(fact.openedAt)).length,
        facts.opsEvents
          .filter((fact) => upTo(fact.openedAt))
          .map((fact) => `${fact.state}:${fact.recoveredAt}:${fact.closedAt ?? ''}`)
          .join(','),
        facts.taskRuns.map((fact) => fact.state).join(','),
        facts.builds.filter((fact) => upTo(fact.builtAt)).length,
      ].join('|'),
    )
    return hash.digest('hex').slice(0, 16)
  }

  private statSnapshot(): { mtimeMs: number; size: number } | null {
    try {
      const stats = statSync(this.snapshotPath)
      return { mtimeMs: stats.mtimeMs, size: stats.size }
    } catch {
      return null
    }
  }

  /** 快照历史：读取 latest 同级 history 目录，按生成时间从新到旧；损坏文件跳过。 */
  private snapshotHistory(): readonly SnapshotHistoryPoint[] {
    const historyDir = join(dirname(this.snapshotPath), 'history')
    let names: string[]
    try {
      names = readdirSync(historyDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    } catch {
      return []
    }
    const selected = names.slice(-this.snapshotHistoryLimit)
    const key = `${selected.join('|')}:${this.snapshotHistoryLimit}`
    if (this.historyCache?.key === key) return this.historyCache.points
    const points: SnapshotHistoryPoint[] = []
    for (const name of selected) {
      try {
        const path = join(historyDir, name)
        if (statSync(path).size > SNAPSHOT_MAX_BYTES) continue
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        points.push(snapshotHistoryPoint(parseReliabilitySnapshot(parsed)))
      } catch {
        // 损坏或不可读的历史不参与展示，也不影响 latest。
      }
    }
    points.sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt))
    this.historyCache = { key, points }
    return points
  }

  private readCurrentHead(): string | null {
    if (this.headLoaded && Date.now() - this.headAt < 60_000) return this.headValue
    try {
      this.headValue = headCommit(this.projectPath)
    } catch {
      this.headValue = null
    }
    this.headLoaded = true
    this.headAt = Date.now()
    return this.headValue
  }

  private commitsBehind(oldHead: string, currentHead: string): number | null {
    const key = `${oldHead}..${currentHead}`
    if (this.behindCache.has(key)) return this.behindCache.get(key) ?? null
    const result = git(this.projectPath, ['rev-list', '--count', `${oldHead}..${currentHead}`])
    const value =
      result.code === 0 && /^\d+$/.test(result.stdout.trim()) ? Number(result.stdout.trim()) : null
    this.behindCache.set(key, value)
    return value
  }

  private readSnapshot(): SnapshotRead {
    let stats: Stats
    try {
      stats = statSync(this.snapshotPath)
    } catch (error) {
      if (errorMessage(error).includes('ENOENT')) return { kind: 'missing' }
      return { kind: 'invalid', error: `无法读取质量快照：${errorMessage(error)}` }
    }
    if (
      this.snapshotCache &&
      this.snapshotCache.mtimeMs === stats.mtimeMs &&
      this.snapshotCache.size === stats.size
    ) {
      return this.snapshotCache.read
    }
    let read: SnapshotRead
    if (stats.size > SNAPSHOT_MAX_BYTES) {
      read = {
        kind: 'invalid',
        error: `质量快照超过 ${SNAPSHOT_MAX_BYTES} 字节，拒绝读取`,
      }
    } else {
      try {
        const text = readFileSync(this.snapshotPath, 'utf8')
        const parsed: unknown = JSON.parse(text)
        read = { kind: 'ok', snapshot: parseReliabilitySnapshot(parsed) }
      } catch (error) {
        read = { kind: 'invalid', error: `质量快照无法解析：${errorMessage(error)}` }
      }
    }
    this.snapshotCache = { mtimeMs: stats.mtimeMs, size: stats.size, read }
    return read
  }

  private snapshotView(now: Date): ReliabilitySnapshotView {
    const read = this.readSnapshot()
    if (read.kind === 'missing') {
      return {
        availability: 'missing',
        path: this.snapshotPath,
        generatedAt: '',
        commit: '',
        branch: '',
        dirty: false,
        behindCommits: null,
        ageSeconds: null,
        packageVersion: '',
        gates: [],
        tests: null,
        coverage: null,
        keyCoverage: null,
        mutation: null,
        budgets: null,
        suppressions: 0,
        error: '',
        warnings: [],
      }
    }
    if (read.kind === 'invalid') {
      return {
        availability: 'invalid',
        path: this.snapshotPath,
        generatedAt: '',
        commit: '',
        branch: '',
        dirty: false,
        behindCommits: null,
        ageSeconds: null,
        packageVersion: '',
        gates: [],
        tests: null,
        coverage: null,
        keyCoverage: null,
        mutation: null,
        budgets: null,
        suppressions: 0,
        error: read.error,
        warnings: [read.error],
      }
    }
    const snapshot = read.snapshot
    const current = this.currentHead()
    const staleness = snapshotStaleness(snapshot, current, now)
    return {
      availability: staleness.stale ? 'stale' : 'fresh',
      path: this.snapshotPath,
      generatedAt: snapshot.generatedAt,
      commit: snapshot.git.head,
      branch: snapshot.git.branch,
      dirty: snapshot.git.dirty,
      behindCommits:
        current && snapshot.git.head !== current
          ? this.commitsBehind(snapshot.git.head, current)
          : current
            ? 0
            : null,
      ageSeconds: staleness.ageSeconds,
      packageVersion: snapshot.package.version,
      gates: snapshot.gates,
      tests: snapshot.tests,
      coverage: snapshot.coverage,
      keyCoverage: snapshot.coverage ? keyCoverage(snapshot.coverage.files) : null,
      mutation: snapshot.mutation,
      budgets: snapshot.budgets,
      suppressions: snapshot.suppressions,
      error: '',
      warnings: staleness.reasons,
    }
  }

  /** 部署通道统计：只把已收口的 intent 计入分母，进行中的单独报 pending。 */
  private deploymentIntentSummary(
    from: Date | null,
    to: Date,
  ): ReliabilityRuntimeView['deploymentIntents'] {
    const intents = this.repository.deploymentStore
      .deploymentIntents(500)
      .filter(
        (intent) => intent.project === this.project && withinWindow(intent.createdAt, from, to),
      )
    const byState: Record<string, number> = {}
    for (const intent of intents) byState[intent.state] = (byState[intent.state] ?? 0) + 1
    const verified = intents.filter((intent) => intent.state === 'verified').length
    const failed = intents.filter(
      (intent) => intent.state === 'failed' || intent.state === 'verify_failed',
    ).length
    const rolledBack = intents.filter((intent) => intent.state === 'rolled_back').length
    const pending = intents.filter(
      (intent) => !['verified', 'failed', 'verify_failed', 'rolled_back'].includes(intent.state),
    ).length
    return {
      verified,
      failed,
      rolledBack,
      pending,
      total: verified + failed + rolledBack,
      rate: rateOf(verified, verified + failed + rolledBack),
      byState,
    }
  }

  private recentEvents(input: {
    verifications: readonly { reqId: string; verdict: 'pass' | 'block'; verifiedAt: string }[]
    deployments: readonly {
      reqId: string
      state: string
      recordedAt: string
      checks: readonly unknown[]
    }[]
    opsEvents: readonly {
      eventId: string
      state: string
      title: string
      openedAt: string
      recoveredAt: string
      closedAt?: string | undefined
    }[]
    from: Date | null
    to: Date
  }): ReliabilityEventView[] {
    const events: ReliabilityEventView[] = []
    for (const fact of input.verifications) {
      if (fact.verdict !== 'block' || !withinWindow(fact.verifiedAt, input.from, input.to)) continue
      events.push({
        kind: 'verification',
        at: fact.verifiedAt,
        reqId: fact.reqId,
        title: '独立测试阻断',
        detail: '',
      })
    }
    for (const fact of input.deployments) {
      if (fact.state === 'verified' || !withinWindow(fact.recordedAt, input.from, input.to))
        continue
      const failed = fact.checks
        .map((item) => {
          const record = asRecord(item)
          return record?.ok === false && typeof record.id === 'string' ? record.id : ''
        })
        .filter(Boolean)
      events.push({
        kind: 'deployment',
        at: fact.recordedAt,
        reqId: fact.reqId,
        title: '上线核对失败',
        detail: failed.slice(0, 3).join('、'),
      })
    }
    for (const fact of input.opsEvents) {
      // 只展示测量点上仍未恢复/未关闭的事件；之后才恢复的不回填成“当时已解决”。
      if (!withinWindow(fact.openedAt, null, input.to)) continue
      if (fact.recoveredAt !== '' && withinWindow(fact.recoveredAt, null, input.to)) continue
      if (fact.closedAt && withinWindow(fact.closedAt, null, input.to)) continue
      events.push({
        kind: 'ops',
        at: fact.openedAt,
        reqId: '',
        title: fact.title || `运维事件 ${fact.eventId}`,
        detail: '截至测量点未恢复',
      })
    }
    return events
      .sort((left, right) => {
        const leftTime = Date.parse(left.at)
        const rightTime = Date.parse(right.at)
        return (
          (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
        )
      })
      .slice(0, 8)
  }

  private warnings(
    snapshot: ReliabilitySnapshotView,
    runtime: ReliabilityRuntimeView,
    measurement: ReliabilityMeasurement,
  ): string[] {
    const warnings: string[] = [...snapshot.warnings]
    const point = `${measurement.commit.slice(0, 7) || '—'}@${measurement.asOf}`
    if (measurement.source === 'snapshot' && snapshot.availability === 'stale') {
      warnings.push(
        `门禁与运行指标均按测量点 ${point} 计算，不是当前 HEAD；重新生成快照后整页同步切换。`,
      )
    }
    if (snapshot.availability === 'missing') {
      warnings.push(
        '未找到质量快照；运行指标截至当前，未绑定测量点。运行 make reliability-report 生成。',
      )
    }
    if (snapshot.availability === 'invalid') {
      warnings.push(`质量快照不可用：${snapshot.error}；运行指标截至当前，未绑定测量点。`)
    }
    const rates = [
      runtime.verification,
      runtime.firstPassVerification,
      runtime.businessReview,
      runtime.deployment,
    ]
    if (rates.some((rate) => rate.total > 0 && rate.total < 5)) {
      warnings.push('部分可靠性指标样本少于 5，趋势仅供参考。')
    }
    if (rates.every((rate) => rate.total === 0)) {
      warnings.push('当前测量点窗口内没有交付可靠性记录。')
    }
    return [...new Set(warnings)]
  }
}

const dashboards = new WeakMap<Repository, ReliabilityDashboard>()

/** 同一仓库实例复用快照、HEAD 与历史缓存；每次请求只做增量读取。 */
function dashboardFor(
  repository: Repository,
  config: ForgeLoopConfig,
  now: () => Date,
): ReliabilityDashboard {
  let dashboard = dashboards.get(repository)
  if (!dashboard) {
    dashboard = new ReliabilityDashboard({
      repository,
      project: config.project,
      projectPath: config.projectPath,
      snapshotPath: join(
        config.projectPath,
        config.reliabilitySnapshot || 'reports/reliability/latest.json',
      ),
      now,
    })
    dashboards.set(repository, dashboard)
  }
  return dashboard
}

export function reliabilityReport(
  repository: Repository,
  config: ForgeLoopConfig,
  now: () => Date,
  window: ReliabilityWindow,
): ReliabilityReportView {
  return dashboardFor(repository, config, now).report(window)
}

/**
 * 供协调器周期调用：指标变化或心跳到期时追加一条历史样本。
 * 只写 `reliability_metric_samples`，不改需求、验证、部署或运维状态。
 */
export function reliabilitySample(
  repository: Repository,
  config: ForgeLoopConfig,
  now: () => Date,
): boolean {
  return dashboardFor(repository, config, now).recordSampleIfDue()
}
