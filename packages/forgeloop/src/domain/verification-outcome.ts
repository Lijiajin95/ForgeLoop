/**
 * 独立测试的共用判定与证据规则。
 *
 * 连续推进（legacy 执行路径）与显式 `verify`（verification-pipeline）的**执行方式**不同，
 * 但“什么算通过、什么算阻断、候选完整性怎么判”必须只有一份规则；否则两个入口会给出
 * 不一致的结论。这里只放纯函数：输入都是已采集的事实，不读文件、不执行命令。
 */

export interface VerificationOutcomeFacts {
  /** 执行层给出的报告结论；false 表示报告自身判定失败。 */
  readonly reportedPassed: boolean
  /** 执行层已经列出的阻断文案（按原顺序保留，不再重新派生）。 */
  readonly blocking?: readonly string[]
  /** 报告里是否有未通过的场景。 */
  readonly scenarioFailed?: boolean
  /** 失败的测试命令（已含退出码信息）。 */
  readonly failedCommands?: readonly string[]
  readonly coverageIssues?: readonly string[]
  readonly evidenceIssues?: readonly string[]
  readonly integrityIssues?: readonly string[]
  readonly controlIssues?: readonly string[]
}

export interface VerificationOutcome {
  readonly verdict: 'pass' | 'block'
  readonly blocking: string[]
}

/** 可选列表统一成数组，避免判定函数里堆满 `?? []` 分支。 */
function list<T>(value: readonly T[] | undefined): readonly T[] {
  return value ?? []
}

/**
 * 汇总阻断项并判定通过/阻断。
 * 顺序固定为：执行层阻断 → 完整性 → 敏感性对照 → 证据 → 未通过场景 → 失败命令 → 覆盖；
 * 两个入口共用这一顺序，报告与快照因此可比。
 */
export function decideVerificationOutcome(facts: VerificationOutcomeFacts): VerificationOutcome {
  const integrityIssues = list(facts.integrityIssues)
  const controlIssues = list(facts.controlIssues)
  const evidenceIssues = list(facts.evidenceIssues)
  const failedCommands = list(facts.failedCommands)
  const coverageIssues = list(facts.coverageIssues)
  const scenarioBlocking = facts.scenarioFailed === true ? ['报告存在未通过的测试场景'] : []
  const blocking = [
    ...list(facts.blocking),
    ...integrityIssues,
    ...controlIssues,
    ...evidenceIssues,
    ...scenarioBlocking,
    ...failedCommands.map((failure) => `测试命令失败：${failure}`),
    ...coverageIssues,
  ]
  const passed =
    facts.reportedPassed &&
    scenarioBlocking.length === 0 &&
    failedCommands.length === 0 &&
    coverageIssues.length === 0 &&
    evidenceIssues.length === 0 &&
    integrityIssues.length === 0 &&
    controlIssues.length === 0
  return { verdict: passed ? 'pass' : 'block', blocking }
}

export interface CandidateIntegrityFactsInput {
  /** 固定候选时的提交。 */
  readonly expectedHead: string
  /** 测试结束后重新读取的提交。 */
  readonly actualHead: string
  /** 测试结束后的工作区改动路径（已归一化为 `/`）。 */
  readonly changes: readonly string[]
  /** 允许改动的目录前缀，例如 `verification/`。 */
  readonly allowedPrefix: string
}

export interface CandidateIntegrityFacts {
  /** 候选提交在测试期间被移动。 */
  readonly headChanged: boolean
  /** 越出允许目录的改动路径。 */
  readonly outside: string[]
}

/** 候选完整性事实：提交是否被移动、是否改到固定候选。 */
export function candidateIntegrityFacts(
  input: CandidateIntegrityFactsInput,
): CandidateIntegrityFacts {
  return {
    headChanged: input.actualHead !== input.expectedHead,
    outside: input.changes.filter((path) => !path.startsWith(input.allowedPrefix)),
  }
}
