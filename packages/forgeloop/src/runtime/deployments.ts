/**
 * 部署协调器：intent → 门禁 → preflight → 审批/自动 → apply → 等待核对 → 回退。
 *
 * 实际部署只发生在登记工具的进程里；这里负责状态机、证据与失败告警，不拼命令、
 * 不接受模型提供的脚本或参数。工具返回 ok 只代表它执行完了，部署成功要等 status 核对。
 */

import { randomUUID } from 'node:crypto'
import { asRecord } from '../domain/json.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  projectDir,
  type DeploymentTargetConfig,
  type DeploymentToolConfig,
  type ForgeLoopConfig,
} from '../config.js'
import {
  canTransition,
  parseDeploymentToolResult,
  type DeploymentArtifact,
  type DeploymentAttemptState,
  type DeploymentOperation,
  type DeploymentToolResult,
} from '../domain/deployment.js'
import type { DeploymentAttemptRecord, DeploymentIntentRecord } from '../domain/deployment.js'
import type { DeploymentStore } from '../records/deployment-store.js'
import {
  artifactFileDigest,
  runDeploymentTool,
  syncDeploymentToolScript,
  type DeploymentToolPlan,
  type DeploymentToolRun,
} from './deployment-tools.js'
import { sendDeploymentAlert } from './deployment-alerts.js'
import type { OperationResult } from './operation-result.js'
import type { DeploymentGate } from './deployment-gate.js'

export interface DeploymentsDeps {
  readonly config: ForgeLoopConfig
  readonly store: DeploymentStore
  readonly gate: DeploymentGate
  readonly now?: () => string
  readonly runTool?: typeof runDeploymentTool
  readonly alert?: (
    url: string,
    body: Record<string, unknown>,
    timeoutSeconds: number,
  ) => Promise<{ ok: boolean; error: string }>
}

export interface DeploymentOutcome {
  readonly ok: boolean
  readonly code: string
  readonly message: string
  readonly data?: unknown
}

export interface DeploymentRequest {
  readonly targetId: string
  /** 本次部署所属需求；省略时使用目标配置的默认需求。 */
  readonly requirementId?: string
  readonly artifact: DeploymentArtifact
  readonly source: string
}

function ok(message: string, data?: unknown): DeploymentOutcome {
  return { ok: true, code: 'ok', message, ...(data === undefined ? {} : { data }) }
}

function fail(code: string, message: string): DeploymentOutcome {
  return { ok: false, code, message }
}

export class Deployments {
  private readonly now: () => string
  private readonly runTool: typeof runDeploymentTool
  private readonly alert: NonNullable<DeploymentsDeps['alert']>

  constructor(private readonly deps: DeploymentsDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    this.runTool = deps.runTool ?? runDeploymentTool
    this.alert = deps.alert ?? sendDeploymentAlert
  }

  targets(): readonly DeploymentTargetConfig[] {
    return this.deps.config.deployments.targets
  }

  list(limit = 20): DeploymentIntentRecord[] {
    return this.deps.store.deploymentIntents(limit)
  }

  detail(
    intentId: string,
  ): { intent: DeploymentIntentRecord; attempts: DeploymentAttemptRecord[] } | null {
    const intent = this.deps.store.deploymentIntent(intentId)
    if (!intent) return null
    return { intent, attempts: this.deps.store.deploymentAttempts(intentId) }
  }

