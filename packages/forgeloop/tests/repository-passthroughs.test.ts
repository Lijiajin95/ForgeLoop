import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import type { LibraryEntry } from '../src/domain/library.js'

let dir = ''
let database: Database
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-repo-passthrough-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repository = new Repository(database)
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function submit(): void {
  repository.submit({
    reqId: 'req-1',
    project: 'demo',
    text: 'first',
    submittedBy: 'owner',
    source: 'test',
    clientKey: '',
    now: '2026-11-04T00:00:00.000Z',
  })
}

function libraryEntry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: 'a',
    title: 'A',
    status: 'confirmed',
    topics: ['topic'],
    summary: '摘要',
    path: 'docs/product/library/a.md',
    ref: '',
    always: false,
    source: 'docs/product/product.md',
    updatedAt: '2026-11-13',
    body: '正文',
    ...overrides,
  }
}

describe('repository passthroughs', () => {
  it('reads the latest business-context draft for a requirement', () => {
    submit()
    expect(repository.latestBusinessContextDraft('req-1')).toBeNull()
    repository.recordBusinessContextDraft({
      reqId: 'req-1',
      analysisVersion: 1,
      requirementVersion: 1,
      document: '# 业务背景',
      reason: '首次写入',
      createdAt: '2026-11-04T00:00:01.000Z',
    })
    expect(repository.latestBusinessContextDraft('req-1')?.reason).toBe('首次写入')
  })

  it('reads one library entry by id and returns null for an unknown id', () => {
    repository.syncLibrary(
      [{ entry: libraryEntry(), sha256: 'aa', bytes: 2 }],
      '2026-11-04T00:00:00.000Z',
    )
    expect(repository.libraryEntry('a')?.id).toBe('a')
    expect(repository.libraryEntry('missing')).toBeNull()
  })

  it('settles a started action with finishAction', () => {
    repository.startAction({
      actionId: 'act-1',
      taskId: 't1',
      node: 'dev',
      role: 'developer',
      now: '2026-11-04T00:00:00.000Z',
    })
    repository.finishAction('act-1', 'done', '完成', '2026-11-04T00:00:02.000Z')
    expect(repository.action('act-1')).toMatchObject({ state: 'done', detail: '完成' })
  })
})
