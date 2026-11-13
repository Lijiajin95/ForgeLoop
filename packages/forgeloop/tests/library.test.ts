import { describe, expect, it } from 'vitest'
import {
  parseLibraryEntry,
  renderLibraryDigest,
  renderLibraryIndex,
  validateLibrary,
  type LibraryEntry,
} from '../src/domain/library.js'

function entryText(header: Record<string, unknown>, body = '正文'): string {
  return `<!-- library\n${JSON.stringify(header)}\n-->\n\n${body}\n`
}

const base = {
  id: 'metrics.reliability',
  title: '可靠性度量口径',
  status: 'confirmed',
  topics: ['reliability.metric', 'reliability.window'],
  summary: '指标口径与窗口见引用文档。',
  source: 'owner-answer:req-1',
  updatedAt: '2026-11-13',
}

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: 'a',
    title: 'A',
    status: 'confirmed',
    topics: ['a'],
    summary: 'A 摘要',
    path: 'docs/product/library/a.md',
    ref: '',
    always: false,
    source: 'docs/product/product.md',
    updatedAt: '2026-11-13',
    body: '正文',
    ...overrides,
  }
}

describe('library entry parsing', () => {
  it('parses a plain entry with body and optional always flag', () => {
    const parsed = parseLibraryEntry(
      entryText({ ...base, always: true }, '# 可靠性\n\n口径正文'),
      'docs/product/library/metrics.reliability.md',
    )
    expect(parsed).toMatchObject({
      id: 'metrics.reliability',
      title: '可靠性度量口径',
      status: 'confirmed',
      topics: ['reliability.metric', 'reliability.window'],
      summary: base.summary,
      path: 'docs/product/library/metrics.reliability.md',
      ref: '',
      always: true,
      source: base.source,
      updatedAt: '2026-11-13',
    })
    expect(parsed.body).toContain('口径正文')
  })

  it('parses a doc reference entry and keeps its explanation in body', () => {
    const parsed = parseLibraryEntry(
      entryText(
        { ...base, ref: 'docs/product/reliability-dashboard.md' },
        '# 为什么收录\n\n现有方案',
      ),
      'docs/product/library/metrics.reliability.md',
    )
    expect(parsed.ref).toBe('docs/product/reliability-dashboard.md')
    expect(parsed.body).toContain('现有方案')
  })

  it('allows a short explanation beside a doc reference', () => {
    const parsed = parseLibraryEntry(
      entryText(
        { ...base, ref: 'docs/product/reliability-dashboard.md' },
        '为什么收录：这是现行口径',
      ),
      'docs/product/library/metrics.reliability.md',
    )
    expect(parsed.ref).toBe('docs/product/reliability-dashboard.md')
    expect(parsed.body).toContain('为什么收录')
  })

  it('rejects missing, unclosed and malformed headers', () => {
    expect(() => parseLibraryEntry('# 无头\n', 'docs/product/library/a.md')).toThrowError(
      '缺少 JSON 注释头',
    )
    expect(() =>
      parseLibraryEntry('<!-- library\n{"id":"a"}\n', 'docs/product/library/a.md'),
    ).toThrowError('未闭合')
    expect(() =>
      parseLibraryEntry('<!-- library\n{not json}\n-->\n', 'docs/product/library/a.md'),
    ).toThrowError('不是合法 JSON')
  })

  it('rejects unknown fields and invalid enum-like fields', () => {
    expect(() =>
      parseLibraryEntry(entryText({ ...base, statuss: 'confirmed' }), 'docs/product/library/a.md'),
    ).toThrowError('未知字段 statuss')
    expect(() =>
      parseLibraryEntry(entryText({ ...base, status: 'active' }), 'docs/product/library/a.md'),
    ).toThrowError('status 只能是')
    expect(() =>
      parseLibraryEntry(entryText({ ...base, id: 'Bad Id' }), 'docs/product/library/a.md'),
    ).toThrowError('id 只能是')
    expect(() =>
      parseLibraryEntry(
        entryText({ ...base, updatedAt: '2026/11/13' }),
        'docs/product/library/a.md',
      ),
    ).toThrowError('updatedAt')
  })

  it('rejects empty topics, long topics and long summaries', () => {
    expect(() =>
      parseLibraryEntry(entryText({ ...base, topics: [] }), 'docs/product/library/a.md'),
    ).toThrowError('topics')
    expect(() =>
      parseLibraryEntry(
        entryText({ ...base, topics: ['x'.repeat(65)] }),
        'docs/product/library/a.md',
      ),
    ).toThrowError('64')
    expect(() =>
      parseLibraryEntry(
        entryText({ ...base, summary: 'x'.repeat(241) }),
        'docs/product/library/a.md',
      ),
    ).toThrowError('summary')
    expect(() =>
      parseLibraryEntry(entryText({ ...base, ref: '../outside.md' }), 'docs/product/library/a.md'),
    ).toThrowError('ref')
    expect(() =>
      parseLibraryEntry(entryText({ ...base, ref: '/absolute.md' }), 'docs/product/library/a.md'),
    ).toThrowError('ref')
    expect(() =>
      parseLibraryEntry(
        entryText({ ...base, ref: 'docs/product/notes.txt' }),
        'docs/product/library/a.md',
      ),
    ).toThrowError('ref')
  })
})

describe('library collection', () => {
  it('rejects duplicate ids and keeps empty libraries valid', () => {
    expect(() => validateLibrary([])).not.toThrow()
    expect(() => validateLibrary([entry({ id: 'a' }), entry({ id: 'a' })])).toThrowError('id 重复')
  })

  it('rejects libraries over the entry cap', () => {
    const many = Array.from({ length: 65 }, (_, index) => entry({ id: `entry-${index}` }))
    expect(() => validateLibrary(many)).toThrowError('超过 64 条')
  })

  it('renders a stable index without bodies and skips empty libraries', () => {
    const index = renderLibraryIndex([
      entry({ id: 'b', title: 'B', topics: ['b'], ref: 'docs/product/b.md', summary: 'B 摘要' }),
      entry({ id: 'a', title: 'A', topics: ['a'], always: true, summary: 'A 摘要' }),
    ])
    expect(index.split('\n')[0]).toContain('需求库索引')
    expect(index.indexOf('- a｜')).toBeLessThan(index.indexOf('- b｜'))
    expect(index).toContain('confirmed｜topics: a｜always｜A 摘要')
    expect(index).toContain('引用 docs/product/b.md')
    expect(index).not.toContain('正文')
    expect(renderLibraryIndex([])).toBe('')
  })

  it('renders the digest in a stable order regardless of input order', () => {
    const one = {
      id: 'a',
      status: 'confirmed' as const,
      sha256: 'aa',
      bytes: 10,
      path: 'docs/product/library/a.md',
      ref: '',
    }
    const two = {
      id: 'b',
      status: 'draft' as const,
      sha256: 'bb',
      bytes: 20,
      path: 'docs/product/library/b.md',
      ref: 'docs/product/b.md',
    }
    expect(renderLibraryDigest({ entries: [two, one] })).toBe(
      renderLibraryDigest({ entries: [one, two] }),
    )
    expect(JSON.parse(renderLibraryDigest({ entries: [two, one] }))).toEqual({
      entries: [one, two],
    })
  })
})