  async request(input: DeploymentRequest): Promise<DeploymentOutcome> {
    const config = this.deps.config
    if (!config.deployments.enabled) return fail('deployments_disabled', '部署未启用')
    const target = config.deployments.targets.find((item) => item.id === input.targetId)
    if (!target) return fail('not_found', `未登记部署目标：${input.targetId}`)
    const requirementId = input.requirementId?.trim() || target.requirementId
    if (!requirementId) {
      return fail('requirement_required', '部署必须指定所属需求；目标未配置默认需求')
    }
    const tool = config.deployments.tools.find((item) => item.id === target.toolId)
    if (!tool) return fail('not_found', `部署目标引用了未登记工具：${target.toolId}`)
    const busy = this.targetBusy(target.id)
    if (busy) return busy
    const intentId = `dep-${randomUUID()}`
    const intent: DeploymentIntentRecord = {
      intentId,
      project: config.project,
      targetId: target.id,
      requirementId,
      artifactSha256: input.artifact.sha256,
      artifactPath: input.artifact.path,
      artifactVersion: input.artifact.version,
      source: input.source,
      approval: target.approval,
      state: 'draft',
      createdAt: this.now(),
      updatedAt: this.now(),
    }
    this.deps.store.recordDeploymentIntent(intent)
    const dir = this.evidenceFor(intentId)

    const gate = this.deps.gate(target, input.artifact, requirementId)
    if (!gate.ok) {
      this.transition(intent, 'preflight_failed')
      this.recordAttempt({
        intent,
        op: 'preflight',
        state: 'preflight_failed',
        exitCode: -1,
        resultJson: '',
        detail: gate.reason,
        toolSha256: '',
        evidencePath: dir,
      })
      return fail('preflight_failed', `部署门禁未通过：${gate.reason}`)
    }

    const preflight = await this.runOperation({
      intent,
      tool,
      op: 'preflight',
      artifact: input.artifact,
      params: target.params,
      data: target.data,
    })
    if (!preflight.ok) {
      this.transition(intent, 'preflight_failed')
      return fail('preflight_failed', preflight.message)
    }
    if (hasData(target) && !preflight.result.restorePoint) {
      const message = '目标声明了卷或数据库迁移，但 preflight 没有给出 restorePoint，拒绝部署'
      this.transition(intent, 'preflight_failed')
      this.recordAttempt({
        intent,
        op: 'preflight',
        state: 'preflight_failed',
        exitCode: 0,
        resultJson: '',
        detail: message,
        toolSha256: '',
        evidencePath: dir,
      })
      return fail('preflight_failed', message)
    }
    // 预检期间依据可能变化（停止、版本、候选、验收）；产生副作用前必须重新核对。
    const blocked = this.revalidate(target, input.artifact, requirementId)
    if (blocked) {
      this.transition(intent, 'preflight_failed')
      this.recordAttempt({
        intent,
        op: 'preflight',
        state: 'preflight_failed',
        exitCode: 0,
        resultJson: '',
        detail: blocked.message,
        toolSha256: '',
        evidencePath: dir,
      })
      this.deps.store.recordDeploymentDecision({
        intentId,
        decision: 'revalidate_failed',
        by: 'system:coordinator',
        at: this.now(),
        detail: blocked.message,
      })
      return fail('preflight_failed', `部署门禁未通过：${blocked.message}`)
    }
    if (target.approval === 'auto') {
      this.transition(intent, 'ready')
      return this.apply(intent, tool, input.artifact, {
        params: target.params,
        data: target.data,
      })
    }
    this.transition(intent, 'awaiting_approval')
    return ok(`部署 ${intentId} 已通过预检，等待所有者批准`, {
      intentId,
      state: intent.state,
      restorePoint: preflight.result.restorePoint,
    })
  }

  async approve(intentId: string, by = 'owner'): Promise<DeploymentOutcome> {
    const intent = this.requireIntent(intentId)
    if ('code' in intent) return intent
    if (intent.state !== 'awaiting_approval') {
      return fail('invalid_state', `部署 ${intentId} 当前状态 ${intent.state} 不能批准`)
    }
    const target = this.deps.config.deployments.targets.find((item) => item.id === intent.targetId)
    const tool = target
      ? this.deps.config.deployments.tools.find((item) => item.id === target.toolId)
      : undefined
    if (!target || !tool) return fail('not_found', '部署目标或工具已不在配置中')
    // 等待审批期间依据可能变化：停止、版本、候选或验收失效都必须拒绝执行。
    // 拒绝不改变 intent 状态：显式恢复并重新满足门禁后仍可批准。
    const blocked = this.revalidate(target, this.artifactOf(intent), intent.requirementId)
    if (blocked) {
      this.deps.store.recordDeploymentDecision({
        intentId,
        decision: 'revalidate_failed',
        by,
        at: this.now(),
        detail: blocked.message,
      })
      return fail('gate_failed', `部署核对未通过：${blocked.message}`)
    }
    this.transition(intent, 'ready')
    this.deps.store.recordDeploymentDecision({
      intentId,
      decision: 'approve',
      by,
      at: this.now(),
      detail: 'owner 批准部署',
    })
    return this.apply(intent, tool, this.artifactOf(intent), {
      params: target.params,
      data: target.data,
    })
  }

