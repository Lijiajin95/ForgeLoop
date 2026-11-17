/**
 * 需求库一键重建的单轮调度：取证、分批提炼、已有库审查、安全发布与报告。
 *
 * - 同一项目一次只允许一轮；取消只停止尚未发布的部分，发布前不触碰现有库。
 * - 自动产物一律 `draft`；`confirmed` 与人工修改永不覆盖（由 domain 的审查规则决定）。
 * - 发布前核对文件摘要；写入使用临时文件 + 重命名，失败保留原文件。
 * 产品范围见 docs/product/library-rebuild.md。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { projectDir, sessionsDir, type ForgeLoopConfig } from '../config.js'
import { AGENT_PRODUCT } from '../domain/agents.js'
import { errorMessage } from '../domain/errors.js'
import { renderLibraryIndex } from '../domain/library.js'
import {
  candidateFingerprint,
  parseRebuildCandidates,
  planRebuild,
  summarizeRebuildPlan,
  type PreviousPublishedEntry,
  type RebuildCandidate,
  type RebuildEntrySnapshot,
  type RebuildPlan,
  type RebuildReviewSummary,
} from '../domain/library-rebuild.js'
import { RebuildError } from '../domain/library-rebuild.js'
import { asRecord } from '../domain/json.js'
import { loadLibrary, type LoadedLibrary } from './library-docs.js'
import {
  collectRebuildMaterials,
  type RebuildMaterial,
  type RebuildMaterials,
} from './library-extract.js'
import { libraryRebuildPrompt } from './prompts.js'
import type { AgentRunRequest, AgentRunResult } from './agent-runner.js'
import type { LibraryRebuildRun, LibraryRebuildStore } from '../records/library-rebuild-store.js'
import type { LibrarySyncEntry } from '../records/library-store.js'

/** 单次调用携带的材料上限与总批次上限；控制成本与提示词长度。 */
export const REBUILD_MATERIALS_PER_BATCH = 16
export const REBUILD_MAX_BATCHES = 12

export interface LibraryRebuildRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>
}

export interface LibraryRebuildDeps {
  readonly config: ForgeLoopConfig
  readonly store: LibraryRebuildStore
  readonly runner: LibraryRebuildRunner
  readonly now?: () => string
  readonly load?: (projectPath: string) => LoadedLibrary
  readonly collect?: (projectPath: string) => RebuildMaterials
  /** 发布后刷新需求库 SQLite 索引；失败只进报告，不回滚已发布文件。 */
  readonly sync?: (entries: readonly LibrarySyncEntry[], now: string) => void
}

export interface LibraryRebuildStartResult {
  readonly runId: string
  readonly status: LibraryRebuildRun
}

/** 单批提炼的过程记录：页面按批展示，失败批次保留原因。 */
export interface RebuildBatchLogEntry {
  readonly index: number
  readonly materials: number
  readonly candidates: number
  readonly status: 'ok' | 'failed'
  readonly durationMs: number
  readonly error: string
}

/** 一次批量确认的结果：跳过的条目带原因，便于页面与报告核对。 */
export interface LibraryConfirmResult {
  readonly confirmed: readonly string[]
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly reason: string }>
}

/** 运行时装配入口：把配置、记录库与 Agent 运行器接到同一个服务实例。 */
export interface LibraryRebuildRepo {
  readonly libraryRebuildStore: LibraryRebuildStore
  syncLibrary(entries: readonly LibrarySyncEntry[], now: string): void
}

export function createLibraryRebuild(
  config: ForgeLoopConfig,
  repo: LibraryRebuildRepo,
  runner: LibraryRebuildRunner,
): LibraryRebuildService {
  return new LibraryRebuildService({
    config,
    store: repo.libraryRebuildStore,
    runner,
    sync: (entries, now) => {
      repo.syncLibrary(entries, now)
    },
  })
}

interface PublishedEntry {
  readonly id: string
  readonly sha256: string
  readonly fingerprint: string
}

export class LibraryRebuildService {
  private active: { runId: string; controller: AbortController } | undefined
  private completion: Promise<void> | undefined
  private readonly now: () => string

  constructor(private readonly deps: LibraryRebuildDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    // 新进程首次使用该服务时，把上一进程遗留的运行标为中断；同进程热重载不受影响。
    try {
      this.deps.store.markInterrupted(this.deps.config.project, process.pid, this.now())
    } catch {
      // 记录不可写时仍允许读取与重新发起，由页面展示库或记录错误。
    }
  }

