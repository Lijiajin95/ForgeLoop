/**
 * 语言边界（本轮硬性验收）：活动实现、测试与自有工具链统一使用 TypeScript。
 * 任务包若把 Python、旧 `.venv` 或旧 `forgeloop` CLI 当成实现/测试路径，程序必须拒绝，
 * 不能靠提示词或代码评审“自觉遵守”。
 */

import type { TaskPlan } from './task-plan.js'

const PYTHON_TOKEN = /(^|\/)(python[0-9.]*|\.venv[^/]*)(\/|$)/i
const PYTHON_FILE = /\.py$/i
const LEGACY_PATH = /^(src\/forgeloop|tests\/|frontend\/src|scripts\/.+\.[a-z]+|\.venv\/)/i
const LEGACY_COMMAND = /(^|\/)(forgeloop)(\s|$)/i

export interface LanguageViolation {
  readonly taskId: string
  readonly field: 'test_command' | 'files'
  readonly value: string
  readonly reason: string
}

/** 返回任务包中越过 TypeScript 边界的项；空数组表示合规。 */
export function languageViolations(plan: TaskPlan): LanguageViolation[] {
  const violations: LanguageViolation[] = []
  for (const task of plan.tasks) {
    for (const argument of task.testCommand) {
      if (PYTHON_TOKEN.test(argument) || PYTHON_FILE.test(argument)) {
        violations.push({
          taskId: task.taskId,
          field: 'test_command',
          value: argument,
          reason: '正式测试命令不得使用 Python 解释器或旧 .venv',
        })
      }
      if (LEGACY_COMMAND.test(argument)) {
        violations.push({
          taskId: task.taskId,
          field: 'test_command',
          value: argument,
          reason: '正式测试命令不得调用旧 forgeloop CLI',
        })
      }
    }
    for (const file of task.files) {
      if (PYTHON_FILE.test(file) || LEGACY_PATH.test(file)) {
        violations.push({
          taskId: task.taskId,
          field: 'files',
          value: file,
          reason: '任务不得修改已退役的 Python/旧前端/旧脚本路径；活动实现统一在 TypeScript 工程内',
        })
      }
    }
    const joined = task.testCommand.join(' ')
    if (/src\/forgeloop|\.venv/.test(joined)) {
      violations.push({
        taskId: task.taskId,
        field: 'test_command',
        value: joined,
        reason: '正式测试命令不得指向旧 Python 源码或旧虚拟环境',
      })
    }
  }
  return violations
}

/** 任务文件必须落在 TypeScript 工程的允许顶层目录内。 */
export function outsideActiveSource(plan: TaskPlan): LanguageViolation[] {
  const activeRoots = [
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
  ]
  const violations: LanguageViolation[] = []
  for (const task of plan.tasks) {
    for (const file of task.files) {
      if (!activeRoots.some((root) => file === root || file.startsWith(root))) {
        violations.push({
          taskId: task.taskId,
          field: 'files',
          value: file,
          reason: `文件不在当前活动工程范围（${activeRoots.join('、')}）`,
        })
      }
    }
  }
  return violations
}

/** 任务若引用 packages/<name>，该包必须已经存在；禁止规划出并行的第二个插件包。 */
export function unknownPackages(plan: TaskPlan, existing: readonly string[]): LanguageViolation[] {
  const known = new Set(existing)
  const violations: LanguageViolation[] = []
  for (const task of plan.tasks) {
    for (const file of task.files) {
      const match = /^packages\/([^/]+)\//.exec(file)
      if (match && !known.has(match[1]!)) {
        violations.push({
          taskId: task.taskId,
          field: 'files',
          value: file,
          reason: `包 packages/${match[1]} 不存在；活动插件包是 packages/forgeloop`,
        })
      }
    }
  }
  return violations
}
