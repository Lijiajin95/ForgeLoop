import { parseJsonObject } from '../domain/json.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BusinessReviewRecord,
  CodeCandidateRecord,
  RequirementCommitRecord,
  VerificationRecord,
} from '../records/repository.js'
import type { TaskPlan } from '../domain/task-plan.js'
import { candidateIdentity } from './integration.js'
import { git, requireGit, runCommand } from './workspace.js'
import { VERIFICATION_MATERIAL_DIR } from './service-helpers.js'
import { sha256OfText } from '../domain/delivery.js'

export interface BuildMaterialsInput {
  readonly reqId: string
  readonly plan: TaskPlan
  readonly verification: VerificationRecord
  readonly review: BusinessReviewRecord
  readonly commit: RequirementCommitRecord | null
  readonly candidate: CodeCandidateRecord | null
  readonly requireCommit: boolean
}

export type BuildMaterialCheck<T> =
  { ok: true; value: T } | { ok: false; code: string; message: string }

export type BuildMaterialsResult =
  | { ok: true; diffPath: string; protectedFiles: string[]; workspaceSha256: string }
  | { ok: false; code: string; message: string }

function outsideWorkspaceChanges(source: string): string[] {
  return requireGit(source, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== '' && !path.startsWith(VERIFICATION_MATERIAL_DIR))
}

