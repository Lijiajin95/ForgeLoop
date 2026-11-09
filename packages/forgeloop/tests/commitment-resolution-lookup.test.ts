import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'

let dir = ''
let repo: Repository

function seed(reqId: string): void {
  repo.submit({
    reqId,
    project: 'demo',
    text: '需求正文',
    submittedBy: 'owner',
    source: 'dsh-session:s1',
    now: '2026-11-08T05:00:00.000Z',
  })
}

function record(reqId: string, requirementVersion: number, existingReqId: string): void {
  repo.commitments.recordCustomerDecision({
    reqId,
    requirementVersion,
    existingReqId,
    decision: 'replace',
    decidedBy: 'owner',
    decisionSource: 'web-decision:owner-7',
    reason: '所有者选择替换旧承诺',
    decidedAt: '2026-11-08T05:10:00.000Z',
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-lookup-'))
  repo = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('commitment resolution lookup', () => {
  it('finds a decision by requirement, version and promise', () => {
    seed('req-new')
    record('req-new', 1, 'req-old')
    expect(repo.commitments.commitmentResolutionFor('req-new', 1, 'req-old')).toMatchObject({
      decisionSource: 'web-decision:owner-7',
      decision: 'replace',
      reason: '所有者选择替换旧承诺',
      decisionId: expect.stringMatching(/^cd-/),
    })
    expect(repo.commitments.decisionForCommitment('req-new', 1, 'req-old')).toMatchObject({
      decidedBy: 'owner',
      decision: 'replace',
    })
  })

  it('does not return a decision recorded for another version or another promise', () => {
    seed('req-new')
    record('req-new', 1, 'req-old')
    expect(repo.commitments.commitmentResolutionFor('req-new', 2, 'req-old')).toBeNull()
    expect(repo.commitments.commitmentResolutionFor('req-new', 1, 'req-other')).toBeNull()
    expect(repo.commitments.commitmentResolutionFor('req-other', 1, 'req-old')).toBeNull()
    expect(repo.commitments.decisionForCommitment('req-new', 2, 'req-old')).toBeNull()
    expect(repo.commitments.customerDecision('cd-missing')).toBeNull()
  })

  it('keeps the first decision for a triple and lists all decisions of a requirement', () => {
    seed('req-new')
    record('req-new', 1, 'req-old')
    record('req-new', 2, 'req-old')
    repo.commitments.recordCustomerDecision({
      reqId: 'req-new',
      requirementVersion: 1,
      existingReqId: 'req-old',
      decision: 'reject',
      decidedBy: 'owner',
      decisionSource: 'web-decision:owner-8',
      reason: '后来改主意',
      decidedAt: '2026-11-08T05:20:00.000Z',
    })
    expect(repo.commitments.commitmentResolutionFor('req-new', 1, 'req-old')).toMatchObject({
      decisionSource: 'web-decision:owner-7',
      decision: 'replace',
    })
    expect(repo.commitments.commitmentResolutions('req-new')).toHaveLength(2)
    expect(repo.commitments.customerDecisions('req-new')).toHaveLength(2)
  })

  it('adds the decision_id column to a database created before the rule', () => {
    const legacyPath = join(dir, 'legacy.sqlite')
    const legacy = Database.open(legacyPath)
    legacy.handle.exec(
      `DROP TABLE requirement_commitment_resolutions;
       CREATE TABLE requirement_commitment_resolutions (
         req_id TEXT NOT NULL,
         requirement_version INTEGER NOT NULL,
         existing_req_id TEXT NOT NULL,
         decision_source TEXT NOT NULL,
         decision TEXT NOT NULL,
         reason TEXT NOT NULL DEFAULT '',
         decided_at TEXT NOT NULL,
         PRIMARY KEY (req_id, requirement_version, existing_req_id)
       );`,
    )
    legacy.close()
    const reopened = Database.open(legacyPath)
    const columns = reopened.prepare('PRAGMA table_info(requirement_commitment_resolutions)').all()
    expect(columns.map((column) => column.name)).toContain('decision_id')
    reopened.close()
  })
})
