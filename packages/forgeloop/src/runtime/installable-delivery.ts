import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { deliveryDir } from '../config.js'
import { sha256OfText } from '../domain/delivery.js'
import { errorMessage } from '../domain/errors.js'
import {
  evaluateInstallableDelivery,
  installInstructionsOf,
  type DeliveryCommit,
  type DeliveryEvidence,
  type DeliveryInstructions,
  type DeliveryPackage,
  type DeliveryTrial,
} from '../domain/installable-delivery.js'
import type { InstallableDeliveryRecord } from '../records/installable-delivery-store.js'
import type { Repository } from '../records/repository.js'
import { fail, ok, type OperationResult } from './operation-result.js'

export interface InstallableDeliveryDeps {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly now: () => string
}

type CommitRecord = NonNullable<ReturnType<Repository['latestCommit']>>
type BuildRecord = NonNullable<ReturnType<Repository['candidateBuild']>>
type VerificationRecord = NonNullable<ReturnType<Repository['verification']>>
type ReviewRecord = NonNullable<ReturnType<Repository['businessReviewForCandidate']>>

function commitOf(record: CommitRecord): DeliveryCommit {
  return {
    commitSha: record.commitSha,
    commitMessage: record.commitMessage,
    committedAt: record.committedAt,
  }
}

function packageOf(build: BuildRecord): DeliveryPackage {
  return {
    packageVersion: build.packageVersion,
    tarball: build.tarball,
    artifactSha256: build.artifactSha256,
    builtAt: build.builtAt,
  }
}

function verificationOf(record: VerificationRecord): DeliveryEvidence {
  return { verdict: record.verdict, sha256: record.reportSha256, at: record.verifiedAt }
}

function reviewOf(record: ReviewRecord): DeliveryEvidence {
  return { verdict: record.verdict, sha256: record.reportSha256, at: record.reviewedAt }
}

/** 试装证据与其候选身份；候选为空表示证据来自外部部署工具（intent 不含候选）。 */
interface TrialEvidence {
  readonly trial: DeliveryTrial
  readonly candidateSha256: string
}

function trialEvidenceOf(
  deps: InstallableDeliveryDeps,
  reqId: string,
  planVersion: number,
): TrialEvidence | null {
  const deployment = deps.repo.deployment(reqId, planVersion)
  if (deployment && deployment.state === 'verified') {
    return {
      candidateSha256: deployment.candidateSha256,
      trial: {
        targetId: deployment.targetProfile,
        artifactSha256: deployment.artifactSha256,
        runtimeVersion: deployment.runtimeVersion,
        state: deployment.state,
        verifiedAt: deployment.recordedAt,
      },
    }
  }
  const intent = deps.repo.deploymentStore
    .deploymentIntents(200)
    .find((entry) => entry.requirementId === reqId && entry.state === 'verified')
  if (!intent) return null
  return {
    candidateSha256: '',
    trial: {
      targetId: intent.targetId,
      artifactSha256: intent.artifactSha256,
      runtimeVersion: intent.artifactVersion,
      state: intent.state,
      verifiedAt: intent.updatedAt,
    },
  }
}

function bindingProblem(input: {
  commitCandidate: string
  buildCandidate: string
  buildVerification: string
  verificationCandidate: string
  reviewCandidate: string
  reviewVerification: string
}): string {
  if (input.buildCandidate !== input.commitCandidate) return '安装包不是该受控提交的候选构建产物'
  if (input.verificationCandidate !== input.commitCandidate) return '测试结论不是该候选的测试'
  if (input.reviewCandidate !== input.commitCandidate) return '业务验收结论不是该候选的验收'
  if (input.reviewVerification !== input.buildVerification)
    return '业务验收与本次测试证据不是同一轮'
  return ''
}

function writeInstructions(input: {
  config: ForgeLoopConfig
  reqId: string
  planVersion: number
  requirementVersion: number
  commit: DeliveryCommit
  package: DeliveryPackage
  verification: DeliveryEvidence
  businessReview: DeliveryEvidence
  trial: DeliveryTrial
  now: string
}): { instructions: DeliveryInstructions; dir: string } {
  const dir = deliveryDir(
    input.config,
    input.reqId,
    input.planVersion,
    input.package.artifactSha256,
  )
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'INSTALL.md')
  const target = input.config.deployments.targets.find((entry) => entry.id === input.trial.targetId)
  const text = installInstructionsOf({
    reqId: input.reqId,
    project: input.config.project,
    requirementVersion: input.requirementVersion,
    commit: input.commit,
    package: input.package,
    verification: input.verification,
    businessReview: input.businessReview,
    trial: input.trial,
    targetParams: target?.params ?? {},
  })
  writeFileSync(path, text, 'utf8')
  return {
    dir,
    instructions: {
      path,
      sha256: sha256OfText(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      writtenAt: input.now,
    },
  }
}

export function safeInstallableDelivery(
  deps: InstallableDeliveryDeps,
  reqId: string,
): OperationResult {
  try {
    return recordInstallableDelivery(deps, reqId)
  } catch (error) {
    return fail('delivery_error', `可安装交付登记异常：${errorMessage(error)}`)
  }
}