  reject(intentId: string, reason: string, by = 'owner'): DeploymentOutcome {
    const intent = this.requireIntent(intentId)
    if ('code' in intent) return intent
    if (intent.state !== 'awaiting_approval') {
      return fail('invalid_state', `部署 ${intentId} 当前状态 ${intent.state} 不能拒绝`)
    }
    this.transition(intent, 'rejected')
    this.deps.store.recordDeploymentDecision({
      intentId,
      decision: 'reject',
      by,
      at: this.now(),
      detail: reason || '未说明原因',
    })
    return ok(`部署 ${intentId} 已拒绝：${reason || '未说明原因'}`)
  }

  async verify(intentId: string, by = 'system:coordinator'): Promise<DeploymentOutcome> {
    const intent = this.requireIntent(intentId)
    if ('code' in intent) return intent
    if (intent.state !== 'applied_pending_verify') {
      return fail('invalid_state', `部署 ${intentId} 当前状态 ${intent.state} 不能核对`)
    }
    const target = this.deps.config.deployments.targets.find((item) => item.id === intent.targetId)
    const tool = target
      ? this.deps.config.deployments.tools.find((item) => item.id === target.toolId)
      : undefined
    if (!target || !tool) return fail('not_found', '部署目标或工具已不在配置中')
    this.transition(intent, 'verifying')
    const observed = await this.runOperation({
      intent,
      tool,
      op: 'status',
      artifact: this.artifactOf(intent),
      params: target.params,
      data: target.data,
    })
    if (!observed.ok) {
      this.transition(intent, 'verify_failed')
      this.deps.store.recordDeploymentDecision({
        intentId,
        decision: 'verify_failed',
        by,
        at: this.now(),
        detail: observed.message,
      })
      this.alertFailure(intent, observed.message)
      return fail('verify_failed', observed.message)
    }
    const result = observed.result
    const message = verifyMismatch(result, intent, this.appliedAt(intentId))
    if (message) {
      this.transition(intent, 'verify_failed')
      this.deps.store.recordDeploymentDecision({
        intentId,
        decision: 'verify_failed',
        by,
        at: this.now(),
        detail: message,
      })
      this.alertFailure(intent, message)
      return fail('verify_failed', message)
    }
    this.transition(intent, 'verified')
    this.deps.store.recordDeploymentDecision({
      intentId,
      decision: 'verify',
      by,
      at: this.now(),
      detail: `版本 ${result.version}，运行 pid ${result.runningPid}`,
    })
    return ok(`部署 ${intentId} 已核对：版本 ${intent.artifactVersion}`)
  }

  /** 产生副作用前的依据复核：门禁闭包包含当前版本、停止、候选、验证、终审与验收。 */
  private revalidate(
    target: DeploymentTargetConfig,
    artifact: DeploymentArtifact,
    requirementId: string,
  ): OperationResult | null {
    const result = this.deps.gate(target, artifact, requirementId)
    return result.ok ? null : fail('gate_failed', result.reason)
  }

