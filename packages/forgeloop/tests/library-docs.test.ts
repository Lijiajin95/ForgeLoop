import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadLibrary, markdownFiles } from '../src/runtime/library-docs.js'
import { LibraryError } from '../src/domain/library.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-library-docs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(relativePath: string, content: string): void {
  const target = join(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function header(fields: Record<string, unknown>, body = ''): string {
  return `<!-- library\n${JSON.stringify(fields)}\n-->\n\n${body}`
}

const base = {
  id: 'metrics.reliability',
  title: '可靠性度量口径',
  status: 'confirmed',
  topics: ['reliability.metric'],
  summary: '口径与窗口见引用文档。',
  source: 'owner-answer:req-1',
  updatedAt: '2026-11-13',
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('library document loading', () => {
  it('loads a body entry and hashes the injected body', () => {
    write('docs/product/library/metrics.reliability.md', header(base, '口径正文。'))
    const library = loadLibrary(root)
    expect(library.warnings).toEqual([])
    expect(library.entries).toHaveLength(1)
    const loaded = library.entries[0]!
    expect(loaded.entry.body).toBe('口径正文。')
    expect(loaded.bytes).toBe(Buffer.byteLength('口径正文。', 'utf8'))
    expect(loaded.sha256).toBe(sha256('口径正文。'))
    expect(library.digest.entries[0]).toMatchObject({
      id: 'metrics.reliability',
      status: 'confirmed',
      ref: '',
    })
  })

  it('loads a doc reference and hashes the referenced document', () => {
    write('docs/product/metrics.md', '# 指标\n\n口径。\n')
    write(
      'docs/product/library/metrics.reliability.md',
      header({ ...base, ref: 'docs/product/metrics.md' }),
    )
    const loaded = loadLibrary(root).entries[0]!
    expect(loaded.entry.ref).toBe('docs/product/metrics.md')
    expect(loaded.sha256).toBe(sha256('# 指标\n\n口径。\n'))
  })

  it('skips documents without a header but keeps a warning', () => {
    write('docs/product/library/README.md', '# 索引说明\n')
    write('docs/product/library/a.md', header({ ...base, id: 'a', title: 'A' }, '正文'))
    const library = loadLibrary(root)
    expect(library.entries.map((item) => item.entry.id)).toEqual(['a'])
    expect(library.warnings[0]).toContain('跳过非条目文档：docs/product/library/README.md')
  })

  it('fails closed on a missing reference or malformed header', () => {
    write('docs/product/library/a.md', header({ ...base, id: 'a', ref: 'docs/product/missing.md' }))
    expect(() => loadLibrary(root)).toThrowError('引用条目')

    rmSync(join(root, 'docs/product/library/a.md'))
    write('docs/product/library/b.md', '<!-- library\n{not json}\n-->\n')
    expect(() => loadLibrary(root)).toThrowError('不是合法 JSON')
  })

  it('fails on duplicate ids and keeps an absent directory empty', () => {
    expect(loadLibrary(root).entries).toEqual([])
    expect(markdownFiles(root)).toEqual([])

    write('docs/product/library/a.md', header({ ...base, id: 'dup' }, 'A'))
    write('docs/product/library/b.md', header({ ...base, id: 'dup' }, 'B'))
    expect(() => loadLibrary(root)).toThrowError(LibraryError)
    expect(() => loadLibrary(root)).toThrowError('id 重复')
  })

  it('discovers nested markdown files in stable order', () => {
    write('docs/product/library/z.md', header({ ...base, id: 'z' }))
    write('docs/product/library/nested/a.md', header({ ...base, id: 'nested.a' }))
    expect(markdownFiles(root)).toEqual([
      'docs/product/library/nested/a.md',
      'docs/product/library/z.md',
    ])
  })

  it('fails closed when entry content exceeds the body cap', () => {
    write('docs/product/library/a.md', header({ ...base, id: 'a' }, 'x'.repeat(64 * 1024 + 1)))
    expect(() => loadLibrary(root)).toThrowError('超过')
  })
})
