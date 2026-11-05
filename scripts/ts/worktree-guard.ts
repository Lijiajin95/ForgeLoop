/**
 * 提交前的项目级硬约束：主工作树不得直接提交代码改动。
 *
 * 文档、状态记录等非代码文件仍可在主工作树提交；代码必须先在
 * `.cache/worktrees/<task>` 的独立 worktree 中修改和验证，再由 main 快进合并。
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WorktreeGuardInput {
  readonly root: string
  readonly mainRoot: string
  readonly staged: readonly string[]
}

export interface WorktreeGuardResult {
  readonly ok: boolean
  readonly message: string
}

const CODE_PREFIXES = ['packages/', 'scripts/', 'contracts/', '.github/', '.githooks/'] as const
const CODE_FILES = new Set([
  'Makefile',
  'package.json',
  'package-lock.json',
  'pnpm-workspace.yaml',
  'eslint.config.js',
  'skills-lock.json',
])

function normalized(path: string): string {
  return resolve(path).replace(/\\/g, '/').replace(/\/$/, '')
}

export function isCodePath(path: string): boolean {
  const file = path.replace(/\\/g, '/')
  return (
    CODE_PREFIXES.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix)) ||
    CODE_FILES.has(file)
  )
}

export function checkWorktree(input: WorktreeGuardInput): WorktreeGuardResult {
  const code = input.staged.filter(isCodePath)
  if (normalized(input.root) !== normalized(input.mainRoot)) {
    return { ok: true, message: 'linked worktree' }
  }
  if (code.length > 0) {
    return {
      ok: false,
      message:
        `主工作树禁止直接提交代码：${code.join('、')}\n` +
        '请先执行 make worktree-start TASK=<task>，在 .cache/worktrees/<task> 中修改并提交，' +
        '再用 make worktree-merge 快进合并；主工作树只接收合并与纯文档改动。',
    }
  }
  return { ok: true, message: 'main worktree: docs-only' }
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function mainWorktree(): string {
  const first = git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .find((line) => line.startsWith('worktree '))
  if (!first) throw new Error('无法确定主工作树')
  return first.slice('worktree '.length)
}

function runCli(): void {
  const root = git(['rev-parse', '--show-toplevel'])
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMRD'])
    .split('\n')
    .filter(Boolean)
  const result = checkWorktree({ root, mainRoot: mainWorktree(), staged })
  if (!result.ok) {
    console.error(`[worktree-guard] ${result.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    console.error(`[worktree-guard] ${(error as Error).message}`)
    process.exit(1)
  }
}
