/**
 * 运维 Agent 运行时：把已登记的检查、诊断、受控处置与恢复复核接成一条可审计闭环。
 *
 * 分工：
 * - 运维 Agent（模型）只读诊断，输出影响、事实、推断与一个已登记动作建议；没有工具。
 * - 主控（本模块）执行检查与动作、校验参数、判定恢复、落库与取证；模型不能直接执行命令。
 * - 目录在装载期登记；动作只能来自目录，参数只能取允许值，恢复只认检查退出码。
 *
 * 安全与恢复：
 * - 动作先登记意图（running）再执行；宿主中断后标记为 `interrupted`，事件按未解决收口。
 * - 没有结果记录时不由状态猜测：运维 Agent 基于已记录事实分析根因并上报，不自动重放。
 * - 每个事件首版只执行一次处置动作；失败后不循环重试，等待人工决定或修复需求。
 * - 正常巡检通过不产生事件，也不进入人工介入统计的分母。
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { opsDir, projectDir } from '../config.js'
import type {
  OpsActionAttemptRecord,
  OpsEventRecord,
  OpsObservationRecord,
  Repository,
} from '../records/repository.js'
import {
  OPS_ATTEMPT_FAILED,
  OPS_ATTEMPT_INTERRUPTED,
  OPS_ATTEMPT_RUNNING,
  OPS_ATTEMPT_SUCCEEDED,
  OPS_AWAITING_DECISION,
  OPS_CLOSED,
  OPS_DIAGNOSED,
  OPS_OPEN,
  OPS_RECOVERED,
  OPS_RECOVERING,
  OPS_UNRESOLVED,
  actionArgv,
  authorizeOpsAction,
  isOpsActive,
  opsSignatureOf,
  opsStats,
  parseOpsDiagnosis,
  parseOpsInterruptionReport,
  recoveryPassed,
  serializeOpsDiagnosis,
  type OpsAction,
  type OpsCheck,
  type OpsDiagnosis,
  type OpsInterruptionReport,
  type OpsResource,
  type OpsStats,
} from '../domain/ops.js'
import type { AgentRunRequest, AgentRunResult } from './agent-runner.js'
import { opsDiagnosisPrompt, opsInterruptionPrompt } from './prompts.js'

export interface OpsRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>
}

export interface OpsRuntimeOptions {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly runner: OpsRunner
  readonly now: () => Date
}

export interface OpsResult {
  readonly ok: boolean
  readonly code: string
  readonly message: string
  readonly data?: unknown
}

function ok(message: string, data?: unknown): OpsResult {
  return { ok: true, code: 'ok', message, data }
}

function fail(code: string, message: string): OpsResult {
  return { ok: false, code, message }
}

export interface OpsCommandResult {
  readonly code: number
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly stdout: string
  readonly stderr: string
}

const MAX_OUTPUT_BYTES = 256 * 1024
const TRUNCATED_MARK = '\n…（输出已截断）'

function appendOutput(current: string, chunk: Buffer): string {
  if (current.length >= MAX_OUTPUT_BYTES) {
    // 恰好填满上限时也要留下截断标记，避免证据看起来完整。
    return current.endsWith(TRUNCATED_MARK)
      ? current
      : `${current.slice(0, MAX_OUTPUT_BYTES)}${TRUNCATED_MARK}`
  }
  const next = current + chunk.toString('utf8')
  if (next.length <= MAX_OUTPUT_BYTES) return next
  return `${next.slice(0, MAX_OUTPUT_BYTES)}${TRUNCATED_MARK}`
}

/**
 * 执行登记过的 argv。不用 Shell，不展开变量；超时或宿主停止都返回可判定的结果，
 * 由调用方按“失败/中断”收口，而不是当作可重试的成功或未知状态。
 */
export function runOpsCommand(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OpsCommandResult> {
  const executable = argv[0]
  if (!executable) {
    return Promise.resolve({ code: 127, timedOut: false, aborted: false, stdout: '', stderr: '空命令' })
  }
  if (signal?.aborted) {
    return Promise.resolve({ code: 130, timedOut: false, aborted: true, stdout: '', stderr: '已取消' })
  }
  return new Promise<OpsCommandResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    const child = spawn(executable, argv.slice(1), {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (code: number, extra?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        timedOut,
        aborted,
        stdout,
        stderr: extra ? `${stderr}${stderr ? '\n' : ''}${extra}` : stderr,
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, Math.max(1, timeoutMs))
    timer.unref?.()
    const onAbort = (): void => {
      aborted = true
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk)
    })
    child.on('error', (error) => finish(127, error.message))
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1))
  })
}

export interface OpsTickResult {
  readonly skipped: boolean
  readonly checked: number
  readonly failed: number
  readonly diagnosed: number
  readonly executed: number
  readonly recovered: number
  readonly unresolved: number
  readonly errors: readonly string[]
}

export interface OpsEventView {
  readonly eventId: string
  readonly resourceId: string
  readonly resourceLabel: string
  readonly resourceKind: string
  readonly checkId: string
  readonly severity: string
  readonly state: string
  readonly title: string
  readonly impact: string
  readonly openedAt: string
  readonly updatedAt: string
  readonly recoveredAt: string
  readonly closedAt: string
  readonly fixRequirementId: string
  readonly decision: string
  readonly humanInvolved: boolean
  readonly diagnosis: OpsDiagnosis | null
  readonly lastObservation: string
}

export interface OpsEventDetail {
  readonly event: OpsEventRecord
  readonly observations: readonly OpsObservationRecord[]
  readonly attempts: readonly OpsActionAttemptRecord[]
  readonly diagnosis: OpsDiagnosis | null
  readonly resource: OpsResource | null
  readonly check: OpsCheck | null
  readonly actions: readonly OpsAction[]
}

