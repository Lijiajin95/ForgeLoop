import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ANALYSIS_PROMPT_VERSION,
  BUSINESS_CONTEXT_DOC,
  MAX_AUTO_ANALYSIS_RETRIES,
  PRODUCT_TOOL_ALLOWLIST,
} from '../src/domain/analysis.js'
import {
  ForgeLoopError,
  GrantExhaustedError,
  MalformedError,
  NotFoundError,
  RuleViolationError,
  errorMessage,
} from '../src/domain/errors.js'
import {
  ISSUE_FIXED,
  ISSUE_OPEN,
  ISSUE_RESOLVED,
  ISSUE_STAGE_VERIFICATION,
  ISSUE_STAGES,
  ISSUE_STATUSES,
  buildRequirementIssue,
  nextIssueAttempt,
  type RequirementIssue,
} from '../src/domain/issue.js'
import { Database } from '../src/records/db.js'
import { IssueStore } from '../src/records/issues.js'
import { issueStageOf, issueStatusOf } from '../src/records/rows.js'

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    blocking: ['测试未通过'],
    summary: '测试失败',
    commands: [],
    logs: [],
    environment: {
      project: 'demo',
      projectPath: '/tmp/demo',
      platform: 'linux',
      nodeVersion: 'v24',
      pid: 1,
      hostname: 'host',
      pluginVersion: '0.0.2',
      requirementStatus: 'verifying',
      requirementVersion: 1,
      planVersion: 1,
      candidateSha256: 'a'.repeat(64),
      candidateVersion: 1,
      candidateDiffPath: '/tmp/diff',
      verificationReportPath: '/tmp/report',
      verificationReportSha256: 'b'.repeat(64),
      verificationEvidenceDir: '/tmp/evidence',
      devWorkspace: '/tmp/ws',
    },
    state: { attempt: 1, stage: ISSUE_STAGE_VERIFICATION, verificationVerdict: 'block' },
    ...overrides,
  }
}

function issue(overrides: Partial<RequirementIssue> = {}): RequirementIssue {
  return {
    issueId: 'issue-1',
    requirementId: 'req-1',
    project: 'demo',
    attempt: 1,
    stage: ISSUE_STAGE_VERIFICATION,
    status: ISSUE_OPEN,
    summary: '测试失败',
    evidence: evidence() as RequirementIssue['evidence'],
    verificationSha256: 'b'.repeat(64),
    candidateSha256: 'a'.repeat(64),
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    resolvedAt: '',
    ...overrides,
  }
}

