import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  LIBRARY_MAX_BODY_BYTES,
  parseLibraryEntry,
  type LibraryEntry,
} from '../src/domain/library.js'
import { loadLibrary } from '../src/runtime/library-docs.js'
import {
  gapsFromReviewText,
  writeAnswerDecisions,
  writeBackClarificationAnswers,
} from '../src/runtime/library-writeback.js'

const roots: string[] = []

function projectDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-library-cover-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function entryText(overrides: Record<string, string> = {}): string {
  const header = {
    id: 'a',
    title: 'A',
    status: 'confirmed',
    topics: ['topic'],
    summary: '摘要',
    updatedAt: '2026-11-13',
    source: 'docs/product/product.md',
    ...overrides,
  }
  return `<!-- library\n${JSON.stringify(header)}\n-->\n\n正文\n`
}

function writeEntry(root: string, name: string, text: string): void {
  mkdirSync(join(root, 'docs/product/library'), { recursive: true })
  writeFileSync(join(root, 'docs/product/library', name), text, 'utf8')
}

describe('requirement library loading edge branches', () => {
  it('returns no entries when the library directory does not exist', () => {
    const root = projectDir()
    expect(loadLibrary(root).entries).toEqual([])
  })

  it('rejects an entry whose body exceeds the byte limit', () => {
    const root = projectDir()
    writeEntry(root, 'big.md', entryText())
    // 正文超过 64 KB 上限：程序必须显式拒绝，而不是截断后当成有效条目。
    writeFileSync(
      join(root, 'docs/product/library/big.md'),
      `${entryText()}${'x'.repeat(LIBRARY_MAX_BODY_BYTES + 1)}\n`,
      'utf8',
    )
    expect(() => loadLibrary(root)).toThrowError(/超过/)
  })

  it('rejects a ref entry whose document exceeds the read limit', () => {
    const root = projectDir()
    writeEntry(root, 'ref.md', entryText({ ref: 'docs/product/full.md' }))
    writeFileSync(join(root, 'docs/product/full.md'), 'y'.repeat(70 * 1024), 'utf8')
    expect(() => loadLibrary(root)).toThrowError(/读取上限/)
  })

  it('skips documents without the library header', () => {
    const root = projectDir()
    writeEntry(root, 'plain.md', '# 普通文档\n')
    const loaded = loadLibrary(root)
    expect(loaded.entries).toEqual([])
    expect(loaded.warnings[0]).toContain('跳过非条目文档')
  })

  it('rejects a ref entry whose referenced document is missing', () => {
    const root = projectDir()
    writeEntry(root, 'ref.md', entryText({ ref: 'docs/product/missing.md' }))
    expect(() => loadLibrary(root)).toThrowError(/不可读/)
  })

  it('ignores symbolic links and non-markdown files under the library directory', () => {
    const root = projectDir()
    writeEntry(root, 'a.md', entryText())
    writeFileSync(join(root, 'docs/product/library/notes.txt'), 'x', 'utf8')
    try {
      symlinkSync(
        join(root, 'docs/product/library/a.md'),
        join(root, 'docs/product/library/link.md'),
      )
    } catch {
      // Windows 未开启开发者模式时无法创建符号链接；此时只验证非 Markdown 文件被忽略。
    }
    expect(loadLibrary(root).entries.map((item) => item.entry.id)).toEqual(['a'])
  })
})

describe('library writeback edge branches', () => {
  const gap = { question: 'Q?', topic: 'topic', reason: '缺少结论', blocking: 'scope' as const }
  const answers = [
    {
      question: 'Q?',
      questionId: 'q1',
      answer: 'A'.repeat(200),
    },
  ]

  function existing(): readonly LibraryEntry[] {
    return [parseLibraryEntry(entryText(), 'docs/product/library/a.md')]
  }

  it('treats an unparsable review as no gaps', () => {
    expect(gapsFromReviewText('')).toEqual([])
    expect(gapsFromReviewText('{not json')).toEqual([])
    expect(gapsFromReviewText('{"reviewed":"not-an-array"}')).toEqual([])
  })

  it('writes a long answer as a truncated one-line summary', () => {
    const root = projectDir()
    const result = writeAnswerDecisions({
      projectPath: root,
      reqId: 'req-1',
      now: '2026-11-14T00:00:00.000Z',
      answers,
      gaps: [gap],
      existing: [],
    })
    expect(result.written).toHaveLength(1)
    const loaded = loadLibrary(root)
    expect(loaded.entries).toHaveLength(1)
  })

  it('skips an answer whose topic already has a confirmed conclusion', () => {
    const root = projectDir()
    const result = writeAnswerDecisions({
      projectPath: root,
      reqId: 'req-1',
      now: '2026-11-14T00:00:00.000Z',
      answers,
      gaps: [gap],
      existing: existing(),
    })
    expect(result.written).toEqual([])
    expect(result.skipped[0]).toContain('已有 confirmed 结论')
  })

  it('skips an answer that has no matching library gap', () => {
    const root = projectDir()
    const result = writeAnswerDecisions({
      projectPath: root,
      reqId: 'req-1',
      now: '2026-11-14T00:00:00.000Z',
      answers: [{ question: '其他问题', questionId: 'q2', answer: 'A' }],
      gaps: [gap],
      existing: [],
    })
    expect(result.written).toEqual([])
    expect(result.skipped[0]).toContain('没有对应的库缺口')
  })

  it('throws when the decision entry cannot be written', () => {
    const root = projectDir()
    // 把库目录位置占成普通文件，写入决策条目必然失败。
    mkdirSync(join(root, 'docs/product'), { recursive: true })
    writeFileSync(join(root, 'docs/product/library'), 'not a directory', 'utf8')
    expect(() =>
      writeAnswerDecisions({
        projectPath: root,
        reqId: 'req-1',
        now: '2026-11-14T00:00:00.000Z',
        answers,
        gaps: [gap],
        existing: [],
      }),
    ).toThrowError(/写入失败|不可写|ENOTDIR|EEXIST/)
  })

  it('writes decision entries and refreshes the library index once', () => {
    const root = projectDir()
    const synced: number[] = []
    const repo = {
      latestLibraryReview: () => JSON.stringify({ reviewed: [], used: [], gaps: [gap] }),
      libraryEntries: () => [],
      syncLibrary: (entries: readonly unknown[]) => {
        synced.push(entries.length)
      },
    }
    writeBackClarificationAnswers({
      projectPath: root,
      repo,
      now: '2026-11-14T00:00:00.000Z',
      reqId: 'req-1',
      questions: [{ questionId: 'q1', text: 'Q?' }],
      answer: 'A',
    })
    expect(synced).toEqual([1])
    expect(loadLibrary(root).entries).toHaveLength(1)
  })

  it('keeps the answer when write-back fails as a whole', () => {
    const root = projectDir()
    const repo = {
      latestLibraryReview: () => {
        throw new Error('records unavailable')
      },
      libraryEntries: () => [],
      syncLibrary: () => {},
    }
    expect(() =>
      writeBackClarificationAnswers({
        projectPath: root,
        repo,
        now: '2026-11-14T00:00:00.000Z',
        reqId: 'req-1',
        questions: [{ questionId: 'q1', text: 'Q?' }],
        answer: 'A',
      }),
    ).not.toThrow()
  })
})
