import { describe, expect, it } from 'vitest'
import { staleActionMs } from '../src/domain/action-liveness.js'

describe('stale action threshold', () => {
  it('uses one hour when no turn limit is configured', () => {
    expect(staleActionMs()).toBe(3_600_000)
    expect(staleActionMs(0)).toBe(3_600_000)
  })

  it('stays above the configured turn limit', () => {
    expect(staleActionMs(2400)).toBe(2_700_000)
    expect(staleActionMs(2400)).toBeGreaterThan(2400 * 1000)
  })
})
