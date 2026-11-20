import { asRecord } from './json.js'
import { MalformedError } from './errors.js'
import { parseJsonLoose } from './requirement.js'

export const CONTROLS_FILE = 'verification/controls.json'
export const CONTROL_DIR = 'verification/controls'

export interface VerificationControlSpec {
  readonly label: string
  readonly patch: string
  readonly expectedFailureOutput: string
  readonly patchSha256?: string
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

export function validateControlCoverage(input: {
  readonly requiredScenarios: readonly string[]
  readonly reportScenarios: readonly {
    readonly scenario: string
    readonly status: string
    readonly commands: readonly string[]
  }[]
  readonly controls: readonly { readonly label: string }[]
  readonly negativeLabels?: readonly string[]
}): string[] {
  const controlled = new Set([
    ...input.controls.map((control) => control.label),
    ...(input.negativeLabels ?? []),
  ])
  const passedRequired = input.reportScenarios.filter(
    (result) => result.status === 'pass' && input.requiredScenarios.includes(result.scenario),
  )
  if (passedRequired.length === 0) return []
  const covered = passedRequired.some((result) =>
    result.commands.some((label) => controlled.has(label)),
  )
  if (covered) return []
  return [
    '没有任何必过场景提供敏感性对照，无法证明用例能发现错误行为；至少选择一个关键必过场景为其命令登记受控错误副本。',
  ]
}

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
      issues.push(`敏感性对照不能只修改测试材料，必须触及业务实现：${target}`)
    }
  }
  return issues
}
