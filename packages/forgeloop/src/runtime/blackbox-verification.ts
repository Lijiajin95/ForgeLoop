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