  /**
   * 中断恢复：applying/verifying 超过核对窗口仍未收口时，先只读观测实际结果，再决定
   * 完成、失败或保留未知；绝不重新执行 apply。
   * 观测无法确认时保留原状态并记录一次待决定事实，避免每轮重复调用外部工具。
   */
  async recoverInterrupted(now = this.now()): Promise<number> {
    if (!this.deps.config.deployments.enabled) return 0
    const limitMs = this.deps.config.deployments.verifyTimeoutSeconds * 1000
    let recovered = 0
    for (const intent of this.deps.store.deploymentIntents(200)) {
      if (!this.interrupted(intent, now, limitMs)) continue
      if (await this.recoverOne(intent, now)) recovered += 1
    }
    return recovered
  }

  /** 需要恢复的中断：applying/verifying 超过窗口，且尚未留下“结果未知”决定。 */
  private interrupted(intent: DeploymentIntentRecord, now: string, limitMs: number): boolean {
    if (intent.state !== 'applying' && intent.state !== 'verifying') return false
    if (this.recoveryUnknown(intent.intentId)) return false
    const age = Date.parse(now) - Date.parse(intent.updatedAt)
    return Number.isFinite(age) && age >= limitMs
  }

  private recoveryUnknown(intentId: string): boolean {
    return this.deps.store
      .deploymentDecisions(intentId)
      .some((decision) => decision.decision === 'recovery_unknown')
  }

  private async recoverOne(intent: DeploymentIntentRecord, now: string): Promise<boolean> {
    const target = this.deps.config.deployments.targets.find((item) => item.id === intent.targetId)
    const tool = target
      ? this.deps.config.deployments.tools.find((item) => item.id === target.toolId)
      : undefined
    if (!target || !tool) {
      this.transition(intent, 'failed')
      this.decide(intent.intentId, 'recovery_failed', '部署目标或工具已不在配置中', now)
      return true
    }
    const observed = await this.runOperation({
      intent,
      tool,
      op: 'status',
      artifact: this.artifactOf(intent),
      params: target.params,
      data: target.data,
    })
    const mismatch = observed.ok ? verifyMismatch(observed.result, intent) : observed.message
    if (mismatch) {
      if (!observed.ok) {
        // 结果未知：先记录事实并告警，保留原状态等待人工决定，不重复调用工具。
        this.decide(intent.intentId, 'recovery_unknown', mismatch, now)
        this.alertFailure(
          intent,
          `部署 ${intent.intentId} 中断后无法确认结果：${mismatch}；等待人工决定`,
        )
        return false
      }
      this.transition(intent, 'failed')
      this.decide(intent.intentId, 'recovery_failed', mismatch, now)
      this.alertFailure(intent, `部署 ${intent.intentId} 中断后观测不一致：${mismatch}`)
      return true
    }
    const wasApplying = intent.state === 'applying'
    this.transition(intent, wasApplying ? 'applied_pending_verify' : 'verified')
    this.decide(
      intent.intentId,
      wasApplying ? 'recovery_applied' : 'verify',
      wasApplying ? '中断后观测到制品已安装，等待核对' : '中断后观测到安装与运行摘要一致',
      now,
    )
    return true
  }

  private decide(intentId: string, decision: string, detail: string, at: string): void {
    this.deps.store.recordDeploymentDecision({
      intentId,
      decision,
      by: 'system:coordinator',
      at,
      detail,
    })
  }

  /**
   * 核对超时：applied_pending_verify 超过 verifyTimeoutSeconds 仍未核对时标记 verify_failed
   * 并告警。只是收口与告警，不自动回退；回退仍是所有者动作。
   */
  expireStale(now = this.now()): number {
    if (!this.deps.config.deployments.enabled) return 0
    const limitMs = this.deps.config.deployments.verifyTimeoutSeconds * 1000
    let expired = 0
    for (const intent of this.deps.store.deploymentIntents(200)) {
      if (intent.state !== 'applied_pending_verify') continue
      const age = Date.parse(now) - Date.parse(intent.updatedAt)
      if (!Number.isFinite(age) || age < limitMs) continue
      this.transition(intent, 'verify_failed')
      this.alertFailure(
        intent,
        `部署 ${intent.intentId} 超过 ${this.deps.config.deployments.verifyTimeoutSeconds} 秒未完成核对`,
      )
      expired += 1
    }
    return expired
  }

