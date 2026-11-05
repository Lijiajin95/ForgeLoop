/**
 * 从干净的 main 创建任务 worktree，并复用主工作树依赖。
 *
 * 用法：make worktree-start TASK=<task> [BRANCH=<branch>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

function fail(message: string): never {
  console.error(`[worktree-start] ${message}`)
  process.exit(1)
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

const task = (process.argv[2] ?? '').trim()
const branch = (process.argv[3] ?? `feat/${task}`).trim()
if (!/^[a-z0-9][a-z0-9-]*$/.test(task)) {
  fail('用法：make worktree-start TASK=<task> [BRANCH=<branch>]；TASK 只允许小写字母、数字和连字符')
}
if (!/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(branch)) {
  fail(`分支名不合法：${branch}`)
}
if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') {
  fail('必须在 main 工作树中执行')
}
if (git(['status', '--porcelain']) !== '') {
  fail('main 工作树不干净；先提交或还原改动')
}
if (git(['branch', '--list', branch])) fail(`分支已存在：${branch}`)

const root = git(['rev-parse', '--show-toplevel'])
const path = join(root, '.cache', 'worktrees', task)
if (existsSync(path)) fail(`worktree 目录已存在：${path}`)
mkdirSync(join(root, '.cache', 'worktrees'), { recursive: true })
git(['worktree', 'add', path, '-b', branch, 'HEAD'])
const modules = join(root, 'node_modules')
if (existsSync(modules) && !existsSync(join(path, 'node_modules'))) {
  try {
    symlinkSync(
      modules,
      join(path, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  } catch {
    // 依赖软链失败不阻断创建；在 worktree 内自行安装即可。
  }
}
console.log(`[worktree-start] 已创建 ${path}`)
console.log(
  `[worktree-start] 分支 ${branch}；进入后开始修改，提交后回到 main 执行 make worktree-merge BRANCH=${branch}`,
)
