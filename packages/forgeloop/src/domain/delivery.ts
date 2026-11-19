import { createHash } from 'node:crypto'

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function candidateIdentityOf(input: {
  readonly planVersion: number
  readonly requirementVersion: number
  readonly baselineCommit: string
  readonly candidateHashes: readonly string[]
}): string {
  return sha256OfText(
    JSON.stringify({
      planVersion: input.planVersion,
      requirementVersion: input.requirementVersion,
      baselineCommit: input.baselineCommit,
      candidateHashes: input.candidateHashes,
    }),
  )
}
