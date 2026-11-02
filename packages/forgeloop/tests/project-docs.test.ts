import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MAX_DOC_READ_BYTES,
  MAX_DOC_WRITE_BYTES,
  readProjectDoc,
  resolveProjectDoc,
  writeProjectDoc,
} from '../src/runtime/project-docs.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-project-docs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('project document boundary', () => {
  it('accepts project-relative Markdown paths and normalizes them', () => {
    expect(resolveProjectDoc(root, 'docs/forgeloop/business-context.md')).toMatchObject({
      ok: true,
      relative: 'docs/forgeloop/business-context.md',
    })
    expect(resolveProjectDoc(root, './docs//a.md')).toMatchObject({
      ok: true,
      relative: 'docs/a.md',
    })
  })

  it('rejects absolute paths, escapes, non-Markdown files and dependency directories', () => {
    for (const [input, reason] of [
      ['/etc/passwd.md', '相对路径'],
      ['../outside.md', '超出项目目录'],
      ['docs/../../outside.md', '超出项目目录'],
      ['', '不能为空'],
      ['src/index.ts', '只允许读写 Markdown'],
      ['.git/config.md', '.git'],
      ['node_modules/pkg/readme.md', 'node_modules'],
    ] as const) {
      const outcome = resolveProjectDoc(root, input)
      expect(outcome.ok, input).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toContain(reason)
    }
  })

  it('writes and reads back a document, creating parent directories', () => {
    const written = writeProjectDoc(root, 'docs/forgeloop/business-context.md', '# 背景\n')
    expect(written).toMatchObject({ ok: true, bytes: 9 })
    const read = readProjectDoc(root, 'docs/forgeloop/business-context.md')
    expect(read).toMatchObject({ ok: true, content: '# 背景\n', truncated: false })
  })

  it('marks oversized documents as truncated instead of returning them whole', () => {
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/long.md'), 'a'.repeat(MAX_DOC_READ_BYTES + 1))
    const read = readProjectDoc(root, 'docs/long.md')
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.truncated).toBe(true)
      expect(read.content.length).toBe(MAX_DOC_READ_BYTES)
    }
  })

  it('refuses writes above the size limit without touching the existing file', () => {
    writeProjectDoc(root, 'docs/a.md', '旧内容')
    const refused = writeProjectDoc(root, 'docs/a.md', 'b'.repeat(MAX_DOC_WRITE_BYTES + 1))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain('上限')
    expect(readFileSync(join(root, 'docs/a.md'), 'utf8')).toBe('旧内容')
  })

  it('reports a missing document as unreadable', () => {
    const read = readProjectDoc(root, 'docs/missing.md')
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain('不存在')
  })
})
