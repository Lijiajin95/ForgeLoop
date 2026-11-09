/**
 * 合并一个 worktree 分支并自动清理：
 * 1) 只允许从干净的 main 快进合并；
 * 2) 分支必须在 worktree 中（若有）保持干净；
 * 3) 合并后移除 worktree，删除已合并分支。
 *
 * 用法：make worktree-merge BRANCH=fix/xxx
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { unlinkWorkspaceLink } from './worktree-links.ts'

function fail(message: string): never {
  console.error(`[worktree-merge] ${message}`)
  process.exit(1)
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function isAncestor(ancestor: string, descendant: string): boolean {
  try {
    git(['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

interface WorktreeEntry {
  readonly path: string
  readonly branch: string
}

function worktrees(): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: { path?: string; branch?: string } = {}
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) current.path = line.slice('worktree '.length)
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length)
    else if (line === '' && current.path && current.branch) {
      entries.push({ path: current.path, branch: current.branch })
      current = {}
    }
  }
  if (current.path && current.branch) entries.push({ path: current.path, branch: current.branch })
  return entries
}

const branch = process.argv[2]?.trim() ?? ''
if (!branch) fail('用法：make worktree-merge BRANCH=<branch>')
if (branch === 'main') fail('不能合并 main 自身')

if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('必须在 main 工作树中执行')
if (git(['status', '--porcelain']) !== '') fail('main 工作树不干净；先提交或还原改动')

const exists = git(['branch', '--list', branch])
if (!exists) fail(`分支不存在：${branch}`)
if (!isAncestor('main', branch)) {
  fail(`分支 ${branch} 不是 main 的快进后继；先 rebase 或手工处理分叉`)
}

const entry = worktrees().find((item) => item.branch === `refs/heads/${branch}`)
if (entry) {
  if (git(['status', '--porcelain'], entry.path) !== '') {
    fail(`worktree 不干净：${entry.path}`)
  }
  console.log(`[worktree-merge] 合并 ${branch}（worktree ${entry.path}）`)
} else {
  console.log(`[worktree-merge] 合并 ${branch}（无 worktree）`)
}

git(['merge', '--ff-only', branch])
if (entry) {
  // 先摘掉复用依赖的链接：递归删除工作树会顺着链接删到主工作树的 node_modules。
  for (const link of ['node_modules', join('packages', 'forgeloop', 'node_modules')]) {
    if (unlinkWorkspaceLink(join(entry.path, link))) {
      console.log(`[worktree-merge] 已摘除链接 ${join(entry.path, link)}`)
    }
  }
  if (git(['status', '--porcelain'], entry.path) !== '') {
    fail(`摘除链接后 worktree 仍不干净：${entry.path}；请手工核对后再清理`)
  }
  git(['worktree', 'remove', entry.path])
  console.log(`[worktree-merge] 已移除 worktree ${entry.path}`)
}
git(['branch', '-d', branch])
console.log(`[worktree-merge] 已删除分支 ${branch}`)
