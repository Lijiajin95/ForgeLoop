import type { VerificationReport } from '../domain/verification.js'
import {
  candidateIntegrityFacts,
  decideVerificationOutcome,
} from '../domain/verification-outcome.js'
import { sha256OfText } from '../domain/delivery.js'
import { requireGit } from './workspace.js'
import { VERIFICATION_MATERIAL_DIR, workspaceChanges } from './service-helpers.js'

/**
 * 显式 `verify` / 任务包推进用的判定适配：把采集到的报告转换成共用判定函数的输入。
 * 判定规则本身在 `domain/verification-outcome.ts`，与连续推进入口共用同一份。
 */
export function verificationVerdict(input: {
  report: VerificationReport
  failedCommands: readonly string[]
  coverageIssues: readonly string[]
  evidenceIssues: readonly string[]
  integrityIssues: readonly string[]
  controlIssues?: readonly string[]
}): { verdict: 'pass' | 'block'; blocking: string[] } {
  return decideVerificationOutcome({
    reportedPassed: input.report.verdict === 'pass',
    blocking: input.report.blocking,
    scenarioFailed: input.report.scenarios.some((scenario) => scenario.status === 'fail'),
    failedCommands: input.failedCommands,
    coverageIssues: input.coverageIssues,
    evidenceIssues: input.evidenceIssues,
    integrityIssues: input.integrityIssues,
    controlIssues: input.controlIssues ?? [],
  })
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
  const facts = candidateIntegrityFacts({
    expectedHead: workspaceHead,
    actualHead: afterHead,
    changes: afterChanges,
    allowedPrefix: VERIFICATION_MATERIAL_DIR,
  })
  const integrityIssues: string[] = []
  if (facts.outside.length > 0) {
    integrityIssues.push(`测试命令修改了固定候选：${facts.outside.join('、')}`)
  }
  return {
    ok: true,
    integrityIssues,
    afterHead,
    afterChanges,
    candidateContentSha256: sha256OfText(requireGit(workspace, ['diff', 'HEAD', '--binary'])),
  }
}
