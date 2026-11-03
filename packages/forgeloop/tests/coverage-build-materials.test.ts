import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BuildMaterialValidator, type BuildMaterialsInput } from '../src/runtime/build-materials.js'
import { sha256OfText } from '../src/domain/delivery.js'
import { candidateIdentity } from '../src/runtime/integration.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import type {
  BusinessReviewRecord,
  CodeCandidateRecord,
  RequirementCommitRecord,
  VerificationRecord,
} from '../src/records/rows.js'

const state = vi.hoisted(() => ({
  statusOutput: '',
  trackedOutput: 'a.ts\n',
  treeOutput: '',
  commitFilesOutput: '',
  candidateDiff: { code: 0, stdout: '' },
  canonicalDiff: '',
  runCode: 0,
}))

vi.mock('../src/runtime/workspace.js', () => ({
  git: () => state.candidateDiff,
  requireGit: (_cwd: string, args: readonly string[]) => {
    if (args[0] === 'status') return state.statusOutput
    if (args[0] === 'ls-files') return state.trackedOutput
    if (args[0] === 'rev-parse') return state.treeOutput
    if (args[0] === 'diff-tree') return state.commitFilesOutput
    if (args[0] === 'diff') return state.canonicalDiff
    return ''
  },
  runCommand: () => ({ code: state.runCode, stdout: '', stderr: '' }),
}))

const REQ = 'req-1'
const PLAN_VERSION = 2
const REQUIREMENT_VERSION = 3
const CANDIDATE_SHA = 'c'.repeat(64)
const WORKSPACE_SHA = 'w'.repeat(64)
const DIFF_TEXT = 'diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+export const a = 1\n'

let dir = ''
let project = ''
let validator: BuildMaterialValidator

function plan(): TaskPlan {
  return {
    taskPlanId: 'plan-1',
    requirementId: REQ,
    project: 'demo',
    planVersion: PLAN_VERSION,
    requirementVersion: REQUIREMENT_VERSION,
    tasks: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function verificationReport(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reqId: REQ,
    planVersion: PLAN_VERSION,
    requirementVersion: REQUIREMENT_VERSION,
    candidateSha256: CANDIDATE_SHA,
    workspaceSha256: WORKSPACE_SHA,
    verdict: 'pass',
    ...overrides,
  })
}

function businessReview(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reqId: REQ,
    planVersion: PLAN_VERSION,
    requirementVersion: REQUIREMENT_VERSION,
    candidateSha256: CANDIDATE_SHA,
    verificationSha256: verification.reportSha256,
    verdict: 'pass',
    ...overrides,
  })
}

function write(path: string, text: string): string {
  writeFileSync(path, text, 'utf8')
  return path
}

let verification: VerificationRecord
let review: BusinessReviewRecord
let candidate: CodeCandidateRecord

