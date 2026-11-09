import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { buildAdmissionFacts, decideAdmission } from '../src/domain/admission.js'

let dir = ''
let repo: Repository
const policy = {
  enabled: true,
  allowCodeCommit: true,
  trustedSources: ['dsh-session:'],
  allowAnySource: false,
  requireOwner: true,
} as const

const conflict = {
  existingReqId: 'req-old',
  commitment: '旧承诺：统一入口',
  conflict: '共享入口',
  options: ['保留旧承诺', '替换'],
  decisionNeeded: '请所有者选择保留还是替换',
}

function seedRequirement(reqId: string): void {
  repo.submit({
    reqId,
    project: 'demo',
    text: '需求正文',
    submittedBy: 'owner',
    source: 'dsh-session:s1',
    now: '2026-11-08T01:00:00.000Z',
  })
}

function recordAnalysis(
  reqId: string,
  version: number,
  conflicts: readonly (typeof conflict)[],
): void {
  repo.recordAnalysis({
    reqId,
    analysisVersion: version,
    requirementVersion: 1,
    goal: '目标',
    scenarios: ['场景'],
    acceptanceCriteria: ['验收'],
    clarifications: [],
    conflicts: [...conflicts],
    createdAt: `2026-11-08T01:0${version}:00.000Z`,
  })
}

/** 客户决定入口的领域等价：记录决定 + 投影，供准入三维回查。 */
function recordDecision(
  reqId: string,
  requirementVersion: number,
  existingReqId: string,
  overrides: Partial<{
    decision: 'revise' | 'replace' | 'reject'
    decidedBy: string
    decisionSource: string
    reason: string
  }> = {},
): string {
  return repo.commitments.recordCustomerDecision({
    reqId,
    requirementVersion,
    existingReqId,
    decision: overrides.decision ?? 'replace',
    decidedBy: overrides.decidedBy ?? 'owner',
    decisionSource: overrides.decisionSource ?? 'web-decision:owner-1',
    reason: overrides.reason ?? '所有者选择替换旧承诺',
    decidedAt: '2026-11-08T02:00:00.000Z',
  }).decisionId
}

function admissionFor(reqId: string) {
  const requirement = repo.getRequirement(reqId)!
  const analysis = repo.latestAnalysis(reqId)
  return decideAdmission(
    buildAdmissionFacts({
      requirementStatus: requirement.status,
      requirementVersion: requirement.versions.length,
      project: 'demo',
      projectPath: dir,
      source: requirement.source,
      submittedBy: requirement.submittedBy,
      owner: 'owner',
      analysis,
      ...repo.commitments.admissionCommitmentHistory(
        reqId,
        analysis ? repo.priorCommitmentConflicts(reqId, analysis.analysisVersion) : [],
      ),
    }),
    policy,
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-p0-close-'))
  repo = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('commitment resolutions at the admission entry', () => {
  it('keeps blocking when a later analysis returns an empty conflict list', () => {
    seedRequirement('req-new')
    recordAnalysis('req-new', 1, [conflict])
    recordAnalysis('req-new', 2, [])
    const decision = admissionFor('req-new')
    expect(decision).toMatchObject({ admit: false, code: 'commitment_conflict' })
    expect(decision.reason).toContain('req-old：共享入口')
    expect(decision.reason).toContain('没有引用已记录的客户决定')
  })

  it('ignores decisions bound to another version or another requirement', () => {
    seedRequirement('req-new')
    recordAnalysis('req-new', 1, [conflict])
    recordAnalysis('req-new', 2, [])
    recordDecision('req-new', 99, 'req-old', { reason: '旧版本决定' })
    expect(admissionFor('req-new')).toMatchObject({ code: 'commitment_conflict' })

    seedRequirement('req-other')
    recordDecision('req-other', 1, 'req-old', { reason: '别的需求的决定' })
    expect(admissionFor('req-new')).toMatchObject({ code: 'commitment_conflict' })
  })

  it('continues after a version-bound customer decision', () => {
    seedRequirement('req-new')
    recordAnalysis('req-new', 1, [conflict])
    recordAnalysis('req-new', 2, [])
    recordDecision('req-new', 1, 'req-old', { decision: 'revise', reason: '所有者选择修订旧承诺' })
    expect(admissionFor('req-new')).toMatchObject({ admit: true, code: 'admitted' })
  })

  it('does not treat a model source as a customer decision', () => {
    seedRequirement('req-new')
    recordAnalysis('req-new', 1, [conflict])
    recordAnalysis('req-new', 2, [])
    recordDecision('req-new', 1, 'req-old', {
      decision: 'replace',
      decisionSource: 'agent:model',
      reason: '模型自己决定',
    })
    const decision = admissionFor('req-new')
    expect(decision).toMatchObject({ code: 'commitment_conflict' })
    expect(decision.reason).toContain('不是客户决定来源')
  })

  it('blocks a decision recorded by an identity other than the owner', () => {
    seedRequirement('req-new')
    recordAnalysis('req-new', 1, [conflict])
    recordDecision('req-new', 1, 'req-old', { decidedBy: 'intruder' })
    const decision = admissionFor('req-new')
    expect(decision).toMatchObject({ code: 'commitment_conflict' })
    expect(decision.reason).toContain('与配置所有者不一致')
  })

  it('admits an ordinary requirement without conflicts', () => {
    seedRequirement('req-plain')
    recordAnalysis('req-plain', 1, [])
    expect(admissionFor('req-plain')).toMatchObject({ admit: true, code: 'admitted' })
  })

  it('treats missing history inputs as empty rather than failing', () => {
    const facts = buildAdmissionFacts({
      requirementStatus: 'draft',
      requirementVersion: 1,
      project: 'demo',
      projectPath: dir,
      source: 'dsh-session:s1',
      submittedBy: 'owner',
      owner: 'owner',
      analysis: {
        analysisVersion: 1,
        requirementVersion: 1,
        clarifications: [],
      },
    })
    expect(facts.conflicts).toBe(0)
    expect(facts.conflictSummaries).toEqual([])
    expect(facts.conflictReasons).toEqual([])
    expect(decideAdmission(facts, policy)).toMatchObject({ code: 'admitted' })
  })

  it('keeps the first recorded decision for a version and promise', () => {
    seedRequirement('req-new')
    recordAnalysis('req-new', 1, [conflict])
    recordDecision('req-new', 1, 'req-old', { decision: 'revise', reason: '第一次决定' })
    recordDecision('req-new', 1, 'req-old', { decision: 'reject', reason: '后来改主意' })
    expect(repo.commitments.commitmentResolutions('req-new')).toEqual([
      expect.objectContaining({ decision: 'revise', reason: '第一次决定' }),
    ])
    expect(repo.commitments.customerDecisions('req-new')).toEqual([
      expect.objectContaining({ decision: 'revise', decidedBy: 'owner' }),
    ])
  })
})
