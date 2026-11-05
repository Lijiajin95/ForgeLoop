/**
 * 定时主动监控：采集快照 → 运维 Agent 评审 → 新问题建事件 / 旧问题归并 → 外部告警。
 *
 * 模型只有两个只读工具（制品状态与登记日志），不能执行命令或改文件；
 * 能否自动处置仍由目录授权在 `authorizeOpsAction` 中判定。
 * 监控事件与检查失败事件共用同一套事件、诊断、处置与恢复记录；区别只在于事实来源
 * 是快照而不是检查退出码。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { opsDir, projectDir } from '../config.js'
import { errorMessage } from '../domain/errors.js'
import { asRecord, parseJsonObject } from '../domain/json.js'
import {
  OPS_AWAITING_DECISION,
  OPS_DIAGNOSED,
  OPS_OPEN,
  actionArgv,
  authorizeOpsAction,
  serializeOpsDiagnosis,
  type OpsAction,
} from '../domain/ops.js'
import {
  monitorSignatureOf,
  parseMonitorReport,
  type MonitorIssue,
  type MonitorReport,
} from '../domain/monitor.js'
import type { OpsEventRecord, OpsEventPatch, Repository } from '../records/repository.js'
import type { AgentRunRequest, AgentRunResult } from './agent-runner.js'
import { collectMonitorSnapshot, type MonitorSnapshot } from './monitor.js'
import { OPS_ARTIFACT_TOOL_NAMES } from './ops-artifacts.js'
import { sendOpsAlert } from './ops-alerts.js'
import { sendOpsHeartbeat } from './ops-heartbeat.js'
import { monitorPrompt } from './prompts.js'

export const MONITOR_CHECK_ID = 'monitor'
const MONITOR_META = 'ops_monitor_last'
const HEARTBEAT_META = 'ops_heartbeat_last'
const MAX_META_TEXT = 300

interface MonitorRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>
}

export interface OpsMonitorOptions {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly runner: MonitorRunner
  readonly now: () => Date
}

export interface OpsMonitorSummary {
  readonly enabled: boolean
  readonly intervalSeconds: number
  readonly lastScanAt: string
  readonly status: string
  readonly summary: string
  readonly issues: number
  /** 产生最近一份快照的提供方；当前只有自研采集器。 */
  readonly providers: readonly string[]
  readonly host: {
    readonly cpuPercent: number
    readonly memoryUsedPercent: number
    readonly load1: number
  }
  readonly sources: {
    readonly processes: number
    readonly latency: number
    readonly logs: number
    readonly alerts: number
    readonly checks: number
  }
  /** 外部心跳：是否配置、最近一次上报时间与结果，以及是否已过期。 */
  readonly heartbeat: {
    readonly configured: boolean
    readonly at: string
    readonly ok: boolean
    readonly ageSeconds: number | null
    readonly stale: boolean
  }
  /** 本轮采集是否完整；缺来源时不为“健康”背书。 */
  readonly collection: {
    readonly complete: boolean
    readonly errors: readonly string[]
  }
  /** 最近一次扫描的新鲜度；过期后不再显示旧的健康状态。 */
  readonly freshness: {
    readonly ageSeconds: number | null
    readonly stale: boolean
  }
  readonly error: string
}

export interface MonitorScanOutcome {
  readonly scanned: boolean
  readonly status: string
  readonly issues: number
  readonly opened: number
  readonly merged: number
  readonly alerted: number
  readonly errors: readonly string[]
}

const EMPTY_OUTCOME: MonitorScanOutcome = {
  scanned: false,
  status: '',
  issues: 0,
  opened: 0,
  merged: 0,
  alerted: 0,
  errors: [],
}

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
}

