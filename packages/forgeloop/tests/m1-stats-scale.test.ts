import { describe, expect, it } from 'vitest'
import {
  dedupeByKey,
  formatRatio,
  groupIncidents,
  type OpsEventFacts,
} from '../src/domain/m1-stats.js'

function event(
  index: number,
  resourceId: string,
  overrides: Partial<OpsEventFacts> = {},
): OpsEventFacts {
  return {
    eventId: `ops-${index.toString().padStart(4, '0')}`,
    resourceId,
    checkId: 'svc-health',
    fixRequirementId: '',
    state: 'recovered',
    humanInvolved: false,
    closedAt: '',
    recoveredAt: '2026-11-08T10:00:00.000Z',
    ...overrides,
  }
}

/** 250 条独立事件：120 + 80 + 50，超过 200 条规模边界。 */
const events: OpsEventFacts[] = [
  ...Array.from({ length: 120 }, (_, index) => event(index, 'svc-a')),
  ...Array.from({ length: 80 }, (_, index) => event(120 + index, 'svc-b')),
  ...Array.from({ length: 50 }, (_, index) =>
    event(200 + index, 'svc-c', { humanInvolved: true, closedAt: '2026-11-08T11:00:00.000Z' }),
  ),
]

describe('stats scale boundary', () => {
  it('groups more than 200 events into their incidents without losing any', () => {
    expect(events).toHaveLength(250)
    const incidents = groupIncidents(events)
    expect(incidents).toHaveLength(3)
    const byKey = new Map(incidents.map((incident) => [incident.key, incident]))
    expect(byKey.get('svc-a|svc-health|')?.eventIds).toHaveLength(120)
    expect(byKey.get('svc-b|svc-health|')?.eventIds).toHaveLength(80)
    expect(byKey.get('svc-c|svc-health|')?.eventIds).toHaveLength(50)
    const total = incidents.reduce((sum, incident) => sum + incident.eventIds.length, 0)
    expect(total).toBe(250)
  })

  it('keeps human involvement and closure per incident', () => {
    const byKey = new Map(groupIncidents(events).map((incident) => [incident.key, incident]))
    expect(byKey.get('svc-a|svc-health|')).toMatchObject({
      humanInvolved: false,
      closed: false,
      recovered: true,
    })
    expect(byKey.get('svc-c|svc-health|')).toMatchObject({
      humanInvolved: true,
      closed: true,
      recovered: true,
    })
  })

  it('deduplicates the same event across archives and reports the repeats', () => {
    const duplicated = [...events, ...events.slice(0, 10)]
    const { unique, duplicates } = dedupeByKey(duplicated, (item) => item.eventId)
    expect(unique).toHaveLength(250)
    expect(duplicates).toHaveLength(10)
    expect(new Set(unique.map((item) => item.eventId)).size).toBe(250)
  })

  it('renders ratios without dropping the factor of one hundred', () => {
    expect(formatRatio(1, 1)).toBe('1/1 = 100.0%')
    expect(formatRatio(0, 0)).toBe('无样本')
    expect(formatRatio(3, 250)).toBe('3/250 = 1.2%')
  })
})
