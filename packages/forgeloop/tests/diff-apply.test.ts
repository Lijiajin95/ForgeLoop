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

async function commit(message: string): Promise<void> {
  await git(['add', '-A'])
  await git(['commit', '-qm', message])
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-diff-apply-'))
  await git(['init', '-q'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('idempotent upstream diff application', () => {
  it('treats an already-applied diff as success', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    await commit('base')
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const patchPath = join(dir, 'change.patch')
    writeFileSync(patchPath, `${await git(['diff'])}\n`)
    await git(['checkout', '--', 'a.txt'])

    expect(await applyDiffFile(dir, patchPath, 'a', '1')).toMatchObject({ ok: true })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n')

    const second = await applyDiffFile(dir, patchPath, 'a', '2')
    expect(second).toMatchObject({ ok: true })
    expect(second.detail).toContain('已存在')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n')
  })

  it('is idempotent for a newly added file', async () => {
    writeFileSync(join(dir, 'base.txt'), 'base\n')
    await commit('base')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    await git(['add', '-N', 'new.txt'])
    const patchPath = join(dir, 'new.patch')
    writeFileSync(patchPath, `${await git(['diff'])}\n`)
    rmSync(join(dir, 'new.txt'))

    expect(await applyDiffFile(dir, patchPath, 'n', '1')).toMatchObject({ ok: true })
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('new\n')
    expect(await applyDiffFile(dir, patchPath, 'n', '2')).toMatchObject({ ok: true })
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('new\n')
  })

  it('still rejects a genuinely conflicting change', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    await commit('base')
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const patchPath = join(dir, 'conflict.patch')
    writeFileSync(patchPath, `${await git(['diff'])}\n`)
    writeFileSync(join(dir, 'a.txt'), 'conflict\n')

    const result = await applyDiffFile(dir, patchPath, 'c', '1')
    expect(result.ok).toBe(false)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('conflict\n')
  })
})
