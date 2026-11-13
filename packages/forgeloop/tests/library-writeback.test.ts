import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  gapsFromReviewText,
  writeAnswerDecision,
  writeAnswerDecisions,
  writeBackClarificationAnswers,
} from '../src/runtime/library-writeback.js'
import { loadLibrary } from '../src/runtime/library-docs.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-library-writeback-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const answer = {
  questionId: 'Q1-1',
  question: '可靠性是替换现有展示还是并存？',
  answer: '替换现有定性展示，保留历史记录但不回填。\n第二行也保留。',
}

const gap = {
  question: answer.question,
  topic: 'reliability.replace',
  searched: ['metrics.reliability'],
  blocking: 'scope' as const,
  reason: '库内只有度量口径',
}

describe('answer write-back', () => {
  it('writes a confirmed decision entry that the library can reload', () => {
    const path = writeAnswerDecision({
      projectPath: root,
      reqId: 'req-20261113081857-9528d6',
      now: '2026-11-14T00:00:00.000Z',
      ...answer,
      topic: gap.topic,
    })
    expect(path).toContain('docs/product/library/decisions/')

    const library = loadLibrary(root)
    expect(library.entries).toHaveLength(1)
    const entry = library.entries[0]!.entry
    expect(entry).toMatchObject({
      status: 'confirmed',
      topics: ['reliability.replace'],
      source: 'owner-answer:req-20261113081857-9528d6#Q1-1',
      updatedAt: '2026-11-14',
    })
    expect(entry.path).toBe(path)
    expect(entry.body).toContain(answer.question)
    expect(entry.body).toContain('> 替换现有定性展示，保留历史记录但不回填。')
    expect(entry.body).toContain('> 第二行也保留。')
  })

  it('writes matched gaps and skips missing or already confirmed topics', () => {
    const result = writeAnswerDecisions({
      projectPath: root,
      reqId: 'req-1',
      now: '2026-11-14T00:00:00.000Z',
      answers: [
        answer,
        { questionId: 'Q1-2', question: '没有缺口的问题？', answer: '回答' },
        { questionId: 'Q1-3', question: '已覆盖主题？', answer: '回答' },
      ],
      gaps: [gap, { ...gap, question: '已覆盖主题？', topic: 'covered.topic' }],
      existing: [{ id: 'old', status: 'confirmed', topics: ['covered.topic'] }],
    })
    expect(result.written).toEqual(['Q1-1'])
    expect(result.skipped.join('\n')).toContain('Q1-2：没有对应的库缺口')
    expect(result.skipped.join('\n')).toContain('Q1-3：主题 covered.topic 已有 confirmed 结论')
    expect(loadLibrary(root).entries.map((item) => item.entry.topics[0])).toEqual([
      'reliability.replace',
    ])
  })

  it('extracts gaps from a stored review and ignores malformed text', () => {
    const review = {
      reviewed: [{ id: 'metrics.reliability', mode: 'read' }],
      used: ['metrics.reliability'],
      gaps: [gap],
    }
    expect(gapsFromReviewText(JSON.stringify(review))).toEqual([gap])
    expect(gapsFromReviewText('')).toEqual([])
    expect(gapsFromReviewText('not json')).toEqual([])
    expect(gapsFromReviewText('{"reviewed":[]}')).toEqual([])
  })

  it('writes from the latest review and refreshes the index once', () => {
    const synced: string[] = []
    writeBackClarificationAnswers({
      projectPath: root,
      repo: {
        latestLibraryReview: () => JSON.stringify({ reviewed: [], used: [], gaps: [gap] }),
        libraryEntries: () => [],
        syncLibrary: (entries) => {
          for (const item of entries) synced.push(item.entry.id)
        },
      },
      now: '2026-11-14T00:00:00.000Z',
      reqId: 'req-1',
      questions: [{ questionId: 'Q1-1', text: answer.question }],
      answer: answer.answer,
    })
    expect(synced).toEqual(['decision.req-1.q1-1'])
    expect(loadLibrary(root).entries.map((item) => item.entry.status)).toEqual(['confirmed'])
  })
})
