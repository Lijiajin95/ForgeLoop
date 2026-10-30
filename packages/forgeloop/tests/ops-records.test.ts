import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { OPS_ATTEMPT_INTERRUPTED, OPS_AWAITING_DECISION, OPS_RECOVERING, OPS_UNRESOLVED } from '../src/domain/ops.js'

const PROJECT = 'forgeloop'
const NOW = '2026-10-29T10:00:00.000Z'

let dir = ''
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-ops-'))
  repository = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function event(eventId = 'ops-1'): void {
  repository.createOpsEvent({
    eventId,
    project: PROJECT,
    resourceId: 'web',
    checkId: 'web-health',
    signature: 'web/web-health/1/abc',
    severity: 'major',
    state: 'open',
    title: '天工页面健康检查失败',
    impact: '',
    openedAt: NOW,
    updatedAt: NOW,
  })
}

describe('ops event records', () => {
  it('stores an event, finds the active event by signature and keeps history after closing', () => {
    event()
    expect(repository.findActiveOpsEvent(PROJECT, 'web/web-health/1/abc')?.eventId).toBe('ops-1')
    repository.updateOpsEvent('ops-1', {
      state: 'closed',
      closedAt: NOW,
      updatedAt: NOW,
      humanInvolved: true,
      humanReason: 'owner 关闭',
    })
    expect(repository.findActiveOpsEvent(PROJECT, 'web/web-health/1/abc')).toBeNull()
    expect(repository.opsEvent('ops-1')?.state).toBe('closed')
    expect(repository.opsEvent('ops-1')?.humanInvolved).toBe(true)
  })

  it('appends observations in sequence and records diagnosis identity', () => {
    event()
    repository.appendOpsObservation({
      eventId: 'ops-1',
      at: NOW,
      kind: 'check',
      summary: '退出码 1',
      detailJson: '{"exitCode":1}',
      evidencePath: 'ops/ops-1/check.log',
    })
    repository.appendOpsObservation({
      eventId: 'ops-1',
      at: NOW,
      kind: 'diagnosis',
      summary: '先重启',
      detailJson: '{}',
      evidencePath: 'ops/ops-1/diagnosis-1.json',
    })
    expect(repository.opsObservations('ops-1').map((item) => item.seq)).toEqual([1, 2])
    repository.updateOpsEvent('ops-1', {
      state: OPS_AWAITING_DECISION,
      diagnosisJson: '{"impact":"x"}',
      diagnosisPath: 'ops/ops-1/diagnosis-1.json',
      diagnosisSession: 'session-ops-1',
      impact: '用户无法打开页面',
      updatedAt: NOW,
    })
    const stored = repository.opsEvent('ops-1')
    expect(stored?.state).toBe(OPS_AWAITING_DECISION)
    expect(stored?.diagnosisSession).toBe('session-ops-1')
    expect(stored?.impact).toBe('用户无法打开页面')
  })

  it('links a fix requirement once and lists events newest first', () => {
    event('ops-1')
    event('ops-2')
    repository.linkOpsFixRequirement('ops-1', 'req-fix-1', NOW)
    expect(repository.opsEvent('ops-1')?.fixRequirementId).toBe('req-fix-1')
    expect(repository.listOpsEvents(PROJECT).map((item) => item.eventId).sort()).toEqual(['ops-1', 'ops-2'])
    expect(() => repository.linkOpsFixRequirement('ops-1', 'req-fix-2', NOW)).toThrow('已经关联')
  })
})

describe('ops action attempts', () => {
  it('records intent before execution and closes the same identity', () => {
    event()
    repository.recordOpsActionAttempt({
      actionId: 'act-1',
      eventId: 'ops-1',
      actionDefId: 'restart-web',
      paramsJson: '{"mode":"graceful"}',
      state: 'running',
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: NOW,
    })
    repository.finishOpsActionAttempt('act-1', {
      state: 'succeeded',
      detail: '退出码 0',
      exitCode: 0,
      finishedAt: NOW,
      evidencePath: 'ops/ops-1/action-1.log',
    })
    const attempts = repository.opsActionAttempts('ops-1')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.state).toBe('succeeded')
    expect(attempts[0]?.exitCode).toBe(0)
    expect(attempts[0]?.authorizationSource).toBe('ops-action:auto:restart-web')
  })

  it('marks a running action as interrupted, closes the event as unresolved and never auto-replays', () => {
    event()
    repository.updateOpsEvent('ops-1', { state: OPS_RECOVERING, updatedAt: NOW })
    repository.recordOpsActionAttempt({
      actionId: 'act-1',
      eventId: 'ops-1',
      actionDefId: 'restart-web',
      paramsJson: '{}',
      state: 'running',
      authorizationSource: 'owner:test',
      startedAt: NOW,
    })
    const marked = repository.markRunningOpsActionsInterrupted('2026-10-29T10:05:00.000Z')
    expect(marked).toEqual([{ actionId: 'act-1', eventId: 'ops-1' }])
    expect(repository.opsActionAttempts('ops-1')[0]?.state).toBe(OPS_ATTEMPT_INTERRUPTED)
    expect(repository.opsActionAttempts('ops-1')[0]?.detail).toContain('不自动重放')
    expect(repository.opsEvent('ops-1')?.state).toBe(OPS_UNRESOLVED)
    expect(repository.markRunningOpsActionsInterrupted('2026-10-29T10:06:00.000Z')).toEqual([])
  })

  it('migrates legacy ops unknown rows to interrupted attempts and unresolved events', () => {
    event()
    repository.recordOpsActionAttempt({
      actionId: 'act-legacy',
      eventId: 'ops-1',
      actionDefId: 'restart-web',
      paramsJson: '{}',
      state: 'unknown',
      authorizationSource: 'owner:test',
      startedAt: NOW,
    })
    repository.updateOpsEvent('ops-1', { state: 'unknown', updatedAt: NOW })
    expect(repository.migrateLegacyOpsUnknown('2026-10-29T10:05:00.000Z')).toBe(2)
    expect(repository.opsActionAttempts('ops-1')[0]?.state).toBe(OPS_ATTEMPT_INTERRUPTED)
    expect(repository.opsEvent('ops-1')?.state).toBe(OPS_UNRESOLVED)
  })
})
