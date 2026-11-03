import { describe, expect, it } from 'vitest'
import { DeploymentService } from '../src/runtime/deployment-service.js'
import type { Deployments } from '../src/runtime/deployments.js'
import type { Repository } from '../src/records/repository.js'
import type { ForgeLoopConfig } from '../src/config.js'

const BUILD = {
  reqId: 'req-1',
  planVersion: 1,
  candidateSha256: 'c'.repeat(64),
  verificationSha256: 'v'.repeat(64),
  packageVersion: '1.2.3',
  artifactSha256: 'a'.repeat(64),
  tarball: '/tmp/pkg.tgz',
  files: [],
  gitHead: 'h',
  builtAt: '2026-11-04T00:00:00.000Z',
  evidenceDir: '/tmp/evidence',
}

function service(overrides: {
  intents?: Array<{ intentId: string; source: string; state: string }>
  request?: (input: unknown) => Promise<unknown>
  build?: typeof BUILD | null
}): { service: DeploymentService; requests: unknown[] } {
  const requests: unknown[] = []
  const deployments = {
    list: () => overrides.intents ?? [],
    request: async (input: unknown) => {
      requests.push(input)
      return overrides.request
        ? await overrides.request(input)
        : { ok: true, code: 'ok', message: 'requested', data: { intentId: 'dep-1' } }
    },
  } as unknown as Deployments
  const repo = {
    latestCandidateBuild: () => (overrides.build === undefined ? BUILD : overrides.build),
  } as unknown as Repository
  const config = {
    owner: 'owner',
    deployments: {
      targets: [{ id: 'target', toolId: 'tool', requirementId: 'req-1', approval: 'owner' }],
    },
  } as unknown as ForgeLoopConfig
  return {
    service: new DeploymentService({ config, repo, deployments }),
    requests,
  }
}

describe('deployment service intent', () => {
  it('resolves the latest candidate build of the target requirement', async () => {
    const { service: api, requests } = service({})
    const result = await api.request({ targetId: 'target', by: 'owner', source: 'web:1' })
    expect(result.ok).toBe(true)
    expect(requests).toEqual([
      {
        targetId: 'target',
        artifact: {
          sha256: BUILD.artifactSha256,
          path: BUILD.tarball,
          version: BUILD.packageVersion,
        },
        source: 'web:1',
      },
    ])
  })

  it('is idempotent for the same source while an intent is still open', async () => {
    const { service: api, requests } = service({
      intents: [{ intentId: 'dep-old', source: 'ops:evt-1', state: 'awaiting_approval' }],
    })
    const result = await api.request({ targetId: 'target', by: 'ops-agent', source: 'ops:evt-1' })
    expect(result).toMatchObject({ ok: true, code: 'duplicate' })
    expect(result.data).toMatchObject({ intentId: 'dep-old', duplicate: true })
    expect(requests).toHaveLength(0)
  })

  it('reports a missing candidate build instead of calling the coordinator', async () => {
    const { service: api, requests } = service({ build: null })
    const result = await api.request({ targetId: 'target', by: 'owner', source: 'web:2' })
    expect(result).toMatchObject({ ok: false, code: 'not_found' })
    expect(requests).toHaveLength(0)
  })
})
