/**
 * 失败轮次追加授权：所有者动作。每次 +3 轮，累计失败与历史保留，不清零。
 * 只在需求处于 blocked 时允许，避免执行中放宽额度。
 */
import { APPROVED, isTerminal } from '../domain/status.js'
import type { Repository } from '../records/repository.js'
import type { WorkBudgetResult } from './budget.js'

export interface FailureRoundGrant {
  readonly reqId: string
  readonly by: string
  readonly source: string
  readonly now?: string
}

export function grantFailureRounds(repo: Repository, input: FailureRoundGrant): WorkBudgetResult {
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
  repo.setStatus(input.reqId, APPROVED, `所有者追加授权 +3 轮（第 ${grantCount} 次），可重新执行`)
  return {
    ok: true,
    code: 'ok',
    message: `已追加授权：失败轮次额度增加 3 轮（授权 ${before} → ${grantCount}）`,
    data: { grantCount, addedRounds: 3 },
  }
}
