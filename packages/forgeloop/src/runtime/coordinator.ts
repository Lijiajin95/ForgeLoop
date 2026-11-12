/**
 * 持久工作协调器：确定性地领取已受理请求，唤醒 Agent 执行，收口动作与结果。
 *
 * 规则：
 * - 输入先落库（service_requests），再由这里领取；重复唤醒不会重复领取。
 * - 同一时刻只领取一条请求；在途请求有动作身份与 AbortController。
 * - 宿主停止时不再领取，取消在途 Agent；中断的请求按 failed 收口。
 * - 重启时 claimed 请求判 failed、started 动作标 interrupted、未收口的运维动作标 interrupted；
 *   没有“无法判定”的状态，也不自动重放有副作用的动作。
 */

import { hostname } from 'node:os'
import { errorMessage } from '../domain/errors.js'
import { staleActionMs } from '../domain/action-liveness.js'
import { randomUUID } from 'node:crypto'
import type { ForgeLoopRuntime } from './service.js'
import { projectDir } from '../config.js'
import { acquireHostLock, type HostLock } from './lock.js'
import { createPluginLogger, type PluginLogger } from './log.js'

export interface CoordinatorOptions {
  readonly runtime: ForgeLoopRuntime
  readonly pollSeconds: number
  readonly autoAdvance: boolean
  /** 可注入时钟；测试用，默认 Date.now。 */
  readonly now?: () => number
}

export interface CoordinatorSnapshot {
  readonly owner: string
  readonly running: boolean
  readonly inflight: readonly string[]
  readonly lastTickAt: string
  readonly lastError: string
  readonly lock: { acquired: boolean; holder: string; reason: string }
}

export class Coordinator {
  private readonly runtime: ForgeLoopRuntime
  private readonly pollSeconds: number
  private readonly autoAdvance: boolean
  readonly owner: string
  private readonly logger: PluginLogger
  private timer: NodeJS.Timeout | undefined
  private watchdogTimer: NodeJS.Timeout | undefined
  private opsTimer: NodeJS.Timeout | undefined
  private opsCurrent: Promise<void> | undefined
  private deliveryTimer: NodeJS.Timeout | undefined
  private deliveryCurrent: Promise<void> | undefined
  private stopped = true
  private ticking = false
  private inflight = new Map<string, AbortController>()
  private readonly now: () => number
  /** 各在途请求开始执行的时间；用于给“尚未产生进展”的回合留出启动宽限。 */
  private readonly startedAt = new Map<string, number>()
  private lastTickAt = ''
  private lastError = ''
  private current: Promise<void> | undefined
  private lock: HostLock | undefined

  constructor(options: CoordinatorOptions) {
    this.runtime = options.runtime
    this.logger = createPluginLogger(options.runtime.config)
    this.pollSeconds = options.pollSeconds
    this.autoAdvance = options.autoAdvance
    this.now = options.now ?? (() => Date.now())
    this.owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
  }

  snapshot(): CoordinatorSnapshot {
    return {
      owner: this.owner,
      running: !this.stopped,
      inflight: [...this.inflight.keys()],
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      lock: {
        acquired: this.lock?.acquired ?? false,
        holder: this.lock?.holder ?? '',
        reason: this.lock?.reason ?? 'coordinator not started',
      },
    }
  }

