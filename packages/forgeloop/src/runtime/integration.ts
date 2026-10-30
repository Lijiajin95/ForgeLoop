/**
 * 需求级候选与受控提交：候选是研发工作区相对快照基线的固定 diff；
 * 提交只把该 diff 应用到真实项目，运行配置的检查后创建本地 commit。
 *
 * 不 push、不创建 tag、不修改版本号；不把真实项目中的其他在途改动混入提交。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256OfText } from '../domain/delivery.js'
import { RuleViolationError } from '../domain/errors.js'
import { git, requireGit, runCommand } from './workspace.js'

export interface CandidateFile {
  readonly reqId: string
  readonly planVersion: number
  readonly candidateVersion: number
  readonly candidateSha256: string
  readonly requirementVersion: number
  readonly baselineCommit: string
  readonly snapshotCommit: string
  readonly diffPath: string
  readonly diffSha256: string
  readonly createdAt: string
}

export function candidateIdentity(input: {
  readonly reqId: string
  readonly planVersion: number
  readonly requirementVersion: number
  readonly baselineCommit: string
  readonly snapshotCommit: string
  readonly diffSha256: string
}): string {
  return sha256OfText(
    JSON.stringify({
      reqId: input.reqId,
      planVersion: input.planVersion,
      requirementVersion: input.requirementVersion,
      baselineCommit: input.baselineCommit,
      snapshotCommit: input.snapshotCommit,
      diffSha256: input.diffSha256,
    }),
  )
}

/** 从研发工作区导出相对快照基线的完整候选；调用前工作区必须已提交。 */
export function exportCandidate(input: {
  readonly workspace: string
  readonly snapshotCommit: string
  readonly baselineCommit: string
  readonly reqId: string
  readonly planVersion: number
  readonly requirementVersion: number
  readonly candidateVersion: number
  readonly outputPath: string
  readonly now: string
}): CandidateFile {
  const status = requireGit(input.workspace, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.trim()) throw new RuleViolationError('研发工作区仍有未提交改动；不能生成候选')
  const diffResult = git(input.workspace, ['diff', `${input.snapshotCommit}..HEAD`, '--binary'])
  if (diffResult.code !== 0) {
    throw new RuleViolationError(`读取候选 diff 失败：${diffResult.stderr.trim() || diffResult.stdout.trim()}`)
  }
  const diff = diffResult.stdout
  mkdirSync(join(input.outputPath, '..'), { recursive: true })
  writeFileSync(input.outputPath, diff, 'utf8')
  const diffSha256 = sha256OfText(diff)
  return {
    reqId: input.reqId,
    planVersion: input.planVersion,
    candidateVersion: input.candidateVersion,
    candidateSha256: candidateIdentity({
      reqId: input.reqId,
      planVersion: input.planVersion,
      requirementVersion: input.requirementVersion,
      baselineCommit: input.baselineCommit,
      snapshotCommit: input.snapshotCommit,
      diffSha256,
    }),
    requirementVersion: input.requirementVersion,
    baselineCommit: input.baselineCommit,
    snapshotCommit: input.snapshotCommit,
    diffPath: input.outputPath,
    diffSha256,
    createdAt: input.now,
  }
}

export interface IntegrationResult {
  readonly ok: boolean
  readonly checkPassed: boolean
  readonly commitSha: string
  readonly files: readonly string[]
  readonly checkLogPath: string
  readonly checkSha256: string
  readonly detail: string
}

function worktreeAdd(projectPath: string, path: string, commit: string): void {
  const result = runCommand('git', ['worktree', 'add', '--detach', path, commit], projectPath, 30_000)
  if (result.code !== 0) throw new RuleViolationError(`创建提交检查工作树失败：${result.stderr.trim() || result.stdout.trim()}`)
}

function worktreeRemove(projectPath: string, path: string): void {
  runCommand('git', ['worktree', 'remove', '--force', path], projectPath, 30_000)
  runCommand('git', ['worktree', 'prune'], projectPath, 30_000)
}

/**
 * 在临时工作树上应用候选并执行检查，通过后才在真实项目上暂存同一 diff 并提交。
 * 真实项目必须干净且 HEAD 与候选基线一致；否则阻断，不做自动合并或清理。
 */
