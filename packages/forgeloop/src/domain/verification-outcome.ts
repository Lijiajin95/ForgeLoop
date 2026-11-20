export interface VerificationOutcomeFacts {
  readonly reportedPassed: boolean
  readonly blocking?: readonly string[]
  readonly scenarioFailed?: boolean
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

function list<T>(value: readonly T[] | undefined): readonly T[] {
  return value ?? []
}

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
  readonly expectedHead: string
  readonly actualHead: string
  /** 测试结束后的工作区改动路径（已归一化为 `/`）。 */
  readonly changes: readonly string[]
  readonly allowedPrefix: string
}

export interface CandidateIntegrityFacts {
  readonly headChanged: boolean
  readonly outside: string[]
}

export function candidateIntegrityFacts(
  input: CandidateIntegrityFactsInput,
): CandidateIntegrityFacts {
  return {
    headChanged: input.actualHead !== input.expectedHead,
    outside: input.changes.filter((path) => !path.startsWith(input.allowedPrefix)),
  }
}
