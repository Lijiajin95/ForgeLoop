/**
 * 需求队列领域模型：需求按提出时间（`enqueuedAt`）先后进入研发。
 *
 * 业务规则：
 * - 入队立即返回，不检查、也不等待已有需求完成；研发忙时需求照常排队。
 * - 同一时间只允许一个需求处于研发中（已领取）；已有领取时再次领取返回 null。
 * - 按提出时间升序领取，提出时间相同则按入队顺序（`sequence`）稳定排序。
 * - 空队列领取返回 null；完成领取后下一个需求才可被领取。
 *
 * 领域层只依赖存储端口；SQLite 适配在 `records/requirement-queue.ts`，
 * 内存实现用于领域测试与其他无持久化场景。
 */

import { NotFoundError, RuleViolationError } from './errors.js'

export const QUEUE_QUEUED = 'queued'
export const QUEUE_CLAIMED = 'claimed'

export type QueueEntryState = typeof QUEUE_QUEUED | typeof QUEUE_CLAIMED

export interface RequirementQueueEntry {
  readonly requirementId: string
  readonly project: string
  /** 需求提出时间，规范化为 UTC ISO 字符串，保证字符串序即时间序。 */
  readonly enqueuedAt: string
  /** 队列内单调递增的入队序号，用于提出时间相同时的稳定排序。 */
  readonly sequence: number
  readonly state: QueueEntryState
  /** 领取时间；未领取时为空字符串。 */
  readonly claimedAt: string
}

export interface NewQueueEntry {
  readonly requirementId: string
  readonly project: string
  readonly enqueuedAt: string
}

/**
 * 队列存储端口。`append` 负责分配 `sequence`；`claimNext` 必须在一次原子操作内
 * 完成“无在研需求时领取队首”的判定，避免并发领取同一需求。
 */
export interface RequirementQueueStore {
  append(entry: NewQueueEntry): RequirementQueueEntry
  find(requirementId: string): RequirementQueueEntry | null
  /** 返回全部条目，按 enqueuedAt 升序、sequence 升序。 */
  list(): readonly RequirementQueueEntry[]
  /** 领取队首未领取条目并标记为 claimed；已有 claimed 条目或队列为空时返回 null。 */
  claimNext(claimedAt: string): RequirementQueueEntry | null
  remove(requirementId: string): boolean
}

/** 按提出时间升序、入队序号升序比较；这是队列唯一的排序口径。 */
export function compareQueueEntries(left: RequirementQueueEntry, right: RequirementQueueEntry): number {
  if (left.enqueuedAt !== right.enqueuedAt) return left.enqueuedAt < right.enqueuedAt ? -1 : 1
  return left.sequence - right.sequence
}

/** 把提出时间规范化为 UTC ISO 字符串；无法解析时按规则拒绝，不静默取当前时间。 */
export function normalizeEnqueuedAt(value: string | Date): string {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (!Number.isFinite(time)) throw new RuleViolationError(`需求提出时间无法解析：${String(value)}`)
  return new Date(time).toISOString()
}

export interface EnqueueInput {
  readonly requirementId: string
  readonly project: string
  /** 需求提出时间；缺省取当前时间。 */
  readonly enqueuedAt?: string | Date
}

export class RequirementQueue {
  private readonly store: RequirementQueueStore
  private readonly now: () => Date

  constructor(store: RequirementQueueStore, now: () => Date = () => new Date()) {
    this.store = store
    this.now = now
  }

  /** 入队：立即返回，不等待、也不改变正在研发的需求。 */
  enqueue(input: EnqueueInput): RequirementQueueEntry {
    const requirementId = input.requirementId.trim()
    const project = input.project.trim()
    if (!requirementId) throw new RuleViolationError('入队需求的身份不能为空')
    if (!project) throw new RuleViolationError('入队需求必须绑定项目')
    if (this.store.find(requirementId)) {
      throw new RuleViolationError(`需求 ${requirementId} 已在队列中，不能重复入队`)
    }
    return this.store.append({
      requirementId,
      project,
      enqueuedAt: normalizeEnqueuedAt(input.enqueuedAt ?? this.now()),
    })
  }

  /** 研发空闲时领取队首需求；研发忙或队列为空时返回 null。 */
  claimNext(): RequirementQueueEntry | null {
    return this.store.claimNext(this.now().toISOString())
  }

  /** 完成已领取的需求并释放研发位；未知身份或尚未领取都按规则拒绝。 */
  complete(requirementId: string): RequirementQueueEntry {
    const entry = this.store.find(requirementId)
    if (!entry) throw new NotFoundError(`需求 ${requirementId} 不在队列中`)
    if (entry.state !== QUEUE_CLAIMED) {
      throw new RuleViolationError(`需求 ${requirementId} 尚未领取，不能标记完成`)
    }
    this.store.remove(requirementId)
    return entry
  }

  /** 等待研发的需求，按领取顺序返回。 */
  pending(): RequirementQueueEntry[] {
    return this.store.list().filter((entry) => entry.state === QUEUE_QUEUED)
  }

  /** 正在研发的需求；同一时间最多一条。 */
  inFlight(): RequirementQueueEntry | null {
    return this.store.list().find((entry) => entry.state === QUEUE_CLAIMED) ?? null
  }
}

/** 无持久化的队列存储；序号单调递增，提出时间相同时按入队顺序稳定排序。 */
export class MemoryRequirementQueueStore implements RequirementQueueStore {
  private readonly entries = new Map<string, RequirementQueueEntry>()
  private sequence = 0

  append(entry: NewQueueEntry): RequirementQueueEntry {
    const record: RequirementQueueEntry = {
      ...entry,
      sequence: this.nextSequence(),
      state: QUEUE_QUEUED,
      claimedAt: '',
    }
    this.entries.set(record.requirementId, record)
    return record
  }

  find(requirementId: string): RequirementQueueEntry | null {
    return this.entries.get(requirementId) ?? null
  }

  list(): readonly RequirementQueueEntry[] {
    return [...this.entries.values()].sort(compareQueueEntries)
  }

  claimNext(claimedAt: string): RequirementQueueEntry | null {
    if (this.claimedEntry()) return null
    const next = this.list().find((entry) => entry.state === QUEUE_QUEUED)
    if (!next) return null
    const claimed: RequirementQueueEntry = { ...next, state: QUEUE_CLAIMED, claimedAt }
    this.entries.set(claimed.requirementId, claimed)
    return claimed
  }

  remove(requirementId: string): boolean {
    return this.entries.delete(requirementId)
  }

  private claimedEntry(): RequirementQueueEntry | undefined {
    return this.list().find((entry) => entry.state === QUEUE_CLAIMED)
  }

  private nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }
}
