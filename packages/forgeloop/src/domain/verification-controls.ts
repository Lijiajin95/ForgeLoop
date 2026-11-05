/**
 * 验证敏感性对照：证明必过用例确实能发现对应错误行为。
 *
 * 只靠“命令退出 0 + 输出里有预期文字”不能证明业务正确：只打印固定标记的脚本
 * 同样满足这两点。验证材料必须为关键用例声明一个受控错误补丁，程序把补丁应用到
 * 候选的隔离副本后重跑同一命令，要求它按目标业务规则失败。对照不修改正式候选。
 *
 * 补丁只能改 `verification/` 之外的文件，避免“把测试自己改坏”冒充敏感性。
 */

import { asRecord } from './json.js'
import { MalformedError } from './errors.js'
import { parseJsonLoose } from './requirement.js'

export const CONTROLS_FILE = 'verification/controls.json'
export const CONTROL_DIR = 'verification/controls'

export interface VerificationControlSpec {
  readonly label: string
  /** 相对工作区的补丁路径，必须位于 verification/controls/ 下。 */
  readonly patch: string
  /** 受控错误实现下必须出现在命令输出中的失败原文（至少 8 个字符）。 */
  readonly expectedFailureOutput: string
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MalformedError(`${field} 必须是非空字符串`)
  }
  return value.trim()
}

function validatePatchPath(path: string): string {
  if (path.startsWith('/') || path.includes('..') || !path.startsWith(`${CONTROL_DIR}/`)) {
    throw new MalformedError(`敏感性对照补丁必须位于 ${CONTROL_DIR}/ 下且不能越界：${path}`)
  }
  if (!path.endsWith('.patch')) {
    throw new MalformedError(`敏感性对照补丁必须是 .patch 文件：${path}`)
  }
  return path
}

/** 解析 `verification/controls.json`；结构不合法时 fail-closed。 */
export function parseVerificationControls(raw: string): VerificationControlSpec[] {
  const data = asRecord(parseJsonLoose(raw, '敏感性对照'))
  if (!data) throw new MalformedError('敏感性对照必须是 JSON 对象')
  if (!Array.isArray(data.controls)) {
    throw new MalformedError('敏感性对照必须给出 controls 数组')
  }
  if (data.controls.length > 20) throw new MalformedError('敏感性对照一次最多 20 条')
  const labels = new Set<string>()
  const controls = data.controls.map((item, index) => {
    const control = asRecord(item)
    if (!control) throw new MalformedError(`controls[${index}] 必须是 JSON 对象`)
    const label = nonEmpty(control.label, `controls[${index}].label`)
    if (labels.has(label)) throw new MalformedError(`敏感性对照的 label 不能重复：${label}`)
    labels.add(label)
    const patch = validatePatchPath(nonEmpty(control.patch, `controls[${index}].patch`))
    const expected = nonEmpty(
      control.expected_failure_output ?? control.expectedFailureOutput,
      `controls[${index}].expected_failure_output`,
    )
    if (expected.length < 8) {
      throw new MalformedError(
        `controls[${index}].expected_failure_output 至少 8 个字符，必须能核对到目标业务规则`,
      )
    }
    return { label, patch, expectedFailureOutput: expected } satisfies VerificationControlSpec
  })
  return controls
}

/**
 * 至少一个必过场景必须有关联命令带敏感性对照；否则无法证明测试能发现错误行为。
 * 回归场景可以复用同一业务入口，不要求每条必过用例都单独做变异式对照。
 */
export function validateControlCoverage(input: {
  readonly requiredScenarios: readonly string[]
  readonly reportScenarios: readonly {
    readonly scenario: string
    readonly status: string
    readonly commands: readonly string[]
  }[]
  readonly controls: readonly { readonly label: string }[]
}): string[] {
  const controlled = new Set(input.controls.map((control) => control.label))
  const covered = input.reportScenarios.some(
    (result) =>
      result.status === 'pass' &&
      input.requiredScenarios.includes(result.scenario) &&
      result.commands.some((label) => controlled.has(label)),
  )
  if (covered) return []
  return [
    '没有任何必过场景提供敏感性对照，无法证明用例能发现错误行为；至少选择一个关键必过场景为其命令登记受控错误副本。',
  ]
}

/** 从统一 diff 中读取目标路径；用于拒绝只改验证材料或越界的“对照”。 */
export function controlPatchTargets(patch: string): string[] {
  const targets = new Set<string>()
  for (const line of patch.split('\n')) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (match?.[2]) {
      targets.add(match[2])
      continue
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line)
    if (plus?.[1] && plus[1] !== '/dev/null') targets.add(plus[1])
  }
  return [...targets]
}

/**
 * 对照补丁必须修改业务文件，不能只改 verification/ 下的测试或标记脚本；
 * 路径必须留在工作区内。返回问题列表，空数组表示可执行。
 */
export function validateControlPatch(patch: string): string[] {
  const targets = controlPatchTargets(patch)
  if (targets.length === 0) return ['敏感性对照补丁没有可识别的目标文件']
  const issues: string[] = []
  for (const target of targets) {
    if (target.startsWith('/') || target.includes('..')) {
      issues.push(`敏感性对照补丁路径越界：${target}`)
      continue
    }
    if (target.startsWith('verification/')) {
      issues.push(`敏感性对照不能只修改验证材料，必须触及业务实现：${target}`)
    }
  }
  return issues
}
