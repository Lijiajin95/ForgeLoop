import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectDir, resolveConfig, type RawConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import type { LibrarySyncEntry } from '../src/records/library-store.js'
import {
  LibraryRebuildStore,
  type LibraryRebuildRun,
} from '../src/records/library-rebuild-store.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { LibraryRebuildService } from '../src/runtime/library-rebuild.js'
import { loadLibrary } from '../src/runtime/library-docs.js'
import { collectRebuildMaterials } from '../src/runtime/library-extract.js'

const NOW = '2026-11-16T10:00:00.000Z'

function candidateJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  }
}

function completed(text: string): AgentRunResult {
  return {
    status: 'completed',
    text,
    sessionId: 'session',
    reason: '',
    transcriptPath: '',
    durationMs: 0,
    toolCalls: [],
  }
}

function failed(reason: string): AgentRunResult {
  return { ...completed(''), status: 'error', reason }
}

function setup(
  runner: (request: AgentRunRequest) => Promise<AgentRunResult>,
  options: {
    sync?: (entries: readonly LibrarySyncEntry[], now: string) => void
    omitSync?: boolean
    seed?: (store: LibraryRebuildStore) => void
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-rebuild-run-'))
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs/order.md'), '# 取消规则\n\n已发货订单在签收前可以取消。\n', 'utf8')
  const raw: RawConfig = {
    project: 'p',
    projectPath: dir,
    recordsRoot: join(dir, 'records'),
    owner: 'owner',
    pollSeconds: 2,
    autoAdvance: false,
  }
  const config = resolveConfig(raw, dir)
  const db = Database.open(join(projectDir(config), 'records.sqlite'))
  const store = new LibraryRebuildStore(db)
  options.seed?.(store)
  const calls: AgentRunRequest[] = []
  const service = new LibraryRebuildService({
    config,
    store,
    runner: {
      run: async (request) => {
        calls.push(request)
        return runner(request)
      },
    },
    load: loadLibrary,
    collect: async (projectPath) => await collectRebuildMaterials(projectPath),
    ...(options.omitSync ? {} : { sync: options.sync ?? (() => undefined) }),
    now: () => NOW,
  })
  return { dir, service, store, calls, entryPath: join(dir, 'docs/product/library') }
}

describe('library rebuild run', () => {
  it('publishes a draft from model candidates and writes a report', async () => {
    const { dir, service, store, entryPath } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson()] })),
    )
    const { runId } = await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const run = service.status(runId)
    expect(run).toMatchObject({ status: 'done', published: 1, drafts: 1 })
    const loaded = loadLibrary(dir)
    expect(loaded.entries.map((item) => item.entry.id)).toEqual(['rules.cancel-shipped-order'])
    expect(loaded.entries[0]?.entry.status).toBe('draft')
    expect(existsSync(join(entryPath, 'rules.cancel-shipped-order.md'))).toBe(true)
    expect(existsSync(join(run!.reportPath, 'report.md'))).toBe(true)
    expect(existsSync(join(run!.reportPath, 'run.json'))).toBe(true)
    expect(store.get(runId)?.finishedAt).toBe(NOW)
  })

  it('keeps an unchanged draft untouched on rerun', async () => {
    const { service, entryPath } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson()] })),
    )
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    const file = join(entryPath, 'rules.cancel-shipped-order.md')
    const before = readFileSync(file, 'utf8')

    const second = await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const latest = service.status(second.runId)
    expect(latest).toMatchObject({ status: 'done', published: 0, conflicts: 0, unresolved: 0 })
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('updates a rebuild draft when the rule changed and the file is untouched', async () => {
    let rules = ['签收后不允许取消']
    const { dir, service, entryPath } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson({ rules })] })),
    )
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    rules = ['签收前可取消，签收后拒绝']
    const second = await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const latest = service.status(second.runId)
    expect(latest).toMatchObject({ status: 'done', published: 1, conflicts: 0 })
    const text = readFileSync(join(entryPath, 'rules.cancel-shipped-order.md'), 'utf8')
    expect(text).toContain('签收前可取消，签收后拒绝')
    expect(loadLibrary(dir).entries[0]?.entry.status).toBe('draft')
  })

  it('protects a rebuild draft edited by a human', async () => {
    let rules = ['签收后不允许取消']
    const { service, entryPath } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson({ rules })] })),
    )
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    const file = join(entryPath, 'rules.cancel-shipped-order.md')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n人工补充。\n`, 'utf8')
    const edited = readFileSync(file, 'utf8')

    rules = ['签收前可取消']
    const second = await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const latest = service.status(second.runId)
    expect(latest).toMatchObject({ status: 'done', published: 0, conflicts: 1 })
    expect(readFileSync(file, 'utf8')).toBe(edited)
  })

  it('records model failures and publishes nothing', async () => {
    const { dir, service } = setup(async () => failed('model down'))
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const run = service.status()
    expect(run).toMatchObject({ status: 'done', published: 0 })
    expect(loadLibrary(dir).entries).toEqual([])
    const report = readFileSync(join(run!.reportPath, 'run.json'), 'utf8')
    expect(report).toContain('model down')
  })

  it('cancels before publishing when the run is aborted', async () => {
    let resolveStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const { dir, service } = setup(
      (request) =>
        new Promise<AgentRunResult>((resolve) => {
          resolveStarted?.()
          request.signal?.addEventListener('abort', () => resolve(completed('{"candidates":[]}')))
        }),
    )
    const { runId } = await service.start({ by: 'owner', source: 'test' })
    await started
    expect(await service.cancel(runId)).toBe(true)
    await service.whenIdle()

    expect(service.status(runId)).toMatchObject({ status: 'cancelled', published: 0 })
    expect(loadLibrary(dir).entries).toEqual([])
  })

  it('rejects a second run while one is active', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service } = setup(async () => {
      await gate
      return completed('{"candidates":[]}')
    })
    await service.start({ by: 'owner', source: 'test' })
    await expect(service.start({ by: 'owner', source: 'test' })).rejects.toThrow(/已有重建/)
    release?.()
    await service.whenIdle()
  })

  it('finishes with no candidates when the model returns an empty list', async () => {
    const { dir, service } = setup(async () => completed('{"candidates":[]}'))
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    expect(service.status()).toMatchObject({ status: 'done', published: 0, candidates: 0 })
    expect(loadLibrary(dir).entries).toEqual([])
  })

  it('records a throwing runner and unusable model output without publishing', async () => {
    const throwing = setup(async () => {
      throw new Error('runner exploded')
    })
    await throwing.service.start({ by: 'owner', source: 'test' })
    await throwing.service.whenIdle()
    expect(throwing.service.status()).toMatchObject({ status: 'done', published: 0 })
    expect(readFileSync(join(throwing.service.status()!.reportPath, 'run.json'), 'utf8')).toContain(
      '调用失败',
    )

    const invalid = setup(async () => completed('not-json'))
    await invalid.service.start({ by: 'owner', source: 'test' })
    await invalid.service.whenIdle()
    expect(invalid.service.status()).toMatchObject({ status: 'done', published: 0 })
    expect(readFileSync(join(invalid.service.status()!.reportPath, 'run.json'), 'utf8')).toContain(
      '输出不可用',
    )
  })

  it('handles unknown status and cancel requests and an idle wait', async () => {
    const { service } = setup(async () => completed('{"candidates":[]}'))
    expect(service.status('missing')).toBeNull()
    expect(await service.cancel('missing')).toBe(false)
    await service.whenIdle()
  })

  it('keeps published entries when the index refresh fails', async () => {
    const { dir, service } = setup(
      async () => completed(JSON.stringify({ candidates: [candidateJson()] })),
      {
        sync: () => {
          throw new Error('index down')
        },
      },
    )
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    const run = service.status()
    expect(run).toMatchObject({ status: 'done', published: 1 })
    expect(readFileSync(join(run!.reportPath, 'run.json'), 'utf8')).toContain('索引刷新失败')
    expect(loadLibrary(dir).entries[0]?.entry.status).toBe('draft')
  })

  it('keeps a rebuild draft without a previous publication record unresolved', async () => {
    const { dir, service, entryPath } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson()] })),
    )
    mkdirSync(entryPath, { recursive: true })
    writeFileSync(
      join(entryPath, 'rules.cancel-shipped-order.md'),
      `<!-- library\n${JSON.stringify({
        id: 'rules.cancel-shipped-order',
        title: '旧草稿',
        status: 'draft',
        topics: ['order.cancel'],
        summary: '旧的自动草稿',
        source: 'library-rebuild:old-run#rules.cancel-shipped-order',
        updatedAt: '2026-11-10',
      })}\n-->\n\n旧正文\n`,
      'utf8',
    )
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const run = service.status()
    expect(run).toMatchObject({ status: 'done', published: 0, unresolved: 1 })
    expect(loadLibrary(dir).entries).toHaveLength(1)
  })

  it('ignores malformed previous publication records', async () => {
    const { service, store } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson()] })),
    )
    store.save({
      runId: 'lrb-broken',
      project: 'p',
      status: 'done',
      stage: 'done',
      requestedBy: 'owner',
      source: 'test',
      pid: 1,
      batchLogJson: '[]',
      materials: 1,
      batches: 1,
      batchesDone: 1,
      candidates: 1,
      published: 1,
      drafts: 1,
      conflicts: 0,
      unresolved: 0,
      error: '',
      startedAt: '2026-11-15T00:00:00.000Z',
      finishedAt: '2026-11-15T00:10:00.000Z',
      reportPath: '',
      publishedJson: '{"not":"an array"}',
    })
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    expect(service.status()).toMatchObject({ status: 'done', published: 1 })
  })

  it('merges duplicate candidates from the same batch', async () => {
    const { dir, service } = setup(async () =>
      completed(
        JSON.stringify({
          candidates: [
            candidateJson(),
            candidateJson(),
            candidateJson({
              evidence: [
                { kind: 'git', ref: 'abc1234', locator: 'docs/order.md', time: '', digest: '' },
              ],
            }),
          ],
        }),
      ),
    )
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    const run = service.status()
    expect(run).toMatchObject({ status: 'done', published: 1, candidates: 1 })
    const text = readFileSync(
      join(dir, 'docs/product/library/rules.cancel-shipped-order.md'),
      'utf8',
    )
    expect(text).toContain('abc1234')
  })

  it('reports a write failure without removing the previous file', async () => {
    const { dir, service, entryPath } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson()] })),
    )
    mkdirSync(join(entryPath, 'rules.cancel-shipped-order.md'), { recursive: true })
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const run = service.status()
    expect(run).toMatchObject({ status: 'done', published: 0 })
    expect(readFileSync(join(run!.reportPath, 'run.json'), 'utf8')).toContain('写入失败')
    expect(loadLibrary(dir).entries).toEqual([])
  })

  it('publishes when the optional index sync is not configured', async () => {
    const { service } = setup(
      async () => completed(JSON.stringify({ candidates: [candidateJson()] })),
      { omitSync: true },
    )
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    expect(service.status()).toMatchObject({ status: 'done', published: 1 })
  })

  it('ignores malformed published records from an earlier run', async () => {
    const { service, store } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson()] })),
    )
    store.save({
      runId: 'lrb-broken-json',
      project: 'p',
      status: 'done',
      stage: 'done',
      requestedBy: 'owner',
      source: 'test',
      pid: 1,
      batchLogJson: '[]',
      materials: 0,
      batches: 0,
      batchesDone: 0,
      candidates: 0,
      published: 0,
      drafts: 0,
      conflicts: 0,
      unresolved: 0,
      error: '',
      startedAt: '2026-11-15T00:00:00.000Z',
      finishedAt: '2026-11-15T00:10:00.000Z',
      reportPath: '',
      publishedJson: 'not-json',
    })
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    expect(service.status()).toMatchObject({ status: 'done', published: 1 })
  })

  it('skips incomplete published entries from an earlier run', async () => {
    const { service, store } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson()] })),
    )
    store.save({
      runId: 'lrb-broken-entries',
      project: 'p',
      status: 'done',
      stage: 'done',
      requestedBy: 'owner',
      source: 'test',
      pid: 1,
      batchLogJson: '[]',
      materials: 0,
      batches: 0,
      batchesDone: 0,
      candidates: 0,
      published: 0,
      drafts: 0,
      conflicts: 0,
      unresolved: 0,
      error: '',
      startedAt: '2026-11-15T00:00:00.000Z',
      finishedAt: '2026-11-15T00:10:00.000Z',
      reportPath: '',
      publishedJson: '[null,{"id":"x"},{"id":"a","sha256":"s","fingerprint":""}]',
    })
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    expect(service.status()).toMatchObject({ status: 'done', published: 1 })
  })

  it('reports overflow when the library is already at capacity', async () => {
    const { service, entryPath } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson()] })),
    )
    mkdirSync(entryPath, { recursive: true })
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(
        join(entryPath, `rules.existing-${index}.md`),
        `<!-- library\n${JSON.stringify({
          id: `rules.existing-${index}`,
          title: `已有规则 ${index}`,
          status: 'draft',
          topics: ['order.existing'],
          summary: '已有规则',
          source: 'docs/order.md',
          updatedAt: '2026-11-10',
        })}\n-->\n\n已有规则正文\n`,
        'utf8',
      )
    }
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const run = service.status()
    expect(run).toMatchObject({ status: 'done', published: 0 })
    expect(readFileSync(join(run!.reportPath, 'report.md'), 'utf8')).toContain('整库容量已满')
  })

  it('marks the run failed when the library cannot be read', async () => {
    const { service, entryPath } = setup(async () => completed('{"candidates":[]}'))
    mkdirSync(entryPath, { recursive: true })
    writeFileSync(join(entryPath, 'broken.md'), '<!-- library\n{broken}\n-->\n', 'utf8')

    const { runId } = await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const run = service.status(runId)
    expect(run).toMatchObject({ status: 'failed' })
    expect(run?.error).toContain('需求库')
  })

  it('skips an update when the file changed before the publish step', async () => {
    let editBeforePublish = false
    let rules = ['签收后不允许取消']
    const { service, entryPath } = setup(async () => {
      if (editBeforePublish) {
        const file = join(entryPath, 'rules.cancel-shipped-order.md')
        writeFileSync(file, `${readFileSync(file, 'utf8')}\n人工改动。\n`, 'utf8')
      }
      return completed(JSON.stringify({ candidates: [candidateJson({ rules })] }))
    })
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    editBeforePublish = true
    rules = ['新规则']
    const second = await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const run = service.status(second.runId)
    expect(run).toMatchObject({ status: 'done', published: 0 })
    expect(readFileSync(join(run!.reportPath, 'run.json'), 'utf8')).toContain('跳过更新')
  })

  it('records per-batch progress and candidate counts incrementally', async () => {
    const { service } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson()] })),
    )
    await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const run = service.status()!
    const log = JSON.parse(run.batchLogJson) as Array<Record<string, unknown>>
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ index: 1, materials: 1, candidates: 1, status: 'ok' })
    expect(run.candidates).toBe(1)
  })

  it('marks a run left running by another host process as interrupted', async () => {
    const seeded: LibraryRebuildRun = {
      runId: 'lrb-old',
      project: 'p',
      status: 'running',
      stage: 'synthesize',
      requestedBy: 'owner',
      source: 'test',
      pid: 1,
      batchLogJson: '[]',
      materials: 1,
      batches: 1,
      batchesDone: 0,
      candidates: 0,
      published: 0,
      drafts: 0,
      conflicts: 0,
      unresolved: 0,
      error: '',
      startedAt: '2026-11-16T09:00:00.000Z',
      finishedAt: '',
      reportPath: '',
      publishedJson: '[]',
    }
    const { store } = setup(async () => completed('{"candidates":[]}'), {
      seed: (seedStore) => seedStore.save(seeded),
    })

    expect(store.get('lrb-old')).toMatchObject({
      status: 'failed',
      error: '宿主重启导致运行中断',
      finishedAt: NOW,
    })
  })

  it('constructs even when interrupted-run cleanup fails', () => {
    const service = new LibraryRebuildService({
      config: { project: 'p', projectPath: '/tmp' },
      store: {
        markInterrupted: () => {
          throw new Error('db locked')
        },
        get: () => null,
        latest: () => null,
      },
      runner: { run: async () => completed('{"candidates":[]}') },
      load: () => ({ entries: [], warnings: [] }),
      collect: () => ({
        materials: [],
        batches: [],
        counts: { doc: 0, acceptance: 0, git: 0, source: 0, library: 0 },
        skipped: [],
      }),
      now: () => NOW,
    } as never)
    expect(service.status()).toBeNull()
  })

  it('confirms every draft of a run with one owner action', async () => {
    const { dir, service } = setup(async () =>
      completed(JSON.stringify({ candidates: [candidateJson()] })),
    )
    const { runId } = await service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const result = await service.confirm(runId, 'owner-confirm:web-decision:s1')
    expect(result.confirmed).toEqual(['rules.cancel-shipped-order'])
    expect(result.skipped).toEqual([])

    const loaded = loadLibrary(dir)
    expect(loaded.entries[0]?.entry.status).toBe('confirmed')
    expect(loaded.entries[0]?.entry.source).toBe('owner-confirm:web-decision:s1')
    expect(loaded.entries[0]?.entry.updatedAt).toBe('2026-11-16')

    // 再点一次是幂等的：已确认条目不再计入“本次确认”。
    expect(await service.confirm(runId, 'owner-confirm:web-decision:s1')).toMatchObject({
      confirmed: [],
    })
  })

  it('refuses to confirm a rebuild that is still running', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<AgentRunResult>((resolve) => {
      release = () => resolve(completed('{"candidates":[]}'))
    })
    const { service } = setup(() => pending)
    const { runId } = await service.start({ by: 'owner', source: 'test' })

    expect(() => service.confirm(runId, 'owner-confirm:test')).toThrow('尚未完成')
    release?.()
    await service.whenIdle()
  })

  function doneRun(overrides: Partial<LibraryRebuildRun> = {}): LibraryRebuildRun {
    return {
      runId: 'lrb-manual',
      project: 'p',
      status: 'done',
      stage: 'done',
      requestedBy: 'owner',
      source: 'test',
      pid: process.pid,
      batchLogJson: '[]',
      materials: 0,
      batches: 1,
      batchesDone: 1,
      candidates: 0,
      published: 0,
      drafts: 0,
      conflicts: 0,
      unresolved: 0,
      error: '',
      startedAt: '2026-11-16T09:00:00.000Z',
      finishedAt: NOW,
      reportPath: '',
      publishedJson: '[]',
      ...overrides,
    }
  }

  function libraryHeader(id: string, status: string, source: string): string {
    return [
      '<!-- library',
      JSON.stringify(
        {
          id,
          title: id,
          status,
          topics: [id],
          summary: id,
          source,
          updatedAt: '2026-11-16',
        },
        null,
        2,
      ),
      '-->',
      '',
      '# ' + id,
      '',
    ].join('\n')
  }

  it('skips published ids that are missing, not drafts, or not rebuild drafts', async () => {
    const { service, store, entryPath } = setup(async () => completed('{"candidates":[]}'))
    mkdirSync(entryPath, { recursive: true })
    writeFileSync(
      join(entryPath, 'manual.draft.md'),
      libraryHeader('manual.draft', 'draft', 'manual'),
      'utf8',
    )
    writeFileSync(
      join(entryPath, 'manual.superseded.md'),
      libraryHeader('manual.superseded', 'superseded', 'manual'),
      'utf8',
    )
    store.save(
      doneRun({
        publishedJson: JSON.stringify([
          { id: 'manual.draft', sha256: 'x', fingerprint: 'f' },
          { id: 'manual.superseded', sha256: 'x', fingerprint: 'f' },
          { id: 'missing.entry', sha256: 'x', fingerprint: 'f' },
        ]),
      }),
    )

    const result = await service.confirm('lrb-manual', 'owner-confirm:test')
    expect(result.confirmed).toEqual([])
    expect(result.skipped.map((item) => item.reason).sort()).toEqual(
      ['不是重建草稿', '不是草稿', '条目不存在'].sort(),
    )
  })

  it('returns no confirmation for an empty or malformed published list', async () => {
    const { service, store } = setup(async () => completed('{"candidates":[]}'))
    store.save(doneRun({ runId: 'lrb-empty', publishedJson: '[]' }))
    expect(await service.confirm('lrb-empty', 'owner-confirm:test')).toEqual({
      confirmed: [],
      skipped: [],
    })

    store.save(doneRun({ runId: 'lrb-bad', publishedJson: 'not-json' }))
    expect(await service.confirm('lrb-bad', 'owner-confirm:test')).toEqual({
      confirmed: [],
      skipped: [],
    })

    expect(() => service.confirm('missing-run', 'owner-confirm:test')).toThrow('没有可确认')
  })

  it('uses the latest done run when no run id is given and ignores non-array credits', async () => {
    const { service, store } = setup(async () => completed('{"candidates":[]}'))
    expect(() => service.confirm(undefined, 'owner-confirm:test')).toThrow('没有可确认')

    store.save(doneRun({ runId: 'lrb-object', publishedJson: '{}' }))
    expect(await service.confirm(undefined, 'owner-confirm:test')).toEqual({
      confirmed: [],
      skipped: [],
    })
  })
})
