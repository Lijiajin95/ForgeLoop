/**
 * 代码可靠性看板的运行时视图：读取质量快照、组合只读业务记录与最近事件。
 *
 * 快照是本地登记材料；文件缺失或损坏不抛到整页，而是作为快照状态返回。
 * 运行指标只使用追加型记录；任务运行是当前状态，不参与历史趋势。
 */

import { readFileSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { errorMessage } from '../domain/errors.js'
import { asRecord } from '../domain/json.js'
import {
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
  snapshotStaleness,
  taskRunSummary,
  unresolvedOpsCount,
  weeklyReliability,
  withinWindow,
  type KeyCoverageSummary,
  type ReliabilityBudgets,
  type ReliabilityCoverage,
  type ReliabilityGate,
  type ReliabilityMutation,
  type ReliabilityRate,
  type ReliabilitySnapshot,
  type ReliabilityTests,
  type ReliabilityWindow,
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

export interface ReliabilityReportView {
  readonly project: string
  readonly generatedAt: string
  readonly window: {
    readonly key: ReliabilityWindow
    readonly from: string | null
    readonly to: string
  }
  readonly snapshot: ReliabilitySnapshotView
  readonly runtime: ReliabilityRuntimeView
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
}

export class ReliabilityDashboard {
  private readonly repository: Repository
  private readonly project: string
  private readonly projectPath: string
  private readonly now: () => Date
  private readonly snapshotPath: string
  private readonly currentHead: () => string | null
  private snapshotCache: CachedSnapshot | null = null
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
  }

  report(window: ReliabilityWindow): ReliabilityReportView {
    const now = this.now()
    const range = reliabilityWindowRange(window, now)
    const verifications = this.repository.reliabilityVerifications()
    const reviews = this.repository.reliabilityBusinessReviews()
    const deployments = this.repository.reliabilityDeployments()
    const rounds = this.repository.reliabilityFailureRounds()
    const opsEvents = this.repository.reliabilityOpsEvents(this.project)
    const taskRuns = this.repository.reliabilityTaskRuns()
    const builds = this.repository.reliabilityCandidateBuilds()

    const windowedVerifications = verifications.filter((fact) =>
      withinWindow(fact.verifiedAt, range.from, range.to),
    )
    const windowedRounds = rounds.filter((fact) =>
      withinWindow(fact.occurredAt, range.from, range.to),
    )
    const verification = rateOf(
      windowedVerifications.filter((fact) => fact.verdict === 'pass').length,
      windowedVerifications.length,
    )
    const firstPassVerification = firstPassVerificationRate(verifications, range.from, range.to)
    const businessReview = reviewRate(reviews, range.from, range.to)
    const deployment = deploymentRate(deployments, range.from, range.to)
    const deploymentIntents = this.deploymentIntentSummary(range.from, range.to)
    const ops = opsRecoverySummary(opsEvents, range.from, range.to)
    const snapshot = this.snapshotView(now)
    const runtime: ReliabilityRuntimeView = {
      verification,
      firstPassVerification,
      businessReview,
      deployment,
      failureRounds: failureSummary(windowedRounds),
      tasks: taskRunSummary(taskRuns),
      ops: { ...ops, unresolved: unresolvedOpsCount(opsEvents) },
      candidateBuilds: builds.filter((fact) => withinWindow(fact.builtAt, range.from, range.to))
        .length,
      deploymentFailures: deploymentFailures(deployments, range.from, range.to),
      deploymentIntents,
      trend: weeklyReliability({
        verifications,
        failureRounds: rounds,
        deployments,
        now,
        weeks: 8,
      }),
      recentEvents: this.recentEvents({
        verifications,
        deployments,
        opsEvents,
        from: range.from,
        to: range.to,
      }),
    }
    const warnings = this.warnings(snapshot, runtime)
    return {
      project: this.project,
      generatedAt: now.toISOString(),
      window: {
        key: window,
        from: range.from?.toISOString() ?? null,
        to: range.to.toISOString(),
      },
      snapshot,
      runtime,
      warnings,
    }
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
      if (fact.state === 'recovered' || fact.state === 'closed') continue
      events.push({
        kind: 'ops',
        at: fact.openedAt,
        reqId: '',
        title: fact.title || `运维事件 ${fact.eventId}`,
        detail: fact.state,
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

  private warnings(snapshot: ReliabilitySnapshotView, runtime: ReliabilityRuntimeView): string[] {
    const warnings: string[] = [...snapshot.warnings]
    if (snapshot.availability === 'missing') {
      warnings.push('未找到质量快照；运行 make reliability-report 生成。')
    }
    if (snapshot.availability === 'invalid') {
      warnings.push(`质量快照不可用：${snapshot.error}`)
    }
    if (snapshot.availability === 'stale') {
      warnings.push('质量快照已过期，门禁数值只代表生成时的代码。')
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
      warnings.push('当前窗口没有交付可靠性记录。')
    }
    return [...new Set(warnings)]
  }
}

const dashboards = new WeakMap<Repository, ReliabilityDashboard>()

/** 同一仓库实例复用快照与 HEAD 缓存；每次请求只做增量读取。 */
export function reliabilityReport(
  repository: Repository,
  config: ForgeLoopConfig,
  now: () => Date,
  window: ReliabilityWindow,
): ReliabilityReportView {
  let dashboard = dashboards.get(repository)
  if (!dashboard) {
    dashboard = new ReliabilityDashboard({
      repository,
      project: config.project,
      projectPath: config.projectPath,
      now,
    })
    dashboards.set(repository, dashboard)
  }
  return dashboard.report(window)
}
