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
import { randomUUID } from 'node:crypto'
import type { ForgeLoopRuntime } from './service.js'
import { projectDir } from '../config.js'
import { acquireHostLock, type HostLock } from './lock.js'

export interface CoordinatorOptions {
  readonly runtime: ForgeLoopRuntime
  readonly pollSeconds: number
  readonly autoAdvance: boolean
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
  private timer: NodeJS.Timeout | undefined
  private opsTimer: NodeJS.Timeout | undefined
  private opsCurrent: Promise<void> | undefined
  private stopped = true
  private ticking = false
  private inflight = new Map<string, AbortController>()
  private lastTickAt = ''
  private lastError = ''
  private current: Promise<void> | undefined
  private lock: HostLock | undefined

  constructor(options: CoordinatorOptions) {
    this.runtime = options.runtime
    this.pollSeconds = options.pollSeconds
    this.autoAdvance = options.autoAdvance
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
      console.error(`[forgeloop] ${this.lastError}`)
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
      }),
      now,
    )
    this.lastTickAt = now
    this.timer = setInterval(() => {
      void this.kick()
    }, this.pollSeconds * 1000)
    this.timer.unref?.()
    if (this.runtime.ops.enabled) {
      this.opsTimer = setInterval(() => void this.kickOps(), this.pollSeconds * 1000)
      this.opsTimer.unref?.()
      setTimeout(() => void this.kickOps(), 80).unref?.()
    }
    // 启动扫描：先核对/恢复，再立即消费 pending。
    setTimeout(() => void this.kick(), 50).unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.opsTimer) clearInterval(this.opsTimer)
    this.opsTimer = undefined
    for (const controller of this.inflight.values()) controller.abort()
    await this.current?.catch(() => undefined)
    await this.opsCurrent?.catch(() => undefined)
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
          console.error(`[forgeloop] 运维巡检错误：${this.lastError}`)
        }
      })
      .catch((error) => {
        this.lastError = `运维巡检异常：${(error as Error).message}`
        console.error(`[forgeloop] ${this.lastError}`)
      })
      .finally(() => {
        this.opsCurrent = undefined
      })
    return this.opsCurrent
  }

  private async runOnce(): Promise<void> {
    try {
      if (this.autoAdvance) this.ensureAutoAdvanceRequests()
      let request = this.runtime.repo.claimNextRequest(this.owner, new Date().toISOString())
      while (request && !this.stopped) {
        await this.execute(request)
        request = this.runtime.repo.claimNextRequest(this.owner, new Date().toISOString())
      }
      this.lastTickAt = new Date().toISOString()
    } catch (error) {
      this.lastError = (error as Error).message
    }
  }

  private ensureAutoAdvanceRequests(): void {
    // 判定与手动 requeue 共用同一套准入/额度/在途请求规则；协调器只负责排队。
    this.runtime.autoAdvanceRequests(new Date().toISOString())
  }

  private async execute(request: NonNullable<ReturnType<ForgeLoopRuntime['repo']['request']>>): Promise<void> {
    const controller = new AbortController()
    this.inflight.set(request.requestId, controller)
    const actionId = `act-${request.requestId}`
    const now = new Date().toISOString()
    this.runtime.repo.startAction({
      actionId,
      taskId: request.reqId,
      node: request.action,
      role: 'coordinator',
      detail: `${request.action} 请求 ${request.requestId}`,
      now,
      pid: process.pid,
    })
    try {
      const outcome = await this.runtime.executeRequest(request, controller.signal)
      const finishedAt = new Date().toISOString()
      this.runtime.repo.finishAction(actionId, outcome.state, outcome.detail, finishedAt)
      this.runtime.repo.resolveRequest(request.requestId, outcome.state, outcome.detail, finishedAt)
    } catch (error) {
      const finishedAt = new Date().toISOString()
      const detail = `执行异常：${(error as Error).message}；按失败收口，可重新执行`
      this.lastError = detail
      this.runtime.repo.finishAction(actionId, 'failed', detail, finishedAt)
      this.runtime.repo.resolveRequest(request.requestId, 'failed', detail, finishedAt)
    } finally {
      this.inflight.delete(request.requestId)
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
    return this.runtime.repo
      .requestsFor(reqId)
      .map((request) => ({
        request: request.requestId,
        action: request.action,
        state: request.state,
        record: this.runtime.repo.action(`act-${request.requestId}`),
      }))
  }
}