  /**
   * 回退：从 applied_pending_verify/verified/verify_failed/failed 进入 rolling_back，
   * 先按 target 声明的数据范围调用 data-rollback，再调用 rollback，最后用 status 复核。
   * 回退成功只表示工具执行且状态观测通过，不把“退出码 0”当成数据已恢复。
   */
  async rollback(intentId: string, reason: string): Promise<DeploymentOutcome> {
    const intent = this.requireIntent(intentId)
    if ('code' in intent) return intent
    const rollbackFrom: readonly DeploymentAttemptState[] = [
      'applied_pending_verify',
      'verified',
      'verify_failed',
      'failed',
    ]
    if (!rollbackFrom.includes(intent.state)) {
      return fail('invalid_state', `部署 ${intentId} 当前状态 ${intent.state} 不能回退`)
    }
    const target = this.deps.config.deployments.targets.find((item) => item.id === intent.targetId)
    const tool = target
      ? this.deps.config.deployments.tools.find((item) => item.id === target.toolId)
      : undefined
    if (!target || !tool) return fail('not_found', '部署目标或工具已不在配置中')

    const restorePoint = this.restorePointOf(intent.intentId)
    const data = target.data
    if (hasData(target) && !tool.capabilities.includes('data-rollback')) {
      return fail(
        'capability_missing',
        `目标声明了数据范围，但工具 ${tool.id} 没有 data-rollback 能力`,
      )
    }
    if (hasData(target) && !restorePoint) {
      const message = `部署 ${intentId} 没有可用的 restorePoint，拒绝回退`
      this.transition(intent, 'rolling_back')
      this.transition(intent, 'failed')
      this.alertFailure(intent, message)
      return fail('restore_point_missing', message)
    }

    this.transition(intent, 'rolling_back')
    const artifact = this.artifactOf(intent)
    const previous = {
      sha256: intent.artifactSha256,
      path: intent.artifactPath,
      restorePoint,
    }
    if (hasData(target)) {
      const dataRollback = await this.runOperation({
        intent,
        tool,
        op: 'data-rollback',
        artifact,
        params: target.params,
        data,
        previous,
      })
      if (!dataRollback.ok) {
        this.transition(intent, 'failed')
        this.alertFailure(intent, dataRollback.message)
        return fail('data_rollback_failed', dataRollback.message)
      }
    }
    const rolled = await this.runOperation({
      intent,
      tool,
      op: 'rollback',
      artifact,
      params: target.params,
      data,
      previous,
    })
    if (!rolled.ok) {
      this.transition(intent, 'failed')
      this.alertFailure(intent, rolled.message)
      return fail('rollback_failed', rolled.message)
    }
    const observed = await this.runOperation({
      intent,
      tool,
      op: 'status',
      artifact,
      params: target.params,
      data,
      previous,
    })
    if (!observed.ok) {
      this.transition(intent, 'failed')
      const message = `回退后状态核对失败：${observed.message}`
      this.alertFailure(intent, message)
      return fail('rollback_verify_failed', message)
    }
    this.transition(intent, 'rolled_back')
    return ok(`部署 ${intentId} 已回退：${reason || '未说明原因'}`, {
      intentId,
      state: intent.state,
      restorePoint,
    })
  }

  /** 本次安装实际开始时间；用于判断运行进程是否在安装之后才启动。 */
  private appliedAt(intentId: string): string {
    const attempt = this.deps.store
      .deploymentAttempts(intentId)
      .find((item) => item.op === 'apply' && item.state === 'ready')
    return attempt?.startedAt ?? ''
  }