export function integrateCandidate(input: {
  readonly projectPath: string
  readonly candidateDiffPath: string
  readonly candidateBaseline: string
  readonly expectedDiffSha256: string
  readonly checkCommand: readonly string[]
  readonly commitMessage: string
  readonly evidenceDir: string
  readonly timeoutMs: number
}): IntegrationResult {
  if (!existsSync(input.candidateDiffPath)) {
    return {
      ok: false,
      checkPassed: false,
      commitSha: '',
      files: [],
      checkLogPath: '',
      checkSha256: '',
      detail: '候选 diff 文件缺失',
    }
  }
  const diff = readFileSync(input.candidateDiffPath, 'utf8')
  if (!diff.trim()) {
    return {
      ok: false,
      checkPassed: true,
      commitSha: '',
      files: [],
      checkLogPath: '',
      checkSha256: '',
      detail: '候选没有产生可提交的文件改动',
    }
  }
  if (sha256OfText(diff) !== input.expectedDiffSha256) {
    return {
      ok: false,
      checkPassed: false,
      commitSha: '',
      files: [],
      checkLogPath: '',
      checkSha256: '',
      detail: '候选 diff 摘要不一致',
    }
  }
  const status = git(input.projectPath, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.code !== 0 || status.stdout.trim()) {
    return {
      ok: false,
      checkPassed: false,
      commitSha: '',
      files: [],
      checkLogPath: '',
      checkSha256: '',
      detail: '真实项目工作树有未提交改动；不能把本次需求与其他改动混入同一提交',
    }
  }
  const head = requireGit(input.projectPath, ['rev-parse', 'HEAD']).trim()
  if (head !== input.candidateBaseline) {
    return {
      ok: false,
      checkPassed: false,
      commitSha: '',
      files: [],
      checkLogPath: '',
      checkSha256: '',
      detail: `真实项目 HEAD 已从候选基线 ${input.candidateBaseline.slice(0, 12)} 变为 ${head.slice(0, 12)}；需重新研发`,
    }
  }

  mkdirSync(input.evidenceDir, { recursive: true })
  const checkPath = join(input.evidenceDir, 'commit-check.log')
  const worktree = join(input.evidenceDir, 'check-worktree')
  try {
    worktreeAdd(input.projectPath, worktree, input.candidateBaseline)
    const applied = runCommand('git', ['apply', '--binary', input.candidateDiffPath], worktree, 60_000)
    if (applied.code !== 0) {
      const detail = `候选 diff 无法应用到提交检查工作树：${applied.stderr.trim() || applied.stdout.trim()}`
      writeFileSync(checkPath, `${detail}\n`, 'utf8')
      return {
        ok: false,
        checkPassed: false,
        commitSha: '',
        files: [],
        checkLogPath: checkPath,
        checkSha256: sha256OfText(readFileSync(checkPath, 'utf8')),
        detail,
      }
    }
    let checkPassed = true
    let checkDetail = '未配置提交检查命令'
    let checkOutput = ''
    if (input.checkCommand.length > 0) {
      const check = runCommand(
        input.checkCommand[0]!,
        input.checkCommand.slice(1),
        worktree,
        input.timeoutMs,
      )
      checkPassed = check.code === 0
      checkDetail = `提交检查退出码 ${check.code}`
      checkOutput = `${JSON.stringify(input.checkCommand)}\nexit_code: ${check.code}\n${check.stdout}\n${check.stderr}\n`
    } else {
      checkOutput = '未配置提交检查命令；以独立验证结果为质量依据。\n'
    }
    writeFileSync(checkPath, checkOutput, 'utf8')
    const checkSha256 = sha256OfText(checkOutput)
    if (!checkPassed) {
      return {
        ok: false,
        checkPassed: false,
        commitSha: '',
        files: [],
        checkLogPath: checkPath,
        checkSha256,
        detail: checkDetail,
      }
    }

    // 检查通过：在真实干净项目上暂存同一 diff，创建本地提交。
    const staged = runCommand('git', ['apply', '--index', '--binary', input.candidateDiffPath], input.projectPath, 60_000)
    if (staged.code !== 0) {
      return {
        ok: false,
        checkPassed: true,
        commitSha: '',
        files: [],
        checkLogPath: checkPath,
        checkSha256,
        detail: `暂存候选失败：${staged.stderr.trim() || staged.stdout.trim()}`,
      }
    }
    const files = requireGit(input.projectPath, ['diff', '--cached', '--name-only'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const commit = runCommand('git', ['commit', '-m', input.commitMessage], input.projectPath, 60_000)
    if (commit.code !== 0) {
      runCommand('git', ['reset'], input.projectPath, 30_000)
      return {
        ok: false,
        checkPassed: true,
        commitSha: '',
        files,
        checkLogPath: checkPath,
        checkSha256,
        detail: `创建提交失败：${commit.stderr.trim() || commit.stdout.trim()}`,
      }
    }
    const commitSha = requireGit(input.projectPath, ['rev-parse', 'HEAD']).trim()
    return {
      ok: true,
      checkPassed: true,
      commitSha,
      files,
      checkLogPath: checkPath,
      checkSha256,
      detail: `已提交 ${commitSha.slice(0, 12)}（${files.length} 个文件）`,
    }
  } finally {
    worktreeRemove(input.projectPath, worktree)
  }
}
