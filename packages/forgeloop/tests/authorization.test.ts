import { describe, expect, it } from 'vitest'
import { resolveRequirementAuthorization } from '../src/domain/authorization.js'
import type { AdmissionRecord } from '../src/records/rows.js'
import type { TaskPlanApproval } from '../src/domain/task-plan.js'

const PLAN = { requirementId: 'req-1', planVersion: 2, requirementVersion: 3 }

function approval(overrides: Partial<TaskPlanApproval> = {}): TaskPlanApproval {
  return {
    requirementId: 'req-1',
    planVersion: 2,
    approvedBy: 'owner',
    approvedAt: '2026-11-23T00:00:00.000Z',
    source: 'web-decision:session:plan-v2',
    ...overrides,
  }
}

function admission(overrides: Partial<AdmissionRecord> = {}): AdmissionRecord {
  return {
    admissionId: 'adm-1',
    requirementId: 'req-1',
    requirementVersion: 3,
    decision: 'admit',
    code: 'admitted',
    reason: '可信需求来源',
    policyVersion: 'system-admission-v1',
    decidedBy: 'system:admission',
    createdAt: '2026-11-23T00:00:00.000Z',
    basis: {
      policyVersion: 'system-admission-v1',
      source: 'test',
      submittedBy: 'owner',
      owner: 'owner',
      project: 'demo',
      projectPath: '/tmp/demo',
      requirementVersion: 3,
      analysisVersion: 1,
      trustedSource: true,
      allowAnySource: true,
      requireOwner: false,
      codeCommitAllowed: true,
    },
    ...overrides,
  }
}

describe('requirement authorization', () => {
  it('authorizes an owner-approved plan', () => {
    const view = resolveRequirementAuthorization({
      requirementVersion: 3,
      plan: PLAN,
      approval: approval(),
      admission: null,
    })
    expect(view.status).toBe('authorized')
    expect(view.authorization).toMatchObject({
      kind: 'owner-approval',
      planVersion: 2,
      requirementVersion: 3,
    })
    expect(view.authorization?.authorizationSource).toContain('plan-approval:req-1:v2')
  })

  it('authorizes a system-admitted requirement without an approval', () => {
    const view = resolveRequirementAuthorization({
      requirementVersion: 3,
      plan: PLAN,
      approval: null,
      admission: admission(),
    })
    expect(view.status).toBe('authorized')
    expect(view.authorization).toMatchObject({ kind: 'system-admission', planVersion: 2 })
    expect(view.authorization?.authorizationSource).toBe('system-admission:adm-1')
  })

  it('authorizes an admission before any plan exists', () => {
    const view = resolveRequirementAuthorization({
      requirementVersion: 3,
      plan: null,
      approval: null,
      admission: admission(),
    })
    expect(view.status).toBe('authorized')
    expect(view.authorization?.planVersion).toBe(0)
  })

  it('keeps the admission valid when the stored plan is for an older requirement version', () => {
    const view = resolveRequirementAuthorization({
      requirementVersion: 3,
      plan: { ...PLAN, requirementVersion: 2 },
      approval: null,
      admission: admission(),
    })
    expect(view.status).toBe('authorized')
    expect(view.authorization?.planVersion).toBe(0)
  })

  it('reports a stale approval bound to an older plan version', () => {
    const view = resolveRequirementAuthorization({
      requirementVersion: 3,
      plan: PLAN,
      approval: approval({ planVersion: 1 }),
      admission: null,
    })
    expect(view.status).toBe('stale')
    expect(view.reason).toContain('旧版本批准')
  })

  it('reports a stale approval for another requirement', () => {
    const view = resolveRequirementAuthorization({
      requirementVersion: 3,
      plan: PLAN,
      approval: approval({ requirementId: 'req-other' }),
      admission: null,
    })
    expect(view.status).toBe('stale')
  })

  it('reports a stale admission bound to an older requirement version', () => {
    const view = resolveRequirementAuthorization({
      requirementVersion: 3,
      plan: null,
      approval: null,
      admission: admission({ requirementVersion: 2 }),
    })
    expect(view.status).toBe('stale')
    expect(view.reason).toContain('准入绑定需求 v2')
  })

  it('reports a blocked admission as missing, not authorized', () => {
    const view = resolveRequirementAuthorization({
      requirementVersion: 3,
      plan: null,
      approval: null,
      admission: admission({ decision: 'block', reason: '来源不可信' }),
    })
    expect(view.status).toBe('missing')
    expect(view.reason).toContain('来源不可信')
  })

  it('reports missing when neither approval nor admission exists', () => {
    const view = resolveRequirementAuthorization({
      requirementVersion: 3,
      plan: PLAN,
      approval: null,
      admission: null,
    })
    expect(view.status).toBe('missing')
    expect(view.authorization).toBeNull()
  })

  it('reports a stale approval when no plan exists to bind it', () => {
    const view = resolveRequirementAuthorization({
      requirementVersion: 3,
      plan: null,
      approval: approval(),
      admission: null,
    })
    expect(view.status).toBe('stale')
  })
})