function bounded(value: string, max = MAX_META_TEXT): string {
  const text = value.trim().replace(/\s+/g, ' ')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function severityRank(severity: string): number {
  if (severity === 'critical') return 0
  if (severity === 'major') return 1
  return 2
}

function metaText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 距给定 ISO 时间过去的秒数；时间为空或不可解析时返回 null，不拿 0 冒充新鲜。 */
function ageSecondsOf(iso: string, now: Date): number | null {
  const parsed = Date.parse(iso)
  if (!iso || !Number.isFinite(parsed)) return null
  return Math.max(0, Math.round((now.getTime() - parsed) / 1000))
}

function metaStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function metaNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function nestedNumber(record: Record<string, unknown>, group: string, key: string): number {
  const nested = asRecord(record[group])
  return nested ? metaNumber(nested[key]) : 0
}

export function monitorDir(config: ForgeLoopConfig): string {
  return join(projectDir(config), 'ops', 'monitor')
}

/**
 * 监控运行时。每次扫描独立取证；报告畸形、模型失败与来源失败都只记录，
 * 不把“没有看到问题”当成健康，也不创建空事件。
 */
export class OpsMonitor {
  private readonly config: ForgeLoopConfig
  private readonly repo: Repository
  private readonly runner: MonitorRunner
  private readonly clock: () => Date

  constructor(options: OpsMonitorOptions) {
    this.config = options.config
    this.repo = options.repo
    this.runner = options.runner
    this.clock = options.now
  }

  private action(actionId: string): OpsAction | undefined {
    return this.config.ops.actions.find((action) => action.id === actionId)
  }

  summary(): OpsMonitorSummary {
    const monitor = this.config.ops.monitor
    const base: OpsMonitorSummary = {
      enabled: monitor.enabled,
      intervalSeconds: monitor.intervalSeconds,
      lastScanAt: '',
      status: '',
      summary: '',
      issues: 0,
      providers: [...monitor.providers],
      host: { cpuPercent: 0, memoryUsedPercent: 0, load1: 0 },
      sources: { processes: 0, latency: 0, logs: 0, alerts: 0, checks: 0 },
      heartbeat: {
        configured: monitor.heartbeat.url !== '',
        at: '',
        ok: false,
        ageSeconds: null,
        stale: false,
      },
      collection: { complete: true, errors: [] },
      freshness: { ageSeconds: null, stale: false },
      error: '',
    }
    const raw = this.repo.getMeta(MONITOR_META)
    const heartbeat = this.heartbeatStatus()
    if (!raw) return { ...base, heartbeat: { ...base.heartbeat, ...heartbeat } }
    try {
      const data = parseJsonObject(raw)
      const collection = asRecord(data.collection)
      const collectionErrors = collection ? metaStrings(collection.errors) : []
      const complete = collectionErrors.length === 0
      const lastScanAt = metaText(data.at)
      const ageSeconds = ageSecondsOf(lastScanAt, this.clock())
      const stale = ageSeconds !== null && ageSeconds > this.staleAfterSeconds()
      const derived = this.deriveStatus({
        status: metaText(data.status),
        error: metaText(data.error),
        complete,
        collectionErrors,
        stale,
        ageSeconds,
        intervalSeconds: monitor.intervalSeconds,
      })
      return {
        ...base,
        lastScanAt,
        status: derived.status,
        summary: metaText(data.summary),
        issues: metaNumber(data.issues),
        providers:
          metaStrings(data.providers).length > 0 ? metaStrings(data.providers) : base.providers,
        host: {
          cpuPercent: nestedNumber(data, 'host', 'cpuPercent'),
          memoryUsedPercent: nestedNumber(data, 'host', 'memoryUsedPercent'),
          load1: nestedNumber(data, 'host', 'load1'),
        },
        sources: {
          processes: nestedNumber(data, 'sources', 'processes'),
          latency: nestedNumber(data, 'sources', 'latency'),
          logs: nestedNumber(data, 'sources', 'logs'),
          alerts: nestedNumber(data, 'sources', 'alerts'),
          checks: nestedNumber(data, 'sources', 'checks'),
        },
        heartbeat: { ...base.heartbeat, ...heartbeat },
        collection: { complete, errors: collectionErrors },
        freshness: { ageSeconds, stale },
        error: derived.error,
      }
    } catch {
      return {
        ...base,
        status: 'error',
        heartbeat: { ...base.heartbeat, ...heartbeat },
        error: '最近一次监控摘要不可读',
      }
    }
  }

  /**
   * 摘要状态：采集不完整不能显示成健康；旧结论超过新鲜度窗口不再当作当前健康。
   * 扫描内部错误（error）保持最高优先级，不会被过期覆盖。
   */
  private deriveStatus(input: {
    status: string
    error: string
    complete: boolean
    collectionErrors: readonly string[]
    stale: boolean
    ageSeconds: number | null
    intervalSeconds: number
  }): { status: string; error: string } {
    let status = input.status
    let error = input.error
    if (!input.complete && (status === 'healthy' || status === '')) status = 'incomplete'
    if (!input.complete && !error) error = `采集不完整：${input.collectionErrors.join('；')}`
    if (!input.stale || status === 'error') return { status, error }
    if (status === 'healthy' || status === 'incomplete' || status === '') status = 'stale'
    if (!error) {
      error = `最近一次监控扫描已过期 ${input.ageSeconds} 秒（周期 ${input.intervalSeconds} 秒）`
    }
    return { status, error }
  }

  /** 扫描结果超过两个周期仍未更新即视为过期；最短 60 秒，避免小周期抖动。 */
  private staleAfterSeconds(): number {
    return Math.max(this.config.ops.monitor.intervalSeconds * 2, 60)
  }

  /** 心跳状态独立于扫描摘要：扫描失败时它仍然记录最近一次上报。 */
  private heartbeatStatus(): {
    at: string
    ok: boolean
    ageSeconds: number | null
    stale: boolean
  } {
    const raw = this.repo.getMeta(HEARTBEAT_META)
    if (!raw) return { at: '', ok: false, ageSeconds: null, stale: false }
    try {
      const data = parseJsonObject(raw)
      const at = metaText(data.at)
      const ageSeconds = ageSecondsOf(at, this.clock())
      const stale = ageSeconds !== null && ageSeconds > this.staleAfterSeconds()
      return { at, ok: data.ok === true, ageSeconds, stale }
    } catch {
      return { at: '', ok: false, ageSeconds: null, stale: false }
    }
  }

  /**
   * 跑一轮监控。扫描间隔由调用方按 `ops_monitor_at` 判定；这里在每个结果上都写时间戳，
   * 避免模型失败时每 5 秒重试一次。心跳在扫描之后单独上报，失败只记录，不改变扫描结论。
   */
  async scan(signal?: AbortSignal): Promise<MonitorScanOutcome> {
    if (!this.config.ops.monitor.enabled) return { ...EMPTY_OUTCOME }
    if (signal?.aborted) return { ...EMPTY_OUTCOME, errors: ['主动监控已取消'] }
    const started = this.clock()
    const outcome = await this.runScan(started, signal)
    const beatError = await this.beat(started, outcome, signal)
    return beatError ? { ...outcome, errors: [...outcome.errors, beatError] } : outcome
  }

  private async runScan(started: Date, signal?: AbortSignal): Promise<MonitorScanOutcome> {
    try {
      return await this.scanOnce(started, signal)
    } catch (error) {
      const message = `主动监控异常：${errorMessage(error)}`
      this.recordFailure(started, message)
      return { ...EMPTY_OUTCOME, scanned: true, status: 'error', errors: [message] }
    } finally {
      this.repo.setMeta('ops_monitor_at', this.clock().toISOString())
    }
  }

  /**
   * 上报一次外部心跳。宿主已中止时不上报：把主动停机谎报成“仍然存活”比不报更糟。
   * 地址为空表示关闭，不做任何记录。
   */
  private async beat(at: Date, outcome: MonitorScanOutcome, signal?: AbortSignal): Promise<string> {
    const heartbeat = this.config.ops.monitor.heartbeat
    if (!heartbeat.url || signal?.aborted) return ''
    const result = await sendOpsHeartbeat({
      url: heartbeat.url,
      method: heartbeat.method,
      timeoutSeconds: heartbeat.timeoutSeconds,
      project: this.config.project,
      at,
      status: outcome.status || 'unknown',
      issues: outcome.issues,
    })
    this.repo.setMeta(
      HEARTBEAT_META,
      JSON.stringify({
        at: at.toISOString(),
        ok: result.ok,
        status: result.status,
        error: bounded(result.error),
      }),
    )
    return result.ok ? '' : result.error
  }

  private async scanOnce(started: Date, signal?: AbortSignal): Promise<MonitorScanOutcome> {
    const snapshot = await collectMonitorSnapshot({
      config: this.config,
      repo: this.repo,
      now: started,
      ...(signal ? { signal } : {}),
    })
    const prompt = monitorPrompt({
      snapshot,
      resources: this.config.ops.resources,
      actions: this.config.ops.actions,
    })
    const transcriptPath = join(monitorDir(this.config), `monitor-${stamp(started)}.jsonl`)
    let result: AgentRunResult
    try {
      result = await this.runner.run({
        role: 'ops',
        cwd: this.config.projectPath,
        prompt,
        permission: 'workspace-write',
        timeoutMs: this.config.agent.timeoutSeconds * 1000,
        transcriptPath,
        allowTools: OPS_ARTIFACT_TOOL_NAMES,
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      const message = `主动监控未完成：${errorMessage(error)}`
      this.recordFailure(started, message)
      return { ...EMPTY_OUTCOME, scanned: true, status: 'error', errors: [message] }
    }
    if (result.status !== 'completed') {
      const message = `主动监控未完成：${result.reason || result.status}`
      this.recordFailure(started, message)
      return { ...EMPTY_OUTCOME, scanned: true, status: 'error', errors: [message] }
    }
    let report: MonitorReport
    try {
      report = parseMonitorReport(result.text)
    } catch (error) {
      const message = `主动监控报告不可用：${errorMessage(error)}`
      this.recordFailure(started, message)
      return { ...EMPTY_OUTCOME, scanned: true, status: 'error', errors: [message] }
    }
    const evidencePath = this.writeScanEvidence(started, snapshot, report, result)
    this.recordScan(started, snapshot, report)
    const counts = await this.applyIssues({
      report,
      evidencePath,
      at: started,
      session: result.sessionId,
      ...(signal ? { signal } : {}),
    })
    return {
      scanned: true,
      status: report.status,
      issues: report.issues.length,
      opened: counts.opened,
      merged: counts.merged,
      alerted: counts.alerted,
      errors: counts.errors,
    }
  }

  private recordFailure(at: Date, message: string): void {
    this.repo.setMeta(
      MONITOR_META,
      JSON.stringify({
        at: at.toISOString(),
        status: 'error',
        summary: bounded(message),
        error: bounded(message),
        issues: 0,
        providers: [],
        host: null,
        sources: { processes: 0, latency: 0, logs: 0, alerts: 0, checks: 0 },
      }),
    )
  }

  private recordScan(at: Date, snapshot: MonitorSnapshot, report: MonitorReport): void {
    this.repo.setMeta(
      MONITOR_META,
      JSON.stringify({
        at: at.toISOString(),
        status: report.status,
        summary: bounded(report.summary),
        error: '',
        issues: report.issues.length,
        providers: snapshot.providers.map((provider) => provider.id),
        host: {
          cpuPercent: snapshot.host.cpuPercent,
          memoryUsedPercent: snapshot.host.memoryUsedPercent,
          load1: snapshot.host.load1,
        },
        sources: {
          processes: snapshot.processes.length,
          latency: snapshot.latency.length,
          logs: snapshot.logs.length,
          alerts: snapshot.alerts.length,
          checks: snapshot.checks.length,
        },
        // 采集失败不吞掉：模型结论与采集完整性分别保存，供摘要判断是否为“健康”背书。
        collection: { errors: snapshot.errors },
      }),
    )
  }

  private writeScanEvidence(
    at: Date,
    snapshot: MonitorSnapshot,
    report: MonitorReport,
    result: AgentRunResult,
  ): string {
    const dir = monitorDir(this.config)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `monitor-${stamp(at)}.json`)
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          at: at.toISOString(),
          project: this.config.project,
          snapshot,
          report,
          session: result.sessionId,
          modelStatus: result.status,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return path
  }

  private writeIssueEvidence(
    eventId: string,
    at: Date,
    issue: MonitorIssue,
    session: string,
  ): string {
    const dir = opsDir(this.config, eventId)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `monitor-${stamp(at)}.json`)
    writeFileSync(
      path,
      `${JSON.stringify({ at: at.toISOString(), issue, session, source: 'monitor' }, null, 2)}\n`,
      'utf8',
    )
    return path
  }

  private async applyIssues(input: {
    readonly report: MonitorReport
    readonly evidencePath: string
    readonly at: Date
    readonly session: string
    readonly signal?: AbortSignal
  }): Promise<{ opened: number; merged: number; alerted: number; errors: string[] }> {
    let opened = 0
    let merged = 0
    let alerted = 0
    const errors: string[] = []
    for (const issue of input.report.issues) {
      if (!this.config.ops.resources.some((resource) => resource.id === issue.resourceId)) {
        errors.push(`监控问题 ${issue.key} 引用了未登记资源 ${issue.resourceId}`)
        continue
      }
      const signature = monitorSignatureOf(issue.resourceId, issue.key)
      const existing = this.repo.findActiveOpsEvent(this.config.project, signature)
      if (existing) {
        this.mergeIssue(existing, issue, input.evidencePath)
        merged += 1
        continue
      }
      const created = this.openIssue({
        issue,
        evidencePath: input.evidencePath,
        at: input.at,
        session: input.session,
      })
      opened += 1
      if (!issue.alert) continue
      const alert = await sendOpsAlert({
        config: this.config,
        repo: this.repo,
        now: this.clock(),
        eventId: created.eventId,
        severity: issue.severity,
        title: issue.title,
        impact: issue.impact,
        source: 'monitor',
        summary: issue.summary,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      if (alert.sent) alerted += 1
      if (alert.error) errors.push(alert.error)
    }
    return { opened, merged, alerted, errors }
  }

  private decideExecution(issue: MonitorIssue): { auto: boolean; reason: string } {
    const proposed = issue.proposedAction
    if (!proposed) return { auto: false, reason: '监控报告没有给出处置动作，等待所有者决定' }
    const action = this.action(proposed.actionId)
    if (!action) return { auto: false, reason: `监控提出的动作 ${proposed.actionId} 未登记` }
    if (action.resourceId !== issue.resourceId) {
      return { auto: false, reason: `动作 ${action.id} 不属于资源 ${issue.resourceId}` }
    }
    try {
      actionArgv(action, proposed.params)
    } catch (error) {
      return { auto: false, reason: errorMessage(error) }
    }
    const authorization = authorizeOpsAction({
      event: { resourceId: issue.resourceId, severity: issue.severity, state: OPS_OPEN },
      action,
      diagnosis: issue,
    })
    if (authorization.auto) return { auto: true, reason: authorization.source }
    return { auto: false, reason: `${authorization.reason}；等待所有者决定` }
  }

  private openIssue(input: {
    readonly issue: MonitorIssue
    readonly evidencePath: string
    readonly at: Date
    readonly session: string
  }): OpsEventRecord {
    const { issue } = input
    const now = input.at.toISOString()
    const eventId = `ops-${stamp(input.at)}-${randomUUID().slice(0, 6)}`
    const decision = this.decideExecution(issue)
    const diagnosisPath = this.writeIssueEvidence(eventId, input.at, issue, input.session)
    const created = this.repo.createOpsEvent({
      eventId,
      project: this.config.project,
      resourceId: issue.resourceId,
      checkId: MONITOR_CHECK_ID,
      signature: monitorSignatureOf(issue.resourceId, issue.key),
      severity: issue.severity,
      state: decision.auto ? OPS_DIAGNOSED : OPS_AWAITING_DECISION,
      title: issue.title,
      impact: issue.impact,
      openedAt: now,
      updatedAt: now,
    })
    this.repo.updateOpsEvent(eventId, {
      diagnosisJson: serializeOpsDiagnosis(issue),
      diagnosisPath,
      diagnosisSession: input.session,
      ...(decision.auto
        ? { decision: 'auto', decisionBy: 'ops-catalog', decisionAt: now }
        : { decision: '' }),
      updatedAt: now,
    })
    this.repo.appendOpsObservation({
      eventId,
      at: now,
      kind: 'monitor',
      summary: `${issue.key}：${issue.summary}`,
      detailJson: JSON.stringify({
        key: issue.key,
        severity: issue.severity,
        alert: issue.alert,
        facts: issue.facts,
        hypotheses: issue.hypotheses,
        proposedAction: issue.proposedAction,
        fixRequired: issue.fixRequired,
      }),
      evidencePath: input.evidencePath,
    })
    this.repo.appendOpsObservation({
      eventId,
      at: now,
      kind: decision.auto ? 'authorization' : 'decision_required',
      summary: decision.auto
        ? `按目录自动授权处置 ${issue.proposedAction?.actionId ?? ''}（${decision.reason}）`
        : decision.reason,
    })
    return created
  }

  private mergeIssue(existing: OpsEventRecord, issue: MonitorIssue, evidencePath: string): void {
    const now = this.clock().toISOString()
    this.repo.appendOpsObservation({
      eventId: existing.eventId,
      at: now,
      kind: 'monitor',
      summary: `${issue.key}：${issue.summary}`,
      detailJson: JSON.stringify({
        key: issue.key,
        severity: issue.severity,
        alert: issue.alert,
        facts: issue.facts,
        hypotheses: issue.hypotheses,
        proposedAction: issue.proposedAction,
        fixRequired: issue.fixRequired,
      }),
      evidencePath,
    })
    const patch: OpsEventPatch = { updatedAt: now }
    if (severityRank(issue.severity) < severityRank(existing.severity)) {
      patch.severity = issue.severity
    }
    if (!existing.impact) patch.impact = issue.impact
    this.repo.updateOpsEvent(existing.eventId, patch)
  }
}
