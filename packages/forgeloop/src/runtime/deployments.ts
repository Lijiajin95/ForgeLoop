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
  runDeploymentTool,
  syncDeploymentToolScript,
  type DeploymentToolPlan,
  type DeploymentToolRun,
} from './deployment-tools.js'
import { sendDeploymentAlert } from './deployment-alerts.js'
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
    const tool = config.deployments.tools.find((item) => item.id === target.toolId)
    if (!tool) return fail('not_found', `部署目标引用了未登记工具：${target.toolId}`)

    const intentId = `dep-${randomUUID()}`
    const at = this.now()
    const intent: DeploymentIntentRecord = {
      intentId,
      project: config.project,
      targetId: target.id,
      requirementId: target.requirementId,
      artifactSha256: input.artifact.sha256,
      artifactPath: input.artifact.path,
      artifactVersion: input.artifact.version,
      source: input.source,
      approval: target.approval,
      state: 'draft',
      createdAt: at,
      updatedAt: at,
    }
    this.deps.store.recordDeploymentIntent(intent)
    const dir = this.evidenceDir(intentId)
    mkdirSync(dir, { recursive: true })

    const gate = this.deps.gate(target, input.artifact)
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
    if (target.approval === 'auto') {
      this.transition(intent, 'ready')
      return this.apply(intent, tool, input.artifact, { params: target.params, data: target.data })
    }
    this.transition(intent, 'awaiting_approval')
    return ok(`部署 ${intentId} 已通过预检，等待所有者批准`, {
      intentId,
      state: intent.state,
      restorePoint: preflight.result.restorePoint,
    })
  }

  async approve(intentId: string): Promise<DeploymentOutcome> {
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
    this.transition(intent, 'ready')
    return this.apply(intent, tool, this.artifactOf(intent), {
      params: target.params,
      data: target.data,
    })
  }

  reject(intentId: string, reason: string): DeploymentOutcome {
    const intent = this.requireIntent(intentId)
    if ('code' in intent) return intent
    if (intent.state !== 'awaiting_approval') {
      return fail('invalid_state', `部署 ${intentId} 当前状态 ${intent.state} 不能拒绝`)
    }
    this.transition(intent, 'rejected')
    return ok(`部署 ${intentId} 已拒绝：${reason || '未说明原因'}`)
  }

  async verify(intentId: string): Promise<DeploymentOutcome> {
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
      this.alertFailure(intent, observed.message)
      return fail('verify_failed', observed.message)
    }
    if (observed.result.version !== intent.artifactVersion) {
      this.transition(intent, 'verify_failed')
      const message = `实际运行版本 ${observed.result.version || '未知'} 与制品 ${intent.artifactVersion} 不一致`
      this.alertFailure(intent, message)
      return fail('verify_failed', message)
    }
    this.transition(intent, 'verified')
    return ok(`部署 ${intentId} 已核对：版本 ${intent.artifactVersion}`)
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

  private async apply(
    intent: DeploymentIntentRecord,
    tool: DeploymentToolConfig,
    artifact: DeploymentArtifact,
    scope: {
      readonly params: Readonly<Record<string, string>>
      readonly data: { readonly volumes: readonly string[]; readonly migrations: readonly string[] }
    },
  ): Promise<DeploymentOutcome> {
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
    const planPath = join(dir, `${op}.json`)
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
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
  }): void {
    const { intent, op, state, exitCode, resultJson, detail, toolSha256, evidencePath } = input
    const at = this.now()
    this.deps.store.recordDeploymentAttempt({
      intentId: intent.intentId,
      op,
      state,
      exitCode,
      resultJson,
      detail,
      toolSha256,
      evidencePath,
      startedAt: at,
      finishedAt: at,
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
}

function hasData(target: {
  readonly data: { readonly volumes: readonly string[]; readonly migrations: readonly string[] }
}): boolean {
  return target.data.volumes.length > 0 || target.data.migrations.length > 0
}

function emptyResult(): DeploymentToolResult {
  return { ok: false, state: '', version: '', detail: '', steps: [], restorePoint: '' }
}
