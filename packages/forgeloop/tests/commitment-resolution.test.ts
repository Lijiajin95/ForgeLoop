import { describe, expect, it } from 'vitest'
import {
  decisionSourceTrusted,
  resolutionCovers,
  unresolvedCommitments,
} from '../src/domain/commitment-resolution.js'

const conflict = { existingReqId: 'req-old', conflict: '共享入口', options: ['保留旧承诺', '替换'] }

function resolution(overrides: Record<string, unknown> = {}) {
  return {
    reqId: 'req-new',
    requirementVersion: 3,
    existingReqId: 'req-old',
    decisionSource: 'web-decision:owner-42',
    decision: 'replace' as const,
    reason: '所有者选择替换旧承诺',
    decidedAt: '2026-11-07T04:00:00.000Z',
    ...overrides,
  }
}

describe('commitment resolution evidence', () => {
  it('accepts a customer decision bound to the current requirement version', () => {
    expect(decisionSourceTrusted('web-decision:owner-42')).toBe(true)
    expect(decisionSourceTrusted('owner:direct')).toBe(true)
    expect(decisionSourceTrusted('coordinator:auto-advance')).toBe(false)
    expect(decisionSourceTrusted('agent:model')).toBe(false)
    expect(decisionSourceTrusted('')).toBe(false)
    expect(
      resolutionCovers(resolution(), { requirementVersion: 3, conflicts: [conflict] }),
    ).toEqual({ ok: true })
  })

  it('rejects a decision for another version, an unknown conflict or a model source', () => {
    expect(
      resolutionCovers(resolution(), { requirementVersion: 4, conflicts: [conflict] }),
    ).toMatchObject({ ok: false })
    expect(
      resolutionCovers(resolution({ existingReqId: 'req-other' }), {
        requirementVersion: 3,
        conflicts: [conflict],
      }),
    ).toMatchObject({ ok: false })
    expect(
      resolutionCovers(resolution({ decisionSource: 'agent:model' }), {
        requirementVersion: 3,
        conflicts: [conflict],
      }),
    ).toMatchObject({ ok: false })
    expect(
      resolutionCovers(resolution({ reason: '  ' }), {
        requirementVersion: 3,
        conflicts: [conflict],
      }),
    ).toMatchObject({ ok: false })
  })

  it('keeps a known conflict blocking when the model returns an empty conflict list', () => {
    const still = unresolvedCommitments({
      previousConflicts: [conflict],
      analysisConflicts: [],
      resolutions: [],
      requirementVersion: 3,
    })
    expect(still).toEqual([conflict])
  })

  it('clears a conflict only with a valid resolution for the current version', () => {
    expect(
      unresolvedCommitments({
        previousConflicts: [conflict],
        analysisConflicts: [],
        resolutions: [resolution()],
        requirementVersion: 3,
      }),
    ).toEqual([])
    // 旧版本的解除依据不能顺延到新版本。
    expect(
      unresolvedCommitments({
        previousConflicts: [conflict],
        analysisConflicts: [],
        resolutions: [resolution({ requirementVersion: 2 })],
        requirementVersion: 3,
      }),
    ).toEqual([conflict])
  })

  it('adds newly reported conflicts that have no resolution yet', () => {
    const fresh = { existingReqId: 'req-second', conflict: '重复通知', options: ['合并', '保留'] }
    expect(
      unresolvedCommitments({
        previousConflicts: [],
        analysisConflicts: [fresh],
        resolutions: [],
        requirementVersion: 3,
      }),
    ).toEqual([fresh])
  })

  it('does not treat a normal conflict-free requirement as blocked', () => {
    expect(
      unresolvedCommitments({
        previousConflicts: [],
        analysisConflicts: [],
        resolutions: [],
        requirementVersion: 3,
      }),
    ).toEqual([])
  })
})
