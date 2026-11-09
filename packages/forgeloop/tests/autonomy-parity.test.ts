import { describe, expect, it } from 'vitest'
import {
  computeAutonomyStats,
  requirementAutonomousSuccess,
  type RequirementAutonomyFacts,
} from '../src/domain/autonomy.js'
import { isAutonomousSuccess, type RequirementFacts } from '../src/domain/m1-stats.js'

/** 同一组事实分别喂给看板（autonomy）与复算脚本（m1-stats）的判定，口径必须一致。 */
function facts(deployed: boolean, verification: string, interventions = 0) {
  const scriptFacts: RequirementFacts = {
    status: 'committed',
    versions: 1 + interventions,
    grants: 0,
    budgetExtensions: 0,
    stops: 0,
    cancellations: 0,
    clarificationQuestions: 0,
    committed: true,
    verification,
    deployed,
  }
  const boardFacts: RequirementAutonomyFacts = {
    status: 'committed',
    versionCount: 1 + interventions,
    grants: 0,
    budgetExtensions: 0,
    stopped: false,
    cancelled: false,
    humanRequests: 0,
    committed: true,
    verificationPassed: verification === 'pass',
    deployed,
    humanDeploymentInvolved: false,
  }
  return { scriptFacts, boardFacts }
}

describe('script and board autonomy parity', () => {
  it('agrees that a deployed, verified, untouched requirement is autonomous', () => {
    const { scriptFacts, boardFacts } = facts(true, 'pass')
    expect(isAutonomousSuccess(scriptFacts)).toBe(true)
    expect(requirementAutonomousSuccess(boardFacts)).toBe(true)
  })

  it('agrees that an undeployed requirement is not autonomous', () => {
    const { scriptFacts, boardFacts } = facts(false, 'pass')
    expect(isAutonomousSuccess(scriptFacts)).toBe(false)
    expect(requirementAutonomousSuccess(boardFacts)).toBe(false)
  })

  it('agrees that a failed verification is not autonomous', () => {
    const { scriptFacts, boardFacts } = facts(true, 'failed')
    expect(isAutonomousSuccess(scriptFacts)).toBe(false)
    expect(requirementAutonomousSuccess(boardFacts)).toBe(false)
  })

  it('agrees that a human intervention blocks autonomy', () => {
    const { scriptFacts, boardFacts } = facts(true, 'pass', 1)
    expect(isAutonomousSuccess(scriptFacts)).toBe(false)
    expect(requirementAutonomousSuccess(boardFacts)).toBe(false)
  })

  it('counts the same totals through both public entry points', () => {
    const rows = [
      facts(true, 'pass'),
      facts(false, 'pass'),
      facts(true, 'failed'),
      facts(true, 'pass', 1),
    ]
    const stats = computeAutonomyStats(
      rows.map((row) => row.boardFacts),
      [],
    )
    const scriptCount = rows.filter((row) => isAutonomousSuccess(row.scriptFacts)).length
    expect(stats.requirements.total).toBe(rows.length)
    expect(stats.requirements.autonomousSuccess).toBe(scriptCount)
    // 人工介入只算“有介入依据”的那一条；验证失败/未部署不算介入，但都不计自主成功。
    expect(stats.requirements.humanInvolved).toBe(1)
  })
})
