import type { VerificationReport } from '../domain/verification.js'
import { sha256OfText } from '../domain/delivery.js'
import { requireGit } from './workspace.js'
import { VERIFICATION_MATERIAL_DIR, workspaceChanges } from './service-helpers.js'

export function verificationVerdict(input: {
  report: VerificationReport
  failedCommands: readonly string[]
  coverageIssues: readonly string[]
  evidenceIssues: readonly string[]
  integrityIssues: readonly string[]
  controlIssues?: readonly string[]
}): { verdict: 'pass' | 'block'; blocking: string[] } {
  const {
    report,
    failedCommands,
    coverageIssues,
    evidenceIssues,
    integrityIssues,
    controlIssues = [],
  } = input
  const anyScenarioFailed = report.scenarios.some((scenario) => scenario.status === 'fail')
  const blocking = [
    ...report.blocking,
    ...integrityIssues,
    ...controlIssues,
    ...evidenceIssues,
    ...(anyScenarioFailed ? ['报告存在未通过的测试场景'] : []),
    ...failedCommands.map((failure) => `测试命令失败：${failure}`),
    ...coverageIssues,
  ]
  const pass =
    report.verdict === 'pass' &&
    failedCommands.length === 0 &&
    coverageIssues.length === 0 &&
    evidenceIssues.length === 0 &&
    integrityIssues.length === 0 &&
    controlIssues.length === 0 &&
    !anyScenarioFailed
  return { verdict: pass ? 'pass' : 'block', blocking }
}

export function verificationIntegrity(
  workspace: string,
  workspaceHead: string,
):
  | {
      ok: true
      integrityIssues: string[]
      afterHead: string
      afterChanges: string[]
      candidateContentSha256: string
    }
  | { ok: false; detail: string } {
  const afterHead = requireGit(workspace, ['rev-parse', 'HEAD'])
  if (afterHead !== workspaceHead) {
    return {
      ok: false,
      detail: `验证期间候选提交发生变化（fail-closed）：${workspaceHead.slice(0, 12)} → ${afterHead.slice(0, 12)}`,
    }
  }
  const afterChanges = workspaceChanges(workspace)
  const integrityIssues: string[] = []
  const outsideAfter = afterChanges.filter((path) => !path.startsWith(VERIFICATION_MATERIAL_DIR))
  if (outsideAfter.length > 0) {
    integrityIssues.push(`测试命令修改了固定候选：${outsideAfter.join('、')}`)
  }
  return {
    ok: true,
    integrityIssues,
    afterHead,
    afterChanges,
    candidateContentSha256: sha256OfText(requireGit(workspace, ['diff', 'HEAD', '--binary'])),
  }
}
