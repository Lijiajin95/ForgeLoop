import { describe, expect, it } from 'vitest'
import { errorMessage } from '../src/domain/errors.js'

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('stringifies non-Error throws instead of returning undefined', () => {
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage({ code: 'x' })).toBe('[object Object]')
  })
})
