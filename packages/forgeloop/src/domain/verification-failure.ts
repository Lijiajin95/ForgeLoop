import type { VerificationCheckRun } from './verification.js'

export const VERIFICATION_FAILURE_KINDS = [
  'implementation_defect',
  'test_error',
  'environment_error',
  'insufficient_evidence',
  'requirement_dispute',
  'undetermined',
] as const

export type VerificationFailureKind = (typeof VERIFICATION_FAILURE_KINDS)[number]

export interface VerificationFailureClassification {
  readonly kind: VerificationFailureKind
  readonly reasons: readonly string[]
  readonly evidence: readonly string[]
  readonly requiresCodeChange: boolean
  readonly guidance: string
}

export interface VerificationFailureInput {
  readonly blocking: readonly string[]
  readonly commandRuns: readonly VerificationCheckRun[]
  readonly failedScenarios?: readonly string[]
  readonly coverageIssues?: readonly string[]
  readonly evidenceIssues?: readonly string[]
  readonly integrityIssues?: readonly string[]
  readonly controlIssues?: readonly string[]
  readonly materialIssues?: readonly string[]
  readonly environmentIssues?: readonly string[]
}

const ASSERTION_SIGNATURES = [
  /AssertionError/i,
  /\bexpected\b[\s\S]{0,120}\b(?:to|but|actual|received)\b/i,
  /\bactual\s*:\s*/i,
  /\bFAIL(?:ED)?\b/,
  /✕|×/,
  /not ok \d+/i,
]

function hasAssertionSignature(output: string): boolean {
  return ASSERTION_SIGNATURES.some((pattern) => pattern.test(output))
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))]
}

function runEvidence(run: VerificationCheckRun): string {
  const state = run.aborted
    ? '被中止'
    : run.timedOut
      ? '超时'
      : run.exitCode === null
        ? '无退出码'
        : `退出码 ${run.exitCode}`
  return `${run.label}（${state}）`
}

function preBusinessFailure(
  input: VerificationFailureInput,
  blocking: readonly string[],
): VerificationFailureClassification | null {
  const environmentIssues = input.environmentIssues ?? []
  if (environmentIssues.length > 0) {
    return {
      kind: 'environment_error',
      reasons: unique(environmentIssues),
      evidence: unique(environmentIssues),
      requiresCodeChange: false,
      guidance: '先恢复依赖、宿主或外部服务；按环境依据复验同一候选，旧异常与未验证状态保留。',
    }
  }
  const aborted = input.commandRuns.filter((run) => run.aborted)
  if (aborted.length > 0) {
    return {
      kind: 'undetermined',
      reasons: [...blocking, ...aborted.map((run) => `测试命令被中止：${run.label}`)],
      evidence: aborted.map(runEvidence),
      requiresCodeChange: false,
      guidance: '验证被停止或中断；先核对现场与副作用，确认后再复验，不要求研发改代码。',
    }
  }
  const timedOut = input.commandRuns.filter((run) => run.timedOut)
  if (timedOut.length > 0) {
    return {
      kind: 'undetermined',
      reasons: [...blocking, ...timedOut.map((run) => `测试命令超时：${run.label}`)],
      evidence: timedOut.map(runEvidence),
      requiresCodeChange: false,
      guidance: '先诊断超时属于环境、用例等待还是实现挂起；取得依据前不要求研发改代码，也不放行。',
    }
  }
  const integrityIssues = input.integrityIssues ?? []
  if (integrityIssues.length > 0) {
    return {
      kind: 'test_error',
      reasons: [...blocking, ...integrityIssues],
      evidence: unique(integrityIssues),
      requiresCodeChange: false,
      guidance: '固定候选被验证过程改变；保留原始记录，修正测试材料后在同一候选复验。',
    }
  }
  const controlIssues = input.controlIssues ?? []
  if (controlIssues.length > 0) {
    return {
      kind: 'test_error',
      reasons: [...blocking, ...controlIssues],
      evidence: unique(controlIssues),
      requiresCodeChange: false,
      guidance:
        '必过用例没有证明能发现对应错误行为；修订用例与敏感性对照，按测试修订流程复核后复验。',
    }
  }
  // 归到测试材料错误，让 Agent 改脚本，而不是让研发去改实现。
  // 只在“确实失败”且“没有任何业务断言失败”时才这样归类：对照组正常输出里的同类文本、
  // 或被别的命令的业务断言遮蔽时，不能把真实缺陷判成测试材料问题。
  const failedRuns = input.commandRuns.filter(
    (run) => !run.aborted && !run.timedOut && run.exitCode !== null && run.exitCode !== 0,
  )
  const hasAssertionFailure = failedRuns.some((run) => hasAssertionSignature(run.output))
  // 这是测试材料写法问题，不是候选业务缺陷。
  if (!hasAssertionFailure) {
    const moduleErrors = failedRuns.filter((run) =>
      /Cannot find module '[^']*\/src\/[^']*\.js'|ERR_MODULE_NOT_FOUND[^\n]*\/src\//.test(
        run.output,
      ),
    )
    if (moduleErrors.length > 0) {
      return {
        kind: 'test_error',
        reasons: [
          ...blocking,
          ...moduleErrors.map((run) => `验证脚本引用了不存在的源码模块：${run.label}`),
        ],
        evidence: moduleErrors.map(runEvidence),
        requiresCodeChange: false,
        guidance:
          '验证脚本不要直接 import 源码目录的 .ts 或按 .js 解析源码；改用 npm 脚本、已构建的 lib/dist 入口或测试运行器，在同一候选复验。',
      }
    }
  }
  const scriptErrors = hasAssertionFailure
    ? []
    : failedRuns.filter((run) =>
        /require is not defined in ES module scope|ERR_REQUIRE_ESM/.test(run.output),
      )
  if (scriptErrors.length > 0) {
    return {
      kind: 'test_error',
      reasons: [...blocking, ...scriptErrors.map((run) => `验证脚本自身报错：${run.label}`)],
      evidence: scriptErrors.map(runEvidence),
      requiresCodeChange: false,
      guidance:
        '验证脚本是 CommonJS 却被当作 ESM 执行（或反之）；把脚本改成工程一致的模块形式（ESM import 或 .cjs）后在同一候选复验，不要求研发改代码。',
    }
  }
  const noExitCode = input.commandRuns.filter(
    (run) => run.exitCode === null && !run.aborted && !run.timedOut,
  )
  if (noExitCode.length > 0) {
    return {
      kind: 'environment_error',
      reasons: [...blocking, ...noExitCode.map((run) => `测试命令未取得退出码：${run.label}`)],
      evidence: noExitCode.map((run) => `${run.label}: ${run.output.slice(0, 200)}`),
      requiresCodeChange: false,
      guidance: '命令无法启动或执行器异常；恢复环境后按同一方案复验，不要求研发改代码。',
    }
  }
  return null
}

