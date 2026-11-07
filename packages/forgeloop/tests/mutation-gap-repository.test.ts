import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'

let dir = ''
let database: Database
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-repo-gap-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repository = new Repository(database)
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function submit(
  text = 'first',
  clientKey = '',
  now = '2026-11-04T00:00:00.000Z',
  reqId = 'req-1',
  project = 'demo',
) {
  return repository.submit({
    reqId,
    project,
    text,
    submittedBy: 'owner',
    source: 'test',
    clientKey,
    now,
  })
}

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    reqId: 'req-1',
    analysisVersion: 1,
    requirementVersion: 1,
    inputKind: 'requirement' as const,
    goal: '目标',
    scenarios: ['场景'],
    businessRules: ['规则'],
    exceptions: ['异常'],
    nonGoals: ['非目标'],
    acceptanceCriteria: ['标准'],
    clarifications: [],
    model: 'm',
    promptVersion: 'p',
    transcriptPath: '/tmp/t',
    toolCalls: ['tool'],
    createdAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  }
}

describe('stale action watchdog', () => {
  it('interrupts only actions whose heartbeat is older than the cutoff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeloop-stale-action-'))
    const repo = new Repository(Database.open(join(dir, '.forgeloop', 'records.sqlite')))
    try {
      repo.startAction({
        actionId: 'act-old',
        taskId: 'req-1',
        node: 'advance',
        role: 'coordinator',
        now: '2026-11-07T00:00:00.000Z',
      })
      repo.startAction({
        actionId: 'act-fresh',
        taskId: 'req-1',
        node: 'advance',
        role: 'coordinator',
        now: '2026-11-07T02:00:00.000Z',
      })
      const marked = repo.markStaleActionsInterrupted(
        '2026-11-07T01:00:00.000Z',
        '2026-11-07T03:00:00.000Z',
      )
      expect(marked).toBe(1)
      expect(repo.action('act-old')?.state).toBe('interrupted')
      expect(repo.action('act-fresh')?.state).toBe('started')
    } finally {
      repo.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
describe('submission and versions', () => {
  it('rejects a conflicting client key with the exact identity message', () => {
    submit('first', 'key-1')
    expect(() => submit('other', 'key-1')).toThrow(
      '客户端幂等键 key-1 已用于不同内容的需求 req-1；拒绝猜用户想改哪一条',
    )
    expect(repository.requirementByClientKey('missing')).toBeNull()
    expect(repository.requirementByClientKey('key-1')?.reqId).toBe('req-1')
  })

  it('falls back to draft when the stored status is empty', () => {
    submit()
    database.handle.prepare("UPDATE requirements SET status = '' WHERE req_id = 'req-1'").run()
    expect(repository.getRequirement('req-1')?.status).toBe('draft')
    expect(repository.getRequirement('missing')).toBeNull()
  })

  it('orders versions and numbers the latest version from 0 when absent', () => {
    expect(repository.latestVersionNumber('req-missing')).toBe(0)
    submit()
    repository.appendVersion({
      reqId: 'req-1',
      text: 'second',
      revisedBy: 'owner',
      source: 'cmd',
      now: '2026-11-04T00:01:00.000Z',
    })
    expect(repository.latestVersionNumber('req-1')).toBe(2)
    expect(repository.versions('req-1').map((version) => version.version)).toEqual([1, 2])
  })

  it('rejects unknown revisions and blank text, and resets status on revision', () => {
    expect(() =>
      repository.appendVersion({
        reqId: 'missing',
        text: 'x',
        revisedBy: 'o',
        source: 's',
        now: 't',
      }),
    ).toThrow('未找到需求 missing')
    submit()
    repository.setStatus('req-1', 'blocked', '等待补充')
    expect(() =>
      repository.appendVersion({
        reqId: 'req-1',
        text: '  ',
        revisedBy: 'o',
        source: 's',
        now: 't',
      }),
    ).toThrow('需求修订原文不能为空')
    expect(() => repository.setStatus('missing', 'draft')).toThrow('未找到需求 missing')
    const updated = repository.appendVersion({
      reqId: 'req-1',
      text: ' second ',
      revisedBy: 'owner',
      source: 'cmd',
      now: '2026-11-04T00:02:00.000Z',
    })
    expect(updated.status).toBe('draft')
    expect(updated.versions[1]?.text).toBe('second')
  })

  it('lists requirements per project in reverse creation order', () => {
    submit('a', '', '2026-11-04T00:00:00.000Z', 'req-a', 'demo')
    submit('b', '', '2026-11-04T00:01:00.000Z', 'req-b', 'demo')
    submit('c', '', '2026-11-04T00:02:00.000Z', 'req-c', 'other')
    expect(repository.listRequirements('demo').map((item) => item.reqId)).toEqual([
      'req-b',
      'req-a',
    ])
    expect(repository.listRequirements('other').map((item) => item.reqId)).toEqual(['req-c'])
    expect(repository.listRequirements()).toHaveLength(3)
  })
})

describe('acceptance and cancellation', () => {
  it('returns empty acceptance and refuses unknown requirements', () => {
    expect(repository.acceptance('missing')).toEqual({})
    expect(() =>
      repository.recordAcceptance({
        reqId: 'missing',
        acceptedBy: 'owner',
        source: 'cmd',
        fingerprint: 'f',
        now: 't',
      }),
    ).toThrow('未找到需求 missing')
    submit()
    repository.recordAcceptance({
      reqId: 'req-1',
      acceptedBy: 'owner',
      source: 'cmd',
      fingerprint: 'fingerprint',
      now: '2026-11-04T01:00:00.000Z',
    })
    expect(repository.getRequirement('req-1')?.status).toBe('accepted')
    expect(repository.acceptance('req-1')).toEqual({
      accepted_at: '2026-11-04T01:00:00.000Z',
      accepted_by: 'owner',
      acceptance_source: 'cmd',
      acceptance_fingerprint: 'fingerprint',
    })
  })

  it('records and overwrites cancellation details', () => {
    expect(repository.cancellation('req-1')).toBeNull()
    submit()
    repository.recordCancellation({
      reqId: 'req-1',
      cancelledBy: 'owner',
      reason: '不再需要',
      now: '2026-11-04T00:00:00.000Z',
    })
    expect(repository.getRequirement('req-1')?.status).toBe('cancelled')
    expect(repository.cancellation('req-1')).toEqual({
      cancelledBy: 'owner',
      reason: '不再需要',
      cancelledAt: '2026-11-04T00:00:00.000Z',
    })
    repository.recordCancellation({
      reqId: 'req-1',
      cancelledBy: 'admin',
      reason: '重复',
      now: '2026-11-04T00:01:00.000Z',
    })
    expect(repository.cancellation('req-1')).toEqual({
      cancelledBy: 'admin',
      reason: '重复',
      cancelledAt: '2026-11-04T00:01:00.000Z',
    })
  })
})

describe('analyses and attempts', () => {
  it('round-trips every analysis field and the latest analysis', () => {
    submit()
    expect(repository.nextAnalysisVersion('req-1')).toBe(1)
    expect(repository.latestAnalysis('req-1')).toBeNull()
    repository.recordAnalysis(analysis())
    expect(repository.nextAnalysisVersion('req-1')).toBe(2)
    const { reqId: _reqId, ...stored } = analysis()
    expect(repository.analyses('req-1')).toEqual([stored])
    expect(repository.latestAnalysis('req-1')).toEqual(stored)
    repository.recordAnalysis(
      analysis({
        analysisVersion: 2,
        inputKind: 'problem',
        scenarios: [],
        clarifications: [],
        acceptanceCriteria: ['修复'],
      }),
    )
    expect(repository.latestAnalysis('req-1')?.inputKind).toBe('problem')
  })

  it('defaults legacy input kind and rejects unknown requirements', () => {
    expect(() => repository.recordAnalysis(analysis({ reqId: 'missing' }))).toThrow(
      '未找到需求 missing',
    )
    submit()
    repository.recordAnalysis(analysis())
    database.handle
      .prepare("DELETE FROM requirement_analysis_input_kinds WHERE req_id = 'req-1'")
      .run()
    expect(repository.analyses('req-1')[0]?.inputKind).toBe('requirement')
    database.handle
      .prepare(
        "INSERT INTO requirement_analysis_input_kinds (req_id, analysis_version, kind) VALUES ('req-1', 1, 'other')",
      )
      .run()
    expect(() => repository.analyses('req-1')).toThrow('记录损坏：分析输入类型 取值非法（other）')
  })

  it('fails closed on malformed list columns', () => {
    submit()
    repository.recordAnalysis(analysis())
    database.handle
      .prepare("UPDATE requirement_analyses SET scenarios = 'not-json' WHERE req_id = 'req-1'")
      .run()
    expect(() => repository.analyses('req-1')).toThrow()
    database.handle
      .prepare("UPDATE requirement_analyses SET scenarios = '{\"a\":1}' WHERE req_id = 'req-1'")
      .run()
    expect(() => repository.analyses('req-1')).toThrow('记录损坏：期望字符串数组')
  })

  it('orders analysis attempts and filters by requirement version', () => {
    const attempt = (requirementVersion: number, n: number) => ({
      reqId: 'req-1',
      requirementVersion,
      attempt: n,
      kind: 'initial' as const,
      outcome: 'failed' as const,
      detail: 'd',
      model: 'm',
      promptVersion: 'p',
      transcriptPath: '/tmp/t',
      toolCalls: ['t'],
      createdAt: '2026-11-04T00:00:00.000Z',
    })
    repository.recordAnalysisAttempt(attempt(2, 1))
    repository.recordAnalysisAttempt(attempt(1, 2))
    repository.recordAnalysisAttempt(attempt(1, 1))
    expect(
      repository.analysisAttempts('req-1').map((item) => [item.requirementVersion, item.attempt]),
    ).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ])
    expect(repository.analysisAttempts('req-1', 1).map((item) => item.attempt)).toEqual([1, 2])
    expect(repository.analysisAttempts('missing')).toEqual([])
    database.handle
      .prepare(
        "UPDATE requirement_analysis_attempts SET kind = 'other' WHERE requirement_version = 1",
      )
      .run()
    expect(() => repository.analysisAttempts('req-1', 1)).toThrow(
      '记录损坏：分析尝试 kind 取值非法（other）',
    )
  })
})
