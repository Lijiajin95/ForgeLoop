import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { bestEffort } from './best-effort.js'
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

export async function exportCandidate(input: {
  readonly workspace: string
  readonly snapshotCommit: string
  readonly baselineCommit: string
  readonly reqId: string
  readonly planVersion: number
  readonly requirementVersion: number
  readonly candidateVersion: number
  readonly outputPath: string
  readonly now: string
}): Promise<CandidateFile> {
  const status = await requireGit(input.workspace, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ])
  if (status.trim()) throw new RuleViolationError('研发工作区仍有未提交改动；不能生成候选')
  const diffResult = await git(input.workspace, [
    'diff',
    `${input.snapshotCommit}..HEAD`,
    '--binary',
  ])
  if (diffResult.code !== 0) {
    throw new RuleViolationError(
      `读取候选 diff 失败：${diffResult.stderr.trim() || diffResult.stdout.trim()}`,
    )
  }
  const diff = diffResult.stdout
  await mkdir(join(input.outputPath, '..'), { recursive: true })
  await writeFile(input.outputPath, diff, 'utf8')
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

async function worktreeAdd(projectPath: string, path: string, commit: string): Promise<void> {
  const result = await runCommand(
    'git',
    ['worktree', 'add', '--detach', path, commit],
    projectPath,
    30_000,
  )
  if (result.code !== 0)
    throw new RuleViolationError(
      `创建提交检查工作树失败：${result.stderr.trim() || result.stdout.trim()}`,
    )
}

async function worktreeRemove(projectPath: string, path: string): Promise<void> {
  await runCommand('git', ['worktree', 'remove', '--force', path], projectPath, 30_000)
  await runCommand('git', ['worktree', 'prune'], projectPath, 30_000)
}

function failure(detail: string, extra: Partial<IntegrationResult> = {}): IntegrationResult {
  return {
    ok: false,
    checkPassed: false,
    commitSha: '',
    files: [],
    checkLogPath: '',
    checkSha256: '',
    ...extra,
    detail,
  }
}

async function readCandidateDiff(input: {
  readonly candidateDiffPath: string
  readonly expectedDiffSha256: string
}): Promise<string | IntegrationResult> {
  if (!existsSync(input.candidateDiffPath)) return failure('候选 diff 文件缺失')
  const diff = await readFile(input.candidateDiffPath, 'utf8')
  if (!diff.trim()) return failure('候选没有产生可提交的文件改动', { checkPassed: true })
  if (sha256OfText(diff) !== input.expectedDiffSha256) {
    return failure('候选 diff 摘要不一致')
  }
  return diff
}

async function preflightProject(input: {
  readonly projectPath: string
  readonly candidateBaseline: string
}): Promise<IntegrationResult | null> {
  const status = await git(input.projectPath, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.code !== 0 || status.stdout.trim()) {
    return failure('真实项目工作树有未提交改动；不能把本次需求与其他改动混入同一提交')
  }
  const head = (await requireGit(input.projectPath, ['rev-parse', 'HEAD'])).trim()
  if (head !== input.candidateBaseline) {
    return failure(
      `真实项目 HEAD 已从候选基线 ${input.candidateBaseline.slice(0, 12)} 变为 ${head.slice(0, 12)}；需重新研发`,
    )
  }
  return null
}

async function recheckBeforeCommit(
  input: { readonly projectPath: string; readonly candidateBaseline: string },
  checkPath: string,
  checkOutput: string,
): Promise<IntegrationResult | null> {
  const status = await git(input.projectPath, ['status', '--porcelain=v1', '--untracked-files=all'])
  const head = (await requireGit(input.projectPath, ['rev-parse', 'HEAD'])).trim()
  const index = await git(input.projectPath, ['diff', '--cached', '--name-only'])
  const changed =
    status.code !== 0 ||
    Boolean(status.stdout.trim()) ||
    index.code !== 0 ||
    Boolean(index.stdout.trim()) ||
    head !== input.candidateBaseline
  if (!changed) return null
  const content = `${checkOutput}\n提交前复核失败：工作树/暂存区/HEAD 在检查期间发生变化。\n`
  await writeFile(checkPath, content, 'utf8')
  return failure('检查期间项目工作树、暂存区或 HEAD 发生变化；保留双方现场，未提交', {
    checkPassed: true,
    checkLogPath: checkPath,
    checkSha256: sha256OfText(content),
  })
}