  private restorePointOf(intentId: string): string {
    const attempts = this.deps.store.deploymentAttempts(intentId)
    for (const attempt of [...attempts].reverse()) {
      if (attempt.op !== 'preflight' || attempt.state !== 'ready') continue
      try {
        const raw = asRecord(JSON.parse(attempt.resultJson))
        if (!raw) continue
        const stdout = raw.stdout
        if (typeof stdout !== 'string') continue
        const parsed = parseDeploymentToolResult(stdout)
        if (parsed.restorePoint) return parsed.restorePoint
      } catch {
        continue
      }
    }
    return ''
  }

  /** 同一目标同一时刻只允许一个未收口的 intent：部署、核对与回退不能互相踩踏。 */
  private targetBusy(targetId: string): DeploymentOutcome | null {
    const active = this.deps.store.activeDeploymentIntentForTarget(targetId)
    if (!active) return null
    return fail(
      'target_busy',
      `部署目标 ${targetId} 有进行中的部署 ${active.intentId}（${active.state}），先完成或收口后再发起`,
    )
  }

  /**
   * apply 前的确定性复核：返回空串才允许继续。
   * - 门禁按当前记录重新判定（需求版本、停止、验证、终审、提交、验收绑定）；
   * - 同一目标不能有另一个进行中的 intent；
   * - 磁盘上的制品摘要必须与 intent 记录一致（等待批准期间可能被换包）。
   */
  private revalidateBeforeApply(
    intent: DeploymentIntentRecord,
    target: DeploymentTargetConfig,
    artifact: DeploymentArtifact,
  ): string {
    const gate = this.deps.gate(target, artifact, intent.requirementId)
    if (!gate.ok) return `部署前复核未通过：${gate.reason}`
    const active = this.deps.store.activeDeploymentIntentForTarget(target.id, intent.intentId)
    if (active) {
      return `部署目标 ${target.id} 有进行中的部署 ${active.intentId}（${active.state}），本次部署不再执行`
    }
    const digest = artifactFileDigest(artifact.path)
    if (!digest) return `制品文件不可读：${artifact.path}`
    if (digest !== intent.artifactSha256) {
      return `制品文件摘要 ${digest.slice(0, 12)}… 与记录 ${intent.artifactSha256.slice(0, 12)}… 不一致，拒绝部署换包后的制品`
    }
    return ''
  }

  private decision(
    intent: DeploymentIntentRecord,
    decision: string,
    by: string,
    detail: string,
  ): void {
    this.deps.store.recordDeploymentDecision({
      intentId: intent.intentId,
      decision,
      by,
      at: this.now(),
      detail,
    })
  }

  private async apply(
    intent: DeploymentIntentRecord,
    tool: DeploymentToolConfig,
    artifact: DeploymentArtifact,
    scope: {
      readonly params: Readonly<Record<string, string>>
      readonly data: { readonly volumes: readonly string[]; readonly migrations: readonly string[] }
    },
  ): Promise<DeploymentOutcome> {
    const target = this.deps.config.deployments.targets.find((item) => item.id === intent.targetId)
    // apply 前复核：门禁、目标互斥与磁盘制品摘要都必须在调用工具前重新成立。
    const blocked = target
      ? this.revalidateBeforeApply(intent, target, artifact)
      : '部署目标已不在配置中'
    if (blocked) {
      this.transition(intent, 'preflight_failed')
      this.decision(intent, 'gate_failed', 'system:deployment-gate', blocked)
      return fail('preflight_failed', blocked)
    }
    this.transition(intent, 'applying')
    const result = await this.runOperation({
      intent,
      tool,
      op: 'apply',
      artifact,
      params: scope.params,
      data: scope.data,
    })
    if (!result.ok) {
      this.transition(intent, 'failed')
      return fail('tool_failed', result.message)
    }
    this.transition(intent, 'applied_pending_verify')
    return ok(`部署 ${intent.intentId} 已执行，等待核对`, {
      intentId: intent.intentId,
      state: intent.state,
    })
  }

