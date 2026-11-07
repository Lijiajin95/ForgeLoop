import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { BusinessContextStore } from '../src/records/business-context-store.js'
import { ClarificationStore } from '../src/records/clarification-store.js'

let dir = ''
let db: Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-stores-'))
  db = Database.open(join(dir, 'records.sqlite'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('business context store', () => {
  it('keeps one draft per analysis version and applies it later', () => {
    const store = new BusinessContextStore(db)
    expect(store.latestDraft('req-1')).toBeNull()

    store.recordDraft({
      reqId: 'req-1',
      analysisVersion: 1,
      requirementVersion: 1,
      document: '# 背景 v1',
      reason: '首次分析',
      createdAt: '2026-11-07T01:00:00.000Z',
    })
    // 同一分析版本重试：覆盖最新草案，状态仍是 draft，不产生正式文档摘要。
    store.recordDraft({
      reqId: 'req-1',
      analysisVersion: 1,
      requirementVersion: 2,
      document: '# 背景 v1 修订',
      reason: '澄清后修订',
      createdAt: '2026-11-07T01:05:00.000Z',
    })

    const draft = store.latestDraft('req-1')
    expect(draft).toMatchObject({
      reqId: 'req-1',
      analysisVersion: 1,
      requirementVersion: 2,
      status: 'draft',
      reason: '澄清后修订',
      documentSha256: '',
      appliedAt: '',
      changed: true,
    })

    store.markApplied({
      reqId: 'req-1',
      analysisVersion: 1,
      docSha256: 'a'.repeat(64),
      appliedAt: '2026-11-07T02:00:00.000Z',
    })
    expect(store.latestDraft('req-1')).toBeNull()
    expect(store.changes('req-1')).toEqual([
      expect.objectContaining({
        status: 'applied',
        documentSha256: 'a'.repeat(64),
        appliedAt: '2026-11-07T02:00:00.000Z',
      }),
    ])
  })

  it('orders changes by analysis version and degrades unknown status to draft', () => {
    const store = new BusinessContextStore(db)
    for (const version of [2, 1]) {
      store.recordDraft({
        reqId: 'req-2',
        analysisVersion: version,
        requirementVersion: version,
        document: `# 背景 v${version}`,
        reason: `分析 ${version}`,
        createdAt: '2026-11-07T01:00:00.000Z',
      })
    }
    db.prepare(
      "UPDATE requirement_business_context_changes SET status = 'unknown-status' WHERE req_id = 'req-2' AND analysis_version = 2",
    ).run()
    db.prepare(
      "UPDATE requirement_business_context_changes SET status = 'rejected' WHERE req_id = 'req-2' AND analysis_version = 1",
    ).run()

    const changes = store.changes('req-2')
    expect(changes.map((change) => change.analysisVersion)).toEqual([1, 2])
    expect(changes.map((change) => change.status)).toEqual(['rejected', 'draft'])
    // 未知状态按草稿保留，不会被当成已应用。
    expect(store.latestDraft('req-2')?.analysisVersion).toBe(2)
  })
})

describe('clarification store legacy answers', () => {
  function insertLegacy(input: {
    reqId: string
    analysisVersion: number
    questionIds: string
    answer?: string
  }): void {
    db.prepare(
      `INSERT INTO requirement_clarification_answers
        (req_id, analysis_version, requirement_version, answered_version, question_ids, answer, source, answered_at)
       VALUES (?, ?, 1, 1, ?, ?, 'owner', '2026-11-07T03:00:00.000Z')`,
    ).run(input.reqId, input.analysisVersion, input.questionIds, input.answer ?? '只覆盖当前版本')
  }

  it('expands a legacy answer into one row per question id', () => {
    const store = new ClarificationStore(db)
    insertLegacy({ reqId: 'req-legacy', analysisVersion: 1, questionIds: '["Q1-1","Q1-2"]' })

    const answers = store.answers('req-legacy')
    expect(answers.map((answer) => [answer.questionId, answer.answerSeq])).toEqual([
      ['Q1-1', 1],
      ['Q1-2', 2],
    ])
    expect(answers[1]).toMatchObject({
      reqId: 'req-legacy',
      analysisVersion: 1,
      requirementVersion: 1,
      answeredVersion: 1,
      answer: '只覆盖当前版本',
      source: 'owner',
      answeredAt: '2026-11-07T03:00:00.000Z',
    })
  })

  it('ignores malformed or non-string question id lists', () => {
    const store = new ClarificationStore(db)
    insertLegacy({ reqId: 'req-broken', analysisVersion: 2, questionIds: 'not json' })
    insertLegacy({ reqId: 'req-broken', analysisVersion: 3, questionIds: '{"a":1}' })
    insertLegacy({ reqId: 'req-broken', analysisVersion: 4, questionIds: '["Q4-1", 7, null]' })

    const answers = store.answers('req-broken')
    expect(answers.map((answer) => [answer.analysisVersion, answer.questionId])).toEqual([
      [4, 'Q4-1'],
    ])
  })
})