function candidateRecord(): CodeCandidateRecord {
  const diffSha256 = sha256OfText(DIFF_TEXT)
  return {
    requirementId: REQ,
    planVersion: PLAN_VERSION,
    candidateVersion: 1,
    candidateSha256: candidateIdentity({
      reqId: REQ,
      planVersion: PLAN_VERSION,
      requirementVersion: REQUIREMENT_VERSION,
      baselineCommit: 'b'.repeat(40),
      snapshotCommit: 's'.repeat(40),
      diffSha256,
    }),
    requirementVersion: REQUIREMENT_VERSION,
    baselineCommit: 'b'.repeat(40),
    snapshotCommit: 's'.repeat(40),
    diffPath: join(dir, 'candidate.diff'),
    diffSha256,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function input(overrides: Partial<BuildMaterialsInput> = {}): BuildMaterialsInput {
  return {
    reqId: REQ,
    plan: plan(),
    verification,
    review,
    commit: null,
    candidate,
    requireCommit: false,
    ...overrides,
  }
}

function rewriteVerification(text: string): void {
  write(verification.reportPath, text)
  verification = { ...verification, reportSha256: sha256OfText(text) }
  const reviewText = businessReview()
  write(review.reportPath, reviewText)
  review = {
    ...review,
    reportSha256: sha256OfText(reviewText),
    verificationSha256: verification.reportSha256,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-materials-'))
  project = join(dir, 'project')
  mkdirSync(project, { recursive: true })
  const evidenceDir = join(dir, 'evidence')
  mkdirSync(join(evidenceDir, 'workspace'), { recursive: true })
  const verificationText = verificationReport()
  const reportPath = write(join(dir, 'verification.json'), verificationText)
  write(join(dir, 'candidate.diff'), DIFF_TEXT)
  verification = {
    requirementId: REQ,
    planVersion: PLAN_VERSION,
    candidateSha256: CANDIDATE_SHA,
    requirementVersion: REQUIREMENT_VERSION,
    workspaceSha256: WORKSPACE_SHA,
    verdict: 'pass',
    reportJson: '',
    reportPath,
    reportSha256: sha256OfText(verificationText),
    evidenceDir,
    sessionId: 'session-1',
    verifiedAt: '2026-01-01T00:00:00.000Z',
  }
  const reviewText = businessReview()
  const reviewPath = write(join(dir, 'review.json'), reviewText)
  review = {
    requirementId: REQ,
    planVersion: PLAN_VERSION,
    candidateSha256: CANDIDATE_SHA,
    requirementVersion: REQUIREMENT_VERSION,
    verificationSha256: verification.reportSha256,
    verdict: 'pass',
    reportJson: '',
    reportPath: reviewPath,
    reportSha256: sha256OfText(businessReview()),
    sessionId: 'session-1',
    reviewedAt: '2026-01-01T00:00:00.000Z',
  }
  candidate = candidateRecord()
  state.statusOutput = ''
  state.trackedOutput = 'a.ts\n'
  state.treeOutput = `${WORKSPACE_SHA}\n`
  state.commitFilesOutput = 'a.ts\n'
  state.candidateDiff = { code: 0, stdout: DIFF_TEXT }
  state.canonicalDiff = DIFF_TEXT
  state.runCode = 0
  validator = new BuildMaterialValidator(project)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('build material validation', () => {
  it('accepts complete materials without a controlled commit', () => {
    const result = validator.validateBuildMaterials(input())
    expect(result).toEqual({
      ok: true,
      diffPath: candidate.diffPath,
      protectedFiles: ['a.ts'],
      workspaceSha256: WORKSPACE_SHA,
    })
  })

  it('requires the verification report file', () => {
    verification = { ...verification, reportPath: join(dir, 'missing.json') }
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'verification_invalid',
      message: expect.stringContaining('文件缺失'),
    })
  })

  it('rejects a verification report whose digest changed', () => {
    write(verification.reportPath, verificationReport({ verdict: 'block' }))
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'verification_invalid',
      message: expect.stringContaining('摘要'),
    })
  })

  it('rejects a verification report that is not JSON', () => {
    const text = '{not json'
    write(verification.reportPath, text)
    verification = { ...verification, reportSha256: sha256OfText(text) }
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'verification_invalid',
      message: expect.stringContaining('不是可解析 JSON'),
    })
  })

  it('rejects a verification report with a mismatched identity', () => {
    const text = verificationReport({ verdict: 'block' })
    write(verification.reportPath, text)
    verification = { ...verification, reportSha256: sha256OfText(text) }
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'verification_invalid',
      message: expect.stringContaining('身份不一致'),
    })
  })

  it('requires the business review file', () => {
    review = { ...review, reportPath: join(dir, 'missing-review.json') }
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'business_review_invalid',
      message: expect.stringContaining('文件缺失'),
    })
  })

  it('rejects a business review whose digest changed', () => {
    write(review.reportPath, businessReview({ verdict: 'block' }))
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'business_review_invalid',
      message: expect.stringContaining('摘要'),
    })
  })

  it('rejects a business review that is not JSON', () => {
    const text = '{not json'
    write(review.reportPath, text)
    review = { ...review, reportSha256: sha256OfText(text) }
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'business_review_invalid',
      message: expect.stringContaining('不是可解析 JSON'),
    })
  })

  it('rejects a business review with a mismatched identity', () => {
    const text = businessReview({ candidateSha256: 'd'.repeat(64) })
    write(review.reportPath, text)
    review = { ...review, reportSha256: sha256OfText(text) }
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'business_review_invalid',
      message: expect.stringContaining('身份不一致'),
    })
  })

  it('rejects a missing candidate diff file', () => {
    candidate = { ...candidate, diffPath: join(dir, 'missing.diff') }
    rmSync(join(dir, 'candidate.diff'))
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'candidate_content_mismatch',
      message: expect.stringContaining('候选 diff 文件缺失'),
    })
  })

  it('rejects a candidate diff whose digest changed', () => {
    write(candidate.diffPath, `${DIFF_TEXT}+more\n`)
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'candidate_content_mismatch',
      message: expect.stringContaining('摘要'),
    })
  })

  it('rejects a candidate whose identity no longer matches', () => {
    candidate = { ...candidate, candidateSha256: 'e'.repeat(64) }
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'candidate_identity_mismatch',
      message: expect.stringContaining('候选身份'),
    })
  })

  it('rejects a candidate bound to another plan version', () => {
    candidate = { ...candidate, planVersion: PLAN_VERSION + 1 }
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'candidate_identity_mismatch',
    })
  })

  it('requires a controlled commit when the build asks for one', () => {
    expect(validator.validateBuildMaterials(input({ requireCommit: true }))).toMatchObject({
      ok: false,
      code: 'commit_required',
    })
  })

  it('rejects a commit bound to another candidate', () => {
    const commit: RequirementCommitRecord = {
      requirementId: REQ,
      planVersion: PLAN_VERSION,
      candidateSha256: 'f'.repeat(64),
      commitSha: 'a'.repeat(40),
      commitMessage: 'feat: demo',
      checkCommand: [],
      checkLogPath: '',
      checkSha256: '',
      files: ['a.ts'],
      committedAt: '2026-01-01T00:00:00.000Z',
    }
    expect(validator.validateBuildMaterials(input({ requireCommit: true, commit }))).toMatchObject({
      ok: false,
      code: 'commit_identity_mismatch',
      message: expect.stringContaining('当前候选'),
    })
  })

  it('rejects a commit that the project does not contain', () => {
    state.runCode = 1
    const commit: RequirementCommitRecord = {
      requirementId: REQ,
      planVersion: PLAN_VERSION,
      candidateSha256: CANDIDATE_SHA,
      commitSha: 'a'.repeat(40),
      commitMessage: 'feat: demo',
      checkCommand: [],
      checkLogPath: '',
      checkSha256: '',
      files: ['a.ts'],
      committedAt: '2026-01-01T00:00:00.000Z',
    }
    expect(validator.validateBuildMaterials(input({ requireCommit: true, commit }))).toMatchObject({
      ok: false,
      code: 'commit_identity_mismatch',
      message: expect.stringContaining('不存在'),
    })
  })

  it('rejects a commit whose actual file list differs', () => {
    state.commitFilesOutput = 'b.ts\n'
    const commit: RequirementCommitRecord = {
      requirementId: REQ,
      planVersion: PLAN_VERSION,
      candidateSha256: CANDIDATE_SHA,
      commitSha: 'a'.repeat(40),
      commitMessage: 'feat: demo',
      checkCommand: [],
      checkLogPath: '',
      checkSha256: '',
      files: ['a.ts'],
      committedAt: '2026-01-01T00:00:00.000Z',
    }
    expect(validator.validateBuildMaterials(input({ requireCommit: true, commit }))).toMatchObject({
      ok: false,
      code: 'commit_identity_mismatch',
      message: expect.stringContaining('实际文件'),
    })
  })

  it('rejects a commit whose files differ from the candidate diff', () => {
    state.commitFilesOutput = 'a.ts\n'
    const commit: RequirementCommitRecord = {
      requirementId: REQ,
      planVersion: PLAN_VERSION,
      candidateSha256: CANDIDATE_SHA,
      commitSha: 'a'.repeat(40),
      commitMessage: 'feat: demo',
      checkCommand: [],
      checkLogPath: '',
      checkSha256: '',
      files: ['a.ts'],
      committedAt: '2026-01-01T00:00:00.000Z',
    }
    const diffPath = write(join(dir, 'two.diff'), `${DIFF_TEXT}+++ b/b.ts\n+export const b = 2\n`)
    candidate = {
      ...candidate,
      diffPath,
      diffSha256: sha256OfText(`${DIFF_TEXT}+++ b/b.ts\n+export const b = 2\n`),
      candidateSha256: candidateIdentity({
        reqId: REQ,
        planVersion: PLAN_VERSION,
        requirementVersion: REQUIREMENT_VERSION,
        baselineCommit: candidate.baselineCommit,
        snapshotCommit: candidate.snapshotCommit,
        diffSha256: sha256OfText(`${DIFF_TEXT}+++ b/b.ts\n+export const b = 2\n`),
      }),
    }
    state.candidateDiff = {
      code: 0,
      stdout: candidate.diffSha256 === '' ? '' : `${DIFF_TEXT}+++ b/b.ts\n+export const b = 2\n`,
    }
    expect(validator.validateBuildMaterials(input({ requireCommit: true, commit }))).toMatchObject({
      ok: false,
      code: 'commit_identity_mismatch',
      message: expect.stringContaining('候选 diff 文件'),
    })
  })

  it('accepts a controlled commit that matches the candidate', () => {
    const commit: RequirementCommitRecord = {
      requirementId: REQ,
      planVersion: PLAN_VERSION,
      candidateSha256: CANDIDATE_SHA,
      commitSha: 'a'.repeat(40),
      commitMessage: 'feat: demo',
      checkCommand: [],
      checkLogPath: '',
      checkSha256: '',
      files: ['a.ts'],
      committedAt: '2026-01-01T00:00:00.000Z',
    }
    expect(validator.validateBuildMaterials(input({ requireCommit: true, commit }))).toMatchObject({
      ok: true,
    })
  })

  it('requires the verification workspace', () => {
    rmSync(join(verification.evidenceDir, 'workspace'), { recursive: true, force: true })
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'verification_workspace_missing',
    })
  })

  it('rejects a workspace whose HEAD tree changed', () => {
    state.treeOutput = `${'x'.repeat(64)}\n`
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'verification_workspace_invalid',
    })
  })

  it('rejects protected changes left in the verification workspace', () => {
    state.statusOutput = ' M a.ts\n?? verification/raw.txt\n'
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'candidate_content_mismatch',
      message: expect.stringContaining('受保护改动'),
    })
  })

  it('rejects a candidate workspace diff that cannot be read', () => {
    state.candidateDiff = { code: 1, stdout: '' }
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'candidate_content_mismatch',
      message: expect.stringContaining('候选内容'),
    })
  })

  it('rejects a candidate workspace diff with another digest', () => {
    state.candidateDiff = { code: 0, stdout: 'other\n' }
    expect(validator.validateBuildMaterials(input())).toMatchObject({
      ok: false,
      code: 'candidate_content_mismatch',
      message: expect.stringContaining('候选内容'),
    })
  })

  it('accepts a legacy verification workspace with matching protected content', () => {
    const text = verificationReport({
      candidateIntegrity: { candidateContentSha256: sha256OfText(DIFF_TEXT) },
    })
    rewriteVerification(text)
    expect(validator.validateBuildMaterials(input({ candidate: null }))).toMatchObject({ ok: true })
  })

  it('rejects a legacy verification workspace with changed protected content', () => {
    const text = verificationReport({
      candidateIntegrity: { candidateContentSha256: 'z'.repeat(64) },
    })
    rewriteVerification(text)
    expect(validator.validateBuildMaterials(input({ candidate: null }))).toMatchObject({
      ok: false,
      code: 'candidate_content_mismatch',
      message: expect.stringContaining('受保护内容'),
    })
  })

  it('accepts a legacy verification workspace without recorded content', () => {
    expect(validator.validateBuildMaterials(input({ candidate: null }))).toMatchObject({ ok: true })
  })
})
