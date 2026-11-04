import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CandidatePipeline } from '../src/runtime/candidate-pipeline.js'
import { resolveConfig } from '../src/config.js'

const NOW = '2026-11-04T00:00:00.000Z'

function pipeline(overrides: Record<string, unknown> = {}) {
  const config = resolveConfig({
    project: 'demo',
    projectPath: '/tmp/demo',
    recordsRoot: '/tmp/demo/.forgeloop',
    candidateBuildCommand: ['node'],
    candidatePackageCommand: ['node'],
    candidateArtifactPath: 'artifact.json',
  })
  const deps = {
    config,
    repo: {},
    now: () => NOW,
    validateBuildMaterials: () => ({ ok: true }),
    requireAuthorizedPlan: () => ({ ok: true, value: { plan: {} } }),
    currentAdmission: () => ({ admissionId: 'a' }),
    candidateIdentity: () => 'identity',
    statusBoard: () => ({}),
    ...overrides,
  }
  return new CandidatePipeline(deps as never)
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    plan: { planVersion: 1 },
    candidate: { candidateSha256: 'c'.repeat(64) },
    verification: { verdict: 'pass', reportSha256: 'r'.repeat(64) },
    review: { verdict: 'pass' },
    commit: { commitSha: 's'.repeat(40) },
    ...overrides,
  }
}

describe('candidate build readiness', () => {
  it('requires passing verification and business review', () => {
    const p = pipeline()
    expect(p['buildReadiness'](delivery({ candidate: null }) as never, undefined)).toMatchObject({
      ok: false,
      code: 'verification_required',
      message: '候选没有通过的独立验证；不能构建',
    })
    expect(
      p['buildReadiness'](delivery({ verification: { verdict: 'block' } }) as never, undefined),
    ).toMatchObject({
      code: 'verification_required',
    })
    expect(p['buildReadiness'](delivery({ review: null }) as never, undefined)).toMatchObject({
      code: 'business_review_required',
      message: '候选没有通过的业务验收；不能构建',
    })
    expect(
      p['buildReadiness'](delivery({ review: { verdict: 'block' } }) as never, undefined),
    ).toMatchObject({
      code: 'business_review_required',
    })
  })

  it('requires configured build/package commands and artifact path', () => {
    const config = resolveConfig({
      projectPath: '/tmp/demo',
      recordsRoot: '/tmp/demo/.forgeloop',
      candidateBuildCommand: [],
    })
    const p = new CandidatePipeline({ config } as never)
    expect(p['buildReadiness'](delivery() as never, undefined)).toMatchObject({
      code: 'candidate_not_configured',
      message: '未配置 candidateBuildCommand / candidatePackageCommand / candidateArtifactPath',
    })
  })

  it('validates optional candidate versions', () => {
    const p = pipeline()
    expect(p['buildReadiness'](delivery() as never, undefined)).toBeNull()
    expect(p['buildReadiness'](delivery() as never, '1.2.3')).toBeNull()
    expect(p['buildReadiness'](delivery() as never, '1.2')).toMatchObject({
      code: 'version_invalid',
      message: '候选版本必须是 x.y.z，实际 "1.2"',
    })
    expect(p['buildReadiness'](delivery() as never, '1.2.3.4')).toMatchObject({
      code: 'version_invalid',
    })
    expect(p['buildReadiness'](delivery() as never, '1.2.3-beta')).toMatchObject({
      code: 'version_invalid',
    })
  })
})

describe('admitted delivery lookup', () => {
  it('requires an admission before listing plans', () => {
    const p = pipeline({ currentAdmission: () => null })
    expect(p['admittedDelivery']('req-1')).toBeNull()
  })

  it('scans plans newest first and returns the first with a candidate', () => {
    const calls: number[] = []
    const p = pipeline({
      repo: {
        taskPlans: () => [{ planVersion: 1 }, { planVersion: 2 }],
        latestCodeCandidate: (_req: string, version: number) => {
          calls.push(version)
          return version === 1 ? { candidateSha256: 'c'.repeat(64) } : null
        },
        verificationForCandidate: () => ({ verdict: 'pass' }),
        businessReviewForCandidate: () => ({ verdict: 'pass' }),
        commitForCandidate: () => ({ commitSha: 's' }),
      },
    })
    expect(p['admittedDelivery']('req-1')).toMatchObject({ plan: { planVersion: 1 } })
    expect(calls).toEqual([2, 1])
    const none = pipeline({
      repo: {
        taskPlans: () => [{ planVersion: 1 }],
        latestCodeCandidate: () => null,
        verificationForCandidate: () => null,
        businessReviewForCandidate: () => null,
        commitForCandidate: () => null,
      },
    })
    expect(none['admittedDelivery']('req-1')).toBeNull()
  })
})

describe('protected file hashing', () => {
  it('hashes existing files, marks missing ones empty and reports changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeloop-candidate-gap-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'a')
      const p = pipeline()
      const hashes = p['protectedFileHashes'](dir, ['a.txt', 'missing.txt'])
      expect(hashes.get('a.txt')).toMatch(/^[0-9a-f]{64}$/)
      expect(hashes.get('missing.txt')).toBe('')
      expect(p['protectedFilesChanged'](dir, hashes, [])).toEqual([])
      writeFileSync(join(dir, 'a.txt'), 'changed')
      expect(p['protectedFilesChanged'](dir, hashes, [])).toEqual(['a.txt'])
      expect(p['protectedFilesChanged'](dir, hashes, ['a.txt'])).toEqual([])
      expect(p['protectedFilesChanged'](dir, hashes, ['a.txt', 'missing.txt'])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('build entry failures', () => {
  it('reports a missing candidate before touching materials', () => {
    const p = pipeline({ currentAdmission: () => null })
    expect(p['buildAdmittedCandidate']({ reqId: 'req-1', by: 'owner' })).toMatchObject({
      ok: false,
      code: 'candidate_missing',
      message: '需求 req-1 没有可构建的新链路候选',
    })
  })

  it('propagates material validation failures', () => {
    const p = pipeline({
      validateBuildMaterials: () => ({
        ok: false,
        code: 'material_mismatch',
        message: '材料不一致',
      }),
      repo: {
        taskPlans: () => [{ planVersion: 1 }],
        latestCodeCandidate: () => ({ candidateSha256: 'c'.repeat(64) }),
        verificationForCandidate: () => ({ verdict: 'pass', reportSha256: 'r'.repeat(64) }),
        businessReviewForCandidate: () => ({ verdict: 'pass' }),
        commitForCandidate: () => ({ commitSha: 's' }),
      },
    })
    expect(p['buildAdmittedCandidate']({ reqId: 'req-1', by: 'owner' })).toMatchObject({
      ok: false,
      code: 'material_mismatch',
      message: '材料不一致',
    })
  })
})
