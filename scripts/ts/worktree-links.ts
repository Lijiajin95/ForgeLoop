/**
 * worktree 复用依赖时会在工作树里放一个 `node_modules` 链接（POSIX 符号链接，
 * Windows 目录联接）。递归删除工作树会顺着链接删到主工作树的依赖甚至更远，
 * 因此清理前必须先只摘掉链接本身，再删除工作树。
 */
import { lstatSync, rmdirSync, unlinkSync } from 'node:fs'

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
