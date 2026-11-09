import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unlinkWorkspaceLink } from '../../../scripts/ts/worktree-links.ts'

/**
 * worktree 复用依赖时放的是目录链接；清理工作树前必须只摘链接本身。
 * 这里固定“摘链接不删目标内容”，避免再次顺着链接删掉主工作树的依赖或源码。
 */

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-worktree-links-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('workspace link cleanup', () => {
  it('removes only the link and keeps the target contents', () => {
    const target = join(dir, 'target')
    mkdirSync(join(target, 'nested'), { recursive: true })
    writeFileSync(join(target, 'nested', 'keep.txt'), 'keep\n', 'utf8')
    const link = join(dir, 'node_modules')
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')

    expect(unlinkWorkspaceLink(link)).toBe(true)
    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(target, 'nested', 'keep.txt'))).toBe(true)
  })

  it('leaves a real directory and a missing path alone', () => {
    const real = join(dir, 'real')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'file.txt'), 'x\n', 'utf8')
    expect(unlinkWorkspaceLink(real)).toBe(false)
    expect(existsSync(join(real, 'file.txt'))).toBe(true)
    expect(unlinkWorkspaceLink(join(dir, 'missing'))).toBe(false)
  })
})