  /** 启动一轮重建；已有运行在途时拒绝，重复点击由页面读取当前进度。 */
  start(input: { readonly by: string; readonly source: string }): LibraryRebuildStartResult {
    if (this.active) throw new RebuildError('已有重建在运行；请等待完成或先取消')
    const runId = `lrb-${stamp(this.now())}-${randomUUID().slice(0, 8)}`
    const record = emptyRun({
      runId,
      project: this.deps.config.project,
      startedAt: this.now(),
      requestedBy: input.by,
      source: input.source,
    })
    this.deps.store.save(record)
    const controller = new AbortController()
    this.active = { runId, controller }
    this.completion = this.execute(record, controller)
      .catch((error: unknown) => {
        this.fail(runId, error)
      })
      .finally(() => {
        if (this.active?.runId === runId) this.active = undefined
      })
    void this.completion
    return { runId, status: this.deps.store.get(runId) ?? record }
  }

  status(runId?: string): LibraryRebuildRun | null {
    if (runId) return this.deps.store.get(runId)
    if (this.active) return this.deps.store.get(this.active.runId)
    return this.deps.store.latest(this.deps.config.project)
  }

  /** 取消尚未发布的一轮；已发布文件不回滚。 */
  cancel(runId: string): boolean {
    if (!this.active || this.active.runId !== runId) return false
    this.active.controller.abort()
    return true
  }

  /**
   * 所有者一次授权把某轮发布的草稿整批确认为 `confirmed`（减少逐条操作）。
   * 只动来源为本轮 `library-rebuild:` 的 `draft`；其余条目跳过并给出原因。
   */
  confirm(runId: string | undefined, source: string): LibraryConfirmResult {
    const run = runId
      ? this.deps.store.get(runId)
      : this.deps.store.latestDone(this.deps.config.project)
    if (!run) throw new RebuildError('没有可确认的重建运行')
    if (run.status !== 'done') throw new RebuildError('该重建尚未完成，不能确认草稿')
    const ids = publishedIds(run.publishedJson)
    const loaded = (this.deps.load ?? loadLibrary)(this.deps.config.projectPath)
    const byId = new Map(loaded.entries.map((item) => [item.entry.id, item.entry]))
    const confirmed: string[] = []
    const skipped: Array<{ id: string; reason: string }> = []
    const today = this.now().slice(0, 10)
    for (const id of ids) {
      const entry = byId.get(id)
      if (!entry) {
        skipped.push({ id, reason: '条目不存在' })
        continue
      }
      const outcome = confirmOne(entry, this.deps.config.projectPath, source, today)
      if (outcome.done) confirmed.push(id)
      else if (outcome.reason) skipped.push({ id, reason: outcome.reason })
    }
    if (confirmed.length > 0) {
      const fresh = (this.deps.load ?? loadLibrary)(this.deps.config.projectPath)
      this.deps.sync?.(fresh.entries, this.now())
    }
    return { confirmed, skipped }
  }

  /** 测试与关闭流程等待当前运行收尾。 */
  async whenIdle(): Promise<void> {
    await this.completion
  }

  private async execute(initial: LibraryRebuildRun, controller: AbortController): Promise<void> {
    const { config } = this.deps
    const projectPath = config.projectPath
    const runId = initial.runId
    this.patch(runId, { status: 'running', stage: 'collect' })

    const loaded = (this.deps.load ?? loadLibrary)(projectPath)
    const existing = snapshots(loaded, projectPath)
    const libraryIndex = renderLibraryIndex(loaded.entries.map((item) => item.entry))
    const materials = (this.deps.collect ?? collectRebuildMaterials)(projectPath)
    this.patch(runId, { materials: materials.materials.length, stage: 'synthesize' })
    const batches = chunk(materials.materials, REBUILD_MATERIALS_PER_BATCH).slice(
      0,
      REBUILD_MAX_BATCHES,
    )
    this.patch(runId, { batches: batches.length })
    const errors = [...materials.skipped]
    const merged = await this.synthesize({
      runId,
      projectPath,
      batches,
      libraryIndex,
      controller,
      errors,
    })
    if (isAborted(controller.signal)) {
      this.cancelled(runId)
      return
    }

    const candidates = [...merged.values()]
    this.patch(runId, { candidates: candidates.length, stage: 'review' })
    const plan = planRebuild({
      candidates,
      existing,
      previous: this.previousPublished(),
      runId,
      updatedAt: this.now().slice(0, 10),
    })
    const summary = summarizeRebuildPlan(plan)
    if (isAborted(controller.signal)) {
      this.cancelled(runId)
      return
    }

    this.patch(runId, { stage: 'publish' })
    const published = this.publish(projectPath, plan, errors)
    this.refreshIndex(projectPath, published.length, errors)
    const reportPath = this.writeReport({
      runId,
      plan,
      summary,
      published,
      errors,
      materials,
      candidates,
    })
    this.patch(runId, {
      status: 'done',
      stage: 'done',
      published: published.length,
      drafts: published.length,
      conflicts: summary.conflicts,
      unresolved: summary.unresolved,
      finishedAt: this.now(),
      reportPath,
      publishedJson: JSON.stringify(published),
    })
  }

