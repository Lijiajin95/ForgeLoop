import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectDir, resolveConfig, type RawConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import type { LibrarySyncEntry } from '../src/records/library-store.js'
import { LibraryRebuildStore } from '../src/records/library-rebuild-store.js'
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
    collect: (projectPath) => collectRebuildMaterials(projectPath),
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
    const { runId } = service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    const file = join(entryPath, 'rules.cancel-shipped-order.md')
    const before = readFileSync(file, 'utf8')

    const second = service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    rules = ['签收前可取消，签收后拒绝']
    const second = service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    const file = join(entryPath, 'rules.cancel-shipped-order.md')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n人工补充。\n`, 'utf8')
    const edited = readFileSync(file, 'utf8')

    rules = ['签收前可取消']
    const second = service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const latest = service.status(second.runId)
    expect(latest).toMatchObject({ status: 'done', published: 0, conflicts: 1 })
    expect(readFileSync(file, 'utf8')).toBe(edited)
  })

  it('records model failures and publishes nothing', async () => {
    const { dir, service } = setup(async () => failed('model down'))
    service.start({ by: 'owner', source: 'test' })
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
    const { runId } = service.start({ by: 'owner', source: 'test' })
    await started
    expect(service.cancel(runId)).toBe(true)
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
    service.start({ by: 'owner', source: 'test' })
    expect(() => service.start({ by: 'owner', source: 'test' })).toThrow(/已有重建/)
    release?.()
    await service.whenIdle()
  })

  it('finishes with no candidates when the model returns an empty list', async () => {
    const { dir, service } = setup(async () => completed('{"candidates":[]}'))
    service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()
    expect(service.status()).toMatchObject({ status: 'done', published: 0, candidates: 0 })
    expect(loadLibrary(dir).entries).toEqual([])
  })

  it('records a throwing runner and unusable model output without publishing', async () => {
    const throwing = setup(async () => {
      throw new Error('runner exploded')
    })
    throwing.service.start({ by: 'owner', source: 'test' })
    await throwing.service.whenIdle()
    expect(throwing.service.status()).toMatchObject({ status: 'done', published: 0 })
    expect(readFileSync(join(throwing.service.status()!.reportPath, 'run.json'), 'utf8')).toContain(
      '调用失败',
    )

    const invalid = setup(async () => completed('not-json'))
    invalid.service.start({ by: 'owner', source: 'test' })
    await invalid.service.whenIdle()
    expect(invalid.service.status()).toMatchObject({ status: 'done', published: 0 })
    expect(readFileSync(join(invalid.service.status()!.reportPath, 'run.json'), 'utf8')).toContain(
      '输出不可用',
    )
  })

  it('handles unknown status and cancel requests and an idle wait', async () => {
    const { service } = setup(async () => completed('{"candidates":[]}'))
    expect(service.status('missing')).toBeNull()
    expect(service.cancel('missing')).toBe(false)
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
    service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const run = service.status()
    expect(run).toMatchObject({ status: 'done', published: 0 })
    expect(readFileSync(join(run!.reportPath, 'report.md'), 'utf8')).toContain('整库容量已满')
  })

  it('marks the run failed when the library cannot be read', async () => {
    const { service, entryPath } = setup(async () => completed('{"candidates":[]}'))
    mkdirSync(entryPath, { recursive: true })
    writeFileSync(join(entryPath, 'broken.md'), '<!-- library\n{broken}\n-->\n', 'utf8')

    const { runId } = service.start({ by: 'owner', source: 'test' })
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
    service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    editBeforePublish = true
    rules = ['新规则']
    const second = service.start({ by: 'owner', source: 'test' })
    await service.whenIdle()

    const run = service.status(second.runId)
    expect(run).toMatchObject({ status: 'done', published: 0 })
    expect(readFileSync(join(run!.reportPath, 'run.json'), 'utf8')).toContain('跳过更新')
  })
})
