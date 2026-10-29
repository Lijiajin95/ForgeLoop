/**
 * 持久工作协调器：确定性地领取已受理请求，唤醒 Agent 执行，收口动作与结果。
 *
 * 规则：
 * - 输入先落库（service_requests），再由这里领取；重复唤醒不会重复领取。
 * - 同一时刻只领取一条请求；在途请求有动作身份与 AbortController。
 * - 宿主停止时不再领取，取消在途 Agent，保留可核对状态。
 * - 重启时 claimed 请求标为 unknown、started 动作标为 interrupted；不自动重放。
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
      // 只读宿主：不领取、不把别人的在途请求标为 unknown。
      this.stopped = true
      this.lastError = `单消费者锁未取得：${lock.reason}（${lock.holder}）`
      console.error(`[forgeloop] ${this.lastError}`)
      return
    }
    this.stopped = false
    const now = new Date().toISOString()
    const unknownRequests = this.runtime.repo.markClaimedUnknown(now)
    const interrupted = this.runtime.repo.markStartedActionsInterrupted(now)
    this.runtime.repo.setMeta('host_owner', this.owner, now)
    this.runtime.repo.setMeta(
      'last_recovery',
      JSON.stringify({
        at: now,
        unknownRequests: unknownRequests.map((request) => request.requestId),
        interruptedActions: interrupted,
      }),
      now,
    )
    this.lastTickAt = now
    this.timer = setInterval(() => {
      void this.kick()
    }, this.pollSeconds * 1000)
    this.timer.unref?.()
    // 启动扫描：先核对/恢复，再立即消费 pending。
    setTimeout(() => void this.kick(), 50).unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const controller of this.inflight.values()) controller.abort()
    await this.current?.catch(() => undefined)
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
    for (const requirement of this.runtime.repo.listRequirements(this.runtime.config.project)) {
      if (!['approved', 'executing'].includes(requirement.status)) continue
      const active = this.runtime.repo
        .requestsFor(requirement.reqId)
        .some((request) => ['pending', 'claimed'].includes(request.state))
      if (active) continue
      const plan = this.runtime.repo.latestTaskPlan(requirement.reqId)
      if (!plan) continue
      const artifacts = this.runtime.repo.taskArtifacts(requirement.reqId, plan.planVersion)
      if (artifacts.length >= plan.tasks.length) continue
      try {
        this.runtime.repo.recordRequest({
          requestId: `rq-${randomUUID()}`,
          reqId: requirement.reqId,
          project: this.runtime.config.project,
          planVersion: plan.planVersion,
          action: 'advance',
          requestedBy: 'coordinator:auto-advance',
          source: 'auto-advance',
          now: new Date().toISOString(),
        })
      } catch {
        // 动作冲突/不可排队时由下一次扫描再判断，不制造第二套状态。
      }
    }
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
      const detail = `执行异常：${(error as Error).message}`
      this.lastError = detail
      this.runtime.repo.finishAction(actionId, 'unknown', detail, finishedAt)
      this.runtime.repo.resolveRequest(request.requestId, 'unknown', detail, finishedAt)
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