const MAX_DIAGNOSIS_ATTEMPTS = 3

function outputOf(result: OpsCommandResult): string {
  const parts: string[] = []
  if (result.stdout.trim()) parts.push(result.stdout.trim())
  if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trim()}`)
  return parts.join('\n') || '（无输出）'
}

function logOf(argv: readonly string[], result: OpsCommandResult): string {
  return [
    `command: ${JSON.stringify(argv)}`,
    `exit_code: ${result.code}`,
    `timed_out: ${result.timedOut}`,
    `aborted: ${result.aborted}`,
    '',
    outputOf(result),
  ].join('\n')
}

function observationOutput(observation: OpsObservationRecord | undefined): string {
  if (!observation) return '（没有检查输出）'
  try {
    const data = JSON.parse(observation.detailJson) as { output?: unknown }
    if (typeof data.output === 'string' && data.output.trim()) return data.output
  } catch {
    // 旧记录或损坏字段回退到摘要。
  }
  return observation.summary
}

function eventStamp(now: Date): string {
  return now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

export class OpsRuntime {
  private readonly config: ForgeLoopConfig
  private readonly repo: Repository
  private readonly runner: OpsRunner
  private readonly clock: () => Date
  private ticking = false

  constructor(options: OpsRuntimeOptions) {
    this.config = options.config
    this.repo = options.repo
    this.runner = options.runner
    this.clock = options.now
  }

  get enabled(): boolean {
    return this.config.ops.enabled
  }

  private now(): Date {
    return this.clock()
  }

  private isoNow(): string {
    return this.now().toISOString()
  }

  private resource(resourceId: string): OpsResource | undefined {
    return this.config.ops.resources.find((resource) => resource.id === resourceId)
  }

  private check(checkId: string): OpsCheck | undefined {
    return this.config.ops.checks.find((check) => check.id === checkId)
  }

  private action(actionId: string): OpsAction | undefined {
    return this.config.ops.actions.find((action) => action.id === actionId)
  }

  private writeEvidence(eventId: string, name: string, content: string): string {
    const dir = opsDir(this.config, eventId)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(path, content, 'utf8')
    return path
  }

  private readDiagnosis(event: OpsEventRecord): OpsDiagnosis | null {
    if (!event.diagnosisJson) return null
    try {
      return parseOpsDiagnosis(event.diagnosisJson)
    } catch {
      return null
    }
  }

  private activeEvents(): OpsEventRecord[] {
    const rank: Record<string, number> = { critical: 0, major: 1, minor: 2 }
    return this.repo
      .listOpsEvents(this.config.project)
      .filter((event) => isOpsActive(event.state))
      .sort((left, right) => {
        const severity = (rank[left.severity] ?? 3) - (rank[right.severity] ?? 3)
        return severity !== 0 ? severity : left.openedAt.localeCompare(right.openedAt)
      })
  }

  // ------------------------------------------------------------ 周期巡检

  private checkDue(check: OpsCheck): boolean {
    const raw = this.repo.getMeta(`ops_check_at:${check.id}`)
    if (!raw) return true
    const last = Date.parse(raw)
    if (!Number.isFinite(last)) return true
    return this.now().getTime() - last >= this.config.ops.intervalSeconds * 1000
  }

  /**
   * 一次巡检：到期检查 → 失败归并/建事件 → 诊断 → 授权内处置 → 恢复复核 → 修复需求。
   * 单个检查或事件失败不会中断其他事件；错误只在返回值和日志中出现，不伪造成功。
   */
  async tick(signal?: AbortSignal): Promise<OpsTickResult> {
    const empty: OpsTickResult = {
      skipped: true,
      checked: 0,
      failed: 0,
      diagnosed: 0,
      executed: 0,
      recovered: 0,
      unresolved: 0,
      errors: [],
    }
    if (!this.enabled) return empty
    if (this.ticking) return { ...empty, errors: ['上一轮巡检尚未结束，本次跳过'] }
    this.ticking = true
    const errors: string[] = []
    let checked = 0
    let failed = 0
    let diagnosed = 0
    let executed = 0
    let recovered = 0
    let unresolved = 0
    try {
      for (const check of this.config.ops.checks) {
        if (signal?.aborted) break
        if (!this.checkDue(check)) continue
        try {
          const result = await runOpsCommand(
            check.command,
            this.config.projectPath,
            check.timeoutSeconds * 1000,
            signal,
          )
          checked += 1
          if (result.code === 0 && !result.timedOut && !result.aborted) {
            this.repo.setMeta(`ops_check_at:${check.id}`, this.isoNow())
            continue
          }
          this.recordFailure(check, result)
          this.repo.setMeta(`ops_check_at:${check.id}`, this.isoNow())
          failed += 1
        } catch (error) {
          errors.push(`检查 ${check.id} 失败：${(error as Error).message}`)
        }
      }

      // 事件在一个 Tick 内最多推进三轮：诊断 → 处置 → 复核。
      // 同一事件在一次 Tick 内只尝试一次诊断，避免模型失败时立刻重试三次。
      const diagnosedThisTick = new Set<string>()
      for (let pass = 0; pass < 3; pass += 1) {
        let progressed = false
        for (const event of this.activeEvents()) {
          if (signal?.aborted) break
          try {
            if (event.state === OPS_OPEN) {
              if (diagnosedThisTick.has(event.eventId)) continue
              diagnosedThisTick.add(event.eventId)
              if (await this.diagnoseEvent(event, signal)) {
                diagnosed += 1
                progressed = true
              }
            } else if (event.state === OPS_DIAGNOSED) {
              const outcome = await this.executeEvent(event, signal)
              if (outcome !== 'not_started') {
                executed += 1
                progressed = true
                if (outcome === 'recovered') recovered += 1
                if (outcome === 'unresolved') unresolved += 1
              }
            } else if (event.state === OPS_AWAITING_DECISION && event.decision === 'approved') {
              const outcome = await this.executeEvent(event, signal)
              if (outcome !== 'not_started') {
                executed += 1
                progressed = true
                if (outcome === 'recovered') recovered += 1
                if (outcome === 'unresolved') unresolved += 1
              }
            } else if (event.state === OPS_RECOVERING) {
              const outcome = await this.verifyEvent(event)
              if (outcome !== 'not_started') {
                progressed = true
                if (outcome === 'recovered') recovered += 1
                if (outcome === 'unresolved') unresolved += 1
              }
            }
          } catch (error) {
            errors.push(`事件 ${event.eventId} 处理失败：${(error as Error).message}`)
          }
        }
        if (!progressed) break
      }

      // 中断的处置动作没有结果记录：由运维 Agent 分析根因并上报；不重放动作。
      for (const event of this.repo.listOpsEvents(this.config.project)) {
        if (signal?.aborted) break
        if (!isOpsActive(event.state)) continue
        try {
          await this.reportInterruption(event)
        } catch (error) {
          errors.push(`事件 ${event.eventId} 中断根因上报失败：${(error as Error).message}`)
        }
      }

      // 已恢复但需要永久修复的事件，生成一次关联修复需求；不重复创建。
      for (const event of this.repo.listOpsEvents(this.config.project)) {
        if (![OPS_RECOVERED, OPS_UNRESOLVED].includes(event.state)) continue
        const diagnosis = this.readDiagnosis(event)
        if (!diagnosis?.fixRequired || event.fixRequirementId) continue
        try {
          this.ensureFixRequirement(event, diagnosis)
        } catch (error) {
          errors.push(`事件 ${event.eventId} 生成修复需求失败：${(error as Error).message}`)
        }
      }
    } finally {
      this.ticking = false
    }
    return {
      skipped: false,
      checked,
      failed,
      diagnosed,
      executed,
      recovered,
      unresolved,
      errors,
    }
  }

  private recordFailure(check: OpsCheck, result: OpsCommandResult): void {
    const now = this.isoNow()
    const resource = this.resource(check.resourceId)
    const label = resource?.label ?? check.resourceId
    const output = outputOf(result)
    const signature = opsSignatureOf({
      resourceId: check.resourceId,
      checkId: check.id,
      exitCode: result.code,
      output,
    })
    const active = this.repo.findActiveOpsEvent(this.config.project, signature)
    const event =
      active ??
      this.repo.createOpsEvent({
        eventId: `ops-${eventStamp(this.now())}-${randomUUID().slice(0, 6)}`,
        project: this.config.project,
        resourceId: check.resourceId,
        checkId: check.id,
        signature,
        severity: check.severity,
        state: OPS_OPEN,
        title: `${label}：${check.id} 检查失败`,
        openedAt: now,
        updatedAt: now,
      })
    const seq = this.repo.opsObservations(event.eventId).filter((item) => item.kind === 'check').length + 1
    const evidencePath = this.writeEvidence(
      event.eventId,
      `check-${seq}.log`,
      logOf(check.command, result),
    )
    this.repo.appendOpsObservation({
      eventId: event.eventId,
      at: now,
      kind: 'check',
      summary: `${check.id} 失败：退出码 ${result.code}${result.timedOut ? '（超时）' : ''}${result.aborted ? '（中止）' : ''}`,
      detailJson: JSON.stringify({
        checkId: check.id,
        exitCode: result.code,
        timedOut: result.timedOut,
        aborted: result.aborted,
        output,
      }),
      evidencePath,
    })
    this.repo.updateOpsEvent(event.eventId, { updatedAt: now })
  }

  // ------------------------------------------------------------ 诊断

  private async diagnoseEvent(event: OpsEventRecord, signal?: AbortSignal): Promise<boolean> {
    const now = this.isoNow()
    const observations = this.repo.opsObservations(event.eventId)
    const attempts = observations.filter(
      (item) => item.kind === 'diagnosis' || item.kind === 'diagnosis_error',
    ).length
    if (attempts >= MAX_DIAGNOSIS_ATTEMPTS) {
      this.repo.updateOpsEvent(event.eventId, {
        state: OPS_AWAITING_DECISION,
        impact: event.impact || '自动诊断多次未完成，需要人工判断',
        updatedAt: now,
      })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: now,
        kind: 'decision_required',
        summary: `自动诊断连续 ${attempts} 次未完成，等待人工判断`,
      })
      return true
    }

    const check = this.check(event.checkId)
    const resource = this.resource(event.resourceId)
    if (!check || !resource) {
      this.repo.updateOpsEvent(event.eventId, {
        state: OPS_AWAITING_DECISION,
        impact: event.impact || '登记目录已变化，无法继续自动诊断',
        updatedAt: now,
      })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: now,
        kind: 'decision_required',
        summary: '事件的检查或资源已不在登记目录中，等待人工处理',
      })
      return true
    }

    const latestCheck = [...observations].reverse().find((item) => item.kind === 'check')
    const prompt = opsDiagnosisPrompt({
      eventId: event.eventId,
      title: event.title,
      severity: event.severity,
      openedAt: event.openedAt,
      resource,
      checkId: check.id,
      observations: observations
        .filter((item) => item.kind === 'check')
        .slice(-5)
        .map((item) => `${item.at} ${item.summary}`),
      output: observationOutput(latestCheck),
      actions: this.config.ops.actions
        .filter((action) => action.resourceId === event.resourceId)
        .map((action) => ({
          id: action.id,
          params: action.params.map((param) => ({ name: param.name, values: param.values })),
        })),
    })
    const transcriptPath = join(opsDir(this.config, event.eventId), `diagnosis-${attempts + 1}.jsonl`)
    const result = await this.runner.run({
      role: 'ops',
      cwd: this.config.projectPath,
      prompt,
      permission: 'workspace-write',
      timeoutMs: this.config.agent.timeoutSeconds * 1000,
      transcriptPath,
      signal,
      tools: 'none',
    })
    if (result.status !== 'completed') {
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'diagnosis_error',
        summary: `诊断未完成：${result.reason || result.status}`,
      })
      this.repo.updateOpsEvent(event.eventId, { updatedAt: this.isoNow() })
      return true
    }

    let diagnosis: OpsDiagnosis
    try {
      diagnosis = parseOpsDiagnosis(result.text)
    } catch (error) {
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'diagnosis_error',
        summary: `诊断结果畸形：${(error as Error).message}`,
      })
      this.repo.updateOpsEvent(event.eventId, { updatedAt: this.isoNow() })
      return true
    }

    let invalid = ''
    const proposed = diagnosis.proposedAction
    const action = proposed ? this.action(proposed.actionId) : undefined
    if (proposed && !action) {
      invalid = `诊断提出的动作 ${proposed.actionId} 未登记`
    } else if (proposed && action) {
      if (action.resourceId !== event.resourceId) {
        invalid = `动作 ${action.id} 不属于事件资源 ${event.resourceId}`
      } else {
        try {
          actionArgv(action, proposed.params)
        } catch (error) {
          invalid = (error as Error).message
        }
      }
    }
    const diagnosisPath = this.writeEvidence(
      event.eventId,
      `diagnosis-${attempts + 1}.json`,
      `${JSON.stringify(
        {
          diagnosis,
          session: result.sessionId,
          modelStatus: result.status,
          invalid: invalid || null,
        },
        null,
        2,
      )}\n`,
    )
    this.repo.updateOpsEvent(event.eventId, {
      impact: diagnosis.impact,
      diagnosisJson: serializeOpsDiagnosis(diagnosis),
      diagnosisPath,
      diagnosisSession: result.sessionId,
      updatedAt: this.isoNow(),
    })
    this.repo.appendOpsObservation({
      eventId: event.eventId,
      at: this.isoNow(),
      kind: 'diagnosis',
      summary: diagnosis.summary,
      detailJson: JSON.stringify({
        facts: diagnosis.facts,
        hypotheses: diagnosis.hypotheses,
        proposedAction: diagnosis.proposedAction,
        fixRequired: diagnosis.fixRequired,
      }),
      evidencePath: diagnosisPath,
    })

    if (!action || !proposed) {
      this.repo.updateOpsEvent(event.eventId, { state: OPS_AWAITING_DECISION, updatedAt: this.isoNow() })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'decision_required',
        summary: '诊断没有给出可执行动作，等待所有者决定',
      })
      return true
    }
    if (invalid) {
      this.repo.updateOpsEvent(event.eventId, {
        state: OPS_AWAITING_DECISION,
        decision: '',
        updatedAt: this.isoNow(),
      })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'decision_required',
        summary: invalid,
      })
      return true
    }

    const authorization = authorizeOpsAction({
      event: { resourceId: event.resourceId, severity: event.severity, state: event.state },
      action,
      diagnosis,
    })
    if (authorization.auto) {
      this.repo.updateOpsEvent(event.eventId, {
        state: OPS_DIAGNOSED,
        decision: 'auto',
        decisionBy: 'ops-catalog',
        decisionAt: this.isoNow(),
        updatedAt: this.isoNow(),
      })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'authorization',
        summary: `按目录自动授权处置 ${action.id}（${authorization.source}）`,
      })
    } else {
      this.repo.updateOpsEvent(event.eventId, {
        state: OPS_AWAITING_DECISION,
        decision: '',
        updatedAt: this.isoNow(),
      })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'decision_required',
        summary: `${authorization.reason}；等待所有者决定`,
      })
    }
    return true
  }

  // ------------------------------------------------------------ 处置与复核

  private async executeEvent(
    event: OpsEventRecord,
    signal?: AbortSignal,
  ): Promise<'recovered' | 'unresolved' | 'not_started'> {
    const diagnosis = this.readDiagnosis(event)
    const proposed = diagnosis?.proposedAction
    const action = proposed ? this.action(proposed.actionId) : undefined
    if (!diagnosis || !proposed || !action) {
      this.repo.updateOpsEvent(event.eventId, { state: OPS_AWAITING_DECISION, updatedAt: this.isoNow() })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'decision_required',
        summary: '诊断提出的动作已不在登记目录中，等待人工处理',
      })
      return 'not_started'
    }
    if (this.repo.opsActionAttempts(event.eventId).length > 0) {
      // 首版每个事件只执行一次处置动作；失败或中断都不自动重放。
      return 'not_started'
    }

    let authorizationSource = ''
    if (event.decision === 'auto') {
      const authorization = authorizeOpsAction({
        event: { resourceId: event.resourceId, severity: event.severity, state: event.state },
        action,
        diagnosis,
      })
      if (!authorization.auto) {
        this.repo.updateOpsEvent(event.eventId, {
          state: OPS_AWAITING_DECISION,
          decision: '',
          updatedAt: this.isoNow(),
        })
        this.repo.appendOpsObservation({
          eventId: event.eventId,
          at: this.isoNow(),
          kind: 'decision_required',
          summary: `自动授权已不成立：${authorization.reason}`,
        })
        return 'not_started'
      }
      authorizationSource = authorization.source
    } else if (event.decision === 'approved' && event.decisionBy) {
      authorizationSource = `owner:${event.decisionBy}:${event.decisionSource || 'missing-source'}`
    } else {
      return 'not_started'
    }

    let argv: string[]
    try {
      argv = actionArgv(action, proposed.params)
    } catch (error) {
      this.repo.updateOpsEvent(event.eventId, { state: OPS_AWAITING_DECISION, updatedAt: this.isoNow() })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'decision_required',
        summary: (error as Error).message,
      })
      return 'not_started'
    }

    const attemptId = `opa-${randomUUID()}`
    const attemptIndex = this.repo.opsActionAttempts(event.eventId).length + 1
    const evidencePath = join(opsDir(this.config, event.eventId), `action-${attemptIndex}.log`)
    this.repo.recordOpsActionAttempt({
      actionId: attemptId,
      eventId: event.eventId,
      actionDefId: action.id,
      paramsJson: JSON.stringify(proposed.params),
      state: OPS_ATTEMPT_RUNNING,
      authorizationSource,
      startedAt: this.isoNow(),
    })
    this.repo.updateOpsEvent(event.eventId, { state: OPS_RECOVERING, updatedAt: this.isoNow() })

    const result = await runOpsCommand(
      argv,
      this.config.projectPath,
      action.timeoutSeconds * 1000,
      signal,
    )
    mkdirSync(opsDir(this.config, event.eventId), { recursive: true })
    writeFileSync(evidencePath, logOf(argv, result), 'utf8')

    if (result.aborted || result.timedOut) {
      // 中止或超时是确定事实：动作没有成功收口、没有退出码。
      // 不把它改写成“未知”状态，也不自动重放。
      this.repo.finishOpsActionAttempt(attemptId, {
        state: OPS_ATTEMPT_FAILED,
        detail: result.aborted
          ? '宿主停止：动作没有完成，没有退出码；事件按未解决收口，不自动重放'
          : `动作超时（${action.timeoutSeconds} 秒）：动作没有完成，没有退出码；不自动重放`,
        exitCode: null,
        finishedAt: this.isoNow(),
        evidencePath,
      })
      this.repo.updateOpsEvent(event.eventId, { state: OPS_UNRESOLVED, updatedAt: this.isoNow() })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'action',
        summary: `动作 ${action.id} 未完成（${result.aborted ? '宿主停止' : '超时'}）；没有退出码，按未解决收口`,
        evidencePath,
      })
      const latest = this.repo.opsEvent(event.eventId)
      if (latest) this.ensureFixIfNeeded(latest, diagnosis)
      if (result.timedOut) {
        // 超时后仍可用登记的恢复检查判定实际服务状态；检查通过即视为已恢复。
        return this.verifyAfterAction(event.eventId, action, diagnosis, attemptIndex)
      }
      return 'unresolved'
    }

    if (result.code !== 0) {
      this.repo.finishOpsActionAttempt(attemptId, {
        state: OPS_ATTEMPT_FAILED,
        detail: `动作退出码 ${result.code}`,
        exitCode: result.code,
        finishedAt: this.isoNow(),
        evidencePath,
      })
      this.repo.updateOpsEvent(event.eventId, { state: OPS_UNRESOLVED, updatedAt: this.isoNow() })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'action',
        summary: `动作 ${action.id} 失败：退出码 ${result.code}`,
        evidencePath,
      })
      const latest = this.repo.opsEvent(event.eventId)
      if (latest) this.ensureFixIfNeeded(latest, diagnosis)
      return 'unresolved'
    }

    this.repo.finishOpsActionAttempt(attemptId, {
      state: OPS_ATTEMPT_SUCCEEDED,
      detail: '动作退出码 0',
      exitCode: 0,
      finishedAt: this.isoNow(),
      evidencePath,
    })
    this.repo.appendOpsObservation({
      eventId: event.eventId,
      at: this.isoNow(),
      kind: 'action',
      summary: `动作 ${action.id} 完成：退出码 0`,
      evidencePath,
    })
    return this.verifyAfterAction(event.eventId, action, diagnosis, attemptIndex)
  }

  /** 处置后必须由登记的恢复检查复核；动作退出码 0 本身不算恢复。 */
  private async verifyAfterAction(
    eventId: string,
    action: OpsAction,
    diagnosis: OpsDiagnosis,
    attemptIndex: number,
  ): Promise<'recovered' | 'unresolved' | 'not_started'> {
    const check = this.check(action.verifyCheckId)
    if (!check) {
      this.repo.updateOpsEvent(eventId, { state: OPS_UNRESOLVED, updatedAt: this.isoNow() })
      this.repo.appendOpsObservation({
        eventId,
        at: this.isoNow(),
        kind: 'recovery',
        summary: `恢复检查 ${action.verifyCheckId} 已不在登记目录中，不能确认恢复`,
      })
      return 'unresolved'
    }
    const result = await runOpsCommand(
      check.command,
      this.config.projectPath,
      check.timeoutSeconds * 1000,
    )
    const evidencePath = this.writeEvidence(
      eventId,
      `recovery-${attemptIndex}.log`,
      logOf(check.command, result),
    )
    const passed = recoveryPassed({ code: result.code, timedOut: result.timedOut })
    this.repo.appendOpsObservation({
      eventId,
      at: this.isoNow(),
      kind: 'recovery',
      summary: passed
        ? `恢复复核通过：${check.id} 退出码 0`
        : `恢复复核未通过：${check.id} 退出码 ${result.code}${result.timedOut ? '（超时）' : ''}`,
      detailJson: JSON.stringify({ checkId: check.id, exitCode: result.code, timedOut: result.timedOut }),
      evidencePath,
    })
    if (passed) {
      this.repo.updateOpsEvent(eventId, {
        state: OPS_RECOVERED,
        recoveredAt: this.isoNow(),
        updatedAt: this.isoNow(),
      })
    } else {
      this.repo.updateOpsEvent(eventId, { state: OPS_UNRESOLVED, updatedAt: this.isoNow() })
    }
    const latest = this.repo.opsEvent(eventId)
    if (latest) this.ensureFixIfNeeded(latest, diagnosis)
    return passed ? 'recovered' : 'unresolved'
  }

  /** 宿主中断后恢复：已有动作记录的事件不再执行，只按记录收口；无记录时等待人工决定。 */
  private async verifyEvent(
    event: OpsEventRecord,
  ): Promise<'recovered' | 'unresolved' | 'not_started'> {
    const attempt = this.repo.latestOpsActionAttempt(event.eventId)
    if (!attempt) {
      this.repo.updateOpsEvent(event.eventId, { state: OPS_AWAITING_DECISION, updatedAt: this.isoNow() })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'decision_required',
        summary: '恢复中的事件缺少处置动作记录；没有执行痕迹，可由所有者重新决定',
      })
      return 'not_started'
    }
    if (attempt.state === OPS_ATTEMPT_RUNNING) return 'not_started'
    if (attempt.state === OPS_ATTEMPT_INTERRUPTED) {
      // 事实：动作已开始但没有结果记录；事件按未解决收口，根因由运维 Agent 上报。
      this.repo.updateOpsEvent(event.eventId, { state: OPS_UNRESOLVED, updatedAt: this.isoNow() })
      return 'unresolved'
    }
    if (attempt.state === OPS_ATTEMPT_FAILED) {
      this.repo.updateOpsEvent(event.eventId, { state: OPS_UNRESOLVED, updatedAt: this.isoNow() })
      return 'unresolved'
    }
    if (attempt.state !== OPS_ATTEMPT_SUCCEEDED) return 'not_started'
    const diagnosis = this.readDiagnosis(event)
    const action = this.action(attempt.actionDefId)
    if (!diagnosis || !action) {
      this.repo.updateOpsEvent(event.eventId, { state: OPS_UNRESOLVED, updatedAt: this.isoNow() })
      return 'unresolved'
    }
    return this.verifyAfterAction(
      event.eventId,
      action,
      diagnosis,
      this.repo.opsActionAttempts(event.eventId).length,
    )
  }

  /**
   * 中断的动作没有结果记录：先把确定性事实写入观测，再由运维 Agent 分析根因并上报。
   * 报告只用于人工判断，不改变“每个事件只执行一次动作”的规则，也不自动重放。
   * 每次中断只尝试一次模型报告；失败时保留事实并记录错误，不反复调用模型。
   */
  private async reportInterruption(event: OpsEventRecord): Promise<void> {
    const observations = this.repo.opsObservations(event.eventId)
    if (
      observations.some(
        (item) => item.kind === 'interruption_report' || item.kind === 'interruption_error',
      )
    ) {
      return
    }
    const attempt = this.repo
      .opsActionAttempts(event.eventId)
      .find((item) => item.state === OPS_ATTEMPT_INTERRUPTED)
    if (!attempt) return
    const action = this.action(attempt.actionDefId)
    let params: Record<string, string> = {}
    try {
      const parsed: unknown = JSON.parse(attempt.paramsJson || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        params = parsed as Record<string, string>
      }
    } catch {
      params = {}
    }
    let argv: readonly string[] = []
    try {
      if (action) argv = actionArgv(action, params)
    } catch {
      argv = []
    }
    const factSummary = `处置动作 ${attempt.actionDefId} 被宿主中断，没有退出码；按未解决收口，不自动重放`
    if (!observations.some((item) => item.kind === 'interruption')) {
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'interruption',
        summary: factSummary,
        detailJson: JSON.stringify({
          actionId: attempt.actionDefId,
          params,
          argv,
          authorizationSource: attempt.authorizationSource,
          startedAt: attempt.startedAt,
          detail: attempt.detail,
          evidencePath: attempt.evidencePath,
        }),
        evidencePath: attempt.evidencePath,
      })
    }

    let logTail = ''
    try {
      if (attempt.evidencePath && existsSync(attempt.evidencePath)) {
        logTail = readFileSync(attempt.evidencePath, 'utf8').slice(-4000)
      }
    } catch {
      logTail = ''
    }
    const evidenceDir = opsDir(this.config, event.eventId)
    let result: AgentRunResult
    try {
      result = await this.runner.run({
        role: 'ops',
        cwd: this.config.projectPath,
        prompt: opsInterruptionPrompt({
          eventId: event.eventId,
          title: event.title,
          severity: event.severity,
          openedAt: event.openedAt,
          resource: this.resource(event.resourceId) ?? {
            id: event.resourceId,
            kind: 'other',
            label: event.resourceId,
          },
          checkId: event.checkId,
          observations: observations
            .slice(-5)
            .map((item) => `${item.kind}：${item.summary}`),
          attempt: {
            actionId: attempt.actionDefId,
            params,
            authorizationSource: attempt.authorizationSource,
            startedAt: attempt.startedAt,
            detail: attempt.detail,
            evidencePath: attempt.evidencePath,
          },
          logTail,
        }),
        permission: 'workspace-write',
        timeoutMs: this.config.agent.timeoutSeconds * 1000,
        transcriptPath: join(evidenceDir, 'interruption-report.jsonl'),
        tools: 'none',
      })
    } catch (error) {
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'interruption_error',
        summary: `中断根因分析异常：${(error as Error).message}；保留上述事实`,
      })
      return
    }
    if (result.status !== 'completed') {
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'interruption_error',
        summary: `中断根因分析未完成：${result.reason || result.status}；保留上述事实`,
      })
      return
    }
    let report: OpsInterruptionReport
    try {
      report = parseOpsInterruptionReport(result.text)
    } catch (error) {
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: this.isoNow(),
        kind: 'interruption_error',
        summary: `中断根因报告不可用：${(error as Error).message}；保留上述事实`,
      })
      return
    }
    const reportPath = this.writeEvidence(
      event.eventId,
      `interruption-${attempt.actionId}.json`,
      `${JSON.stringify({ report, session: result.sessionId, modelStatus: result.status }, null, 2)}\n`,
    )
    this.repo.appendOpsObservation({
      eventId: event.eventId,
      at: this.isoNow(),
      kind: 'interruption_report',
      summary: report.summary,
      detailJson: JSON.stringify(report),
      evidencePath: reportPath,
    })
    this.repo.updateOpsEvent(event.eventId, { updatedAt: this.isoNow() })
  }

  // ------------------------------------------------------------ 修复需求

  private ensureFixIfNeeded(event: OpsEventRecord, diagnosis: OpsDiagnosis | null): void {
    if (!diagnosis?.fixRequired || event.fixRequirementId) return
    if (![OPS_RECOVERED, OPS_UNRESOLVED].includes(event.state)) return
    this.ensureFixRequirement(event, diagnosis)
  }

  /**
   * 为事件生成一次关联修复需求：走正常需求流程，不自动批准、不跳过分析。
   * 客户端幂等键绑定事件；同一事件不会生成第二条需求。
   */
  private ensureFixRequirement(event: OpsEventRecord, diagnosis: OpsDiagnosis): string {
    if (event.fixRequirementId) return event.fixRequirementId
    const now = this.isoNow()
    const reqId = `req-${eventStamp(this.now())}-${randomUUID().slice(0, 6)}`
    const resource = this.resource(event.resourceId)
    const attempts = this.repo.opsActionAttempts(event.eventId)
    const actionSummary =
      attempts.length === 0
        ? '未执行处置动作'
        : attempts
            .map(
              (attempt) =>
                `${attempt.actionDefId}（${attempt.state}${attempt.exitCode === null ? '' : `，退出码 ${attempt.exitCode}`}）`,
            )
            .join('；')
    const text = [
      `运维事件 ${event.eventId} 的永久修复（由运维 Agent 创建）`,
      '',
      `资源：${resource?.label ?? event.resourceId}（${event.resourceId}）`,
      `检查：${event.checkId}`,
      `严重度：${event.severity}`,
      `首次发现：${event.openedAt}`,
      `当前状态：${event.state}`,
      `业务影响：${event.impact || diagnosis.impact}`,
      `诊断摘要：${diagnosis.summary}`,
      `已执行处置：${actionSummary}`,
      `事件证据：${event.diagnosisPath || opsDir(this.config, event.eventId)}`,
      '',
      '要求：定位并修复根因，给出可验证的验收方式；恢复服务与永久修复分别收口。',
      '本需求只记录修复工作，不表示事件已经恢复，也不构成验收或发布授权。',
    ].join('\n')
    const { requirement, created } = this.repo.submit({
      reqId,
      project: this.config.project,
      text,
      submittedBy: 'ops-agent',
      source: `ops:${event.eventId}`,
      clientKey: `ops:${event.eventId}`,
      now,
    })
    if (created) {
      try {
        this.repo.recordRequest({
          requestId: `rq-${randomUUID()}`,
          reqId: requirement.reqId,
          project: this.config.project,
          planVersion: 0,
          action: 'analyze',
          requestedBy: 'ops-agent',
          source: `ops:${event.eventId}`,
          now,
        })
      } catch {
        // 已有同需求请求时复用，不制造第二套队列状态。
      }
    }
    this.repo.linkOpsFixRequirement(event.eventId, requirement.reqId, now)
    return requirement.reqId
  }

  // ------------------------------------------------------------ 所有者决定

  decide(input: {
    eventId: string
    decision: 'approve' | 'decline'
    by: string
    source: string
    reason?: string
  }): OpsResult {
    const event = this.repo.opsEvent(input.eventId)
    if (!event) return fail('not_found', `未找到运维事件 ${input.eventId}`)
    if (event.state !== OPS_AWAITING_DECISION) {
      return fail('not_awaiting_decision', `事件 ${input.eventId} 当前状态 ${event.state}，没有待决定处置`)
    }
    const diagnosis = this.readDiagnosis(event)
    const proposed = diagnosis?.proposedAction
    if (!diagnosis || !proposed) return fail('no_action', '该事件没有可批准的处置建议')
    const action = this.action(proposed.actionId)
    if (!action) return fail('action_missing', `处置动作 ${proposed.actionId} 已不在登记目录中`)
    try {
      actionArgv(action, proposed.params)
    } catch (error) {
      return fail('invalid_params', (error as Error).message)
    }
    const now = this.isoNow()
    const reason = input.reason?.trim() || ''
    if (input.decision === 'approve') {
      this.repo.updateOpsEvent(event.eventId, {
        decision: 'approved',
        decisionBy: input.by,
        decisionSource: input.source,
        decisionAt: now,
        humanInvolved: true,
        humanReason: `${input.by} 批准处置 ${action.id}（${input.source}）${reason ? `：${reason}` : ''}`,
        updatedAt: now,
      })
      this.repo.appendOpsObservation({
        eventId: event.eventId,
        at: now,
        kind: 'decision',
        summary: `${input.by} 批准处置 ${action.id}；等待协调器执行`,
      })
      return ok(`已批准事件 ${event.eventId} 的处置 ${action.id}；协调器会在下一次巡检执行`, {
        eventId: event.eventId,
        actionId: action.id,
      })
    }
    this.repo.updateOpsEvent(event.eventId, {
      state: OPS_UNRESOLVED,
      decision: 'declined',
      decisionBy: input.by,
      decisionSource: input.source,
      decisionAt: now,
      humanInvolved: true,
      humanReason: `${input.by} 拒绝处置 ${action.id}（${input.source}）${reason ? `：${reason}` : ''}`,
      updatedAt: now,
    })
    this.repo.appendOpsObservation({
      eventId: event.eventId,
      at: now,
      kind: 'decision',
      summary: `${input.by} 拒绝处置 ${action.id}${reason ? `：${reason}` : ''}`,
    })
    const latest = this.repo.opsEvent(event.eventId)
    if (latest) this.ensureFixIfNeeded(latest, diagnosis)
    return ok(`已拒绝事件 ${event.eventId} 的处置 ${action.id}，事件保留为未解决`)
  }

  close(input: { eventId: string; by: string; reason: string }): OpsResult {
    const event = this.repo.opsEvent(input.eventId)
    if (!event) return fail('not_found', `未找到运维事件 ${input.eventId}`)
    if (event.state === OPS_CLOSED) return fail('already_closed', `事件 ${input.eventId} 已经关闭`)
    if (this.repo.latestOpsActionAttempt(event.eventId)?.state === OPS_ATTEMPT_RUNNING) {
      return fail('action_running', '事件仍有动作在执行，不能关闭')
    }
    const now = this.isoNow()
    this.repo.updateOpsEvent(event.eventId, {
      state: OPS_CLOSED,
      closedAt: now,
      humanInvolved: true,
      humanReason: `${input.by} 关闭：${input.reason || '未说明'}`,
      updatedAt: now,
    })
    this.repo.appendOpsObservation({
      eventId: event.eventId,
      at: now,
      kind: 'closed',
      summary: `${input.by} 关闭事件：${input.reason || '未说明'}`,
    })
    return ok(`已关闭事件 ${event.eventId}；历史与证据保留`)
  }

  requestFix(input: { eventId: string; by: string; source: string }): OpsResult {
    const event = this.repo.opsEvent(input.eventId)
    if (!event) return fail('not_found', `未找到运维事件 ${input.eventId}`)
    if (event.fixRequirementId) {
      return ok(`事件 ${event.eventId} 已关联修复需求 ${event.fixRequirementId}`, {
        reqId: event.fixRequirementId,
      })
    }
    const diagnosis = this.readDiagnosis(event)
    if (!diagnosis) return fail('no_diagnosis', '事件尚无诊断结论，不能生成修复需求')
    if (![OPS_RECOVERED, OPS_UNRESOLVED, OPS_AWAITING_DECISION].includes(event.state)) {
      return fail('state_conflict', `事件当前状态 ${event.state}，不能生成修复需求`)
    }
    const reqId = this.ensureFixRequirement(event, diagnosis)
    this.repo.updateOpsEvent(event.eventId, {
      humanInvolved: true,
      humanReason: `${input.by} 要求生成修复需求（${input.source}）`,
      updatedAt: this.isoNow(),
    })
    return ok(`已为事件 ${event.eventId} 生成修复需求 ${reqId}`, { reqId })
  }

  // ------------------------------------------------------------ 查询

  list(): OpsEventView[] {
    return this.repo.listOpsEvents(this.config.project).map((event) => {
      const resource = this.resource(event.resourceId)
      const diagnosis = this.readDiagnosis(event)
      const observations = this.repo.opsObservations(event.eventId)
      return {
        eventId: event.eventId,
        resourceId: event.resourceId,
        resourceLabel: resource?.label ?? event.resourceId,
        resourceKind: resource?.kind ?? 'other',
        checkId: event.checkId,
        severity: event.severity,
        state: event.state,
        title: event.title,
        impact: event.impact,
        openedAt: event.openedAt,
        updatedAt: event.updatedAt,
        recoveredAt: event.recoveredAt,
        closedAt: event.closedAt,
        fixRequirementId: event.fixRequirementId,
        decision: event.decision,
        humanInvolved: event.humanInvolved,
        diagnosis,
        lastObservation: observations[observations.length - 1]?.summary ?? '',
      }
    })
  }

  detail(eventId: string): OpsEventDetail | null {
    const event = this.repo.opsEvent(eventId)
    if (!event) return null
    return {
      event,
      observations: this.repo.opsObservations(eventId),
      attempts: this.repo.opsActionAttempts(eventId),
      diagnosis: this.readDiagnosis(event),
      resource: this.resource(event.resourceId) ?? null,
      check: this.check(event.checkId) ?? null,
      actions: this.config.ops.actions.filter((action) => action.resourceId === event.resourceId),
    }
  }

  stats(): OpsStats {
    return opsStats(
      this.repo.listOpsEvents(this.config.project).map((event) => ({
        state: event.state,
        humanInvolved: event.humanInvolved,
        openedAt: event.openedAt,
        recoveredAt: event.recoveredAt,
        fixRequirementId: event.fixRequirementId,
      })),
    )
  }

  summary(): {
    enabled: boolean
    intervalSeconds: number
    resources: number
    checks: number
    actions: number
    stats: OpsStats
  } {
    return {
      enabled: this.enabled,
      intervalSeconds: this.config.ops.intervalSeconds,
      resources: this.config.ops.resources.length,
      checks: this.config.ops.checks.length,
      actions: this.config.ops.actions.length,
      stats: this.stats(),
    }
  }
}

/** 供服务层生成 evidence 目录名；与事件现场保持一致。 */
export function opsEvidenceRoot(config: ForgeLoopConfig): string {
  return join(projectDir(config), 'ops')
}
