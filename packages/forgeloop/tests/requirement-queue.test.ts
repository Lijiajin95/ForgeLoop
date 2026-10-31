import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryRequirementQueueStore, RequirementQueue } from '../src/domain/requirement-queue.js'
import { NotFoundError, RuleViolationError } from '../src/domain/errors.js'
import { Database } from '../src/records/db.js'
import { SqliteRequirementQueueStore } from '../src/records/requirement-queue.js'

const FIXED_NOW = () => new Date('2026-10-31T12:00:00.000Z')

function enqueue(queue: RequirementQueue, requirementId: string, enqueuedAt: string, project = 'forgeloop') {
  return queue.enqueue({ requirementId, project, enqueuedAt })
}

/** 依次领取并完成，返回实际领取顺序；队列忙或为空时立即停止。 */
function drain(queue: RequirementQueue): string[] {
  const claimed: string[] = []
  for (let entry = queue.claimNext(); entry; entry = queue.claimNext()) {
    claimed.push(entry.requirementId)
    queue.complete(entry.requirementId)
  }
  return claimed
}

describe('requirement queue (memory)', () => {
  it('accepts an enqueue immediately while another requirement is still in development', () => {
    const queue = new RequirementQueue(new MemoryRequirementQueueStore(), FIXED_NOW)
    enqueue(queue, 'req-a', '2026-10-31T08:00:00.000Z')
    expect(queue.claimNext()?.requirementId).toBe('req-a')

    const accepted = enqueue(queue, 'req-b', '2026-10-31T08:30:00.000Z')

    expect(accepted.state).toBe('queued')
    expect(queue.inFlight()?.requirementId).toBe('req-a')
    expect(queue.pending().map((entry) => entry.requirementId)).toEqual(['req-b'])
    // 研发仍忙：新需求已入队，但不会被同时领取。
    expect(queue.claimNext()).toBeNull()
  })

  it('claims requirements by proposed time ascending regardless of enqueue order', () => {
    const queue = new RequirementQueue(new MemoryRequirementQueueStore(), FIXED_NOW)
    enqueue(queue, 'req-late', '2026-10-31T10:00:00.000Z')
    enqueue(queue, 'req-early', '2026-10-31T08:00:00.000Z')
    enqueue(queue, 'req-middle', '2026-10-31T09:00:00.000Z')

    expect(drain(queue)).toEqual(['req-early', 'req-middle', 'req-late'])
  })

  it('keeps insertion order stable when proposed times are identical', () => {
    const queue = new RequirementQueue(new MemoryRequirementQueueStore(), FIXED_NOW)
    const sameTime = '2026-10-31T08:00:00.000Z'
    enqueue(queue, 'req-b', sameTime)
    enqueue(queue, 'req-a', sameTime)
    enqueue(queue, 'req-c', sameTime)

    expect(drain(queue)).toEqual(['req-b', 'req-a', 'req-c'])
  })

  it('claims at most one requirement at a time and returns null for an empty queue', () => {
    const queue = new RequirementQueue(new MemoryRequirementQueueStore(), FIXED_NOW)
    expect(queue.claimNext()).toBeNull()

    enqueue(queue, 'req-a', '2026-10-31T08:00:00.000Z')
    enqueue(queue, 'req-b', '2026-10-31T09:00:00.000Z')
    expect(queue.claimNext()?.requirementId).toBe('req-a')
    expect(queue.claimNext()).toBeNull()

    expect(queue.complete('req-a').requirementId).toBe('req-a')
    expect(queue.claimNext()?.requirementId).toBe('req-b')
    expect(queue.complete('req-b').requirementId).toBe('req-b')
    expect(queue.claimNext()).toBeNull()
  })

  it('excludes the claimed requirement from pending and reports the single in-flight entry', () => {
    const queue = new RequirementQueue(new MemoryRequirementQueueStore(), FIXED_NOW)
    enqueue(queue, 'req-a', '2026-10-31T08:00:00.000Z')
    enqueue(queue, 'req-b', '2026-10-31T09:00:00.000Z')
    expect(queue.inFlight()).toBeNull()

    const claimed = queue.claimNext()
    expect(claimed).toMatchObject({ requirementId: 'req-a', state: 'claimed', claimedAt: '2026-10-31T12:00:00.000Z' })
    expect(queue.inFlight()?.requirementId).toBe('req-a')
    expect(queue.pending().map((entry) => entry.requirementId)).toEqual(['req-b'])
  })

  it('rejects a duplicate requirement id until that requirement completes', () => {
    const queue = new RequirementQueue(new MemoryRequirementQueueStore(), FIXED_NOW)
    enqueue(queue, 'req-a', '2026-10-31T08:00:00.000Z')
    expect(() => enqueue(queue, 'req-a', '2026-10-31T09:00:00.000Z')).toThrow(RuleViolationError)

    queue.claimNext()
    expect(() => enqueue(queue, 'req-a', '2026-10-31T09:00:00.000Z')).toThrow(RuleViolationError)

    queue.complete('req-a')
    expect(enqueue(queue, 'req-a', '2026-10-31T09:00:00.000Z').state).toBe('queued')
  })

  it('rejects empty identities and unparseable proposed times', () => {
    const queue = new RequirementQueue(new MemoryRequirementQueueStore(), FIXED_NOW)
    expect(() => enqueue(queue, '  ', '2026-10-31T08:00:00.000Z')).toThrow(RuleViolationError)
    expect(() => queue.enqueue({ requirementId: 'req-a', project: ' ' })).toThrow(RuleViolationError)
    expect(() => enqueue(queue, 'req-a', 'not-a-time')).toThrow(RuleViolationError)
    expect(queue.pending()).toEqual([])
  })

  it('refuses to complete an unknown or still-queued requirement', () => {
    const queue = new RequirementQueue(new MemoryRequirementQueueStore(), FIXED_NOW)
    enqueue(queue, 'req-a', '2026-10-31T08:00:00.000Z')
    expect(() => queue.complete('req-missing')).toThrow(NotFoundError)
    expect(() => queue.complete('req-a')).toThrow(RuleViolationError)
    expect(queue.pending().map((entry) => entry.requirementId)).toEqual(['req-a'])
  })

  it('normalizes proposed times to UTC so text order equals chronological order', () => {
    const queue = new RequirementQueue(new MemoryRequirementQueueStore(), FIXED_NOW)
    enqueue(queue, 'req-beijing', '2026-10-31T17:00:00+08:00')
    enqueue(queue, 'req-utc', '2026-10-31T08:30:00.000Z')

    expect(queue.pending().map((entry) => entry.enqueuedAt)).toEqual([
      '2026-10-31T08:30:00.000Z',
      '2026-10-31T09:00:00.000Z',
    ])
    expect(drain(queue)).toEqual(['req-utc', 'req-beijing'])
  })

  it('keeps claim order stable when enqueues run concurrently with the same proposed time', async () => {
    const queue = new RequirementQueue(new MemoryRequirementQueueStore(), FIXED_NOW)
    const sameTime = '2026-10-31T08:00:00.000Z'
    const submitted = Array.from({ length: 20 }, (_, index) => `req-${String(index).padStart(2, '0')}`)

    await Promise.all(submitted.map((requirementId) => Promise.resolve().then(() => enqueue(queue, requirementId, sameTime))))

    expect(drain(queue)).toEqual(submitted)
  })
})

