import { describe, expect, it } from 'vitest'
import {
  decisionSourceTrusted,
  resolutionCovers,
  resolutionRejections,
  unresolvedCommitments,
  type CustomerDecision,
} from '../src/domain/commitment-resolution.js'

const conflict = { existingReqId: 'req-old', conflict: '共享入口', options: ['保留旧承诺', '替换'] }
const OWNER = 'owner'

function decision(overrides: Partial<CustomerDecision> = {}): CustomerDecision {
  return {
    decisionId: 'cd-1',
    reqId: 'req-new',
    requirementVersion: 3,
    existingReqId: 'req-old',
    decision: 'replace',
    decidedBy: OWNER,
    decisionSource: 'web-decision:owner-42',
    reason: '所有者选择替换旧承诺',
    decidedAt: '2026-11-07T04:00:00.000Z',
    ...overrides,
  }
}

function resolution(overrides: Record<string, unknown> = {}) {
  const base = decision()
  return {
    reqId: base.reqId,
    requirementVersion: base.requirementVersion,
    existingReqId: base.existingReqId,
    decisionId: base.decisionId,
    decisionSource: base.decisionSource,
    decision: base.decision,
    reason: base.reason,
    decidedAt: base.decidedAt,
    ...overrides,
  }
}

function check(overrides: Record<string, unknown> = {}) {
  return {
    requirementVersion: 3,
    conflicts: [conflict],
    decisions: [decision()],
    owner: OWNER,
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
    expect(resolutionCovers(resolution(), check())).toEqual({ ok: true })
  })

  it('rejects a decision for another version, an unknown conflict or a model source', () => {
    expect(resolutionCovers(resolution(), check({ requirementVersion: 4 }))).toMatchObject({
      ok: false,
    })
    expect(resolutionCovers(resolution({ existingReqId: 'req-other' }), check())).toMatchObject({
      ok: false,
    })
    expect(resolutionCovers(resolution({ decisionSource: 'agent:model' }), check())).toMatchObject({
      ok: false,
    })
    expect(resolutionCovers(resolution({ reason: '  ' }), check())).toMatchObject({ ok: false })
  })

  it('requires a recorded customer decision instead of a trusted-looking source', () => {
    const verdict = resolutionCovers(resolution({ decisionId: '' }), check())
    expect(verdict.ok).toBe(false)
    expect(verdict).toMatchObject({ reason: expect.stringContaining('没有引用已记录的客户决定') })
  })

  it('rejects forged sources, wrong identity, expired decisions and cross-requirement reuse', () => {
    expect(
      resolutionCovers(
        resolution(),
        check({ decisions: [decision({ decisionSource: 'agent:model' })] }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('来源不可信') })
    expect(
      resolutionCovers(resolution(), check({ decisions: [decision({ decidedBy: 'intruder' })] })),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('与配置所有者不一致') })
    expect(
      resolutionCovers(resolution(), check({ decisions: [decision({ requirementVersion: 2 })] })),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('已过期') })
    expect(
      resolutionCovers(resolution(), check({ decisions: [decision({ reqId: 'req-other' })] })),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('不能解除需求') })
    expect(
      resolutionCovers(
        resolution(),
        check({ decisions: [decision({ existingReqId: 'req-third' })] }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('不一致') })
  })

  it('collects the concrete reason for every unresolvable commitment', () => {
    const reasons = resolutionRejections({
      ...check(),
      resolutions: [
        resolution({ decisionId: '' }),
        resolution({ decisionId: 'cd-missing' }),
        resolution({ decisionId: 'cd-1', reason: '  ' }),
      ],
    })
    expect(reasons).toHaveLength(3)
    expect(reasons[0]).toContain('没有引用已记录的客户决定')
    expect(reasons[1]).toContain('引用的客户决定不存在')
    expect(reasons[2]).toContain('必须说明理由')
  })

  it('keeps a known conflict blocking when the model returns an empty conflict list', () => {
    const still = unresolvedCommitments({
      previousConflicts: [conflict],
      analysisConflicts: [],
      resolutions: [],
      decisions: [decision()],
      owner: OWNER,
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
        decisions: [decision()],
        owner: OWNER,
        requirementVersion: 3,
      }),
    ).toEqual([])
    // 旧版本的解除依据不能顺延到新版本。
    expect(
      unresolvedCommitments({
        previousConflicts: [conflict],
        analysisConflicts: [],
        resolutions: [resolution({ requirementVersion: 2 })],
        decisions: [decision({ requirementVersion: 2 })],
        owner: OWNER,
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
        decisions: [decision()],
        owner: OWNER,
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
        decisions: [],
        owner: OWNER,
        requirementVersion: 3,
      }),
    ).toEqual([])
  })
})
