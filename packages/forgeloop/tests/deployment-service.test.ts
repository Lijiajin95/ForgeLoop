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
  calls?: string[]
}): { service: DeploymentService; requests: unknown[] } {
  const requests: unknown[] = []
  const deployments = {
    list: () => overrides.intents ?? [],
    detail: (intentId: string) => ({ intent: { intentId }, attempts: [] }),
    approve: async (intentId: string) => {
      overrides.calls?.push('approve')
      return { ok: true, code: 'ok', message: `approved ${intentId}` }
    },
    reject: (intentId: string, reason: string) => {
      overrides.calls?.push('reject')
      return { ok: true, code: 'ok', message: `rejected ${intentId}: ${reason}` }
    },
    verify: async (intentId: string) => {
      overrides.calls?.push('verify')
      return { ok: true, code: 'ok', message: `verified ${intentId}` }
    },
    rollback: async (intentId: string, reason: string) => {
      overrides.calls?.push('rollback')
      return { ok: true, code: 'ok', message: `rolled back ${intentId}: ${reason}` }
    },
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

describe('deployment service decisions and reads', () => {
  it('exposes registered targets and rollout details', () => {
    const { service: api } = service({
      intents: [{ intentId: 'dep-1', source: 'x', state: 'verified' }],
    })
    expect(api.rollouts(5).targets).toEqual([
      { id: 'target', toolId: 'tool', requirementId: 'req-1', approval: 'owner' },
    ])
    expect(api.rollout('dep-1')).toMatchObject({ intent: { intentId: 'dep-1' } })
  })

  it('rejects every owner decision from a non-owner', async () => {
    const calls: string[] = []
    const { service: api } = service({ calls })
    const attempts = [
      await api.approve({ intentId: 'dep-1', by: 'ops-agent' }),
      api.reject({ intentId: 'dep-1', by: 'ops-agent', reason: 'x' }),
      await api.verify({ intentId: 'dep-1', by: 'ops-agent' }),
      await api.rollback({ intentId: 'dep-1', by: 'ops-agent', reason: 'x' }),
    ]
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({ ok: false, code: 'forbidden' })
    }
    expect(calls).toEqual([])
  })

  it('delegates owner decisions to the coordinator', async () => {
    const calls: string[] = []
    const { service: api } = service({ calls })
    await api.approve({ intentId: 'dep-1', by: 'owner' })
    api.reject({ intentId: 'dep-1', by: 'owner', reason: '不要' })
    await api.verify({ intentId: 'dep-1', by: 'owner' })
    await api.rollback({ intentId: 'dep-1', by: 'owner', reason: '回退' })
    expect(calls).toEqual(['approve', 'reject', 'verify', 'rollback'])
  })
})
