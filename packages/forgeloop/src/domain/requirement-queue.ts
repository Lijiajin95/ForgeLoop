import { NotFoundError, RuleViolationError } from './errors.js'

export const QUEUE_QUEUED = 'queued'
export const QUEUE_CLAIMED = 'claimed'

export type QueueEntryState = typeof QUEUE_QUEUED | typeof QUEUE_CLAIMED

export interface RequirementQueueEntry {
  readonly requirementId: string
  readonly project: string
  readonly enqueuedAt: string
  readonly sequence: number
  readonly state: QueueEntryState
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
  list(): readonly RequirementQueueEntry[]
  claimNext(claimedAt: string): RequirementQueueEntry | null
  remove(requirementId: string): boolean
}

export function compareQueueEntries(
  left: RequirementQueueEntry,
  right: RequirementQueueEntry,
): number {
  if (left.enqueuedAt !== right.enqueuedAt) return left.enqueuedAt < right.enqueuedAt ? -1 : 1
  return left.sequence - right.sequence
}

export function normalizeEnqueuedAt(value: string | Date): string {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (!Number.isFinite(time)) throw new RuleViolationError(`需求提出时间无法解析：${String(value)}`)
  return new Date(time).toISOString()
}

export interface EnqueueInput {
  readonly requirementId: string
  readonly project: string
  readonly enqueuedAt?: string | Date
}

export class RequirementQueue {
  private readonly store: RequirementQueueStore
  private readonly now: () => Date

  constructor(store: RequirementQueueStore, now: () => Date = () => new Date()) {
    this.store = store
    this.now = now
  }

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

  claimNext(): RequirementQueueEntry | null {
    return this.store.claimNext(this.now().toISOString())
  }

  complete(requirementId: string): RequirementQueueEntry {
    const entry = this.store.find(requirementId)
    if (!entry) throw new NotFoundError(`需求 ${requirementId} 不在队列中`)
    if (entry.state !== QUEUE_CLAIMED) {
      throw new RuleViolationError(`需求 ${requirementId} 尚未领取，不能标记完成`)
    }
    this.store.remove(requirementId)
    return entry
  }

  pending(): RequirementQueueEntry[] {
    return this.store.list().filter((entry) => entry.state === QUEUE_QUEUED)
  }

  inFlight(): RequirementQueueEntry | null {
    return this.store.list().find((entry) => entry.state === QUEUE_CLAIMED) ?? null
  }
}

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
