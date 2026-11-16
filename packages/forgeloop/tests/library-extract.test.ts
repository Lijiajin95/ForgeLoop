import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectRebuildMaterials,
  orderMaterials,
  redactSecrets,
  type RebuildMaterial,
} from '../src/runtime/library-extract.js'

function project(): string {
  return mkdtempSync(join(tmpdir(), 'forgeloop-extract-'))
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function git(root: string, args: readonly string[], env: Record<string, string> = {}): void {
  execFileSync('git', [...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'ignore',
  })
}

function commit(root: string, date: string, message: string): void {
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  })
}

describe('multi-source extraction', () => {
  it('collects docs, acceptance titles and source fallback without touching the library dir', () => {
    const root = project()
    write(root, 'README.md', '# 订单系统\n\n支持取消。\n')
    write(root, 'docs/product/library/entry.md', '<!-- library\n{}\n-->\n')
    write(
      root,
      'tests/cancel.test.ts',
      "describe('订单取消', () => {\n  it('签收前可以取消', () => {})\n})\n",
    )
    write(root, 'src/cancel.ts', 'export function cancel() {}\n')

    const result = collectRebuildMaterials(root)

    expect(result.counts.doc).toBe(1)
    expect(result.counts.acceptance).toBe(1)
    expect(result.counts.source).toBe(1)
    expect(result.materials.some((item) => item.ref === 'docs/product/library/entry.md')).toBe(
      false,
    )
    expect(
      result.materials.some((item) => item.kind === 'acceptance' && item.text === '签收前可以取消'),
    ).toBe(true)
  })

  it('uses git history for commit evidence and document times', () => {
    const root = project()
    write(root, 'docs/guide.md', '# 取消规则\n\n已发货订单可在签收前取消。\n')
    write(root, 'src/cancel.ts', 'export function cancel() {}\n')
    git(root, ['init'])
    commit(root, '2026-11-01T10:00:00+0800', 'docs: 记录取消规则')

    const result = collectRebuildMaterials(root)

    const doc = result.materials.find((item) => item.kind === 'doc')
    expect(doc?.time).toBe('2026-11-01')
    const commitMaterial = result.materials.find((item) => item.kind === 'git')
    expect(commitMaterial?.time).toBe('2026-11-01')
    expect(commitMaterial?.text).toContain('记录取消规则')
    expect(result.skipped.some((line) => line.includes('不是 Git 仓库'))).toBe(false)
  })

  it('redacts credentials before materials reach the model', () => {
    const root = project()
    write(root, 'docs/config.md', '# 配置\n\napi_key = "sk-abcdef1234567890"\n')
    write(root, 'docs/token.md', '# 令牌\n\nAuthorization: Bearer abcdefghijklmnop\n')
    write(root, 'src/app.ts', 'const secret = "sk-abcdef1234567890"\n')

    const result = collectRebuildMaterials(root)
    for (const material of result.materials) {
      expect(material.text).not.toContain('sk-abcdef1234567890')
      expect(material.text).not.toContain('abcdefghijklmnop')
    }
    expect(result.materials.some((item) => item.text.includes('****'))).toBe(true)
  })

  it('skips source extraction when documents and acceptance cases are sufficient', () => {
    const root = project()
    write(root, 'docs/a.md', '# A\n\n规则 A。\n')
    write(root, 'docs/b.md', '# B\n\n规则 B。\n')
    write(root, 'docs/c.md', '# C\n\n规则 C。\n')
    write(root, 'src/app.ts', 'export const a = 1\n')

    const result = collectRebuildMaterials(root)
    expect(result.counts.source).toBe(0)
    expect(result.skipped.some((line) => line.includes('跳过源码取证'))).toBe(true)
  })

  it('reports non-git projects and limits file counts', () => {
    const root = project()
    for (const name of ['a', 'b', 'c', 'd']) write(root, `docs/${name}.md`, `# ${name}\n`)
    const result = collectRebuildMaterials(root, { docFiles: 2 })
    expect(result.counts.doc).toBe(2)
    expect(result.skipped.some((line) => line.includes('项目文档超过 2 个'))).toBe(true)
    expect(result.skipped.some((line) => line.includes('不是 Git 仓库'))).toBe(true)
  })

  it('orders materials by time from newest to oldest with unknown last', () => {
    const materials: RebuildMaterial[] = [
      { kind: 'doc', ref: 'b', locator: '', time: '', digest: '', text: '' },
      { kind: 'doc', ref: 'a', locator: '', time: '2026-11-01', digest: '', text: '' },
      { kind: 'git', ref: 'c', locator: '', time: '2026-11-12', digest: '', text: '' },
      { kind: 'acceptance', ref: 'd', locator: '', time: '2026-11-12', digest: '', text: '' },
    ]
    expect(orderMaterials(materials).map((item) => item.ref)).toEqual(['d', 'c', 'a', 'b'])
  })

  it('redacts private keys and bearer tokens directly', () => {
    expect(
      redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'),
    ).toBe('[已过滤私钥]')
    expect(redactSecrets('Bearer abcdefghijklmnop')).toBe('Bearer ****')
  })

  it('reports a repository without commits as a git read failure', () => {
    const root = project()
    write(root, 'docs/a.md', '# A\n')
    git(root, ['init'])

    const result = collectRebuildMaterials(root)
    expect(result.counts.git).toBe(0)
    expect(result.skipped.some((line) => line.includes('Git 记录读取失败'))).toBe(true)
  })

  it('skips oversized documents and source files', () => {
    const root = project()
    const big = 'x'.repeat(1_100_000)
    write(root, 'docs/big.md', big)
    write(root, 'src/big.ts', big)

    const result = collectRebuildMaterials(root)
    expect(result.counts.doc).toBe(0)
    expect(result.counts.source).toBe(0)
    expect(result.skipped.some((line) => line.includes('过大的文档'))).toBe(true)
    expect(result.skipped.some((line) => line.includes('过大的源码'))).toBe(true)
  })

  it('limits acceptance titles and git commits', () => {
    const root = project()
    write(root, 'tests/a.test.ts', "it('一', () => {})\nit('二', () => {})\nit('三', () => {})\n")
    write(root, 'docs/a.md', '# A\n')
    git(root, ['init'])
    commit(root, '2026-11-01T10:00:00+0800', 'first')
    write(root, 'docs/b.md', '# B\n')
    commit(root, '2026-11-02T10:00:00+0800', 'second')

    const result = collectRebuildMaterials(root, { acceptanceTitles: 2, commits: 1 })
    expect(result.counts.acceptance).toBe(2)
    expect(result.counts.git).toBe(1)
    expect(result.skipped.some((line) => line.includes('验收用例超过 2 条'))).toBe(true)
    expect(result.skipped.some((line) => line.includes('Git 提交超过 1 条'))).toBe(true)
  })

  it('uses 全文 for documents without a heading and ignores dependency directories', () => {
    const root = project()
    write(root, 'notes.md', '没有标题的业务规则。\n')
    write(root, 'node_modules/x.md', '# 依赖文档\n')
    write(root, 'dist/y.md', '# 构建文档\n')

    const result = collectRebuildMaterials(root)
    expect(result.counts.doc).toBe(1)
    expect(result.materials[0]?.locator).toBe('全文')
    expect(result.materials.some((item) => item.ref.startsWith('node_modules/'))).toBe(false)
    expect(result.materials.some((item) => item.ref.startsWith('dist/'))).toBe(false)
  })

  it('honours explicit limits for every source', () => {
    const root = project()
    write(root, 'docs/a.md', '# A\n')
    write(root, 'docs/b.md', '# B\n')
    write(root, 'tests/a.test.ts', "it('a', () => {})\n")
    write(root, 'tests/b.test.ts', "it('b', () => {})\n")
    write(root, 'src/a.ts', 'export const a = 1\n')
    write(root, 'src/b.ts', 'export const b = 1\n')

    const result = collectRebuildMaterials(root, {
      docFiles: 1,
      docBytes: 10,
      acceptanceFiles: 1,
      sourceFiles: 1,
      sourceBytes: 10,
    })
    expect(result.skipped.some((line) => line.includes('项目文档超过 1 个'))).toBe(true)
    expect(result.skipped.some((line) => line.includes('验收用例文件超过 1 个'))).toBe(true)
    expect(result.skipped.some((line) => line.includes('源码文件超过 1 个'))).toBe(true)
    expect(result.counts.source).toBe(1)
  })

  it('skips oversized acceptance files', () => {
    const root = project()
    write(root, 'tests/big.test.ts', `it('x', () => {})\n${'x'.repeat(1_100_000)}`)

    const result = collectRebuildMaterials(root)
    expect(result.counts.acceptance).toBe(0)
    expect(result.skipped.some((line) => line.includes('过大的用例文件'))).toBe(true)
  })

  it('returns empty materials when the project path is not a directory', () => {
    const root = project()
    const file = join(root, 'not-a-directory')
    writeFileSync(file, 'x', 'utf8')

    const result = collectRebuildMaterials(file)
    expect(result.materials).toEqual([])
    expect(result.skipped.some((line) => line.includes('不是 Git 仓库'))).toBe(true)
  })
})
