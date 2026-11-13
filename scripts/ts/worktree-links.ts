/**
 * worktree 复用依赖时会在工作树里放一个 `node_modules` 链接（POSIX 符号链接，
 * Windows 目录联接）。递归删除工作树会顺着链接删到主工作树的依赖甚至更远，
 * 因此清理前必须先只摘掉链接本身，再删除工作树。
 */
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 路径是否是目录链接（符号链接或 Windows 目录联接）；不存在或不可读时为 false。 */
export function isWorkspaceLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 找出工作树内的全部目录链接，且不进入链接目标。
 * 递归删除前用它兜底：任何残留链接都可能让删除越界。
 */
export function findWorkspaceLinks(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (isWorkspaceLink(full)) {
        found.push(full)
        continue
      }
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(root)
  return found
}

/**
 * 摘掉 `path` 指向别处的目录链接：只删除链接，不触碰目标内容。
 * 既不是链接也不是目录时什么也不做，交给调用方按普通路径处理。
 */
export function unlinkWorkspaceLink(path: string): boolean {
  let stats: ReturnType<typeof lstatSync>
  try {
    stats = lstatSync(path)
  } catch {
    return false
  }
  if (!stats.isSymbolicLink()) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    // Windows 的目录联接用 unlink 可能失败（EPERM），改用 rmdir 只移除联接。
    rmdirSync(path)
    return true
  }
}
