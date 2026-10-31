import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import type { AdmissionDecision } from '../src/domain/admission.js'

/**
 * 需求详情中的只读证据：
 * - admission 是最近一次系统准入的 decision/code/reason/createdAt；
 * - commit 是最近一次受控提交的 commitSha/files/committedAt；
 * - 无记录时两组字段都为 null，旧需求不报错。
 */

interface AdmissionEvidenceView {
  readonly decision: 'admit' | 'block'
  readonly code: string
  readonly reason: string
  readonly createdAt: string
}

interface CommitEvidenceView {
  readonly commitSha: string
  readonly files: readonly string[]
  readonly committedAt: string
}

interface RequirementDetailView {
  readonly admission: AdmissionEvidenceView | null
  readonly commit: CommitEvidenceView | null
  readonly latestPlan: unknown
  readonly artifacts: unknown[]
}

let dir = ''
let runtime: ForgeLoopRuntime

function makeRuntime(): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config })
}

function submitRequirement(): string {
  const submitted = runtime.submit({ text: '需求详情证据', by: 'owner', source: 'test' })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

function detail(reqId: string): RequirementDetailView {
  const result = runtime.requirementDetail(reqId)
  expect(result.ok, result.message).toBe(true)
  return result.data as RequirementDetailView
}

function admissionDecision(
  admit: boolean,
  code: string,
  reason: string,
): AdmissionDecision {
  return {
    admit,
    code,
    reason,
    basis: {
      policyVersion: 'test-policy',
      source: 'test',
      submittedBy: 'owner',
      owner: 'owner',
      project: 'testproj',
      projectPath: dir,
      requirementVersion: 1,
      analysisVersion: 1,
      trustedSource: true,
      codeCommitAllowed: admit,
    },
  }
}

function recordAdmission(
  reqId: string,
  admit: boolean,
  code: string,
  reason: string,
  createdAt: string,
): void {
  runtime.repo.recordAdmission({
    requirementId: reqId,
    requirementVersion: 1,
    decision: admissionDecision(admit, code, reason),
    decidedBy: 'system',
    createdAt,
  })
}

function recordCommit(
  reqId: string,
  commitSha: string,
  files: readonly string[],
  committedAt: string,
): void {
  runtime.repo.recordCommit({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: `candidate-${commitSha}`,
    commitSha,
    commitMessage: `commit ${commitSha}`,
    checkCommand: ['npx', 'vitest', 'run'],
    checkLogPath: `/tmp/${commitSha}.log`,
    checkSha256: `check-${commitSha}`,
    files,
    committedAt,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-detail-evidence-'))
  runtime = makeRuntime()
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('requirement detail admission and commit evidence', () => {
  it('returns null for both evidence fields when the requirement has no records', () => {
    const reqId = submitRequirement()

    const view = detail(reqId)

    expect('admission' in view).toBe(true)
    expect('commit' in view).toBe(true)
    expect(view.admission).toBeNull()
    expect(view.commit).toBeNull()
    expect(view.latestPlan).toBeNull()
    expect(view.artifacts).toEqual([])
  })

  it('maps the recorded system admission and keeps commit null when no commit exists', () => {
    const reqId = submitRequirement()
    recordAdmission(reqId, true, 'admitted', '可信来源与需求说明齐备', '2026-10-31T02:00:00.000Z')

    const view = detail(reqId)

    expect(view.admission).toEqual({
      decision: 'admit',
      code: 'admitted',
      reason: '可信来源与需求说明齐备',
      createdAt: '2026-10-31T02:00:00.000Z',
    })
    expect(view.commit).toBeNull()
  })

  it('maps the recorded controlled commit and keeps admission null when no admission exists', () => {
    const reqId = submitRequirement()
    recordCommit(reqId, 'abc1234', ['packages/forgeloop/src/a.ts'], '2026-10-31T03:00:00.000Z')

    const view = detail(reqId)

    expect(view.admission).toBeNull()
    expect(view.commit).toEqual({
      commitSha: 'abc1234',
      files: ['packages/forgeloop/src/a.ts'],
      committedAt: '2026-10-31T03:00:00.000Z',
    })
  })

  it('returns only the most recent admission when a requirement has several', () => {
    const reqId = submitRequirement()
    recordAdmission(reqId, true, 'latest', '最近一次准入', '2026-10-31T03:00:00.000Z')
    recordAdmission(reqId, false, 'terminal', '最早一次准入', '2026-10-31T01:00:00.000Z')
    recordAdmission(reqId, false, 'analysis_stale', '中间一次准入', '2026-10-31T02:00:00.000Z')

    const view = detail(reqId)

    expect(view.admission).toEqual({
      decision: 'admit',
      code: 'latest',
      reason: '最近一次准入',
      createdAt: '2026-10-31T03:00:00.000Z',
    })
  })

  it('maps a block decision without turning it into an admission', () => {
    const reqId = submitRequirement()
    recordAdmission(reqId, true, 'admitted', '较早的准入', '2026-10-31T01:00:00.000Z')
    recordAdmission(reqId, false, 'terminal', '需求已处于终态 accepted', '2026-10-31T04:00:00.000Z')

    const view = detail(reqId)

    expect(view.admission).toEqual({
      decision: 'block',
      code: 'terminal',
      reason: '需求已处于终态 accepted',
      createdAt: '2026-10-31T04:00:00.000Z',
    })
  })

  it('returns only the most recent commit when a requirement has several', () => {
    const reqId = submitRequirement()
    recordCommit(reqId, 'newest1', ['docs/new.md'], '2026-10-31T03:00:00.000Z')
    recordCommit(reqId, 'oldest1', ['docs/old.md'], '2026-10-31T01:00:00.000Z')
    recordCommit(reqId, 'middle1', ['docs/mid.md'], '2026-10-31T02:00:00.000Z')

    const view = detail(reqId)

    expect(view.commit).toEqual({
      commitSha: 'newest1',
      files: ['docs/new.md'],
      committedAt: '2026-10-31T03:00:00.000Z',
    })
  })

  it('returns both evidence groups together for a requirement with records', () => {
    const reqId = submitRequirement()
    recordAdmission(reqId, true, 'admitted', '准入通过', '2026-10-31T01:00:00.000Z')
    recordCommit(reqId, 'feed123', ['a.ts', 'b.ts'], '2026-10-31T02:00:00.000Z')

    const view = detail(reqId)

    expect(view.admission).toMatchObject({ decision: 'admit', code: 'admitted' })
    expect(view.commit).toMatchObject({ commitSha: 'feed123', files: ['a.ts', 'b.ts'] })
  })
})
