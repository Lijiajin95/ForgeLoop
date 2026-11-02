import { parseJsonObject } from '../domain/json.js'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { candidatesDir } from '../config.js'
import type { ForgeLoopConfig } from '../config.js'
import { sha256OfBytes, sha256OfText } from '../domain/delivery.js'
import { errorMessage } from '../domain/errors.js'
import { verificationBlocking } from './service-helpers.js'
import type { Requirement } from '../domain/requirement.js'
import { buildAcceptanceBinding, type AcceptanceBindingInput } from './acceptance-binding.js'
import { requireGit, runCommand } from './workspace.js'
import type { Repository, VerificationRecord, BusinessReviewRecord } from '../records/repository.js'
import { authorizePlan, type TaskPlan } from '../domain/task-plan.js'
import type { StatusBoardView } from './board.js'
import { type BuildMaterialsInput, type BuildMaterialsResult } from './build-materials.js'
import {
  inspectRequirementModules,
  inspectRuntimeIdentity,
  readInstalledVersion,
  verifyInstalledFiles,
} from './deployment-inspect.js'
import { PLUGIN_VERSION } from './version.js'
import type { OperationResult } from './operation-result.js'
import { fail, ok } from './operation-result.js'
import type { CodeCandidateRecord, RequirementCommitRecord } from '../records/repository.js'

export interface AdmittedDelivery {
  plan: TaskPlan
  candidate: CodeCandidateRecord | null
  verification: VerificationRecord | null
  review: BusinessReviewRecord | null
  commit: RequirementCommitRecord | null
}

export interface CandidatePipelineDeps {
  config: ForgeLoopConfig
  repo: Repository
  now: () => string
  validateBuildMaterials: (input: BuildMaterialsInput) => BuildMaterialsResult
  requireAuthorizedPlan: (
    reqId: string,
  ) => { ok: true; value: { plan: TaskPlan } } | { ok: false; result: OperationResult }
  currentAdmission: (reqId: string) => ReturnType<Repository['latestAdmission']>
  candidateIdentity: (plan: TaskPlan, artifacts: ReturnType<Repository['taskArtifacts']>) => string
  statusBoard: (limit?: number, query?: string) => StatusBoardView
}

function candidateDiffPathOf(delivery: AdmittedDelivery): string {
  const candidate = delivery.candidate
  if (!candidate) return ''
  if (existsSync(candidate.diffPath)) return candidate.diffPath
  const verification = delivery.verification
  return verification ? join(verification.evidenceDir, 'candidate.diff') : ''
}

export class CandidatePipeline {
  constructor(private readonly deps: CandidatePipelineDeps) {}

  private admittedDelivery(reqId: string): {
    plan: TaskPlan
    candidate: ReturnType<Repository['latestCodeCandidate']>
    verification: ReturnType<Repository['verificationForCandidate']>
    review: ReturnType<Repository['businessReviewForCandidate']>
    commit: ReturnType<Repository['commitForCandidate']>
  } | null {
    if (!this.deps.currentAdmission(reqId)) return null
    const plans = this.deps.repo.taskPlans(reqId)
    for (const plan of [...plans].reverse()) {
      const candidate = this.deps.repo.latestCodeCandidate(reqId, plan.planVersion)
      if (!candidate) continue
      const verification = this.deps.repo.verificationForCandidate(
        reqId,
        plan.planVersion,
        candidate.candidateSha256,
      )
      const review = this.deps.repo.businessReviewForCandidate(
        reqId,
        plan.planVersion,
        candidate.candidateSha256,
      )
      const commit = this.deps.repo.commitForCandidate(
        reqId,
        plan.planVersion,
        candidate.candidateSha256,
      )
      return { plan, candidate, verification, review, commit }
    }
    return null
  }

  /**
   * 新旧构建路径共用的材料核验：文件摘要、规范字段、候选身份、验证工作区树、
   * 未提交改动、候选 diff 与受控提交的文件集合都必须一致。只读取证据，不改写历史。
   */
  private protectedFileHashes(root: string, files: readonly string[]): Map<string, string> {
    const hashes = new Map<string, string>()
    for (const file of files) {
      const path = join(root, file)
      if (!existsSync(path)) {
        hashes.set(file, '')
        continue
      }
      hashes.set(file, sha256OfBytes(readFileSync(path)))
    }
    return hashes
  }

  private protectedFilesChanged(
    root: string,
    before: ReadonlyMap<string, string>,
    ignored: readonly string[],
  ): string[] {
    const ignoredSet = new Set(ignored)
    const changed: string[] = []
    for (const [file, hash] of before) {
      if (ignoredSet.has(file)) continue
      const path = join(root, file)
      const now = existsSync(path) ? sha256OfBytes(readFileSync(path)) : ''
      if (now !== hash) changed.push(file)
    }
    return changed
  }