function withDb(run: (store: IssueStore, db: Database) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-issue-gap-'))
  const db = Database.open(join(dir, 'records.sqlite'))
  try {
    run(new IssueStore(db), db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('analysis vocabulary', () => {
  it('keeps prompt/retry/document/tool allowlist literals stable', () => {
    expect(ANALYSIS_PROMPT_VERSION).toBe('analysis-v4')
    expect(MAX_AUTO_ANALYSIS_RETRIES).toBe(3)
    expect(BUSINESS_CONTEXT_DOC).toBe('docs/forgeloop/business-context.md')
    expect(PRODUCT_TOOL_ALLOWLIST).toEqual([
      'forgeloop_read_project_doc',
      'forgeloop_write_project_doc',
      'forgeloop_web_search',
      'forgeloop_web_fetch',
    ])
  })
})

describe('domain errors', () => {
  it('carries stable codes and names for each error class', () => {
    const errors = [
      new RuleViolationError('规则拒绝'),
      new NotFoundError('未找到'),
      new MalformedError('畸形'),
      new GrantExhaustedError('额度用尽'),
    ]
    expect(errors.map((error) => error.code)).toEqual([
      'rule_violation',
      'not_found',
      'malformed',
      'grant_exhausted',
    ])
    expect(errors.map((error) => error.name)).toEqual([
      'RuleViolationError',
      'NotFoundError',
      'MalformedError',
      'GrantExhaustedError',
    ])
    expect(errors.every((error) => error instanceof ForgeLoopError)).toBe(true)
    expect(errors.every((error) => error instanceof Error)).toBe(true)
    expect(errors.map((error) => error.message)).toEqual(['规则拒绝', '未找到', '畸形', '额度用尽'])
  })

  it('renders unknown throws without inventing a message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})

describe('issue domain', () => {
  it('builds and normalizes a valid issue', () => {
    const built = buildRequirementIssue(
      issue({
        issueId: '  issue-1  ',
        requirementId: ' req-1 ',
        project: ' demo ',
        summary: ' 测试失败 ',
        createdAt: ' 2026-11-04T00:00:00.000Z ',
        updatedAt: ' 2026-11-04T00:00:00.000Z ',
      }),
    )
    expect(built).toMatchObject({
      issueId: 'issue-1',
      requirementId: 'req-1',
      project: 'demo',
      summary: '测试失败',
      attempt: 1,
      stage: ISSUE_STAGE_VERIFICATION,
      status: ISSUE_OPEN,
    })
    expect(built.createdAt).toBe('2026-11-04T00:00:00.000Z')
  })

  it('rejects invalid attempts, statuses, stages and blocking evidence', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildRequirementIssue(issue({ attempt }))).toThrow(
        `问题单 attempt 必须是正整数，实际 ${attempt}`,
      )
    }
    expect(() =>
      buildRequirementIssue(issue({ status: 'unknown' as RequirementIssue['status'] })),
    ).toThrow('问题单状态未知：unknown')
    expect(() =>
      buildRequirementIssue(issue({ stage: 'unknown' as RequirementIssue['stage'] })),
    ).toThrow('问题单阶段未知：unknown')
    for (const blocking of [null, 'x', [''], ['  '], [1]]) {
      expect(() =>
        buildRequirementIssue(
          issue({
            evidence: evidence({ blocking }) as RequirementIssue['evidence'],
          }),
        ),
      ).toThrow('问题单阻断项必须是非空字符串数组')
    }
    for (const field of [
      ['issueId', '问题单字段 issueId 不能为空'],
      ['requirementId', '问题单字段 requirementId 不能为空'],
      ['project', '问题单字段 project 不能为空'],
      ['summary', '问题单字段 summary 不能为空'],
      ['createdAt', '问题单字段 createdAt 不能为空'],
      ['updatedAt', '问题单字段 updatedAt 不能为空'],
    ] as const) {
      expect(() => buildRequirementIssue(issue({ [field[0]]: '   ' }))).toThrow(field[1])
    }
  })

  it('declares the closed status and stage vocabularies', () => {
    expect(ISSUE_STATUSES).toEqual([ISSUE_OPEN, ISSUE_FIXED, ISSUE_RESOLVED])
    expect(ISSUE_STAGES).toEqual([ISSUE_STAGE_VERIFICATION])
    expect([ISSUE_OPEN, ISSUE_FIXED, ISSUE_RESOLVED]).toEqual(['open', 'fixed', 'resolved'])
    expect(ISSUE_STAGE_VERIFICATION).toBe('verification')
    expect(nextIssueAttempt([])).toBe(1)
    expect(nextIssueAttempt([issue({ attempt: 1 }), issue({ attempt: 3 })])).toBe(4)
  })
})

describe('issue store', () => {
  it('records idempotently, reads by identity and orders by attempt', () => {
    withDb((store) => {
      store.record(issue({ issueId: 'issue-2', attempt: 2 }))
      store.record(issue({ issueId: 'issue-1', attempt: 1 }))
      store.record(issue({ issueId: 'issue-1', attempt: 1, summary: '覆盖尝试' }))
      expect(store.get('issue-1')?.summary).toBe('测试失败')
      expect(store.get('missing')).toBeNull()
      expect(store.issuesFor('req-1').map((item) => item.issueId)).toEqual(['issue-1', 'issue-2'])
      expect(store.issuesFor('other')).toEqual([])
    })
  })

  it('tracks the latest open issue and closes all open issues', () => {
    withDb((store) => {
      store.record(issue({ issueId: 'issue-1', attempt: 1, status: ISSUE_RESOLVED }))
      store.record(issue({ issueId: 'issue-2', attempt: 2, status: ISSUE_OPEN }))
      store.record(issue({ issueId: 'issue-3', attempt: 3, status: ISSUE_FIXED }))
      expect(store.latestOpen('req-1')?.issueId).toBe('issue-3')
      expect(store.latestOpen('other')).toBeNull()
      expect(store.updateStatus('issue-1', ISSUE_OPEN, '2026-11-04T01:00:00.000Z')).toBe(true)
      expect(store.updateStatus('missing', ISSUE_OPEN, '2026-11-04T01:00:00.000Z')).toBe(false)
      expect(
        store.updateStatus('issue-2', ISSUE_FIXED, '2026-11-04T01:01:00.000Z', '已按问题单修复'),
      ).toBe(true)
      expect(store.get('issue-2')).toMatchObject({
        status: ISSUE_FIXED,
        summary: '已按问题单修复',
        updatedAt: '2026-11-04T01:01:00.000Z',
      })
      expect(store.resolveOpen('req-1', '2026-11-04T02:00:00.000Z')).toBe(3)
      expect(store.latestOpen('req-1')).toBeNull()
      expect(store.issuesFor('req-1').every((item) => item.status === ISSUE_RESOLVED)).toBe(true)
      expect(store.resolveOpen('req-1', '2026-11-04T03:00:00.000Z')).toBe(0)
    })
  })

  it('fails closed on unknown status/stage and malformed evidence', () => {
    withDb((store, db) => {
      db.prepare(
        `INSERT INTO requirement_issues
          (issue_id, req_id, project, attempt, stage, status, summary, evidence_json,
           verification_sha256, candidate_sha256, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'bad-evidence',
        'req-1',
        'demo',
        1,
        'verification',
        'open',
        's',
        'not-json',
        '',
        '',
        't',
        't',
        '',
      )
      expect(() => store.get('bad-evidence')).toThrow('证据不是可解析 JSON')
      db.prepare(
        `INSERT INTO requirement_issues
          (issue_id, req_id, project, attempt, stage, status, summary, evidence_json,
           verification_sha256, candidate_sha256, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'bad-status',
        'req-1',
        'demo',
        2,
        'unknown-stage',
        'unknown-status',
        's',
        JSON.stringify(evidence()),
        '',
        '',
        't',
        't',
        '',
      )
      expect(() => store.get('bad-status')).toThrow('问题单 stage')
      expect(() => issueStageOf({ stage: 'unknown-status' })).toThrow('问题单 stage')
      expect(() => issueStatusOf({ status: 'unknown-status' })).toThrow('问题单 status')
    })
  })
})