describe('requirement queue (sqlite records)', () => {
  let dir = ''
  let path = ''
  let db: Database | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forgeloop-requirement-queue-'))
    path = join(dir, 'records.sqlite')
    db = Database.open(path)
  })

  afterEach(() => {
    db?.close()
    db = null
    rmSync(dir, { recursive: true, force: true })
  })

  function sqliteQueue(database: Database): RequirementQueue {
    return new RequirementQueue(new SqliteRequirementQueueStore(database), FIXED_NOW)
  }

  it('persists proposed order and claim state across a reopen', () => {
    const queue = sqliteQueue(db!)
    enqueue(queue, 'req-late', '2026-10-31T10:00:00.000Z')
    enqueue(queue, 'req-early', '2026-10-31T08:00:00.000Z')
    expect(queue.claimNext()?.requirementId).toBe('req-early')

    db!.close()
    db = Database.open(path)
    const reopened = sqliteQueue(db)

    // 已领取的需求在重启后仍占用研发位，不会被第二个需求同时领取。
    expect(reopened.claimNext()).toBeNull()
    expect(reopened.inFlight()).toMatchObject({ requirementId: 'req-early', state: 'claimed' })
    reopened.complete('req-early')
    expect(drain(reopened)).toEqual(['req-late'])
  })

  it('claims by proposed time ascending with a stable tie-break', () => {
    const queue = sqliteQueue(db!)
    const sameTime = '2026-10-31T08:00:00.000Z'
    enqueue(queue, 'req-3', '2026-10-31T09:00:00.000Z')
    enqueue(queue, 'req-2', sameTime)
    enqueue(queue, 'req-1', sameTime)

    expect(drain(queue)).toEqual(['req-2', 'req-1', 'req-3'])
  })

  it('returns null for an empty queue and refuses duplicate ids', () => {
    const queue = sqliteQueue(db!)
    expect(queue.claimNext()).toBeNull()

    enqueue(queue, 'req-a', '2026-10-31T08:00:00.000Z')
    expect(() => enqueue(queue, 'req-a', '2026-10-31T09:00:00.000Z')).toThrow(RuleViolationError)
    expect(drain(queue)).toEqual(['req-a'])
  })

  it('records claimedAt and refuses to complete a still-queued requirement', () => {
    const queue = sqliteQueue(db!)
    enqueue(queue, 'req-a', '2026-10-31T08:00:00.000Z')
    expect(() => queue.complete('req-a')).toThrow(RuleViolationError)
    expect(() => queue.complete('req-missing')).toThrow(NotFoundError)

    expect(queue.claimNext()).toMatchObject({
      requirementId: 'req-a',
      state: 'claimed',
      claimedAt: '2026-10-31T12:00:00.000Z',
    })
  })

  it('keeps claim order stable when enqueues run concurrently with the same proposed time', async () => {
    const queue = sqliteQueue(db!)
    const sameTime = '2026-10-31T08:00:00.000Z'
    const submitted = Array.from({ length: 20 }, (_, index) => `req-${String(index).padStart(2, '0')}`)

    await Promise.all(submitted.map((requirementId) => Promise.resolve().then(() => enqueue(queue, requirementId, sameTime))))

    expect(drain(queue)).toEqual(submitted)
  })
})
