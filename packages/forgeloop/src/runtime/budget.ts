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
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 86400) {
    return { ok: false, code: 'bad_seconds', message: '延长工时必须是 60 到 86400 秒' }
  }
  const before = repo.budget(input.reqId)
  if (before.limitSeconds <= 0) {
    return {
      ok: true,
      code: 'ok',
      message: '当前不限工时，无需延长',
      data: { limitSeconds: 0, consumedSeconds: before.consumedSeconds, extendedSeconds: 0 },
    }
  }
  const limitSeconds = repo.extendBudget(input.reqId, seconds)
  if (requirement.blockedReason.includes('工时已用尽')) {
    repo.setStatus(input.reqId, APPROVED, `所有者延长工时 ${seconds} 秒，可重新执行`)
  }
  return {
    ok: true,
    code: 'ok',
    message: `工时上限从 ${before.limitSeconds} 秒延长到 ${limitSeconds} 秒`,
    data: {
      limitSeconds,
      consumedSeconds: before.consumedSeconds,
      extendedSeconds: seconds,
    },
  }
}
