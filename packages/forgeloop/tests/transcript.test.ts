import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TranscriptWriter, type TranscriptEvent } from '../src/runtime/transcript.js'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-transcript-'))
  roots.push(dir)
  return dir
}

function event(index: number): TranscriptEvent {
  return { type: 'assistant/message', seq: index, time: index, data: { text: `浜嬩欢 ${index}` } }
}

function eventsOf(count: number): TranscriptEvent[] {
  return Array.from({ length: count }, (_unused, index) => event(index))
}

function legacyTranscript(events: readonly TranscriptEvent[], startSeq = 0): string {
  return `${events
    .slice(startSeq)
    .map((item) => JSON.stringify(item))
    .join('\n')}\n`
}

function sourceOf(events: readonly TranscriptEvent[], startSeq = 0) {
  const reads: Array<readonly [number, number]> = []
  let committed = events.length
  const source = {
    get inheritedEventCount() {
      return startSeq
    },
    get seq() {
      return committed
    },
    snapshotEvents(fromSeq: number, toSeqExclusive: number): readonly TranscriptEvent[] {
      reads.push([fromSeq, toSeqExclusive])
      return events.slice(fromSeq, toSeqExclusive)
    },
  }
  return {
    source,
    reads,
    commit(count: number) {
      committed = count
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('incremental transcript', () => {
  it('writes the same bytes as the legacy full rewrite across ticks', () => {
    const dir = tempDir()
    const path = join(dir, 'evidence', 'dev.jsonl')
    const events = eventsOf(6)
    const { source, commit } = sourceOf(events)
    const writer = new TranscriptWriter(path, source)

    commit(2)
    writer.flushQuietly()
    commit(4)
    writer.flushQuietly()
    commit(6)
    writer.finish()

    expect(readFileSync(path, 'utf8')).toBe(legacyTranscript(events))
    expect(writer.events).toEqual(events)
  })

  it('reads only the new window each tick and nothing when idle', () => {
    const dir = tempDir()
    const events = eventsOf(5)
    const { source, reads, commit } = sourceOf(events)
    const writer = new TranscriptWriter(join(dir, 'dev.jsonl'), source)

    commit(3)
    writer.flushQuietly()
    writer.flushQuietly()
    commit(5)
    writer.flushQuietly()

    expect(reads).toEqual([
      [0, 3],
      [3, 5],
    ])
  })

  it('starts at the inherited prefix of a seeded session', () => {
    const dir = tempDir()
    const path = join(dir, 'dev.jsonl')
    const events = eventsOf(5)
    const { source } = sourceOf(events, 2)
    const writer = new TranscriptWriter(path, source)

    writer.finish()

    expect(readFileSync(path, 'utf8')).toBe(legacyTranscript(events, 2))
  })

  it('truncates a leftover transcript before appending', () => {
    const dir = tempDir()
    const path = join(dir, 'dev.jsonl')
    writeFileSync(path, 'stale line\n', 'utf8')
    const events = eventsOf(2)
    const { source } = sourceOf(events)

    new TranscriptWriter(path, source).finish()

    expect(readFileSync(path, 'utf8')).toBe(legacyTranscript(events))
  })

  it('keeps the single trailing newline when a turn produces no events', () => {
    const dir = tempDir()
    const path = join(dir, 'dev.jsonl')
    writeFileSync(path, 'stale line\n', 'utf8')

    new TranscriptWriter(path, sourceOf([]).source).finish()

    expect(readFileSync(path, 'utf8')).toBe('\n')
  })

  it('swallows write failures for activity snapshots but reports them at finish', () => {
    const dir = tempDir()
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'not a directory', 'utf8')
    const path = join(blocked, 'dev.jsonl')
    const { source, commit } = sourceOf(eventsOf(3))
    const writer = new TranscriptWriter(path, source)

    commit(3)
    expect(() => writer.flushQuietly()).not.toThrow()
    expect(writer.events).toEqual([])
    expect(() => writer.finish()).toThrow()
  })

  it('creates the transcript directory on the first write', () => {
    const dir = tempDir()
    const path = join(dir, 'nested', 'deeper', 'dev.jsonl')
    mkdirSync(dir, { recursive: true })

    new TranscriptWriter(path, sourceOf(eventsOf(1)).source).flush()

    expect(readFileSync(path, 'utf8')).toBe(legacyTranscript(eventsOf(1)))
  })
})
