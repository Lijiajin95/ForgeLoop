/**
 * 验证失败的确定性分流：环境异常、测试/证据缺陷不能冒充代码缺陷，
 * 也不能计入正式失败轮次。无法确定时按实现缺陷处理，但保留原始证据。
 */

export type VerificationFailureKind =
  'implementation' | 'test_defect' | 'environment' | 'evidence_gap'

export interface ClassifiedFailure {
  readonly kind: VerificationFailureKind
  readonly reason: string
}

export interface FailureSignal {
  readonly label: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly expectFailure: boolean
  readonly output: string
}

const ENVIRONMENT_PATTERNS = [
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /cannot find module/i,
  /err_module_not_found/i,
  /enoent/i,
  /npm err!.*missing/i,
  /cannot find package/i,
  /tsc: not found/i,
  /permission denied/i,
]

const TEST_DEFECT_PATTERNS = [
  /验证方案/,
  /验证命令清单/,
  /验证报告/,
  /无法应用/,
  /缺少验证命令/,
  /没有通过工具执行/,
]

const EVIDENCE_GAP_PATTERNS = [
  /证据无法在验证输出中核对/,
  /没有引用正向验证命令/,
  /没有引用错误对照命令/,
  /引用的错误对照没有失败/,
  /没有关联验证命令/,
  /缺少.*证据/,
]

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

/**
 * 先看命令层的确定事实（spawn 失败、超时、终止），再看报告文本中的材料/证据问题，
 * 最后才归为实现缺陷。环境异常优先于测试缺陷，避免把缺依赖误判成断言失败。
 */
export function classifyVerificationFailure(input: {
  readonly signals: readonly FailureSignal[]
  readonly failures: readonly string[]
}): ClassifiedFailure {
  const text = input.failures.join('\n')
  for (const signal of input.signals) {
    if (signal.exitCode === null && !signal.timedOut && !signal.aborted) {
      return {
        kind: 'environment',
        reason: `命令没有取得真实退出码（可能是可执行文件或依赖缺失）：${signal.label}`,
      }
    }
    if (matches(ENVIRONMENT_PATTERNS, signal.output)) {
      return { kind: 'environment', reason: `命令输出显示环境/依赖异常：${signal.label}` }
    }
  }
  if (matches(TEST_DEFECT_PATTERNS, text)) {
    return { kind: 'test_defect', reason: '验证材料或验证命令本身不可用，不能当作代码缺陷' }
  }
  if (matches(EVIDENCE_GAP_PATTERNS, text)) {
    return { kind: 'evidence_gap', reason: '验证/业务证据不足，需补充证据后复验' }
  }
  return { kind: 'implementation', reason: '验证在候选行为上失败，按实现缺陷处理' }
}
