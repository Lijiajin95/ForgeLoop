import { hostname } from 'node:os'
import { errorMessage } from '../domain/errors.js'
import { staleActionMs } from '../domain/action-liveness.js'
import { randomUUID } from 'node:crypto'
import type { ForgeLoopRuntime } from './service.js'
import { projectDir } from '../config.js'
import { acquireHostLock, type HostLock } from './lock.js'
import { createPluginLogger, type PluginLogger } from './log.js'
import { reliabilitySample } from './reliability.js'

export interface CoordinatorOptions {
  readonly runtime: ForgeLoopRuntime
  readonly pollSeconds: number
  readonly autoAdvance: boolean
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
  private reliabilityTimer: NodeJS.Timeout | undefined
  private stopped = true
  private ticking = false
  private inflight = new Map<string, AbortController>()
  private readonly now: () => number
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
    this.runtime.coordinatorOwner = lock.acquired
    if (!lock.acquired) {
      this.stopped = true
      this.lastError = `单消费者锁未取得：${lock.reason}（${lock.holder}）`
      this.logger.error(`[forgeloop] ${this.lastError}`, { event: 'coordinator.lock' })
      return
    }
    this.stopped = false
    const now = new Date().toISOString()
    const recovery = this.runtime.recoverInterrupted(now)
    const interrupted = this.runtime.repo.markStartedActionsInterrupted(now)
    const migratedOpsUnknown = this.runtime.repo.migrateLegacyOpsUnknown(now)
    const interruptedOps = this.runtime.repo.markRunningOpsActionsInterrupted(now)
    const interruptedRuns = this.runtime.repo.markRunningTaskRunsInterrupted(now)
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
    // 看门狗独立于 tick：被 await 挂住的执行不会阻止它继续检查。
    this.watchdogTimer = setInterval(() => void this.runWatchdog(), this.watchdogIntervalMs())
    this.watchdogTimer.unref()
    this.deliveryTimer = setInterval(() => void this.kickDelivery(), this.pollSeconds * 1000)
    this.deliveryTimer.unref()
    setTimeout(() => void this.kickDelivery(), 90).unref()
    this.reliabilityTimer = setInterval(
      () => {
        void this.sampleReliability()
      },
      Math.max(30, this.pollSeconds) * 1000,
    )
    this.reliabilityTimer.unref()
    setTimeout(() => {
      void this.sampleReliability()
    }, 150).unref()
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
    if (this.reliabilityTimer) clearInterval(this.reliabilityTimer)
    this.reliabilityTimer = undefined
    for (const controller of this.inflight.values()) controller.abort()
    await this.current?.catch(() => undefined)
    await this.opsCurrent?.catch(() => undefined)
    await this.deliveryCurrent?.catch(() => undefined)
    this.lock?.release()
    this.lock = undefined
  }

  async kick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.ticking) return this.current ?? Promise.resolve()
    this.ticking = true
    this.current = this.runOnce().finally(() => {
      this.ticking = false
    })
    return this.current
  }

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

  async kickDelivery(): Promise<void> {
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
    await this.runtime.deliveryHandoff.tick()
    this.runtime.deployments.expireStale()
    await this.runtime.deployments.recoverInterrupted()
  }

  private async sampleReliability(): Promise<void> {
    if (this.stopped) return
    try {
      await reliabilitySample(this.runtime.repo, this.runtime.config, () => new Date(this.now()))
    } catch (error) {
      this.logger.error(`[forgeloop] 可靠性指标采样失败：${errorMessage(error)}`, {
        event: 'coordinator.reliability',
        error,
      })
    }
  }

  private hasProgress(reqId: string, requestId: string): boolean {
    const started = this.startedAt.get(requestId) ?? 0
    const at = Math.max(this.runtime.progress.last(reqId), started)
    return this.now() - at <= this.progressGraceMs()
  }

  private progressGraceMs(): number {
    return Math.max(30_000, Math.min(120_000, this.watchdogIntervalMs() * 4))
  }

  private watchdogIntervalMs(): number {
    return Math.max(5, Math.min(30, this.pollSeconds)) * 1000
  }

  private heartbeatIntervalMs(): number {
    return Math.max(5, Math.min(15, this.pollSeconds)) * 1000
  }

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
      this.runtime.analysisQueue.autoRetry()
      this.runtime.intakeQueuedRequirement()
      let request = this.runtime.repo.claimNextRequest(this.owner, new Date().toISOString())
      while (request && !this.stopped) {
        await this.execute(request)
        request = this.runtime.repo.claimNextRequest(this.owner, new Date().toISOString())
      }
      this.lastTickAt = new Date().toISOString()
    } catch (error) {
      this.lastError = errorMessage(error)
      this.logger.error(`[forgeloop] 协调器推进异常：${this.lastError}`, {
        event: 'coordinator.tick',
        error,
      })
    }
  }

  private ensureAutoAdvanceRequests(): void {
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

  describeActions(reqId: string): unknown[] {
    return this.runtime.repo.requestsFor(reqId).map((request) => ({
      request: request.requestId,
      action: request.action,
      state: request.state,
      record: this.runtime.repo.action(`act-${request.requestId}`),
    }))
  }
}

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
