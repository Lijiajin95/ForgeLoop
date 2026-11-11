/**
 * 显式 verify 的黑盒依赖接线（ADR 0012 选项 A）。
 *
 * `service.ts` 有 token 预算上限，接线放在这里、主类只留一行展开；传 getter 是因为
 * 流水线在 `legacyVerification` 赋值前就构造。两个函数都指向连续推进的 `LegacyVerification`，
 * 保证两条入口共用同一受限测试会话。
 */
import type { VerificationPipelineDeps } from './verification-pipeline.js'

export type BlackBoxVerificationSource = Pick<
  VerificationPipelineDeps,
  'openBlackBoxSession' | 'verifyCandidateBlackBox'
>

export function blackBoxVerificationDeps(
  legacy: () => {
    readonly openVerification: VerificationPipelineDeps['openBlackBoxSession']
    readonly verifyCandidate: VerificationPipelineDeps['verifyCandidateBlackBox']
  },
): BlackBoxVerificationSource {
  return {
    openBlackBoxSession: (input) => legacy().openVerification(input),
    verifyCandidateBlackBox: (input) => legacy().verifyCandidate(input),
  }
}