function failedCommandFailure(
  input: VerificationFailureInput,
  blocking: readonly string[],
): VerificationFailureClassification | null {
  const failedRuns = input.commandRuns.filter((run) => run.exitCode !== null && run.exitCode !== 0)
  if (failedRuns.length === 0) return null
  if (failedRuns.some((run) => hasAssertionSignature(run.output))) {
    return {
      kind: 'implementation_defect',
      reasons: [...blocking, ...failedRuns.map((run) => `业务断言失败：${run.label}`)],
      evidence: failedRuns.map((run) => `${runEvidence(run)}: ${run.output.slice(0, 400)}`),
      requiresCodeChange: true,
      guidance:
        '失败来自业务断言；附复现步骤、预期、实际、候选身份、关联用例与日志引用，交回研发定向修复。',
    }
  }
  return {
    kind: 'undetermined',
    reasons: [...blocking, ...failedRuns.map((run) => `测试命令非零退出：${run.label}`)],
    evidence: failedRuns.map((run) => `${runEvidence(run)}: ${run.output.slice(0, 400)}`),
    requiresCodeChange: false,
    guidance: '命令失败但没有可识别的业务断言证据；先诊断失败来源，不直接要求研发改代码。',
  }
}

export function classifyVerificationFailure(
  input: VerificationFailureInput,
): VerificationFailureClassification {
  const blocking = unique(input.blocking)
  const failedScenarios = input.failedScenarios ?? []
  const coverageIssues = input.coverageIssues ?? []
  const evidenceIssues = input.evidenceIssues ?? []
  const materialIssues = input.materialIssues ?? []

  const preBusiness = preBusinessFailure(input, blocking)
  if (preBusiness) return preBusiness
  const failedCommand = failedCommandFailure(input, blocking)
  if (failedCommand) return failedCommand

  const missingEvidence = [...materialIssues, ...coverageIssues, ...evidenceIssues]
  if (missingEvidence.length > 0) {
    return {
      kind: 'insufficient_evidence',
      reasons: [...blocking, ...missingEvidence],
      evidence: unique(missingEvidence),
      requiresCodeChange: false,
      guidance:
        '缺少必过场景、可核对证据或测试材料；补齐观测/用例并按复核流程重验，不能凭模型自述放行。',
    }
  }

  if (failedScenarios.length > 0) {
    return {
      kind: 'insufficient_evidence',
      reasons: [...blocking, ...failedScenarios.map((scenario) => `场景未通过：${scenario}`)],
      evidence: failedScenarios,
      requiresCodeChange: false,
      guidance: '报告声明场景失败但没有对应的失败命令证据；先补齐观测，再判断是否为实现缺陷。',
    }
  }

  if (blocking.some((item) => /需求歧义|需求争议|验收标准.*不清|目标冲突|需.*决定/.test(item))) {
    return {
      kind: 'requirement_dispute',
      reasons: blocking,
      evidence: blocking,
      requiresCodeChange: false,
      guidance: '按业务复核与例外决定规则处理；Agent 不得自行改写需求、验收标准或授权。',
    }
  }

  return {
    kind: 'undetermined',
    reasons: blocking,
    evidence: unique(blocking),
    requiresCodeChange: false,
    guidance: '先按现有证据诊断原因；原因明确前不要求研发改代码，也不以重跑直到通过作为放行依据。',
  }
}
