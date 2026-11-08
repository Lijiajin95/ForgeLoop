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
  repo.recordCommitmentResolution({
    reqId,
    requirementVersion,
    existingReqId,
    decisionSource: 'web-decision:owner-7',
    decision: 'replace',
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
    expect(repo.commitmentResolutionFor('req-new', 1, 'req-old')).toMatchObject({
      decisionSource: 'web-decision:owner-7',
      decision: 'replace',
      reason: '所有者选择替换旧承诺',
    })
  })

  it('does not return a decision recorded for another version or another promise', () => {
    seed('req-new')
    record('req-new', 1, 'req-old')
    expect(repo.commitmentResolutionFor('req-new', 2, 'req-old')).toBeNull()
    expect(repo.commitmentResolutionFor('req-new', 1, 'req-other')).toBeNull()
    expect(repo.commitmentResolutionFor('req-other', 1, 'req-old')).toBeNull()
  })

  it('keeps the first decision for a triple and lists all decisions of a requirement', () => {
    seed('req-new')
    record('req-new', 1, 'req-old')
    record('req-new', 2, 'req-old')
    repo.recordCommitmentResolution({
      reqId: 'req-new',
      requirementVersion: 1,
      existingReqId: 'req-old',
      decisionSource: 'web-decision:owner-8',
      decision: 'reject',
      reason: '后来改主意',
      decidedAt: '2026-11-08T05:20:00.000Z',
    })
    expect(repo.commitmentResolutionFor('req-new', 1, 'req-old')).toMatchObject({
      decisionSource: 'web-decision:owner-7',
      decision: 'replace',
    })
    expect(repo.commitmentResolutions('req-new')).toHaveLength(2)
  })
})