  /** 按时间排序的材料分批提炼；取消时提前返回，由调用方决定不发布。 */
  private async synthesize(input: {
    runId: string
    projectPath: string
    batches: ReadonlyArray<readonly RebuildMaterial[]>
    libraryIndex: string
    controller: AbortController
    errors: string[]
  }): Promise<Map<string, RebuildCandidate>> {
    const merged = new Map<string, RebuildCandidate>()
    const log: RebuildBatchLogEntry[] = []
    for (let index = 0; index < input.batches.length; index += 1) {
      if (isAborted(input.controller.signal)) break
      const batch = input.batches[index] ?? []
      const startedAt = Date.now()
      const result = await this.runBatch({
        runId: input.runId,
        projectPath: input.projectPath,
        batch,
        index,
        total: input.batches.length,
        libraryIndex: input.libraryIndex,
        controller: input.controller,
      })
      const durationMs = Date.now() - startedAt
      if (result.error) input.errors.push(result.error)
      if (result.candidates.length > 0) mergeCandidates(merged, result.candidates)
      log.push({
        index: index + 1,
        materials: batch.length,
        candidates: result.candidates.length,
        status: result.error ? 'failed' : 'ok',
        durationMs,
        error: result.error,
      })
      this.patch(input.runId, {
        batchesDone: index + 1,
        candidates: merged.size,
        batchLogJson: JSON.stringify(log),
      })
    }
    return merged
  }

  /** 跑一个批次：模型只拿有界证据；失败与畸形输出都只记错误，不中断整轮。 */
  private async runBatch(input: {
    runId: string
    projectPath: string
    batch: readonly RebuildMaterial[]
    index: number
    total: number
    libraryIndex: string
    controller: AbortController
  }): Promise<{ readonly candidates: readonly RebuildCandidate[]; readonly error: string }> {
    const prompt = libraryRebuildPrompt({
      materials: input.batch,
      libraryIndex: input.libraryIndex,
      batch: input.index + 1,
      batches: input.total,
    })
    const transcriptPath = join(
      sessionsDir(this.deps.config),
      `library-rebuild-${input.runId}-b${input.index + 1}.jsonl`,
    )
    mkdirSync(dirname(transcriptPath), { recursive: true })
    let result: AgentRunResult
    try {
      result = await this.deps.runner.run({
        role: AGENT_PRODUCT,
        cwd: input.projectPath,
        prompt,
        permission: 'workspace-write',
        timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
        transcriptPath,
        signal: input.controller.signal,
        tools: 'none',
      })
    } catch (error) {
      return { candidates: [], error: `批次 ${input.index + 1} 调用失败：${errorMessage(error)}` }
    }
    if (result.status !== 'completed') {
      return {
        candidates: [],
        error: `批次 ${input.index + 1} 未完成：${result.reason || result.status}`,
      }
    }
    try {
      return { candidates: parseRebuildCandidates(result.text), error: '' }
    } catch (error) {
      return { candidates: [], error: `批次 ${input.index + 1} 输出不可用：${errorMessage(error)}` }
    }
  }

  private patch(
    runId: string,
    patch: Partial<Omit<LibraryRebuildRun, 'runId' | 'project' | 'startedAt'>>,
  ): void {
    this.deps.store.update(runId, patch)
  }

  private fail(runId: string, error: unknown): void {
    try {
      this.patch(runId, {
        status: 'failed',
        stage: 'done',
        error: errorMessage(error),
        finishedAt: this.now(),
      })
    } catch {
      // 记录本身不可写时没有可用的审计位置，避免在清理路径再次抛出。
    }
  }

  private cancelled(runId: string): void {
    this.patch(runId, {
      status: 'cancelled',
      stage: 'done',
      finishedAt: this.now(),
      error: '已取消；未发布任何条目',
    })
  }

