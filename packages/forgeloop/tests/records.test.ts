import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { RuleViolationError } from '../src/domain/errors.js'

let dir = ''
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-records-'))
  repository = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function submit(text = 'first', clientKey = '') {
  return repository.submit({
    reqId: 'req-1',
    project: 'forgeloop',
    text,
    submittedBy: 'owner',
    source: 'test',
    clientKey,
    now: '2026-10-22T00:00:00.000Z',
  })
}

describe('requirement records', () => {
  it('persists original text as version 1 and appends revisions without overwrite', () => {
    const { requirement, created } = submit()
    expect(created).toBe(true)
    expect(requirement.versions).toHaveLength(1)
    const updated = repository.appendVersion({
      reqId: 'req-1',
      text: 'second',
      revisedBy: 'owner',
      source: 'cmd',
      now: '2026-10-22T00:10:00.000Z',
    })
    expect(updated.versions.map((version) => version.text)).toEqual(['first', 'second'])
    expect(repository.getRequirement('req-1')?.versions[0]?.text).toBe('first')
  })

  it('reuses the same requirement for an identical client key and refuses a different body', () => {
    submit('first', 'key-1')
    const again = submit('first', 'key-1')
    expect(again.created).toBe(false)
    expect(again.requirement.reqId).toBe('req-1')
    expect(() => submit('other', 'key-1')).toThrow(RuleViolationError)
    expect(repository.listRequirements('forgeloop')).toHaveLength(1)
  })

  it('keeps unknown ids explicit and honours project scoping', () => {
    submit()
    expect(repository.getRequirement('req-missing')).toBeNull()
    expect(repository.listRequirements('other')).toHaveLength(0)
  })

  it('records analyses per version and latest', () => {
    submit()
    repository.recordAnalysis({
      reqId: 'req-1',
      analysisVersion: 1,
      requirementVersion: 1,
      goal: 'g',
      scenarios: ['s'],
      acceptanceCriteria: ['a'],
      clarifications: [],
      createdAt: 'now',
    })
    expect(repository.latestAnalysis('req-1')?.goal).toBe('g')
    expect(repository.nextAnalysisVersion('req-1')).toBe(2)
  })

  it('resets status to draft on revision but keeps plan and approval history', () => {
    submit()
    repository.setStatus('req-1', 'plan_proposed')
    repository.appendVersion({
      reqId: 'req-1',
      text: 'changed',
      revisedBy: 'owner',
      source: 'cmd',
      now: 'now',
    })
    expect(repository.getRequirement('req-1')?.status).toBe('draft')
  })
})

describe('service requests', () => {
  it('persists acceptance before returning and dedupes the same action', () => {
    submit()
    const first = repository.recordRequest({
      requestId: 'rq-1',
      reqId: 'req-1',
      project: 'forgeloop',
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'cmd',
      now: 'now',
    })
    const second = repository.recordRequest({
      requestId: 'rq-2',
      reqId: 'req-1',
      project: 'forgeloop',
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'cmd',
      now: 'later',
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.request.requestId).toBe('rq-1')
    expect(repository.pendingRequests('forgeloop')).toHaveLength(1)
  })

  it('refuses to queue a different action while one is active', () => {
    submit()
    repository.recordRequest({
      requestId: 'rq-1',
      reqId: 'req-1',
      project: 'forgeloop',
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'cmd',
      now: 'now',
    })
    expect(() =>
      repository.recordRequest({
        requestId: 'rq-2',
        reqId: 'req-1',
        project: 'forgeloop',
        planVersion: 0,
        action: 'advance',
        requestedBy: 'owner',
        source: 'cmd',
        now: 'now',
      }),
    ).toThrow(/不能同时排队/)
  })

  it('claims at most once and marks unclosed claims unknown on restart instead of replaying', () => {
    submit()
    repository.recordRequest({
      requestId: 'rq-1',
      reqId: 'req-1',
      project: 'forgeloop',
      planVersion: 0,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'cmd',
      now: 'now',
    })
    const claimed = repository.claimNextRequest('host-1', 'now')
    expect(claimed?.state).toBe('claimed')
    expect(repository.claimNextRequest('host-2', 'now')).toBeNull()

    const unknown = repository.markClaimedUnknown('restart')
    expect(unknown).toHaveLength(1)
    expect(repository.request('rq-1')?.state).toBe('unknown')
    expect(repository.pendingRequests()).toHaveLength(0)
  })

  it('dismisses only pending requests when a requirement reaches a terminal state', () => {
    submit()
    repository.recordRequest({
      requestId: 'rq-1',
      reqId: 'req-1',
      project: 'forgeloop',
      planVersion: 0,
      action: 'advance',
      requestedBy: 'owner',
      source: 'cmd',
      now: 'now',
    })
    expect(repository.dismissPendingFor('req-1', 'cancelled', 'now')).toBe(1)
    expect(repository.request('rq-1')?.state).toBe('dismissed')
  })
})

describe('actions and budgets', () => {
  it('marks unclosed started actions interrupted without deleting them', () => {
    repository.startAction({ actionId: 'act-1', taskId: 't', node: 'dev', role: 'developer', now: 'now' })
    expect(repository.startedActions('t')).toHaveLength(1)
    expect(repository.markStartedActionsInterrupted('restart')).toBe(1)
    expect(repository.action('act-1')?.state).toBe('interrupted')
    expect(repository.action('act-1')?.detail).toContain('restart')
  })

  it('accumulates execution seconds and grants without clearing history', () => {
    repository.ensureBudget('req-1', 100)
    repository.chargeBudget('req-1', 30)
    repository.chargeBudget('req-1', 20)
    expect(repository.budget('req-1')).toEqual({ limitSeconds: 100, consumedSeconds: 50 })

    expect(repository.grantCount('req-1')).toBe(1)
    expect(repository.appendGrant('req-1', 'owner', 'now')).toBe(2)
    expect(repository.grantCount('req-1')).toBe(2)
  })
})