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
    expect(
      decideAdmission(facts({ analysisVersion: null, analysisRequirementVersion: null }), POLICY),
    ).toMatchObject({
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

describe('system admission reasons (mutation-kill)', () => {
  it('reports each terminal status with its own text', () => {
    for (const status of ['accepted', 'rejected', 'cancelled', 'committed']) {
      const decision = decideAdmission(facts({ requirementStatus: status }), POLICY)
      expect(decision).toEqual({
        admit: false,
        code: 'terminal',
        reason: `需求已处于终态 ${status}`,
        basis: expect.anything(),
      })
    }
  })

  it('reports disabled autonomy, missing project and untrusted source verbatim', () => {
    expect(decideAdmission(facts(), { ...POLICY, enabled: false })).toMatchObject({
      code: 'autonomy_disabled',
      reason: '系统准入未启用；需要所有者显式授权',
    })
    expect(decideAdmission(facts({ project: '   ' }), POLICY)).toMatchObject({
      code: 'project_missing',
      reason: '项目或项目路径未配置；不能确定执行边界',
    })
    expect(decideAdmission(facts({ projectPath: '\t' }), POLICY)).toMatchObject({
      code: 'project_missing',
    })
    expect(decideAdmission(facts({ source: '' }), POLICY)).toMatchObject({
      code: 'untrusted_source',
      reason: '需求来源 （空） 不在可信人类入口内；不能由系统准入',
    })
    expect(decideAdmission(facts({ source: 'cli:1' }), POLICY)).toMatchObject({
      code: 'untrusted_source',
      reason: '需求来源 cli:1 不在可信人类入口内；不能由系统准入',
    })
  })

  it('does not trust an empty prefix', () => {
    expect(
      decideAdmission(facts({ source: 'anything' }), { ...POLICY, trustedSources: [''] }),
    ).toMatchObject({
      code: 'untrusted_source',
    })
    expect(
      decideAdmission(facts({ source: 'anything' }), { ...POLICY, trustedSources: ['x', ''] }),
    ).toMatchObject({
      code: 'untrusted_source',
    })
  })

  it('reports owner mismatch, missing and stale analysis verbatim', () => {
    expect(decideAdmission(facts({ submittedBy: '' }), POLICY)).toMatchObject({
      code: 'owner_mismatch',
      reason: '需求提交者 （空） 与配置所有者不一致；不能由系统准入',
    })
    expect(decideAdmission(facts({ submittedBy: 'other' }), POLICY)).toMatchObject({
      code: 'owner_mismatch',
      reason: '需求提交者 other 与配置所有者不一致；不能由系统准入',
    })
    expect(decideAdmission(facts({ analysisVersion: null }), POLICY)).toMatchObject({
      code: 'analysis_required',
      reason: '尚无与当前需求版本对应的需求说明；不能进入研发',
    })
    expect(
      decideAdmission(facts({ analysisRequirementVersion: null, requirementVersion: 3 }), POLICY),
    ).toMatchObject({
      code: 'analysis_stale',
      reason: '需求说明依据版本 v?，当前是 v3；需要由产品 Agent 重新澄清',
    })
    expect(
      decideAdmission(facts({ analysisRequirementVersion: 1, requirementVersion: 2 }), POLICY),
    ).toMatchObject({
      code: 'analysis_stale',
      reason: '需求说明依据版本 v1，当前是 v2；需要由产品 Agent 重新澄清',
    })
  })

  it('reports clarification count and both admitted reasons', () => {
    expect(decideAdmission(facts({ clarifications: 2 }), POLICY)).toMatchObject({
      code: 'clarification_required',
      reason: '仍有 2 条业务歧义需要澄清',
    })
    expect(decideAdmission(facts(), POLICY).reason).toBe(
      '可信需求来源、有效授权与需求说明齐备；允许研发、验证并提交代码',
    )
    expect(decideAdmission(facts(), { ...POLICY, allowCodeCommit: false }).reason).toBe(
      '可信需求来源与需求说明齐备；允许研发与验证，代码提交仍需单独授权',
    )
  })
})