async function applyAndCheck(
  input: {
    readonly projectPath: string
    readonly candidateDiffPath: string
    readonly candidateBaseline: string
    readonly checkCommand: readonly string[]
    readonly timeoutMs: number
  },
  worktree: string,
  checkPath: string,
): Promise<{ ok: true; checkOutput: string; checkSha256: string } | IntegrationResult> {
  await worktreeAdd(input.projectPath, worktree, input.candidateBaseline)
  // 已安装依赖，才能运行 tsc/vitest 等真实检查，而不是把缺依赖误判为候选失败。
  const sharedModules = join(input.projectPath, 'node_modules')
  if (existsSync(sharedModules) && !existsSync(join(worktree, 'node_modules'))) {
    bestEffort(() => {
      symlinkSync(sharedModules, join(worktree, 'node_modules'), 'dir')
    })
  }
  const applied = await runCommand(
    'git',
    ['apply', '--binary', input.candidateDiffPath],
    worktree,
    60_000,
  )
  if (applied.code !== 0) {
    const detail = `候选 diff 无法应用到提交检查工作树：${applied.stderr.trim() || applied.stdout.trim()}`
    const content = `${detail}\n`
    await writeFile(checkPath, content, 'utf8')
    return failure(detail, {
      checkLogPath: checkPath,
      checkSha256: sha256OfText(content),
    })
  }
  if (input.checkCommand.length === 0) {
    const detail = '未配置提交检查命令；不能提交。请先配置 autonomy.commitCheckCommand 并修复问题'
    const checkOutput = `${detail}\n`
    await writeFile(checkPath, checkOutput, 'utf8')
    return failure(detail, {
      checkLogPath: checkPath,
      checkSha256: sha256OfText(checkOutput),
    })
  }
  const check = await runCommand(
    input.checkCommand[0] ?? '',
    input.checkCommand.slice(1),
    worktree,
    input.timeoutMs,
  )
  const checkPassed = check.code === 0
  const checkDetail = `提交检查退出码 ${check.code}`
  const checkOutput = `${JSON.stringify(input.checkCommand)}\nexit_code: ${check.code}\n${check.stdout}\n${check.stderr}\n`
  await writeFile(checkPath, checkOutput, 'utf8')
  const checkSha256 = sha256OfText(checkOutput)
  if (!checkPassed) return failure(checkDetail, { checkLogPath: checkPath, checkSha256 })
  return { ok: true, checkOutput, checkSha256 }
}

export async function integrateCandidate(input: {
  readonly projectPath: string
  readonly candidateDiffPath: string
  readonly candidateBaseline: string
  readonly expectedDiffSha256: string
  readonly checkCommand: readonly string[]
  readonly commitMessage: string
  readonly evidenceDir: string
  readonly timeoutMs: number
}): Promise<IntegrationResult> {
  const diff = await readCandidateDiff(input)
  if (typeof diff !== 'string') return diff
  const lockPath = join(input.projectPath, '.git', 'forgeloop-commit.lock')
  try {
    mkdirSync(lockPath)
  } catch {
    return failure('另一个 ForgeLoop 提交正在进行；保留双方现场，等待锁释放')
  }
  try {
    const preflight = await preflightProject(input)
    if (preflight) return preflight

    mkdirSync(input.evidenceDir, { recursive: true })
    const checkPath = join(input.evidenceDir, 'commit-check.log')
    const worktree = join(input.evidenceDir, 'check-worktree')
    try {
      const checked = await applyAndCheck(input, worktree, checkPath)
      if (!('checkOutput' in checked)) return checked
      const { checkOutput, checkSha256 } = checked
      // 工作树与暂存区。任何他人在途改动都阻断，绝不 reset/clean 或覆盖。
      const recheck = await recheckBeforeCommit(input, checkPath, checkOutput)
      if (recheck) return recheck
      const checkApply = await runCommand(
        'git',
        ['apply', '--check', '--binary', input.candidateDiffPath],
        input.projectPath,
        30_000,
      )
      if (checkApply.code !== 0) {
        return {
          ok: false,
          checkPassed: true,
          commitSha: '',
          files: [],
          checkLogPath: checkPath,
          checkSha256,
          detail: `提交前候选无法干净应用：${checkApply.stderr.trim() || checkApply.stdout.trim()}`,
        }
      }
      const staged = await runCommand(
        'git',
        ['apply', '--index', '--binary', input.candidateDiffPath],
        input.projectPath,
        60_000,
      )
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
      const files = (await requireGit(input.projectPath, ['diff', '--cached', '--name-only']))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const stagedDiff = await git(input.projectPath, ['diff', '--cached', '--binary'])
      if (stagedDiff.code !== 0 || sha256OfText(stagedDiff.stdout) !== input.expectedDiffSha256) {
        await runCommand('git', ['reset'], input.projectPath, 30_000)
        return {
          ok: false,
          checkPassed: true,
          commitSha: '',
          files,
          checkLogPath: checkPath,
          checkSha256,
          detail: '暂存内容与获准候选不一致；已撤销本次暂存，未提交',
        }
      }
      // 该仓库的 pre-commit 钩子安装但缺少 .pre-commit-config.yaml；这不是候选缺陷。
      // 有配置时正常跑钩子；没有配置时只允许钩子自身跳过，不执行任何检查绕过。
      const commitEnv = existsSync(join(input.projectPath, '.pre-commit-config.yaml'))
        ? {}
        : { PRE_COMMIT_ALLOW_NO_CONFIG: '1' }
      const commit = await runCommand(
        'git',
        ['commit', '-m', input.commitMessage],
        input.projectPath,
        {
          timeoutMs: 60_000,
          env: commitEnv,
        },
      )
      if (commit.code !== 0) {
        await runCommand('git', ['reset'], input.projectPath, 30_000)
        await runCommand(
          'git',
          ['apply', '-R', '--binary', input.candidateDiffPath],
          input.projectPath,
          30_000,
        )
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
      const commitSha = (await requireGit(input.projectPath, ['rev-parse', 'HEAD'])).trim()
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
      await worktreeRemove(input.projectPath, worktree)
    }
  } finally {
    rmSync(lockPath, { recursive: true, force: true })
  }
}
