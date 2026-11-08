import { describe, expect, it } from 'vitest'
import { VerificationPipeline } from '../src/runtime/verification-pipeline.js'

describe('verification retry allowance', () => {
  it('allows five attempts on the same candidate before requiring a new candidate', () => {
    expect(VerificationPipeline.MAX_SAME_CANDIDATE_ATTEMPTS).toBe(5)
  })
})