  /**
   * 新链路构建：依据系统准入、固定候选、独立验证、业务验收和本地提交，
   * 不再要求旧任务包批准或所有者整体验收。
   */
  private buildReadiness(
    delivery: AdmittedDelivery,
    version: string | undefined,
  ): OperationResult | null {
    const { candidate, verification, review } = delivery
    if (!candidate || !verification || verification.verdict !== 'pass') {
      return fail('verification_required', '候选没有通过的独立验证；不能构建')
    }
    if (!review || review.verdict !== 'pass') {
      return fail('business_review_required', '候选没有通过的业务验收；不能构建')
    }
    const configured =
      this.deps.config.candidateBuildCommand.length > 0 &&
      this.deps.config.candidatePackageCommand.length > 0 &&
      Boolean(this.deps.config.candidateArtifactPath)
    if (!configured) {
      return fail(
        'candidate_not_configured',
        '未配置 candidateBuildCommand / candidatePackageCommand / candidateArtifactPath',
      )
    }
    if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version)) {
      return fail('version_invalid', `候选版本必须是 x.y.z，实际 ${JSON.stringify(version)}`)
    }
    return null
  }

  private buildAdmittedCandidate(input: {
    reqId: string
    by: string
    version?: string
  }): OperationResult {
    const delivery = this.admittedDelivery(input.reqId)
    if (!delivery) return fail('candidate_missing', `需求 ${input.reqId} 没有可构建的新链路候选`)
    const { plan, candidate, verification, review, commit } = delivery
    const notReady = this.buildReadiness(delivery, input.version)
    if (notReady) return notReady
    if (!candidate || !verification) {
      return fail('verification_required', '候选没有通过的独立验证；不能构建')
    }
    if (!review) return fail('business_review_required', '候选没有通过的业务验收；不能构建')
    const materials = this.deps.validateBuildMaterials({
      reqId: input.reqId,
      plan,
      verification,
      review,
      commit,
      candidate,
      requireCommit: true,
    })
    if (!materials.ok) return fail(materials.code, materials.message)
    const prepared = this.prepareCandidateBuild(input, { plan, candidate, verification, materials })
    if (!prepared.ok) return prepared.result
    const { dir, source, packageVersion } = prepared
    const artifact = this.readCandidateArtifact(dir, packageVersion)
    if (!artifact.ok) return artifact.result
    const { artifactSha, tarball, files, gitHead, builtAt } = artifact.value
    const buildDir = join(candidatesDir(this.deps.config, input.reqId, plan.planVersion), 'build')
    mkdirSync(buildDir, { recursive: true })
    const recordPath = join(buildDir, 'candidate-build.json')
    const record = {
      kind: 'candidate-build',
      reqId: input.reqId,
      planVersion: plan.planVersion,
      candidateSha256: candidate.candidateSha256,
      verificationSha256: verification.reportSha256,
      packageVersion,
      artifactSha256: artifactSha,
      tarball,
      files,
      gitHead,
      builtAt: builtAt || this.deps.now(),
      commitSha: commit?.commitSha ?? '',
      sourceWorkspace: source,
      at: this.deps.now(),
    }
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    this.deps.repo.recordCandidateBuild({
      reqId: input.reqId,
      planVersion: plan.planVersion,
      candidateSha256: candidate.candidateSha256,
      verificationSha256: verification.reportSha256,
      packageVersion,
      artifactSha256: artifactSha,
      tarball,
      files,
      gitHead,
      builtAt: record.builtAt,
      evidenceDir: dir,
    })
    return ok(`已从准入候选构建安装包 ${packageVersion}（sha256 ${artifactSha.slice(0, 16)}…）`, {
      sha256: artifactSha,
      tarball,
      files,
      evidenceDir: dir,
      packageVersion,
      candidateSha256: candidate.candidateSha256,
      verificationSha256: verification.reportSha256,
      commitSha: commit?.commitSha ?? '',
      recordPath,
    })
  }

  private patchCandidateVersion(dir: string, version: string | undefined): OperationResult | null {
    if (version === undefined) return null
    const packageJsonPath = join(dir, 'packages/forgeloop/package.json')
    if (!existsSync(packageJsonPath)) {
      return fail('package_missing', `候选副本缺少插件包清单 ${packageJsonPath}`)
    }
    const packageJson = parseJsonObject(readFileSync(packageJsonPath, 'utf8'))
    packageJson.version = version
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
    return null
  }

  private prepareCandidateBuild(
    input: { reqId: string; version?: string },
    context: {
      plan: TaskPlan
      candidate: CodeCandidateRecord
      verification: VerificationRecord
      materials: { diffPath: string; protectedFiles: string[] }
    },
  ):
    | { ok: true; dir: string; source: string; packageVersion: string; log: string }
    | { ok: false; result: OperationResult } {
    const { plan, candidate, verification, materials } = context
    const source = join(verification.evidenceDir, 'workspace')
    const dir = candidatesDir(this.deps.config, input.reqId, plan.planVersion)
    const diffText = readFileSync(materials.diffPath, 'utf8')
    rmSync(dir, { recursive: true, force: true })
    cpSync(source, dir, { recursive: true })
    writeFileSync(join(dir, basename(candidate.diffPath)), diffText, 'utf8')
    const sharedModules = join(this.deps.config.projectPath, 'node_modules')
    if (existsSync(sharedModules)) {
      // 验证工作区可能带有不完整的 node_modules 副本；构建副本必须使用主项目
      // 已安装的依赖，否则 tsc 等本地二进制不存在，会把环境缺依赖误判为候选失败。
      rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
      try {
        symlinkSync(sharedModules, join(dir, 'node_modules'), 'dir')
      } catch {
        // 构建失败会由命令输出说明；不伪造成功。
      }
    }
    const versionError = this.patchCandidateVersion(dir, input.version)
    if (versionError) return { ok: false, result: versionError }
    const packageJsonPath = join(dir, 'packages/forgeloop/package.json')
    if (!existsSync(packageJsonPath)) {
      return {
        ok: false,
        result: fail('package_missing', `候选副本缺少插件包清单 ${packageJsonPath}`),
      }
    }
    const packageJson = parseJsonObject(readFileSync(packageJsonPath, 'utf8'))
    const packageVersion = typeof packageJson.version === 'string' ? packageJson.version : ''
    if (!packageVersion) {
      return {
        ok: false,
        result: fail('package_missing', `候选包清单缺少版本号：${packageJsonPath}`),
      }
    }
    const buildIgnore = input.version !== undefined ? ['packages/forgeloop/package.json'] : []
    const protectedBefore = this.protectedFileHashes(dir, materials.protectedFiles)
    const log: string[] = []
    for (const [label, command] of [
      ['build', this.deps.config.candidateBuildCommand],
      ['package', this.deps.config.candidatePackageCommand],
    ] as const) {
      const [executable, ...args] = command
      if (!executable) {
        return {
          ok: false,
          result: fail('candidate_command_missing', `${label} 命令为空`),
        }
      }
      const result = runCommand(
        executable,
        args,
        dir,
        this.deps.config.formalTestTimeoutSeconds * 1000,
      )
      log.push(
        `=== ${label} (exit ${result.code})\n$ ${command.join(' ')}\n${result.stdout}\n${result.stderr}`,
      )
      if (result.code !== 0) {
        writeFileSync(join(dir, 'candidate-build.log'), log.join('\n'), 'utf8')
        return {
          ok: false,
          result: fail(
            'candidate_build_failed',
            `候选包 ${label} 失败（退出码 ${result.code}）；日志 ${join(dir, 'candidate-build.log')}`,
          ),
        }
      }
      const changed = this.protectedFilesChanged(dir, protectedBefore, buildIgnore)
      if (changed.length > 0) {
        writeFileSync(join(dir, 'candidate-build.log'), log.join('\n'), 'utf8')
        return {
          ok: false,
          result: fail(
            'candidate_content_changed',
            `候选构建过程修改了受保护内容：${changed.join('、')}；旧验证不能沿用，必须重新验证`,
          ),
        }
      }
    }
    writeFileSync(join(dir, 'candidate-build.log'), log.join('\n'), 'utf8')
    return { ok: true, dir, source, packageVersion, log: log.join('\n') }
  }

  private readCandidateArtifact(
    dir: string,
    packageVersion: string,
  ):
    | {
        ok: true
        value: {
          artifactSha: string
          tarball: string
          files: string[]
          gitHead: string
          builtAt: string
        }
      }
    | { ok: false; result: OperationResult } {
    const artifactPath = join(dir, this.deps.config.candidateArtifactPath)
    if (!existsSync(artifactPath)) {
      return {
        ok: false,
        result: fail('artifact_missing', `打包完成但没有找到产物清单 ${artifactPath}`),
      }
    }
    const artifact = parseJsonObject(readFileSync(artifactPath, 'utf8'))
    const artifactSha256 = typeof artifact.sha256 === 'string' ? artifact.sha256 : ''
    const artifactTarball = typeof artifact.tarball === 'string' ? artifact.tarball : ''
    const artifactVersion = typeof artifact.version === 'string' ? artifact.version : ''
    const artifactFiles = Array.isArray(artifact.files)
      ? artifact.files.filter((file): file is string => typeof file === 'string')
      : []
    if (!artifactSha256 || !artifactTarball) {
      return {
        ok: false,
        result: fail('artifact_malformed', `产物清单缺少 sha256/tarball：${artifactPath}`),
      }
    }
    if (artifactVersion && artifactVersion !== packageVersion) {
      return {
        ok: false,
        result: fail(
          'artifact_version_mismatch',
          `产物版本 ${artifactVersion} 与包清单 ${packageVersion} 不一致`,
        ),
      }
    }
    const artifactSha = sha256OfBytes(readFileSync(artifactTarball))
    if (artifactSha !== artifactSha256) {
      return {
        ok: false,
        result: fail(
          'artifact_mismatch',
          `产物摘要与清单不一致：清单 ${artifactSha256}，实际 ${artifactSha}`,
        ),
      }
    }
    return {
      ok: true,
      value: {
        artifactSha,
        tarball: artifactTarball,
        files: artifactFiles,
        gitHead: typeof artifact.gitHead === 'string' ? artifact.gitHead : '',
        builtAt: typeof artifact.builtAt === 'string' ? artifact.builtAt : '',
      },
    }
  }

  buildCandidate(input: { reqId: string; by: string; version?: string }): OperationResult {
    const requirement = this.deps.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (this.deps.currentAdmission(input.reqId)) return this.buildAdmittedCandidate(input)
    const guarded = this.legacyBuildGuard(input)
    if (!guarded.ok) return guarded.result
    const { plan, identity, verification, materials } = guarded
    const prepared = this.prepareLegacyCandidate(input, plan, verification)
    if (!prepared.ok) return prepared.result
    const { dir, source, packageVersion, protectedDigest } = prepared
    const commands = [
      { label: 'prepare', command: this.deps.config.worktreePrepareCommand },
      { label: 'build', command: this.deps.config.candidateBuildCommand },
      { label: 'package', command: this.deps.config.candidatePackageCommand },
    ]
    const buildIgnore = input.version !== undefined ? ['packages/forgeloop/package.json'] : []
    const built = this.runCandidateCommands(dir, commands, materials.protectedFiles, buildIgnore)
    if (!built.ok) return built.result
    const artifact = this.readCandidateArtifact(dir, packageVersion)
    if (!artifact.ok) return artifact.result
    const { artifactSha: candidateSha, tarball, files, gitHead, builtAt } = artifact.value
    const buildDir = join(candidatesDir(this.deps.config, input.reqId, plan.planVersion), 'build')
    mkdirSync(buildDir, { recursive: true })
    const recordPath = join(buildDir, 'candidate-build.json')
    const recordedAt = builtAt || this.deps.now()
    const record = {
      kind: 'candidate-build',
      reqId: input.reqId,
      planVersion: plan.planVersion,
      candidateSha256: identity,
      verificationSha256: verification.reportSha256,
      packageVersion,
      artifactSha256: candidateSha,
      tarball,
      files,
      gitHead,
      builtAt: recordedAt,
      candidateContentSha256: protectedDigest,
      sourceWorkspace: source,
      at: this.deps.now(),
    }
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    this.deps.repo.recordCandidate({
      reqId: input.reqId,
      planVersion: plan.planVersion,
      sha256: candidateSha,
      tarball,
      files,
      gitHead,
      builtAt: recordedAt,
      evidenceDir: dir,
    })
    this.deps.repo.recordCandidateBuild({
      reqId: input.reqId,
      planVersion: plan.planVersion,
      candidateSha256: identity,
      verificationSha256: verification.reportSha256,
      packageVersion,
      artifactSha256: candidateSha,
      tarball,
      files,
      gitHead,
      builtAt: recordedAt,
      evidenceDir: dir,
    })
    return ok(
      `已从已验证候选构建安装包 ${packageVersion}（sha256 ${candidateSha.slice(0, 16)}…）`,
      {
        sha256: candidateSha,
        tarball,
        files,
        evidenceDir: dir,
        packageVersion,
        candidateSha256: identity,
        verificationSha256: verification.reportSha256,
        recordPath,
      },
    )
  }

  private runCandidateCommands(
    dir: string,
    commands: ReadonlyArray<{ label: string; command: readonly string[] }>,
    protectedFiles: readonly string[],
    buildIgnore: readonly string[],
  ): { ok: true } | { ok: false; result: OperationResult } {
    const protectedBefore = this.protectedFileHashes(dir, protectedFiles)
    const log: string[] = []
    for (const { label, command } of commands) {
      if (command.length === 0) continue
      const [executable, ...args] = command
      if (!executable) continue
      const result = runCommand(
        executable,
        args,
        dir,
        this.deps.config.formalTestTimeoutSeconds * 1000,
      )
      log.push(
        `=== ${label} (exit ${result.code})\n$ ${command.join(' ')}\n${result.stdout}\n${result.stderr}`,
      )
      if (result.code !== 0) {
        writeFileSync(join(dir, 'candidate-build.log'), log.join('\n'), 'utf8')
        return {
          ok: false,
          result: fail(
            'candidate_build_failed',
            `候选包 ${label} 失败（退出码 ${result.code}）；日志 ${join(dir, 'candidate-build.log')}`,
          ),
        }
      }
      const changed = this.protectedFilesChanged(dir, protectedBefore, buildIgnore)
      if (changed.length > 0) {
        writeFileSync(join(dir, 'candidate-build.log'), log.join('\n'), 'utf8')
        return {
          ok: false,
          result: fail(
            'candidate_content_changed',
            `候选构建过程修改了受保护内容：${changed.join('、')}；旧验证不能沿用，必须重新验证`,
          ),
        }
      }
    }
    writeFileSync(join(dir, 'candidate-build.log'), log.join('\n'), 'utf8')
    return { ok: true }
  }

  private legacyBuildGuard(input: { reqId: string; version?: string }):
    | {
        ok: true
        plan: TaskPlan
        identity: string
        verification: VerificationRecord
        review: BusinessReviewRecord
        materials: BuildMaterialsResult & { ok: true }
      }
    | { ok: false; result: OperationResult } {
    const authorized = this.deps.requireAuthorizedPlan(input.reqId)
    if (!authorized.ok) return { ok: false, result: authorized.result }
    const plan = authorized.value.plan
    const artifacts = this.deps.repo.taskArtifacts(input.reqId, plan.planVersion)
    const missing = plan.tasks.filter(
      (task) => !artifacts.some((artifact) => artifact.taskId === task.taskId),
    )
    if (missing.length > 0) {
      return {
        ok: false,
        result: fail(
          'not_delivered',
          `仍有任务未交付，不能打包：${missing.map((task) => task.taskId).join('、')}`,
        ),
      }
    }
    if (
      this.deps.config.candidateBuildCommand.length === 0 ||
      this.deps.config.candidatePackageCommand.length === 0 ||
      !this.deps.config.candidateArtifactPath
    ) {
      return {
        ok: false,
        result: fail(
          'candidate_not_configured',
          '未配置 candidateBuildCommand / candidatePackageCommand / candidateArtifactPath',
        ),
      }
    }
    if (input.version !== undefined && !/^\d+\.\d+\.\d+$/.test(input.version)) {
      return {
        ok: false,
        result: fail(
          'version_invalid',
          `候选版本必须是 x.y.z，实际 ${JSON.stringify(input.version)}`,
        ),
      }
    }
    if (!this.deps.repo.acceptance(input.reqId).accepted_at) {
      return {
        ok: false,
        result: fail(
          'acceptance_required',
          `需求 ${input.reqId} 尚未通过整体验收；不能构建可发布候选`,
        ),
      }
    }
    const identity = this.deps.candidateIdentity(plan, artifacts)
    const verification = this.deps.repo.verificationForCandidate(
      input.reqId,
      plan.planVersion,
      identity,
    )
    if (!verification || verification.verdict !== 'pass') {
      return {
        ok: false,
        result: fail(
          'verification_required',
          `候选 ${identity.slice(0, 16)}… 没有通过的独立验证；不能构建可发布候选`,
        ),
      }
    }
    const review = this.deps.repo.businessReviewForCandidate(
      input.reqId,
      plan.planVersion,
      identity,
    )
    if (!review || review.verdict !== 'pass') {
      return {
        ok: false,
        result: fail(
          'business_review_required',
          `候选 ${identity.slice(0, 16)}… 没有通过的业务终审；不能构建可发布候选`,
        ),
      }
    }
    const materials = this.deps.validateBuildMaterials({
      reqId: input.reqId,
      plan,
      verification,
      review,
      commit: this.deps.repo.commitForCandidate(input.reqId, plan.planVersion, identity),
      candidate: null,
      requireCommit: false,
    })
    if (!materials.ok) return { ok: false, result: fail(materials.code, materials.message) }
    return { ok: true, plan, identity, verification, review, materials }
  }

  private prepareLegacyCandidate(
    input: { reqId: string; version?: string },
    plan: TaskPlan,
    verification: VerificationRecord,
  ):
    | { ok: true; dir: string; source: string; packageVersion: string; protectedDigest: string }
    | { ok: false; result: OperationResult } {
    const source = join(verification.evidenceDir, 'workspace')
    const protectedDigest = sha256OfText(requireGit(source, ['diff', 'HEAD', '--binary']))
    const dir = candidatesDir(this.deps.config, input.reqId, plan.planVersion)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    cpSync(source, dir, { recursive: true })
    const versionError = this.patchCandidateVersion(dir, input.version)
    if (versionError) return { ok: false, result: versionError }
    const packageJsonPath = join(dir, 'packages/forgeloop/package.json')
    if (!existsSync(packageJsonPath)) {
      return {
        ok: false,
        result: fail('package_missing', `候选副本缺少插件包清单 ${packageJsonPath}`),
      }
    }
    const packageJson = parseJsonObject(readFileSync(packageJsonPath, 'utf8'))
    const packageVersion = typeof packageJson.version === 'string' ? packageJson.version : ''
    if (!packageVersion) {
      return {
        ok: false,
        result: fail('package_missing', `候选包清单缺少版本号：${packageJsonPath}`),
      }
    }
    return { ok: true, dir, source, packageVersion, protectedDigest }
  }

  /**
   * 上线核对：安装由外部受控机制完成，本方法只核对“装进去的、正在跑的”是否就是
   * 被验证并验收的那份候选；任一不一致都保留失败记录，不把安装回执当交付完成。
   */
  private resolveDeploymentTarget(input: { reqId: string; targetProfile: string }):
    | {
        ok: true
        admitted: boolean
        delivery: AdmittedDelivery | null
        plan: TaskPlan
        identity: string
        build: NonNullable<ReturnType<Repository['candidateBuild']>>
        profileDir: string
        installedRoot: string
        checks: Array<{ id: string; ok: boolean; detail: string }>
        check: (id: string, ok: boolean, detail: string) => void
      }
    | { ok: false; result: OperationResult } {
    const requirement = this.deps.repo.getRequirement(input.reqId)
    if (!requirement) {
      return { ok: false, result: fail('not_found', `未找到需求 ${input.reqId}`) }
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(input.targetProfile)) {
      return {
        ok: false,
        result: fail(
          'profile_invalid',
          `目标 profile 只能是安全的 profile 名，实际 ${JSON.stringify(input.targetProfile)}`,
        ),
      }
    }
    const admitted = Boolean(this.deps.currentAdmission(input.reqId))
    const delivery = admitted ? this.admittedDelivery(input.reqId) : null
    if (admitted && !delivery) {
      return {
        ok: false,
        result: fail('candidate_missing', `需求 ${input.reqId} 没有新链路候选`),
      }
    }
    const plan = delivery ? delivery.plan : this.deps.repo.latestTaskPlan(input.reqId)
    if (!plan) {
      return { ok: false, result: fail('plan_missing', `需求 ${input.reqId} 没有任务包`) }
    }
    const identity = this.deploymentIdentity(input.reqId, admitted, delivery, plan)
    if (typeof identity !== 'string') return identity
    const build = this.deps.repo.candidateBuild(input.reqId, plan.planVersion)
    if (!build) {
      return {
        ok: false,
        result: fail('candidate_missing', `需求 ${input.reqId} 尚未构建可安装候选`),
      }
    }
    if (build.candidateSha256 !== identity) {
      return {
        ok: false,
        result: fail(
          'candidate_stale',
          '候选包绑定的候选身份与当前交付材料不一致；需重新验证并构建',
        ),
      }
    }
    if (!admitted && !this.deps.repo.acceptance(input.reqId).accepted_at) {
      return {
        ok: false,
        result: fail('acceptance_required', '需求尚未通过整体验收；不能做上线核对'),
      }
    }
    const profileDir = join(this.deps.config.dshProfilesRoot, input.targetProfile)
    const installedRoot = join(profileDir, 'node_modules', 'forgeloop-dsh')
    if (!existsSync(profileDir)) {
      return { ok: false, result: fail('profile_missing', `目标 profile 不存在：${profileDir}`) }
    }
    if (!existsSync(installedRoot)) {
      return {
        ok: false,
        result: fail('not_installed', `目标 profile 尚未安装 forgeloop-dsh：${installedRoot}`),
      }
    }
    const checks: Array<{ id: string; ok: boolean; detail: string }> = []
    const check = (id: string, ok: boolean, detail: string): void => {
      checks.push({ id, ok, detail })
    }
    return {
      ok: true,
      admitted,
      delivery,
      plan,
      identity,
      build,
      profileDir,
      installedRoot,
      checks,
      check,
    }
  }

  private deploymentIdentity(
    reqId: string,
    admitted: boolean,
    delivery: AdmittedDelivery | null,
    plan: TaskPlan,
  ): string | { ok: false; result: OperationResult } {
    if (admitted && delivery?.candidate) return delivery.candidate.candidateSha256
    const artifacts = this.deps.repo.taskArtifacts(reqId, plan.planVersion)
    const missing = plan.tasks.filter(
      (task) => !artifacts.some((artifact) => artifact.taskId === task.taskId),
    )
    if (missing.length > 0) {
      return { ok: false, result: fail('not_delivered', '仍有任务未交付，不能做上线核对') }
    }
    return this.deps.candidateIdentity(plan, artifacts)
  }

  private inspectBusinessRecords(context: {
    reqId: string
    admitted: boolean
    delivery: AdmittedDelivery | null
    plan: TaskPlan
    identity: string
    build: { readonly verificationSha256: string }
  }): { ok: boolean; detail: string } {
    const { reqId, admitted, delivery, plan, identity, build } = context
    const acceptance = this.deps.repo.acceptance(reqId)
    if (admitted) {
      const review = delivery?.review
      return {
        ok: review?.verdict === 'pass' && review.verificationSha256 === build.verificationSha256,
        detail: `系统准入；业务验收 ${review?.verdict ?? '缺失'}；提交 ${
          this.deps.repo
            .commitForCandidate(reqId, plan.planVersion, identity)
            ?.commitSha.slice(0, 12) ?? '缺失'
        }`,
      }
    }
    const review = this.deps.repo.businessReviewForCandidate(reqId, plan.planVersion, identity)
    return {
      ok:
        Boolean(acceptance.accepted_at) &&
        review?.verdict === 'pass' &&
        review.verificationSha256 === build.verificationSha256,
      detail: `验收 ${acceptance.accepted_at || '缺失'}；业务终审 ${review?.verdict ?? '缺失'}`,
    }
  }

  verifyDeployment(input: {
    reqId: string
    targetProfile: string
    by: string
    source: string
  }): OperationResult {
    const target = this.resolveDeploymentTarget(input)
    if (!target.ok) return target.result
    const { admitted, delivery, plan, identity, build, profileDir, installedRoot, checks, check } =
      target

    const installedVersion = readInstalledVersion(installedRoot)
    check(
      'installed_version',
      installedVersion === build.packageVersion,
      `安装版本 ${installedVersion || '未知'}，候选包版本 ${build.packageVersion}`,
    )

    const filesCheck = verifyInstalledFiles(build, installedRoot)
    check('installed_files', filesCheck.ok, filesCheck.detail)

    check(
      'running_version',
      PLUGIN_VERSION === build.packageVersion,
      `实际运行版本 ${PLUGIN_VERSION}，候选包版本 ${build.packageVersion}`,
    )

    // 包自述文件由插件装载时写入：进程存活且入口/服务摘要与安装内容一致，
    // 才能把“同版本”区分为“同一构建实例”。旧包没有该文件时不伪造该检查。
    const identityCheck = inspectRuntimeIdentity(installedRoot, build)
    if (identityCheck) check(identityCheck.id, identityCheck.ok, identityCheck.detail)
    const modulesCheck = inspectRequirementModules(
      admitted,
      admitted && delivery ? candidateDiffPathOf(delivery) : '',
      plan,
      installedRoot,
    )
    check('requirement_modules', modulesCheck.ok, modulesCheck.detail)

    let boardOk = false
    try {
      const board = this.deps.statusBoard(1)
      boardOk = Array.isArray(board.requirements)
    } catch {
      boardOk = false
    }
    check('key_entry', boardOk, boardOk ? '看板与记录查询可用' : '看板与记录查询不可用')

    const businessCheck = this.inspectBusinessRecords({
      reqId: input.reqId,
      admitted,
      delivery,
      plan,
      identity,
      build,
    })
    check('business_records', businessCheck.ok, businessCheck.detail)

    const dir = join(
      candidatesDir(this.deps.config, input.reqId, plan.planVersion),
      'deployment',
      input.targetProfile,
    )
    mkdirSync(dir, { recursive: true })
    const state = checks.every((entry) => entry.ok) ? 'verified' : 'failed'
    const report = {
      kind: 'deployment',
      reqId: input.reqId,
      planVersion: plan.planVersion,
      candidateSha256: identity,
      verificationSha256: build.verificationSha256,
      artifactSha256: build.artifactSha256,
      packageVersion: build.packageVersion,
      targetProfile: input.targetProfile,
      profileDir,
      runtimeVersion: PLUGIN_VERSION,
      state,
      checks,
      at: this.deps.now(),
    }
    const reportPath = join(dir, 'deployment.json')
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    this.deps.repo.recordDeployment({
      reqId: input.reqId,
      planVersion: plan.planVersion,
      candidateSha256: identity,
      packageVersion: build.packageVersion,
      targetProfile: input.targetProfile,
      artifactSha256: build.artifactSha256,
      runtimeVersion: PLUGIN_VERSION,
      state,
      checks,
      evidenceDir: dir,
      recordedBy: input.by,
      source: input.source,
      recordedAt: this.deps.now(),
    })
    if (state !== 'verified') {
      const failed = checks
        .filter((entry) => !entry.ok)
        .map((entry) => `${entry.id}：${entry.detail}`)
      return fail(
        'deployment_check_failed',
        `上线核对未通过：${failed.join('；')}；证据 ${reportPath}`,
      )
    }
    return ok(
      `上线核对通过：运行版本 ${PLUGIN_VERSION}，候选 ${identity.slice(0, 16)}…，profile ${input.targetProfile}`,
      {
        state,
        reportPath,
        runtimeVersion: PLUGIN_VERSION,
        packageVersion: build.packageVersion,
        candidateSha256: identity,
        artifactSha256: build.artifactSha256,
        checks,
      },
    )
  }

  private businessReviewGuard(review: BusinessReviewRecord): OperationResult | null {
    if (!this.businessReviewMaterialValid(review)) {
      return fail('business_review_invalid', '业务终审报告文件缺失或摘要不一致；不能验收')
    }
    if (review.verdict === 'pass') return null
    return fail(
      'business_review_blocked',
      `业务终审未通过：${verificationBlocking(review.reportJson)}`,
    )
  }

  private businessReviewMaterialValid(record: {
    reportPath: string
    reportSha256: string
  }): boolean {
    return (
      existsSync(record.reportPath) &&
      sha256OfText(readFileSync(record.reportPath, 'utf8')) === record.reportSha256
    )
  }

  private acceptanceInputs(
    reqId: string,
    requirement: Requirement,
  ):
    | {
        ok: true
        latestPlan: TaskPlan
        artifacts: ReturnType<Repository['taskArtifacts']>
        identity: string
        verification: VerificationRecord
        businessReview: BusinessReviewRecord
      }
    | { ok: false; result: OperationResult } {
    const latestPlan = this.deps.repo.latestTaskPlan(reqId)
    if (!latestPlan) return { ok: false, result: fail('plan_missing', `需求 ${reqId} 没有任务包`) }
    const approval = this.deps.repo.planApproval(reqId, latestPlan.planVersion)
    const authorization = authorizePlan(latestPlan, approval)
    if (authorization.status !== 'approved') {
      return { ok: false, result: fail('plan_not_approved', authorization.reason) }
    }
    if (latestPlan.requirementVersion !== requirement.versions.length) {
      return {
        ok: false,
        result: fail('stale_requirement', '任务包所依据的需求版本已过期；需要重新规划并批准'),
      }
    }
    const artifacts = this.deps.repo.taskArtifacts(reqId, latestPlan.planVersion)
    const missing = latestPlan.tasks.filter(
      (task) => !artifacts.some((artifact) => artifact.taskId === task.taskId),
    )
    if (missing.length > 0) {
      return {
        ok: false,
        result: fail(
          'not_delivered',
          `仍有任务未交付：${missing.map((task) => task.taskId).join('、')}`,
        ),
      }
    }
    const verification = this.deps.repo.verification(reqId, latestPlan.planVersion)
    if (!verification) {
      return {
        ok: false,
        result: fail(
          'verification_required',
          `需求 ${reqId} 尚未完成验证 Agent 的独立验证；不能验收`,
        ),
      }
    }
    const identity = this.deps.candidateIdentity(latestPlan, artifacts)
    if (
      verification.candidateSha256 !== identity ||
      verification.requirementVersion !== requirement.versions.length
    ) {
      return {
        ok: false,
        result: fail(
          'verification_stale',
          '独立验证结论绑定的候选或需求版本与当前材料不一致；必须对当前候选重新验证后再验收',
        ),
      }
    }
    if (
      !existsSync(verification.reportPath) ||
      sha256OfText(readFileSync(verification.reportPath, 'utf8')) !== verification.reportSha256
    ) {
      return {
        ok: false,
        result: fail('verification_invalid', '独立验证报告文件缺失或摘要不一致；不能验收'),
      }
    }
    if (verification.verdict !== 'pass') {
      return {
        ok: false,
        result: fail(
          'verification_blocked',
          `独立验证未通过：${verificationBlocking(verification.reportJson)}`,
        ),
      }
    }
    const businessReview = this.deps.repo.businessReviewForCandidate(
      reqId,
      latestPlan.planVersion,
      identity,
    )
    if (!businessReview) {
      return {
        ok: false,
        result: fail(
          'business_review_required',
          `需求 ${reqId} 尚未完成验证 Agent 的业务终审；不能验收`,
        ),
      }
    }
    if (
      businessReview.verificationSha256 !== verification.reportSha256 ||
      businessReview.requirementVersion !== requirement.versions.length
    ) {
      return {
        ok: false,
        result: fail(
          'business_review_stale',
          '业务终审绑定的验证或需求版本与当前材料不一致；必须重新终审',
        ),
      }
    }
    const reviewBlocked = this.businessReviewGuard(businessReview)
    if (reviewBlocked) return { ok: false, result: reviewBlocked }
    return { ok: true, latestPlan, artifacts, identity, verification, businessReview }
  }

  accept(input: {
    reqId: string
    by: string
    source: string
    artifactSha256?: string
  }): OperationResult {
    const requirement = this.deps.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    const inputs = this.acceptanceInputs(input.reqId, requirement)
    if (!inputs.ok) return inputs.result
    const { latestPlan, artifacts, verification, businessReview } = inputs
    const candidate = this.deps.repo.candidate(input.reqId, latestPlan.planVersion)
    if (candidate) {
      if (!input.artifactSha256) {
        return fail(
          'artifact_required',
          `需求 ${input.reqId} 已构建候选包 ${candidate.sha256.slice(0, 16)}…；验收必须显式给出产物 SHA256`,
        )
      }
      if (candidate.sha256 !== input.artifactSha256) {
        return fail(
          'artifact_mismatch',
          '给出的产物摘要与候选包记录不一致；原验收不能绑定另一个产物',
        )
      }
    }
    let binding
    try {
      binding = this.bindingOf({
        plan: latestPlan,
        artifacts,
        verification,
        businessReview,
        artifactSha256: input.artifactSha256,
      })
    } catch (error) {
      return fail('material_invalid', errorMessage(error))
    }
    const fingerprint = sha256OfText(JSON.stringify(binding))
    this.deps.repo.recordAcceptance({
      reqId: input.reqId,
      acceptedBy: input.by,
      source: input.source,
      fingerprint,
      now: this.deps.now(),
    })
    return ok(`需求 ${input.reqId} 已通过整体验收；材料指纹 ${fingerprint.slice(0, 16)}…`, {
      fingerprint,
      binding,
    })
  }

  private bindingOf(input: Omit<AcceptanceBindingInput, 'candidateSha256'>) {
    return buildAcceptanceBinding({
      ...input,
      candidateSha256: this.deps.candidateIdentity(input.plan, input.artifacts),
    })
  }
}
