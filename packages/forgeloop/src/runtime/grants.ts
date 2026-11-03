/**
 * 失败轮次追加授权：所有者动作。每次 +3 轮，累计失败与历史保留，不清零。
 * 只在需求处于 blocked 时允许，避免执行中放宽额度。
 */
import { APPROVED, isTerminal } from '../domain/status.js'
import { MAX_ROUNDS_PER_GRANT } from '../domain/counting.js'
import type { Repository } from '../records/repository.js'
import type { WorkBudgetResult } from './budget.js'

export interface FailureRoundGrant {
  readonly reqId: string
  readonly by: string
  readonly source: string
  readonly now?: string
}

export function grantFailureRounds(
  repo: Repository,
  input: FailureRoundGrant,
  roundsPerGrant = MAX_ROUNDS_PER_GRANT,
): WorkBudgetResult {
  const requirement = repo.getRequirement(input.reqId)
  if (!requirement) {
    return { ok: false, code: 'not_found', message: `未找到需求 ${input.reqId}` }
  }
  if (isTerminal(requirement.status)) {
    return { ok: false, code: 'terminal', message: `需求已处于终态 ${requirement.status}` }
  }
  if (requirement.status !== 'blocked') {
    return {
      ok: false,
      code: 'not_blocked',
      message: '只有阻塞中的需求可以追加授权；执行中不允许放宽额度',
    }
  }
  const before = repo.grantCount(input.reqId)
  const now = input.now ?? new Date().toISOString()
  const grantCount = repo.appendGrant(input.reqId, input.by, now)
  const unlimited = roundsPerGrant === -1
  repo.setStatus(
    input.reqId,
    APPROVED,
    unlimited
      ? `当前失败轮次不限（MAX）；已记录第 ${grantCount} 次授权，可重新执行`
      : `所有者追加授权 +${roundsPerGrant} 轮（第 ${grantCount} 次），可重新执行`,
  )
  return {
    ok: true,
    code: 'ok',
    message: unlimited
      ? `当前失败轮次不限（MAX）；已记录第 ${grantCount} 次授权，上限不因此变化`
      : `已追加授权：失败轮次额度增加 ${roundsPerGrant} 轮（授权 ${before} → ${grantCount}）`,
    data: { grantCount, addedRounds: unlimited ? 0 : roundsPerGrant },
  }
}
