import { describe, expect, it } from 'vitest'
import {
  LibraryError,
  parseLibraryReview,
  validateLibraryReview,
  type LibraryEntry,
  type LibraryReview,
} from '../src/domain/library.js'

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: 'metrics.reliability',
    title: '可靠性度量口径',
    status: 'confirmed',
    topics: ['reliability.metric'],
    summary: '摘要',
    path: 'docs/product/library/metrics.reliability.md',
    ref: '',
    always: false,
    source: 'owner-answer:req-1',
    updatedAt: '2026-11-13',
    body: '正文',
    ...overrides,
  }
}

function review(overrides: Partial<LibraryReview> = {}): LibraryReview {
  return {
    reviewed: [{ id: 'metrics.reliability', mode: 'read', reason: '' }],
    used: ['metrics.reliability'],
    gaps: [],
    ...overrides,
  }
}

describe('library review parsing', () => {
  it('parses reviewed/used/gaps and accepts a missing review', () => {
    expect(parseLibraryReview(undefined)).toBeNull()
    const parsed = parseLibraryReview({
      reviewed: [
        { id: 'a', mode: 'read' },
        { id: 'b', mode: 'dismissed', reason: '无关' },
      ],
      used: ['a'],
      gaps: [
        {
          question: '口径是什么？',
          topic: 'custom.topic',
          searched: ['a', 'b'],
          blocking: 'scope',
          reason: '库内没有结论',
        },
      ],
    })
    expect(parsed).toMatchObject({
      reviewed: [
        { id: 'a', mode: 'read', reason: '' },
        { id: 'b', mode: 'dismissed', reason: '无关' },
      ],
      used: ['a'],
      gaps: [{ topic: 'custom.topic', searched: ['a', 'b'], blocking: 'scope' }],
    })
  })

  it('rejects dismissed without reason and invalid blocking', () => {
    expect(() =>
      parseLibraryReview({ reviewed: [{ id: 'a', mode: 'dismissed' }], gaps: [] }),
    ).toThrowError(LibraryError)
    expect(() =>
      parseLibraryReview({
        reviewed: [{ id: 'a', mode: 'read' }],
        gaps: [{ question: 'q', topic: 't', searched: [], blocking: 'later', reason: 'r' }],
      }),
    ).toThrowError('blocking')
  })
})

describe('library clarification gate', () => {
  it('allows questions when the library is empty and requires review when it is not', () => {
    expect(() =>
      validateLibraryReview({ review: null, entries: [], clarifications: ['问题？'] }),
    ).not.toThrow()
    expect(() =>
      validateLibraryReview({ review: null, entries: [entry()], clarifications: [] }),
    ).toThrowError('必须给出 library_review')
  })

  it('requires every entry to be reviewed exactly once', () => {
    expect(() =>
      validateLibraryReview({
        review: review({ reviewed: [] }),
        entries: [entry()],
        clarifications: [],
      }),
    ).toThrowError('未覆盖全部条目')
    expect(() =>
      validateLibraryReview({
        review: review({
          reviewed: [
            { id: 'metrics.reliability', mode: 'read', reason: '' },
            { id: 'metrics.reliability', mode: 'dismissed', reason: '重复' },
          ],
        }),
        entries: [entry()],
        clarifications: [],
      }),
    ).toThrowError('不能重复')
  })

  it('rejects used/searched ids that were not reviewed', () => {
    expect(() =>
      validateLibraryReview({
        review: review({ used: ['ghost'] }),
        entries: [entry()],
        clarifications: [],
      }),
    ).toThrowError('used 引用了未遍历')
    expect(() =>
      validateLibraryReview({
        review: review({
          gaps: [
            { question: 'q', topic: 't', searched: ['ghost'], blocking: 'scope', reason: 'r' },
          ],
        }),
        entries: [entry()],
        clarifications: ['q'],
      }),
    ).toThrowError('gaps 引用了未遍历')
  })

  it('blocks repeated questions already covered by a confirmed topic', () => {
    expect(() =>
      validateLibraryReview({
        review: review({
          gaps: [
            {
              question: '可靠性口径是什么？',
              topic: 'reliability.metric',
              searched: ['metrics.reliability'],
              blocking: 'scope',
              reason: '想确认',
            },
          ],
        }),
        entries: [entry()],
        clarifications: ['可靠性口径是什么？'],
      }),
    ).toThrowError('已覆盖主题')
  })

  it('requires one gap per clarification and caps questions at three', () => {
    expect(() =>
      validateLibraryReview({
        review: review(),
        entries: [entry()],
        clarifications: ['新问题？'],
      }),
    ).toThrowError('每条澄清必须对应')
    expect(() =>
      validateLibraryReview({
        review: review(),
        entries: [entry()],
        clarifications: ['a', 'b', 'c', 'd'],
      }),
    ).toThrowError('最多提出 3 条')
  })

  it('accepts a fully reviewed library with an uncovered blocking gap', () => {
    expect(() =>
      validateLibraryReview({
        review: review({
          gaps: [
            {
              question: '替换还是并存？',
              topic: 'reliability.replace',
              searched: ['metrics.reliability'],
              blocking: 'scope',
              reason: '库内只有口径',
            },
          ],
        }),
        entries: [entry()],
        clarifications: ['替换还是并存？'],
      }),
    ).not.toThrow()
  })
})
