/**
 * 工时延长：所有者动作。只加总上限、不清零已消耗；当前因工时耗尽阻塞时，
 * 同时解除该阻塞，随后由 requeue/autoAdvance 重新排队。
 */
import { APPROVED, isTerminal } from '../domain/status.js'
import type { Repository } from '../records/repository.js'

export interface WorkBudgetExtension {
  readonly reqId: string
  readonly seconds: number
  readonly by: string
  readonly source: string
}

export interface WorkBudgetResult {
  readonly ok: boolean
  readonly code: string
  readonly message: string
  readonly data?: unknown
}

export function extendWorkBudget(repo: Repository, input: WorkBudgetExtension): WorkBudgetResult {
  const requirement = repo.getRequirement(input.reqId)
  if (!requirement) {
    return { ok: false, code: 'not_found', message: `未找到需求 ${input.reqId}` }
  }
  if (isTerminal(requirement.status)) {
    return { ok: false, code: 'terminal', message: `需求已处于终态 ${requirement.status}` }
  }
  const seconds = Math.trunc(input.seconds)
  const unlimited = seconds === -1
  if (!unlimited && (!Number.isFinite(seconds) || seconds < 60 || seconds > 86400)) {
    return {
      ok: false,
      code: 'bad_seconds',
      message: '延长工时必须是 60 到 86400 秒，或 -1（不限）',
    }
  }
  const before = repo.budget(input.reqId)
  const limitSeconds = repo.extendBudget(input.reqId, seconds)
  if (requirement.blockedReason.includes('工时已用尽')) {
    repo.setStatus(
      input.reqId,
      APPROVED,
      unlimited
        ? '所有者将工时改为不限（MAX），可重新执行'
        : `所有者延长工时 ${seconds} 秒，可重新执行`,
    )
  }
  const label = (value: number): string => (value === -1 ? 'MAX（不限）' : `${value} 秒`)
  return {
    ok: true,
    code: 'ok',
    message:
      limitSeconds === -1 && !unlimited && before.limitSeconds === -1
        ? '当前工时已是不限（MAX），延长不改变上限'
        : `工时上限从 ${label(before.limitSeconds)} 延长到 ${label(limitSeconds)}`,
    data: {
      limitSeconds,
      consumedSeconds: before.consumedSeconds,
      extendedSeconds: unlimited ? 0 : seconds,
    },
  }
}
