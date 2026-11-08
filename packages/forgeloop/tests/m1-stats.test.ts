import { describe, expect, it } from 'vitest'
import {
  dedupeByKey,
  formatRatio,
  groupIncidents,
  interventionsOf,
  isAutonomousSuccess,
  type RequirementFacts,
} from '../src/domain/m1-stats.js'

function facts(overrides: Partial<RequirementFacts> = {}): RequirementFacts {
  return {
    reqId: 'req-1',
    status: 'committed',
    versions: 1,
    grants: 0,
    budgetExtensions: 0,
    stops: 0,
    cancellations: 0,
    clarificationQuestions: 0,
    committed: true,
    verification: 'pass',
    deployed: true,
    ...overrides,
  }
}

describe('M1 requirement statistics', () => {
  it('counts the first additional authorization as an intervention', () => {
    expect(interventionsOf(facts({ grants: 1 }))).toEqual(['追加授权 1 次'])
    expect(isAutonomousSuccess(facts({ grants: 1 }))).toBe(false)
  })

  it('does not count a committed but undeployed requirement as success', () => {
    expect(isAutonomousSuccess(facts({ deployed: false }))).toBe(false)
  })

  it('does not count failed verification, stops or cancellations as success', () => {
    expect(isAutonomousSuccess(facts({ verification: 'block' }))).toBe(false)
    expect(isAutonomousSuccess(facts({ status: 'blocked' }))).toBe(false)
    expect(isAutonomousSuccess(facts({ stops: 1 }))).toBe(false)
    expect(isAutonomousSuccess(facts({ cancellations: 1 }))).toBe(false)
    expect(isAutonomousSuccess(facts({ clarificationQuestions: 1 }))).toBe(false)
  })

  it('treats a fully delivered requirement as autonomous success', () => {
    expect(isAutonomousSuccess(facts())).toBe(true)
  })

  it('reports percentages and never shows a fraction as a percentage', () => {
    expect(formatRatio(1, 1)).toBe('1/1 = 100.0%')
    expect(formatRatio(1, 4)).toBe('1/4 = 25.0%')
    expect(formatRatio(0, 0)).toBe('无样本')
  })
})

describe('M1 sample aggregation', () => {
  it('deduplicates the same requirement across archives', () => {
    const { unique, duplicates } = dedupeByKey(
      [{ reqId: 'a' }, { reqId: 'b' }, { reqId: 'a' }],
      (item) => item.reqId,
    )
    expect(unique.map((item) => item.reqId)).toEqual(['a', 'b'])
    expect(duplicates).toEqual(['a'])
  })

  it('merges alerts of one fault and keeps every event id', () => {
    const incidents = groupIncidents([
      {
        eventId: 'e1',
        resourceId: 'svc',
        checkId: 'svc-health',
        fixRequirementId: 'req-fix',
        state: 'recovered',
        humanInvolved: false,
        closedAt: '',
        recoveredAt: '2026-11-08T00:00:00Z',
      },
      {
        eventId: 'e2',
        resourceId: 'svc',
        checkId: 'svc-health',
        fixRequirementId: 'req-fix',
        state: 'closed',
        humanInvolved: true,
        closedAt: '2026-11-08T01:00:00Z',
        recoveredAt: '',
      },
    ])
    expect(incidents).toHaveLength(1)
    expect(incidents[0]?.eventIds).toEqual(['e1', 'e2'])
    expect(incidents[0]?.humanInvolved).toBe(true)
    expect(incidents[0]?.closed).toBe(true)
  })
})
