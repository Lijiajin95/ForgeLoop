/**
 * 工程范围：任务文件必须落在活动工程的允许顶层路径内。
 *
 * 这里只做“范围”判断，不做语言/文件类型限制：目标项目用什么语言、什么扩展名由项目自己决定，
 * 程序不禁止任何文件。默认的顶层路径是 ForgeLoop 自身工程布局，受控目标项目用 `activeRoots` 替换。
 */

import type { TaskPlan } from './task-plan.js'

export interface LanguageViolation {
  readonly taskId: string
  readonly field: 'test_command' | 'files'
  readonly value: string
  readonly reason: string
}

/** ForgeLoop 自身工程的允许顶层路径；受控目标工程可用配置替换。 */
export const DEFAULT_ACTIVE_ROOTS = [
  'packages/',
  'docs/',
  'contracts/',
  'config/',
  'scripts/ts/',
  'AGENTS.md',
  'README.md',
  'CONTRIBUTING.md',
  'CONTEXT.md',
  'Makefile',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
] as const

/**
 * 任务文件必须落在活动工程的允许顶层目录内。
 * 传入 roots 时用它替换内置的 ForgeLoop 工程约定，供受控目标工程使用。
 */
function normalizedRoot(root: string): string {
  return root.replaceAll('\\', '/').replace(/\/+$/, '').trim()
}

/** 目录按路径边界匹配，文件按完整路径匹配；不能用 src 前缀吞掉 src2。 */
export function insideActiveFile(file: string, roots?: readonly string[]): boolean {
  const normalized = file.replaceAll('\\', '/')
  // 显式声明空数组表示不做范围限制；未声明才使用内置默认（ForgeLoop 自身布局）。
  if (roots && roots.length === 0) return true
  const activeRoots =
    roots && roots.length > 0
      ? roots.map(normalizedRoot).filter(Boolean)
      : DEFAULT_ACTIVE_ROOTS.map(normalizedRoot).filter(Boolean)
  return activeRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
}

/** 按实际变更文件检查活动工程范围；任务计划校验和提交前兜底共用同一规则。 */
export function outsideActiveFiles(files: readonly string[], roots?: readonly string[]): string[] {
  return files.filter((file) => !insideActiveFile(file, roots))
}

/** 从统一 diff 读取实际变更路径；用于在候选/提交通道上按 activeRoots 兜底。 */
export function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>()
  for (const line of diff.split('\n')) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (match?.[2]) {
      files.add(match[2])
      continue
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line)
    if (plus?.[1] && plus[1] !== '/dev/null') files.add(plus[1])
  }
  return [...files]
}

export function outsideActiveSource(
  plan: TaskPlan,
  roots?: readonly string[],
): LanguageViolation[] {
  const violations: LanguageViolation[] = []
  for (const task of plan.tasks) {
    for (const file of task.files) {
      if (!insideActiveFile(file, roots)) {
        violations.push({
          taskId: task.taskId,
          field: 'files',
          value: file,
          reason: `文件不在当前活动工程范围（${(roots && roots.length > 0 ? roots : DEFAULT_ACTIVE_ROOTS).join('、')}）`,
        })
      }
    }
  }
  return violations
}

/** 任务若引用 packages/<name>，该包必须已经存在；`allowNew` 为真时放行（允许新建包）。 */
export function unknownPackages(
  plan: TaskPlan,
  existing: readonly string[],
  allowNew = false,
): LanguageViolation[] {
  if (allowNew) return []
  const known = new Set(existing)
  const violations: LanguageViolation[] = []
  for (const task of plan.tasks) {
    for (const file of task.files) {
      const match = /^packages\/([^/]+)\//.exec(file)
      if (match && !known.has(match[1] ?? '')) {
        violations.push({
          taskId: task.taskId,
          field: 'files',
          value: file,
          reason: `包 packages/${match[1]} 不存在；只能修改已存在的包`,
        })
      }
    }
  }
  return violations
}
