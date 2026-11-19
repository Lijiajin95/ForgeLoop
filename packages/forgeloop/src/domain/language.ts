import type { TaskPlan } from './task-plan.js'

export interface LanguageViolation {
  readonly taskId: string
  readonly field: 'test_command' | 'files'
  readonly value: string
  readonly reason: string
}

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

function normalizedRoot(root: string): string {
  return root.replaceAll('\\', '/').replace(/\/+$/, '').trim()
}

export function insideActiveFile(file: string, roots?: readonly string[]): boolean {
  const normalized = file.replaceAll('\\', '/')
  if (!roots || roots.length === 0) return true
  const activeRoots = roots.map(normalizedRoot).filter(Boolean)
  return activeRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
}

export function outsideActiveFiles(files: readonly string[], roots?: readonly string[]): string[] {
  return files.filter((file) => !insideActiveFile(file, roots))
}

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
          reason: `文件不在当前活动工程范围（${roots && roots.length > 0 ? roots.join('、') : '（未配置）'}）`,
        })
      }
    }
  }
  return violations
}

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