  /** 上一次成功发布的清单；用于区分“重建草稿未变”与“人工改动”。 */
  private previousPublished(): Map<string, PreviousPublishedEntry> {
    const latest = this.deps.store.latestDone(this.deps.config.project)
    if (!latest) return new Map()
    let parsed: unknown
    try {
      parsed = JSON.parse(latest.publishedJson)
    } catch {
      return new Map()
    }
    if (!Array.isArray(parsed)) return new Map()
    const map = new Map<string, PreviousPublishedEntry>()
    for (const item of parsed) {
      const record = asRecord(item)
      if (!record) continue
      const id = typeof record.id === 'string' ? record.id : ''
      const sha256 = typeof record.sha256 === 'string' ? record.sha256 : ''
      const fingerprint = typeof record.fingerprint === 'string' ? record.fingerprint : ''
      if (id && sha256 && fingerprint) map.set(id, { id, sha256, fingerprint })
    }
    return map
  }

  /** 逐条发布：更新前核对文件摘要；写入中失败保留原文件并把原因写进报告。 */
  private publish(projectPath: string, plan: RebuildPlan, errors: string[]): PublishedEntry[] {
    const candidates = new Map<string, RebuildCandidate>()
    for (const review of plan.reviews) {
      if (review.kind === 'create') {
        candidates.set(review.candidate.id, review.candidate)
      } else if (review.kind === 'update' || review.kind === 'conflict') {
        candidates.set(review.id, review.candidate)
      }
    }
    const published: PublishedEntry[] = []
    for (const item of plan.publish) {
      const full = join(projectPath, item.path)
      if (item.action === 'update' && item.replacesSha) {
        if (sha256File(full) !== item.replacesSha) {
          errors.push(`${item.id}：文件与上次发布摘要不一致，按人工改动保护，跳过更新`)
          continue
        }
      }
      if (!writeAtomic(full, item.content)) {
        errors.push(`${item.id}：条目写入失败，已保留原文件`)
        continue
      }
      const candidate = candidates.get(item.id)
      published.push({
        id: item.id,
        sha256: sha256Of(item.content),
        fingerprint: candidate ? candidateFingerprint(candidate) : '',
      })
    }
    return published
  }

  private refreshIndex(projectPath: string, publishedCount: number, errors: string[]): void {
    if (publishedCount === 0) return
    try {
      const reloaded = (this.deps.load ?? loadLibrary)(projectPath)
      this.deps.sync?.(reloaded.entries, this.now())
    } catch (error) {
      errors.push(`需求库索引刷新失败：${errorMessage(error)}`)
    }
  }

  private writeReport(input: {
    runId: string
    plan: RebuildPlan
    summary: RebuildReviewSummary
    published: readonly PublishedEntry[]
    errors: readonly string[]
    materials: RebuildMaterials
    candidates: readonly RebuildCandidate[]
  }): string {
    const dir = join(projectDir(this.deps.config), 'library-rebuild', input.runId)
    mkdirSync(dir, { recursive: true })
    const detail = {
      runId: input.runId,
      project: this.deps.config.project,
      generatedAt: this.now(),
      materials: input.materials.counts,
      skipped: input.materials.skipped,
      errors: input.errors,
      candidates: input.candidates,
      reviews: input.plan.reviews,
      published: input.published,
      overflow: input.plan.overflow,
      summary: input.summary,
    }
    writeAtomic(join(dir, 'run.json'), `${JSON.stringify(detail, null, 2)}\n`)
    const lines = [
      `# 需求库重建报告 ${input.runId}`,
      '',
      `- 项目：${this.deps.config.project}`,
      `- 材料：${Object.entries(input.materials.counts)
        .map(([kind, count]) => `${kind} ${count}`)
        .join('、')}`,
      `- 发布：${input.published.length} 条（新建/更新，均为 draft）`,
      `- 保留：${input.summary.unchanged}；冲突：${input.summary.conflicts}；未决：${input.summary.unresolved}；超容量：${input.summary.overflow}`,
      '',
      '## 发布条目',
      ...(input.published.length > 0
        ? input.published.map((entry) => `- ${entry.id}`)
        : ['（无）']),
      '',
      '## 跳过与失败',
      ...(input.errors.length > 0 ? input.errors.map((line) => `- ${line}`) : ['（无）']),
      '',
      '## 冲突与未决',
      ...input.plan.reviews
        .filter((review) => review.kind === 'conflict' || review.kind === 'unresolved')
        .map((review) => `- ${review.id}：${review.reason}`),
      ...(input.plan.overflow.length > 0
        ? input.plan.overflow.map((id) => `- ${id}：整库容量已满，仅在报告中可见`)
        : []),
      '',
    ]
    writeAtomic(join(dir, 'report.md'), `${lines.join('\n')}\n`)
    return dir
  }
}