  private async runOperation(input: {
    intent: DeploymentIntentRecord
    tool: DeploymentToolConfig
    op: DeploymentOperation
    artifact: DeploymentArtifact
    params: Readonly<Record<string, string>>
    data: { readonly volumes: readonly string[]; readonly migrations: readonly string[] }
    previous?: DeploymentToolPlan['previous']
  }): Promise<{ ok: boolean; message: string; result: DeploymentToolResult }> {
    const { intent, tool, op, artifact, params, data } = input
    const dir = this.evidenceDir(intent.intentId)
    const script = syncDeploymentToolScript(this.deps.store, tool, this.now())
    const plan: DeploymentToolPlan = {
      intentId: intent.intentId,
      op,
      artifact,
      previous: input.previous ?? null,
      params,
      device: { id: 'local', transport: 'local' },
      data,
      timeoutSeconds: tool.timeoutSeconds,
    }
    mkdirSync(dir, { recursive: true })
    const planPath = join(dir, `${op}.json`)
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
    // 真实开始/结束时间进入 attempt 证据，不用同一次 now() 顶替。
    const startedAt = this.now()
    let run: DeploymentToolRun
    try {
      run = await this.runTool(tool, op, planPath)
    } catch (error) {
      const message = `工具 ${tool.id} 调用失败：${error instanceof Error ? error.message : '未知错误'}`
      this.recordAttempt({
        intent,
        op,
        state: 'failed',
        exitCode: -1,
        resultJson: '',
        detail: message,
        toolSha256: script.sha256,
        evidencePath: dir,
        startedAt,
      })
      return { ok: false, message, result: emptyResult() }
    }
    const raw = JSON.stringify({
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stdout: run.stdout,
    })
    if (run.timedOut) {
      const message = `工具 ${tool.id} 执行 ${op} 超时`
      this.recordAttempt({
        intent,
        op,
        state: 'failed',
        exitCode: run.exitCode,
        resultJson: raw,
        detail: message,
        toolSha256: run.sha256,
        evidencePath: dir,
        startedAt,
      })
      return { ok: false, message, result: emptyResult() }
    }
    if (run.exitCode !== 0) {
      const message = `工具 ${tool.id} 执行 ${op} 失败：退出码 ${run.exitCode}`
      this.recordAttempt({
        intent,
        op,
        state: 'failed',
        exitCode: run.exitCode,
        resultJson: raw,
        detail: message,
        toolSha256: run.sha256,
        evidencePath: dir,
        startedAt,
      })
      return { ok: false, message, result: emptyResult() }
    }
    let parsed: DeploymentToolResult
    try {
      parsed = parseDeploymentToolResult(run.stdout)
    } catch (error) {
      const message = `工具 ${tool.id} 的 ${op} 输出不可解析：${error instanceof Error ? error.message : ''}`
      this.recordAttempt({
        intent,
        op,
        state: 'failed',
        exitCode: run.exitCode,
        resultJson: raw,
        detail: message,
        toolSha256: run.sha256,
        evidencePath: dir,
        startedAt,
      })
      return { ok: false, message, result: emptyResult() }
    }
    const state: DeploymentAttemptState = parsed.ok ? 'ready' : 'failed'
    this.recordAttempt({
      intent,
      op,
      state,
      exitCode: run.exitCode,
      resultJson: raw,
      detail: parsed.detail,
      toolSha256: run.sha256,
      evidencePath: dir,
      startedAt,
    })
    return {
      ok: parsed.ok,
      message: parsed.ok ? parsed.detail : `工具 ${tool.id} 报告 ${op} 失败：${parsed.detail}`,
      result: parsed,
    }
  }

  private alertFailure(intent: DeploymentIntentRecord, message: string): void {
    const webhook = this.deps.config.deployments.alerts.webhook
    if (!webhook) return
    void this.alert(
      webhook,
      {
        kind: 'deployment',
        intentId: intent.intentId,
        targetId: intent.targetId,
        artifactVersion: intent.artifactVersion,
        state: intent.state,
        message,
        at: this.now(),
      },
      this.deps.config.deployments.alerts.timeoutSeconds,
    ).catch(() => undefined)
  }