export function recordInstallableDelivery(
  deps: InstallableDeliveryDeps,
  reqId: string,
): OperationResult {
  const requirement = deps.repo.getRequirement(reqId)
  if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
  const currentVersion = requirement.versions.length
  const commitRecord = deps.repo.latestCommit(reqId)
  if (!commitRecord) {
    return fail('delivery_incomplete', `需求 ${reqId} 没有受控提交，不能登记可安装交付`)
  }
  const build = deps.repo.candidateBuild(reqId, commitRecord.planVersion)
  if (!build) {
    return fail('delivery_incomplete', `需求 ${reqId} 缺少与受控提交对应的安装包`)
  }
  const verification = deps.repo.verification(reqId, commitRecord.planVersion)
  if (!verification) {
    return fail('delivery_incomplete', `需求 ${reqId} 缺少独立测试结论`)
  }
  const review = deps.repo.businessReviewForCandidate(
    reqId,
    commitRecord.planVersion,
    commitRecord.candidateSha256,
  )
  if (!review) {
    return fail('delivery_incomplete', `需求 ${reqId} 缺少业务验收结论`)
  }
  const evidence = trialEvidenceOf(deps, reqId, commitRecord.planVersion)
  if (!evidence) {
    return fail('delivery_incomplete', `需求 ${reqId} 缺少已核对通过的试装记录`)
  }
  if (evidence.candidateSha256 && evidence.candidateSha256 !== commitRecord.candidateSha256) {
    return fail(
      'delivery_mismatch',
      `需求 ${reqId} 不能登记可安装交付：试装记录不是该受控提交的部署`,
    )
  }
  const trial = evidence.trial
  const problem = bindingProblem({
    commitCandidate: commitRecord.candidateSha256,
    buildCandidate: build.candidateSha256,
    buildVerification: build.verificationSha256,
    verificationCandidate: verification.candidateSha256,
    reviewCandidate: review.candidateSha256,
    reviewVerification: review.verificationSha256,
  })
  if (problem) return fail('delivery_mismatch', `需求 ${reqId} 不能登记可安装交付：${problem}`)

  const written = writeInstructions({
    config: deps.config,
    reqId,
    planVersion: commitRecord.planVersion,
    requirementVersion: currentVersion,
    commit: commitOf(commitRecord),
    package: packageOf(build),
    verification: verificationOf(verification),
    businessReview: reviewOf(review),
    trial,
    now: deps.now(),
  })
  const verdict = evaluateInstallableDelivery({
    requirementVersion: verification.requirementVersion,
    currentRequirementVersion: currentVersion,
    commit: commitOf(commitRecord),
    package: packageOf(build),
    instructions: written.instructions,
    verification: verificationOf(verification),
    businessReview: reviewOf(review),
    trial,
  })
  if (verdict.status !== 'delivered') {
    return fail(
      'delivery_mismatch',
      `需求 ${reqId} 不能登记可安装交付：${verdict.mismatches.join('；')}`,
    )
  }

  const existing = deps.repo.installableDeliveryStore.forCandidate(
    reqId,
    commitRecord.planVersion,
    commitRecord.candidateSha256,
    build.artifactSha256,
  )
  if (existing) {
    return ok(`需求 ${reqId} 的可安装交付已登记（第 ${existing.deliveryVersion} 次）`, existing)
  }
  const version = deps.repo.installableDeliveryStore.countFor(reqId) + 1
  const record: InstallableDeliveryRecord = {
    deliveryId: `${reqId}-d${version}`,
    reqId,
    deliveryVersion: version,
    project: deps.config.project,
    requirementVersion: currentVersion,
    planVersion: commitRecord.planVersion,
    candidateSha256: commitRecord.candidateSha256,
    commitSha: commitRecord.commitSha,
    packageVersion: build.packageVersion,
    artifactSha256: build.artifactSha256,
    tarball: build.tarball,
    instructionsPath: written.instructions.path,
    instructionsSha256: written.instructions.sha256,
    instructionsBytes: written.instructions.bytes,
    verificationSha256: verification.reportSha256,
    businessReviewSha256: review.reportSha256,
    trialTarget: trial.targetId,
    trialRuntimeVersion: trial.runtimeVersion,
    trialArtifactSha256: trial.artifactSha256,
    availableAt: verdict.availableAt,
    recordedAt: deps.now(),
    evidenceDir: written.dir,
  }
  deps.repo.installableDeliveryStore.record(record)
  const saved = deps.repo.installableDeliveryStore.latest(reqId) ?? record
  return ok(
    `需求 ${reqId} 已登记可安装交付：提交 ${commitRecord.commitSha.slice(0, 12)}，` +
      `包 ${build.packageVersion}（${build.artifactSha256.slice(0, 12)}），` +
      `试装 ${trial.targetId} 核对通过，${verdict.availableAt} 起可用`,
    saved,
  )
}
