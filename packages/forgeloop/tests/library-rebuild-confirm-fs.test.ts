import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const fsState = vi.hoisted(() => ({ failRename: false, failRm: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (fsState.failRename) throw new Error('rename blocked')
      actual.renameSync(from, to)
    },
    rmSync: (path: string, options: { force?: boolean }) => {
      if (fsState.failRm) throw new Error('rm blocked')
      actual.rmSync(path, options)
    },
  }
})

const { projectDir, resolveConfig } = await import('../src/config.js')
const { Database } = await import('../src/records/db.js')
const { LibraryRebuildStore } = await import('../src/records/library-rebuild-store.js')
const { LibraryRebuildService } = await import('../src/runtime/library-rebuild.js')
const { loadLibrary } = await import('../src/runtime/library-docs.js')
const { collectRebuildMaterials } = await import('../src/runtime/library-extract.js')

const NOW = '2026-11-16T10:00:00.000Z'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-rebuild-fs-'))
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs/order.md'), '# 取消规则\n\n已发货订单在签收前可以取消。\n', 'utf8')
  const config = resolveConfig(
    {
      project: 'p',
      projectPath: dir,
      recordsRoot: join(dir, 'records'),
      owner: 'owner',
      pollSeconds: 2,
      autoAdvance: false,
    },
    dir,
  )
  const db = Database.open(join(projectDir(config), 'records.sqlite'))
  const store = new LibraryRebuildStore(db)
  const candidate = {
    id: 'rules.cancel-shipped-order',
    title: '已发货订单的取消',
    topics: ['order.cancel'],
    summary: '已发货订单在签收前可以取消，取消后进入退款。',
    scope: '订单履约，2026-11 版本',
    goal: '允许用户在签收前取消已发货订单。',
    actors: ['下单用户'],
    trigger: '订单已发货且未签收。',
    behavior: '系统接受取消并生成退款。',
    rules: ['签收后不允许取消'],
    exceptions: ['已签收：拒绝取消'],
    acceptance: ['用户看到“已取消，退款处理中”'],
    evidence: [{ kind: 'doc', ref: 'docs/order.md', locator: '取消规则', time: '', digest: '' }],
    confidence: 'high',
    gaps: [],
  }
  const service = new LibraryRebuildService({
    config,
    store,
    runner: {
      run: async () => ({
        status: 'completed',
        text: JSON.stringify({ candidates: [candidate] }),
        sessionId: 'session',
        reason: '',
        transcriptPath: '',
        durationMs: 0,
        toolCalls: [],
      }),
    },
    load: loadLibrary,
    collect: (projectPath) => collectRebuildMaterials(projectPath),
    sync: () => undefined,
    now: () => NOW,
  })
  return { service, store, dir }
}

describe('library rebuild confirm write failures', () => {
  it('reports a write failure and keeps the draft when the atomic rename fails', async () => {
    const { service, dir } = setup()
    const { runId } = service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    fsState.failRename = true
    const failed = service.confirm(runId, 'owner-confirm:test')
    expect(failed.confirmed).toEqual([])
    expect(failed.skipped).toEqual([{ id: 'rules.cancel-shipped-order', reason: '写入失败' }])
    expect(loadLibrary(dir).entries[0]?.entry.status).toBe('draft')

    fsState.failRename = true
    fsState.failRm = true
    expect(service.confirm(runId, 'owner-confirm:test').skipped).toEqual([
      { id: 'rules.cancel-shipped-order', reason: '写入失败' },
    ])
    fsState.failRename = false
    fsState.failRm = false
  })
})
