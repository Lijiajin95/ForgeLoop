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
      previousConflicts: analysis
        ? repo.priorCommitmentConflicts(reqId, analysis.analysisVersion)
        : [],
      commitmentResolutions: repo.commitmentResolutions(reqId),
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
  })

  it('ignores decisions bound to another version or another requirement', () => {
    seedRequirement('req-new')
    recordAnalysis('req-new', 1, [conflict])
    recordAnalysis('req-new', 2, [])
    repo.recordCommitmentResolution({
      reqId: 'req-new',
      requirementVersion: 99,
      existingReqId: 'req-old',
      decisionSource: 'web-decision:owner-1',
      decision: 'replace',
      reason: '旧版本决定',
      decidedAt: '2026-11-08T02:00:00.000Z',
    })
    expect(admissionFor('req-new')).toMatchObject({ code: 'commitment_conflict' })

    seedRequirement('req-other')
    repo.recordCommitmentResolution({
      reqId: 'req-other',
      requirementVersion: 1,
      existingReqId: 'req-old',
      decisionSource: 'web-decision:owner-2',
      decision: 'replace',
      reason: '别的需求的决定',
      decidedAt: '2026-11-08T02:10:00.000Z',
    })
    expect(admissionFor('req-new')).toMatchObject({ code: 'commitment_conflict' })
  })

  it('continues after a version-bound customer decision', () => {
    seedRequirement('req-new')
    recordAnalysis('req-new', 1, [conflict])
    recordAnalysis('req-new', 2, [])
    repo.recordCommitmentResolution({
      reqId: 'req-new',
      requirementVersion: 1,
      existingReqId: 'req-old',
      decisionSource: 'web-decision:owner-3',
      decision: 'revise',
      reason: '所有者选择修订旧承诺',
      decidedAt: '2026-11-08T02:20:00.000Z',
    })
    expect(admissionFor('req-new')).toMatchObject({ admit: true, code: 'admitted' })
  })

  it('does not treat a model source as a customer decision', () => {
    seedRequirement('req-new')
    recordAnalysis('req-new', 1, [conflict])
    recordAnalysis('req-new', 2, [])
    repo.recordCommitmentResolution({
      reqId: 'req-new',
      requirementVersion: 1,
      existingReqId: 'req-old',
      decisionSource: 'agent:model',
      decision: 'replace',
      reason: '模型自己决定',
      decidedAt: '2026-11-08T02:30:00.000Z',
    })
    expect(admissionFor('req-new')).toMatchObject({ code: 'commitment_conflict' })
  })

  it('admits an ordinary requirement without conflicts', () => {
    seedRequirement('req-plain')
    recordAnalysis('req-plain', 1, [])
    expect(admissionFor('req-plain')).toMatchObject({ admit: true, code: 'admitted' })
  })

  it('keeps the first recorded decision for a version and promise', () => {
    seedRequirement('req-new')
    recordAnalysis('req-new', 1, [conflict])
    const base = {
      reqId: 'req-new',
      requirementVersion: 1,
      existingReqId: 'req-old',
      decisionSource: 'web-decision:owner-4',
      decidedAt: '2026-11-08T03:00:00.000Z',
    }
    repo.recordCommitmentResolution({ ...base, decision: 'revise', reason: '第一次决定' })
    repo.recordCommitmentResolution({
      ...base,
      decision: 'reject',
      reason: '后来改主意',
      decidedAt: '2026-11-08T03:10:00.000Z',
    })
    expect(repo.commitmentResolutions('req-new')).toEqual([
      expect.objectContaining({ decision: 'revise', reason: '第一次决定' }),
    ])
  })
})
