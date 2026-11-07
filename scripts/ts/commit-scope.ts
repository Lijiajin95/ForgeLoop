/**
 * 提交范围判定：暂存区是否包含需要覆盖率门禁的代码路径。
 *
 * 复用 worktree-guard 的代码路径定义，避免两处规则漂移。
 * 用法（pre-commit 调用）：node scripts/ts/commit-scope.ts
 * 输出一行 `code` 或 `docs`；读取 git 失败时非零退出，让提交被阻止而不是默认放行。
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCodePath } from './worktree-guard.ts'

export function requiresCoverage(paths: readonly string[]): boolean {
  return paths.some((path) => isCodePath(path))
}

export function scopeOfStaged(paths: readonly string[]): 'code' | 'docs' {
  return requiresCoverage(paths) ? 'code' : 'docs'
}

export function stagedPaths(): string[] {
  return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRD'], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function runCli(): void {
  process.stdout.write(`${scopeOfStaged(stagedPaths())}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    console.error(`[commit-scope] 无法判定暂存范围：${(error as Error).message}`)
    process.exit(1)
  }
}