  private transition(intent: DeploymentIntentRecord, to: DeploymentAttemptState): void {
    if (!canTransition(intent.state, to)) {
      throw new Error(`部署状态非法：${intent.state} → ${to}`)
    }
    intent.state = to
    intent.updatedAt = this.now()
    this.deps.store.updateDeploymentIntentState(intent.intentId, to, intent.updatedAt)
  }

  private recordAttempt(input: {
    intent: DeploymentIntentRecord
    op: DeploymentOperation
    state: DeploymentAttemptState
    exitCode: number
    resultJson: string
    detail: string
    toolSha256: string
    evidencePath: string
    startedAt?: string
  }): void {
    const { intent, op, state, exitCode, resultJson, detail, toolSha256, evidencePath } = input
    const finishedAt = this.now()
    this.deps.store.recordDeploymentAttempt({
      intentId: intent.intentId,
      op,
      state,
      exitCode,
      resultJson,
      detail,
      toolSha256,
      evidencePath,
      startedAt: input.startedAt ?? finishedAt,
      finishedAt,
    })
  }

  private requireIntent(intentId: string): DeploymentIntentRecord | DeploymentOutcome {
    const intent = this.deps.store.deploymentIntent(intentId)
    return intent ?? fail('not_found', `未找到部署 ${intentId}`)
  }

  private artifactOf(intent: DeploymentIntentRecord): DeploymentArtifact {
    return {
      sha256: intent.artifactSha256,
      path: intent.artifactPath,
      version: intent.artifactVersion,
    }
  }

  private evidenceDir(intentId: string): string {
    return join(projectDir(this.deps.config), 'deployments', intentId)
  }

  /** 证据目录必须在第一次调用工具前存在；runOperation 也可能先于 request 被恢复路径调用。 */
  private evidenceFor(intentId: string): string {
    const dir = this.evidenceDir(intentId)
    mkdirSync(dir, { recursive: true })
    return dir
  }
}

function hasData(target: {
  readonly data: { readonly volumes: readonly string[]; readonly migrations: readonly string[] }
}): boolean {
  return target.data.volumes.length > 0 || target.data.migrations.length > 0
}

function verifyMismatch(
  result: DeploymentToolResult,
  intent: { readonly artifactVersion: string; readonly artifactSha256: string },
  appliedAt = '',
): string {
  if (result.version !== intent.artifactVersion) {
    return `实际运行版本 ${result.version || '未知'} 与制品 ${intent.artifactVersion} 不一致`
  }
  if (!result.artifactSha256) return '工具未提供已安装制品摘要，无法核对实际安装内容'
  if (result.artifactSha256 !== intent.artifactSha256) {
    return '已安装制品摘要与本次部署制品不一致'
  }
  if (!result.runningArtifactSha256) {
    return '工具未提供运行中制品摘要，无法确认进程已加载本次制品'
  }
  if (result.runningArtifactSha256 !== intent.artifactSha256) {
    return '运行中制品摘要与本次部署制品不一致（进程可能仍运行旧内容）'
  }
  if (result.runningPid <= 0) return '工具未提供有效运行进程 pid'
  // 同版本新包的常见失败是“装好了但进程没重载”：运行进程必须晚于本次安装才开始。
  if (!result.runningStartedAt) return '工具未提供运行进程启动时间，无法确认进程已加载本次制品'
  const started = Date.parse(result.runningStartedAt)
  if (!Number.isFinite(started)) return '工具提供的运行进程启动时间不可解析'
  const applied = appliedAt ? Date.parse(appliedAt) : Number.NaN
  if (Number.isFinite(applied) && started < applied - 5_000) {
    return '运行进程启动时间早于本次安装，进程可能仍运行旧内容'
  }
  return ''
}

function emptyResult(): DeploymentToolResult {
  return {
    ok: false,
    state: '',
    version: '',
    artifactSha256: '',
    runningArtifactSha256: '',
    runningPid: 0,
    runningStartedAt: '',
    detail: '',
    steps: [],
    restorePoint: '',
  }
}