/** 读取取消状态：通过函数读取避免 TypeScript 把 getter 收窄成常量。 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function emptyRun(input: {
  runId: string
  project: string
  startedAt: string
  requestedBy: string
  source: string
}): LibraryRebuildRun {
  return {
    runId: input.runId,
    project: input.project,
    status: 'queued',
    stage: 'collect',
    requestedBy: input.requestedBy,
    source: input.source,
    pid: process.pid,
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
    startedAt: input.startedAt,
    finishedAt: '',
    reportPath: '',
    publishedJson: '[]',
  }
}

function stamp(iso: string): string {
  return iso.replace(/[^0-9]/g, '').slice(0, 14)
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function mergeCandidates(
  target: Map<string, RebuildCandidate>,
  incoming: readonly RebuildCandidate[],
): void {
  for (const candidate of incoming) {
    const existing = target.get(candidate.id)
    if (!existing) {
      target.set(candidate.id, candidate)
      continue
    }
    const seen = new Set(
      existing.evidence.map((item) => `${item.kind}|${item.ref}|${item.locator}`),
    )
    const extra = candidate.evidence.filter(
      (item) => !seen.has(`${item.kind}|${item.ref}|${item.locator}`),
    )
    if (extra.length === 0) continue
    target.set(candidate.id, { ...existing, evidence: [...existing.evidence, ...extra] })
  }
}

function snapshots(loaded: LoadedLibrary, projectPath: string): RebuildEntrySnapshot[] {
  return loaded.entries.map((item) => ({
    id: item.entry.id,
    status: item.entry.status,
    path: item.entry.path,
    sha256: sha256File(join(projectPath, item.entry.path)),
    source: item.entry.source,
  }))
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sha256File(path: string): string {
  try {
    return sha256Of(readFileSync(path, 'utf8'))
  } catch {
    return ''
  }
}

/** 运行记录里的发布清单：只取 id，坏条目忽略。 */
function publishedIds(json: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const ids: string[] = []
  for (const item of parsed) {
    const record = asRecord(item)
    const id = record && typeof record.id === 'string' ? record.id : ''
    if (id) ids.push(id)
  }
  return ids
}

/** 单条确认：done 表示写入成功；already 与跳过都返回 false，跳过附原因。 */
function confirmOne(
  entry: { readonly path: string; readonly status: string; readonly source: string },
  projectPath: string,
  source: string,
  today: string,
): { readonly done: boolean; readonly reason: string } {
  if (entry.status === 'confirmed') return { done: false, reason: '' }
  if (entry.status !== 'draft') return { done: false, reason: '不是草稿' }
  if (!entry.source.startsWith('library-rebuild:')) return { done: false, reason: '不是重建草稿' }
  const full = join(projectPath, entry.path)
  let text: string
  try {
    text = readFileSync(full, 'utf8')
  } catch {
    return { done: false, reason: '条目不可读' }
  }
  const updated = headerConfirmed(text, source, today)
  if (!updated) return { done: false, reason: '无法识别条目头' }
  return writeAtomic(full, updated)
    ? { done: true, reason: '' }
    : { done: false, reason: '写入失败' }
}

/** 把条目头的 `draft` 改成 `confirmed`，并写所有者来源与日期；正文不动。 */
function headerConfirmed(text: string, source: string, today: string): string | undefined {
  const end = text.indexOf('-->')
  if (end < 0) return undefined
  const header = text.slice(0, end)
  if (!/"status"\s*:\s*"draft"/.test(header)) return undefined
  if (!/"source"\s*:\s*"[^"]*"/.test(header)) return undefined
  if (!/"updatedAt"\s*:\s*"[^"]*"/.test(header)) return undefined
  const next = header
    .replace(/"status"\s*:\s*"draft"/, '"status": "confirmed"')
    .replace(/"source"\s*:\s*"[^"]*"/, `"source": ${JSON.stringify(source)}`)
    .replace(/"updatedAt"\s*:\s*"[^"]*"/, `"updatedAt": "${today}"`)
  return `${next}${text.slice(end)}`
}

/** 临时文件 + 重命名；失败时删除临时文件并保留原文件。 */
function writeAtomic(path: string, content: string): boolean {
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // 临时文件清理失败不覆盖原始错误。
    }
    return false
  }
}
