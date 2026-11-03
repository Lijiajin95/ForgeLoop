import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyDiffFile } from '../src/runtime/diff-apply.js'

let dir = ''

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

function commit(message: string): void {
  git(['add', '-A'])
  git(['commit', '-qm', message])
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-diff-apply-'))
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('idempotent upstream diff application', () => {
  it('treats an already-applied diff as success', () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    commit('base')
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const patchPath = join(dir, 'change.patch')
    writeFileSync(patchPath, `${git(['diff'])}\n`)
    git(['checkout', '--', 'a.txt'])

    expect(applyDiffFile(dir, patchPath, 'a', '1')).toMatchObject({ ok: true })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n')

    const second = applyDiffFile(dir, patchPath, 'a', '2')
    expect(second).toMatchObject({ ok: true })
    expect(second.detail).toContain('已存在')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n')
  })

  it('is idempotent for a newly added file', () => {
    writeFileSync(join(dir, 'base.txt'), 'base\n')
    commit('base')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    git(['add', '-N', 'new.txt'])
    const patchPath = join(dir, 'new.patch')
    writeFileSync(patchPath, `${git(['diff'])}\n`)
    rmSync(join(dir, 'new.txt'))

    expect(applyDiffFile(dir, patchPath, 'n', '1')).toMatchObject({ ok: true })
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('new\n')
    expect(applyDiffFile(dir, patchPath, 'n', '2')).toMatchObject({ ok: true })
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('new\n')
  })

  it('still rejects a genuinely conflicting change', () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    commit('base')
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const patchPath = join(dir, 'conflict.patch')
    writeFileSync(patchPath, `${git(['diff'])}\n`)
    writeFileSync(join(dir, 'a.txt'), 'conflict\n')

    const result = applyDiffFile(dir, patchPath, 'c', '1')
    expect(result.ok).toBe(false)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('conflict\n')
  })
})
