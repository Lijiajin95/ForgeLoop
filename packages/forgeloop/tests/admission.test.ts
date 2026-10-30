import { describe, expect, it } from 'vitest'
import {
  ADMISSION_POLICY_VERSION,
  decideAdmission,
  type AdmissionFacts,
  type AdmissionPolicy,
} from '../src/domain/admission.js'
import { AGENT_IDENTITIES } from '../src/domain/agents.js'
import { COMMITTED, TERMINAL_STATUSES } from '../src/domain/status.js'

const POLICY: AdmissionPolicy = {
  enabled: true,
  allowCodeCommit: true,
  trustedSources: ['dsh-session:'],
}

function facts(overrides: Partial<AdmissionFacts> = {}): AdmissionFacts {
  return {
    requirementStatus: 'draft',
    requirementVersion: 1,
    project: 'demo',
    projectPath: '/tmp/demo',
    source: 'dsh-session:sess-1:msg-1',
    submittedBy: 'owner',
    owner: 'owner',
    analysisVersion: 1,
    analysisRequirementVersion: 1,
    clarifications: 0,
    ...overrides,
  }
}

describe('four Agent identities', () => {
  it('exposes exactly product, dev, verify and ops', () => {
    expect([...AGENT_IDENTITIES].sort()).toEqual(['dev', 'ops', 'product', 'verify'])
  })

  it('keeps committed as a terminal status', () => {
    expect(TERMINAL_STATUSES.has(COMMITTED)).toBe(true)
  })
})

describe('system admission', () => {
  it('admits a trusted human requirement with a current, unambiguous product spec', () => {
    const decision = decideAdmission(facts(), POLICY)
    expect(decision.admit).toBe(true)
    expect(decision.code).toBe('admitted')
    expect(decision.basis).toMatchObject({
      policyVersion: ADMISSION_POLICY_VERSION,
      trustedSource: true,
      codeCommitAllowed: true,
      requirementVersion: 1,
    })
  })

  it('can admit development while refusing code commit until separately authorized', () => {
    const decision = decideAdmission(facts(), { ...POLICY, allowCodeCommit: false })
    expect(decision.admit).toBe(true)
    expect(decision.basis.codeCommitAllowed).toBe(false)
  })

  it('blocks non-human sources, owner mismatch, clarifications and stale analysis', () => {
    expect(decideAdmission(facts({ source: 'test' }), POLICY)).toMatchObject({
      admit: false,
      code: 'untrusted_source',
    })
    expect(decideAdmission(facts(), { ...POLICY, trustedSources: [''] })).toMatchObject({
      admit: false,
      code: 'untrusted_source',
    })
    expect(decideAdmission(facts({ source: '' }), POLICY)).toMatchObject({
      admit: false,
      code: 'untrusted_source',
    })
    expect(decideAdmission(facts({ submittedBy: 'agent' }), POLICY)).toMatchObject({
      admit: false,
      code: 'owner_mismatch',
    })
    expect(decideAdmission(facts({ submittedBy: '' }), POLICY)).toMatchObject({
      admit: false,
      code: 'owner_mismatch',
    })
    expect(decideAdmission(facts({ clarifications: 2 }), POLICY)).toMatchObject({
      admit: false,
      code: 'clarification_required',
    })
    expect(decideAdmission(facts({ analysisRequirementVersion: 2 }), POLICY)).toMatchObject({
      admit: false,
      code: 'analysis_stale',
    })
    expect(
      decideAdmission(facts({ analysisVersion: 1, analysisRequirementVersion: null }), POLICY),
    ).toMatchObject({ admit: false, code: 'analysis_stale' })
    expect(decideAdmission(facts({ analysisVersion: null, analysisRequirementVersion: null }), POLICY)).toMatchObject({
      admit: false,
      code: 'analysis_required',
    })
  })

  it('blocks when autonomy is disabled, the project is missing, or the requirement is terminal', () => {
    expect(decideAdmission(facts(), { ...POLICY, enabled: false })).toMatchObject({
      admit: false,
      code: 'autonomy_disabled',
    })
    expect(decideAdmission(facts({ project: '', projectPath: '' }), POLICY)).toMatchObject({
      admit: false,
      code: 'project_missing',
    })
    expect(decideAdmission(facts({ projectPath: '' }), POLICY)).toMatchObject({
      admit: false,
      code: 'project_missing',
    })
    expect(decideAdmission(facts({ requirementStatus: COMMITTED }), POLICY)).toMatchObject({
      admit: false,
      code: 'terminal',
    })
  })
})