  start(): void {
    if (!this.stopped) return
    const lock = acquireHostLock(projectDir(this.runtime.config), this.owner)
    this.lock = lock
    if (!lock.acquired) {
      // 只读宿主：不领取、不修改别人的在途请求。
      this.stopped = true
      this.lastError = `单消费者锁未取得：${lock.reason}（${lock.holder}）`
      this.logger.error(`[forgeloop] ${this.lastError}`, { event: 'coordinator.lock' })
      return
    }
    this.stopped = false
    const now = new Date().toISOString()
    // 上次没跑完的请求直接收口为 failed，并丢弃一次性工作副本；不保留无法判定的状态。
    const recovery = this.runtime.recoverInterrupted(now)
    const interrupted = this.runtime.repo.markStartedActionsInterrupted(now)
    // 旧库里的运维 unknown 先迁成“中断/未解决”；随后把本次未收口的动作标为 interrupted。
    const migratedOpsUnknown = this.runtime.repo.migrateLegacyOpsUnknown(now)
    const interruptedOps = this.runtime.repo.markRunningOpsActionsInterrupted(now)
    // 任务运行也可能停在 running：标记为阻塞，等待重新执行。
    const interruptedRuns = this.runtime.repo.markRunningTaskRunsInterrupted(now)
    // 本进程没有任何在途研发会话：把上次遗留的 busy 释放为空闲，绑定与总结保留。
    const releasedDevSessions = this.runtime.repo.resetBusyDevSessions(now)
    this.runtime.repo.setMeta('host_owner', this.owner, now)
    this.runtime.repo.setMeta(
      'last_recovery',
      JSON.stringify({
        at: now,
        interruptedRequests: recovery.interruptedRequests,
        migratedUnknown: recovery.migratedUnknown,
        discardedWorkspaces: recovery.discardedWorkspaces,
        interruptedActions: interrupted,
        migratedOpsUnknown,
        interruptedOps,
        interruptedRuns,
        releasedDevSessions,
      }),
      now,
    )
    this.lastTickAt = now
    this.timer = setInterval(() => {
      void this.kick()
    }, this.pollSeconds * 1000)
    this.timer.unref()
    if (this.runtime.ops.enabled) {
      this.startOpsTimer()
    }
    // 交付推进与研发领取分开：长研发任务不能在整轮 tick 里阻塞部署核对与超时收口。
    // 看门狗独立于 tick：被 await 挂住的执行不会阻止它继续检查。
    this.watchdogTimer = setInterval(() => void this.runWatchdog(), this.watchdogIntervalMs())
    this.watchdogTimer.unref()
    this.deliveryTimer = setInterval(() => void this.kickDelivery(), this.pollSeconds * 1000)
    this.deliveryTimer.unref()
    setTimeout(() => void this.kickDelivery(), 90).unref()
    // 启动扫描：先核对/恢复，再立即消费 pending。
    setTimeout(() => void this.kick(), 50).unref()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.opsTimer) clearInterval(this.opsTimer)
    this.opsTimer = undefined
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.watchdogTimer = undefined
    if (this.deliveryTimer) clearInterval(this.deliveryTimer)
    this.deliveryTimer = undefined
    for (const controller of this.inflight.values()) controller.abort()
    await this.current?.catch(() => undefined)
    await this.opsCurrent?.catch(() => undefined)
    await this.deliveryCurrent?.catch(() => undefined)
    this.lock?.release()
    this.lock = undefined
  }

  /** 幂等唤醒：已有一次推进在执行时直接返回。 */
  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.ticking) return this.current ?? Promise.resolve()
    this.ticking = true
    this.current = this.runOnce().finally(() => {
      this.ticking = false
    })
    return this.current
  }

  /** 运维巡检与研发推进各自独立；同一时刻只允许一轮巡检。 */
  kickOps(): Promise<void> {
    if (this.stopped || !this.runtime.ops.enabled) return Promise.resolve()
    if (this.opsCurrent) return this.opsCurrent
    this.opsCurrent = this.runtime
      .opsTick()
      .then((outcome) => {
        if (outcome.errors.length > 0) {
          this.lastError = outcome.errors.join('；')
          this.logger.error(`[forgeloop] 运维巡检错误：${this.lastError}`, {
            event: 'coordinator.ops',
          })
        }
      })
      .catch((error: unknown) => {
        this.lastError = `运维巡检异常：${errorMessage(error)}`
        this.logger.error(`[forgeloop] ${this.lastError}`, { event: 'coordinator.ops', error })
      })
      .finally(() => {
        this.opsCurrent = undefined
      })
    return this.opsCurrent
  }

  private startOpsTimer(): void {
    this.opsTimer = setInterval(() => void this.kickOps(), this.pollSeconds * 1000)
    this.opsTimer.unref()
    setTimeout(() => void this.kickOps(), 80).unref()
  }

  /**
   * 交付推进独立成链：自动构建/部署/核对、核对超时与中断恢复不等待研发请求收口。
   * 幂等由交付交接的持久状态与部署状态机保证；同一时刻只跑一轮。
   */
  kickDelivery(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.deliveryCurrent) return this.deliveryCurrent
    this.deliveryCurrent = this.deliveryTick()
      .catch((error: unknown) => {
        this.lastError = `交付推进异常：${errorMessage(error)}`
        this.logger.error(`[forgeloop] ${this.lastError}`, { event: 'coordinator.delivery', error })
      })
      .finally(() => {
        this.deliveryCurrent = undefined
      })
    return this.deliveryCurrent
  }

  private async deliveryTick(): Promise<void> {
    // 受控提交后按配置自动构建、部署并核对；失败/等待决定有持久记录。
    await this.runtime.deliveryHandoff.tick()
    // 安装完成但不核对会一直停在 applied_pending_verify；超时收口并告警。
    this.runtime.deployments.expireStale()
    // 中断可能停在 applying/verifying：先观测实际结果再收口，不重新安装。
    await this.runtime.deployments.recoverInterrupted()
  }

  /** 是否有可观测进展：最近一次活动在宽限窗口内。 */
  private hasProgress(reqId: string, requestId: string): boolean {
    const started = this.startedAt.get(requestId) ?? 0
    const at = Math.max(this.runtime.progress.last(reqId), started)
    return this.now() - at <= this.progressGraceMs()
  }

  /** 启动宽限与进展宽限：小于停滞阈值，保证正常思考不会被误判。 */
  private progressGraceMs(): number {
    return Math.max(30_000, Math.min(120_000, this.watchdogIntervalMs() * 4))
  }

  /** 看门狗轮询间隔：远小于判定阈值，保证挂起能在一个阈值窗口附近被收口。 */
  private watchdogIntervalMs(): number {
    return Math.max(5, Math.min(30, this.pollSeconds)) * 1000
  }

  /** 执行期间刷新动作心跳的间隔，必须明显小于判定阈值。 */
  private heartbeatIntervalMs(): number {
    return Math.max(5, Math.min(15, this.pollSeconds)) * 1000
  }

  /**
   * 运行期看门狗：与 tick 解耦，被 await 挂住的执行不会阻止它继续检查。
   * 只处理心跳停滞的 started 动作，并把动作、请求、会话与取消信号一起收口；
   * 副作用未知时保留“需核对”的失败记录，不自动重放。返回本次收口数量。
   */
  async runWatchdog(now = new Date(this.now()).toISOString()): Promise<number> {
    if (this.stopped) return 0
    const cutoff = new Date(
      Date.parse(now) - staleActionMs(this.runtime.config.agent.maxTurnSeconds),
    ).toISOString()
    const stale = this.runtime.repo.staleStartedActions(cutoff)
    let closed = 0
    for (const action of stale) {
      const requestId = action.actionId.startsWith('act-')
        ? action.actionId.slice('act-'.length)
        : ''
      // 动作心跳过期但确实还有可观测进展：说明模型在做事，续期而不是误杀。
      if (requestId !== '' && this.hasProgress(action.taskId, requestId)) {
        this.runtime.repo.touchAction(action.actionId, now)
        continue
      }
      const detail =
        `执行无进展：动作心跳早于 ${cutoff}，由看门狗收口（${now}）；` +
        '可能已产生副作用，需人工核对后重新排队，未自动重放'
      if (!this.runtime.repo.finishActionIfStarted(action.actionId, 'interrupted', detail, now)) {
        continue
      }
      if (requestId !== '') {
        this.runtime.repo.resolveRequestIfClaimed(requestId, 'failed', detail, now)
        this.runtime.repo.releaseDevSessionByRequest(requestId, now)
        this.inflight.get(requestId)?.abort()
      }
      closed += 1
    }
    if (closed > 0)
      this.logger.error(`[forgeloop] 看门狗收口 ${closed} 个无进展动作`, {
        event: 'coordinator.watchdog',
      })
    return closed
  }

  private async runOnce(): Promise<void> {
    try {
      if (this.autoAdvance) this.ensureAutoAdvanceRequests()
      // 产品分析失败自动重试：有上限，且不重复排队在途请求。
      this.runtime.analysisQueue.autoRetry()
      // 研发空闲时领取队首需求；忙时新需求只入队，等当前请求收口后的下一轮再启动。
      this.runtime.intakeQueuedRequirement()
      let request = this.runtime.repo.claimNextRequest(this.owner, new Date().toISOString())
      while (request && !this.stopped) {
        await this.execute(request)
        request = this.runtime.repo.claimNextRequest(this.owner, new Date().toISOString())
      }
      this.lastTickAt = new Date().toISOString()
    } catch (error) {
      this.lastError = errorMessage(error)
      // 推进异常必须立即落盘；只写 lastError 会让下一次 tick 覆盖掉唯一线索。
      this.logger.error(`[forgeloop] 协调器推进异常：${this.lastError}`, {
        event: 'coordinator.tick',
        error,
      })
    }
  }

  private ensureAutoAdvanceRequests(): void {
    // 判定与手动 requeue 共用同一套准入/额度/在途请求规则；协调器只负责排队。
    this.runtime.autoAdvanceRequests(new Date().toISOString())
  }

  private async execute(
    request: NonNullable<ReturnType<ForgeLoopRuntime['repo']['request']>>,
  ): Promise<void> {
    const controller = new AbortController()
    this.inflight.set(request.requestId, controller)
    const actionId = `act-${request.requestId}`
    const now = new Date(this.now()).toISOString()
    this.runtime.repo.startAction({
      actionId,
      taskId: request.reqId,
      node: request.action,
      role: 'coordinator',
      detail: `${request.action} 请求 ${request.requestId}`,
      now,
      pid: process.pid,
    })
    // 只有出现可观测进展才刷新心跳：执行器挂起后不再刷新，看门狗才能识别。
    this.startedAt.set(request.requestId, this.now())
    const heartbeat = setInterval(() => {
      if (!this.hasProgress(request.reqId, request.requestId)) return
      this.runtime.repo.touchAction(actionId, new Date(this.now()).toISOString())
    }, this.heartbeatIntervalMs())
    heartbeat.unref()
    const execution = this.runtime.executeRequest(request, controller.signal)
    try {
      const outcome = await Promise.race([execution, abortRejection(controller.signal)])
      const finishedAt = new Date(this.now()).toISOString()
      // 迟到结果不得覆盖已被看门狗收口的状态。
      if (
        !this.runtime.repo.finishActionIfStarted(
          actionId,
          outcome.state,
          outcome.detail,
          finishedAt,
        )
      ) {
        this.logger.error(`[forgeloop] 迟到结果被拒绝：${actionId} 已收口`, {
          event: 'coordinator.late-result',
          actionId,
          reqId: request.reqId,
        })
        return
      }
      this.runtime.repo.resolveRequestIfClaimed(
        request.requestId,
        outcome.state,
        outcome.detail,
        finishedAt,
      )
      this.runtime.settleStopIfQuiet(request.reqId)
    } catch (error) {
      const finishedAt = new Date(this.now()).toISOString()
      // 被取消时优先记录执行器真正返回的原因；取不到再用取消本身的原因。
      // 宿主停止时优先保留执行器真正返回的原因；看门狗收口不等待，避免拖慢后续调度。
      const settled =
        controller.signal.aborted && this.stopped ? await settleWithin(execution) : null
      const reason =
        settled === null
          ? errorMessage(error)
          : settled.status === 'rejected'
            ? errorMessage(settled.reason)
            : settled.value.detail
      const detail = `执行异常：${reason}；按失败收口，可重新执行`
      this.lastError = detail
      this.logger.error(`[forgeloop] ${detail}`, {
        event: 'coordinator.execute',
        actionId,
        reqId: request.reqId,
        error,
      })
      if (this.runtime.repo.finishActionIfStarted(actionId, 'failed', detail, finishedAt)) {
        this.runtime.repo.resolveRequestIfClaimed(request.requestId, 'failed', detail, finishedAt)
      } else {
        this.logger.error(`[forgeloop] 迟到异常被忽略：${actionId} 已收口`, {
          event: 'coordinator.late-error',
          actionId,
          reqId: request.reqId,
        })
      }
      this.runtime.settleStopIfQuiet(request.reqId)
    } finally {
      clearInterval(heartbeat)
      this.inflight.delete(request.requestId)
      this.startedAt.delete(request.requestId)
    }
  }

  /** 中止某个需求当前在途的请求；返回中止数量。 */
  abortRequirement(reqId: string): number {
    let aborted = 0
    for (const [requestId, controller] of this.inflight) {
      const request = this.runtime.repo.request(requestId)
      if (request?.reqId !== reqId) continue
      controller.abort()
      aborted += 1
    }
    return aborted
  }

  /** 供查询展示：动作与请求的对应关系。 */
  describeActions(reqId: string): unknown[] {
    return this.runtime.repo.requestsFor(reqId).map((request) => ({
      request: request.requestId,
      action: request.action,
      state: request.state,
      record: this.runtime.repo.action(`act-${request.requestId}`),
    }))
  }
}

/** 取消信号到位即返回拒绝，避免不响应取消的执行永久占住调度。 */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('执行被取消'))
      return
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(new Error('执行被取消'))
      },
      { once: true },
    )
  })
}

/** 在短窗口内取得执行结果；超时返回 null，避免为记录原因而无限等待。 */
function settleWithin<T>(
  promise: Promise<T>,
): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown } | null> {
  return Promise.race([
    promise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    ),
    new Promise<null>((done) => {
      const timer = setTimeout(() => {
        done(null)
      }, 2_000)
      timer.unref()
    }),
  ])
}
