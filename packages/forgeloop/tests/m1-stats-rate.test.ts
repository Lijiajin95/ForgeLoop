import { describe, expect, it } from 'vitest'
import { formatRate } from '../../../scripts/ts/m1-stats.js'

describe('stats rate formatting', () => {
  it('shows a full rate as 100 percent', () => {
    expect(formatRate(1, 1)).toBe('1/1 = 100.0%')
    expect(formatRate(2, 4)).toBe('2/4 = 50.0%')
  })

  it('shows no sample when the denominator is zero', () => {
    expect(formatRate(0, 0)).toBe('0/0 = 无样本')
  })
})
