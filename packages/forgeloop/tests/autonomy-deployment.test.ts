import { describe, expect, it } from 'vitest'
import { matchesCandidateArtifact } from '../src/runtime/autonomy-stats.js'

const build = { artifactSha256: 'sha-current' }

describe('deployment matches the current candidate', () => {
  it('does not count when nothing was deployed', () => {
    expect(matchesCandidateArtifact([], build)).toBe(false)
  })

  it('does not count an old artifact that is still verified', () => {
    expect(
      matchesCandidateArtifact([{ state: 'verified', artifactSha256: 'sha-old' }], build),
    ).toBe(false)
  })

  it('counts only a verified deployment of the current artifact', () => {
    expect(
      matchesCandidateArtifact(
        [
          { state: 'verified', artifactSha256: 'sha-old' },
          { state: 'verified', artifactSha256: 'sha-current' },
        ],
        build,
      ),
    ).toBe(true)
  })

  it('does not count a current artifact that is not verified yet', () => {
    expect(
      matchesCandidateArtifact(
        [{ state: 'applied_pending_verify', artifactSha256: 'sha-current' }],
        build,
      ),
    ).toBe(false)
  })

  it('does not count when there is no build at all', () => {
    expect(
      matchesCandidateArtifact([{ state: 'verified', artifactSha256: 'sha-current' }], null),
    ).toBe(false)
  })
})
