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

/**
 * 语言/路径约定。默认按 ForgeLoop 自己的工程约定（TypeScript 活动实现、旧 Python/旧脚本路径已退役）；
 * 受控目标工程可以关闭这套专属约定，只保留通用语言检查（仍禁止 Python 文件）。
 */
export interface LanguageRules {
  /** 是否套用 ForgeLoop 专属的退役路径与旧命令规则；默认 true。 */
  readonly forgeLoopConventions?: boolean
}

/** 由工程配置推导语言规则：声明了 activeRoots 的受控工程不套用 ForgeLoop 专属约定。 */
export function languageRulesFor(activeRoots?: readonly string[]): LanguageRules {
  return { forgeLoopConventions: activeRoots === undefined }
}

/** 返回任务包中越过 TypeScript 边界的项；空数组表示合规。 */
export function languageViolations(plan: TaskPlan, rules: LanguageRules = {}): LanguageViolation[] {
  const forgeLoop = rules.forgeLoopConventions !== false
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
      if (forgeLoop && LEGACY_COMMAND.test(argument)) {
        violations.push({
          taskId: task.taskId,
          field: 'test_command',
          value: argument,
          reason: '正式测试命令不得调用旧 forgeloop CLI',
        })
      }
    }
    for (const file of task.files) {
      if (PYTHON_FILE.test(file) || (forgeLoop && LEGACY_PATH.test(file))) {
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
export function outsideActiveSource(
  plan: TaskPlan,
  roots?: readonly string[],
): LanguageViolation[] {
  const activeRoots = roots && roots.length > 0 ? [...roots] : [...DEFAULT_ACTIVE_ROOTS]
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
      if (match && !known.has(match[1] ?? '')) {
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
