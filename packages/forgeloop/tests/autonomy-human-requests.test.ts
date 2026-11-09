import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { buildAutonomyStats } from '../src/runtime/autonomy-stats.js'

let dir = ''
let repo: Repository
const now = '2026-11-10T02:00:00.000Z'

function submit(reqId: string): void {
  repo.submit({
    reqId,
    project: 'demo',
    text: `需求 ${reqId}`,
    submittedBy: 'owner',
    source: 'dsh-session:s1',
    now,
  })
}

function request(reqId: string, id: string, requestedBy: string, source: string): void {
  repo.recordRequest({
    requestId: id,
    reqId,
    project: 'demo',
    planVersion: 1,
    action: 'analyze',
    requestedBy,
    source,
    now,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-autostats-'))
  repo = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('human request detection', () => {
  it('counts a web-decision request as human involvement', () => {
    submit('req-web')
    request('req-web', 'req-1', 'someone', 'web-decision:42')
    expect(buildAutonomyStats(repo, 'demo', 'owner').requirements.humanInvolved).toBe(1)
  })

  it('counts a request made by the configured owner even without the prefix', () => {
    submit('req-owner')
    request('req-owner', 'req-2', 'owner', 'dsh-session:s2')
    expect(buildAutonomyStats(repo, 'demo', 'owner').requirements.humanInvolved).toBe(1)
  })

  it('does not treat a non-owner agent request as human when no owner is configured', () => {
    submit('req-agent')
    request('req-agent', 'req-3', 'agent', 'dsh-session:s3')
    expect(buildAutonomyStats(repo, 'demo', '').requirements.humanInvolved).toBe(0)
  })

  it('does not treat a matching requestedBy as human when the owner is empty', () => {
    submit('req-empty')
    request('req-empty', 'req-4', '', 'dsh-session:s4')
    expect(buildAutonomyStats(repo, 'demo', '').requirements.humanInvolved).toBe(0)
  })
})