function listTrackedFiles(source: string): string[] {
  return requireGit(source, ['ls-files'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 构建材料核验：只读取证据，不改写历史。 */
export class BuildMaterialValidator {
  constructor(private readonly projectPath: string) {}

  private failure(code: string, message: string): { ok: false; code: string; message: string } {
    return { ok: false, code, message }
  }

  validateBuildMaterials(input: BuildMaterialsInput): BuildMaterialsResult {
    const verification = this.checkVerificationMaterial(input)
    if (!verification.ok) return verification
    const review = this.checkBusinessReviewMaterial(input)
    if (!review.ok) return review
    const candidate = this.checkCandidateMaterial(input)
    if (!candidate.ok) return candidate
    const commit = this.checkCommitMaterial(input, candidate.value.diffNames)
    if (!commit.ok) return commit
    const workspace = this.checkVerificationWorkspace(input, verification.value.canonical)
    if (!workspace.ok) return workspace
    return {
      ok: true,
      diffPath: candidate.value.diffPath,
      protectedFiles: workspace.value.protectedFiles,
      workspaceSha256: workspace.value.workspaceSha256,
    }
  }

  private checkVerificationMaterial(
    input: BuildMaterialsInput,
  ): BuildMaterialCheck<{ canonical: Record<string, unknown> }> {
    const { verification, plan } = input
    if (!existsSync(verification.reportPath)) {
      return this.failure('verification_invalid', '独立验证报告文件缺失；不能构建')
    }
    const reportText = readFileSync(verification.reportPath, 'utf8')
    if (sha256OfText(reportText) !== verification.reportSha256) {
      return this.failure('verification_invalid', '独立验证报告摘要与登记不一致；不能构建')
    }
    let canonical: Record<string, unknown>
    try {
      canonical = parseJsonObject(reportText)
    } catch {
      return this.failure('verification_invalid', '独立验证报告不是可解析 JSON；不能构建')
    }
    const canonicalCandidate =
      typeof canonical.candidateSha256 === 'string' ? canonical.candidateSha256 : ''
    const mismatch =
      canonical.reqId !== input.reqId ||
      canonical.planVersion !== plan.planVersion ||
      canonical.requirementVersion !== plan.requirementVersion ||
      canonicalCandidate !== verification.candidateSha256 ||
      canonical.workspaceSha256 !== verification.workspaceSha256 ||
      canonical.verdict !== 'pass'
    if (mismatch) {
      return this.failure(
        'verification_invalid',
        '独立验证报告的候选、需求、方案或工作区身份不一致；不能构建',
      )
    }
    return { ok: true, value: { canonical } }
  }

  private checkBusinessReviewMaterial(input: BuildMaterialsInput): BuildMaterialCheck<null> {
    const { review, verification, plan } = input
    if (!existsSync(review.reportPath)) {
      return this.failure('business_review_invalid', '业务验收报告文件缺失；不能构建')
    }
    const reviewText = readFileSync(review.reportPath, 'utf8')
    if (sha256OfText(reviewText) !== review.reportSha256) {
      return this.failure('business_review_invalid', '业务验收报告摘要与登记不一致；不能构建')
    }
    let reviewCanonical: Record<string, unknown>
    try {
      reviewCanonical = parseJsonObject(reviewText)
    } catch {
      return this.failure('business_review_invalid', '业务验收报告不是可解析 JSON；不能构建')
    }
    const mismatch =
      reviewCanonical.reqId !== input.reqId ||
      reviewCanonical.planVersion !== plan.planVersion ||
      reviewCanonical.requirementVersion !== plan.requirementVersion ||
      reviewCanonical.candidateSha256 !== verification.candidateSha256 ||
      reviewCanonical.verificationSha256 !== verification.reportSha256 ||
      reviewCanonical.verdict !== 'pass'
    if (mismatch) {
      return this.failure('business_review_invalid', '业务验收报告与验证/候选身份不一致；不能构建')
    }
    return { ok: true, value: null }
  }

  private checkCandidateMaterial(
    input: BuildMaterialsInput,
  ): BuildMaterialCheck<{ diffPath: string; diffNames: string[] }> {
    const { candidate, verification, plan } = input
    let diffPath = ''
    let diffNames: string[] = []
    if (candidate) {
      diffPath = existsSync(candidate.diffPath)
        ? candidate.diffPath
        : join(verification.evidenceDir, 'candidate.diff')
      if (!existsSync(diffPath)) {
        return this.failure('candidate_content_mismatch', '候选 diff 文件缺失；不能构建')
      }
      const diffText = readFileSync(diffPath, 'utf8')
      if (sha256OfText(diffText) !== candidate.diffSha256) {
        return this.failure('candidate_content_mismatch', '候选 diff 摘要与登记不一致；不能构建')
      }
      const recomputed = candidateIdentity({
        reqId: candidate.requirementId,
        planVersion: candidate.planVersion,
        requirementVersion: candidate.requirementVersion,
        baselineCommit: candidate.baselineCommit,
        snapshotCommit: candidate.snapshotCommit,
        diffSha256: candidate.diffSha256,
      })
      if (recomputed !== candidate.candidateSha256 || candidate.planVersion !== plan.planVersion) {
        return this.failure(
          'candidate_identity_mismatch',
          '候选身份与需求/方案绑定不一致；不能构建',
        )
      }
      diffNames = [...diffText.matchAll(/^\+\+\+ b\/([^\n]+)$/gm)].map((match) => match[1]!)
    }
    return { ok: true, value: { diffPath, diffNames } }
  }

  private checkCommitMaterial(
    input: BuildMaterialsInput,
    diffNames: readonly string[],
  ): BuildMaterialCheck<null> {
    if (!input.requireCommit) return { ok: true, value: null }
    const { commit, candidate, verification, plan } = input
    if (!commit || commit.commitSha === '') {
      return this.failure('commit_required', '候选尚未受控提交；不能构建')
    }
    if (
      commit.requirementId !== input.reqId ||
      commit.planVersion !== plan.planVersion ||
      commit.candidateSha256 !== verification.candidateSha256
    ) {
      return this.failure(
        'commit_identity_mismatch',
        '受控提交与当前候选/需求/方案不一致；不能构建',
      )
    }
    const commitExists = runCommand(
      'git',
      ['cat-file', '-e', `${commit.commitSha}^{commit}`],
      this.projectPath,
      30_000,
    )
    if (commitExists.code !== 0) {
      return this.failure(
        'commit_identity_mismatch',
        `受控提交 ${commit.commitSha.slice(0, 12)} 在真实项目中不存在；不能构建`,
      )
    }
    const commitFiles = requireGit(this.projectPath, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      commit.commitSha,
    ])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .sort()
    const expectedFiles = [...commit.files].sort()
    if (JSON.stringify(commitFiles) !== JSON.stringify(expectedFiles)) {
      return this.failure(
        'commit_identity_mismatch',
        '受控提交的实际文件与登记文件不一致；不能构建',
      )
    }
    if (candidate && JSON.stringify(expectedFiles) !== JSON.stringify([...diffNames].sort())) {
      return this.failure(
        'commit_identity_mismatch',
        '受控提交文件与候选 diff 文件不一致；不能构建',
      )
    }
    return { ok: true, value: null }
  }

  private checkVerificationWorkspace(
    input: BuildMaterialsInput,
    canonical: Record<string, unknown>,
  ): BuildMaterialCheck<{ protectedFiles: string[]; workspaceSha256: string }> {
    const { verification } = input
    const source = join(verification.evidenceDir, 'workspace')
    if (!existsSync(source)) {
      return this.failure('verification_workspace_missing', `独立验证工作区不存在：${source}`)
    }
    const tree = requireGit(source, ['rev-parse', 'HEAD^{tree}']).trim()
    if (tree !== verification.workspaceSha256) {
      return this.failure(
        'verification_workspace_invalid',
        '独立验证工作区的 HEAD 树与验证记录不一致；不能构建',
      )
    }
    const outside = outsideWorkspaceChanges(source)
    if (outside.length > 0) {
      return this.failure(
        'candidate_content_mismatch',
        `独立验证工作区在验证后出现了受保护改动：${outside.join('、')}`,
      )
    }
    const contentMismatch = this.workspaceCandidateMismatch(source, input.candidate, canonical)
    if (contentMismatch !== null) return contentMismatch
    return { ok: true, value: { protectedFiles: listTrackedFiles(source), workspaceSha256: tree } }
  }

  private workspaceCandidateMismatch(
    source: string,
    candidate: CodeCandidateRecord | null,
    canonical: Record<string, unknown>,
  ): { ok: false; code: string; message: string } | null {
    if (candidate) {
      const applied = git(source, ['diff', `${candidate.snapshotCommit}..HEAD`, '--binary'])
      if (applied.code !== 0 || sha256OfText(applied.stdout) !== candidate.diffSha256) {
        return this.failure(
          'candidate_content_mismatch',
          '验证工作区的候选内容与候选 diff 不一致；不能构建',
        )
      }
      return null
    }
    const recordedContent = (
      canonical.candidateIntegrity as { candidateContentSha256?: unknown } | undefined
    )?.candidateContentSha256
    if (typeof recordedContent !== 'string') return null
    const actual = requireGit(source, ['diff', 'HEAD', '--binary'])
    if (sha256OfText(actual) === recordedContent) return null
    return this.failure(
      'candidate_content_mismatch',
      '验证工作区的受保护内容与验证记录不一致；不能构建',
    )
  }
}
