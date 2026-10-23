/**
 * Git 工作副本：每个任务一个独立 worktree，开发改动只落在副本里。
 * 交付候选 = 暂存后的二进制 diff（含未跟踪文件），并核对改动是否在批准的文件清单内。
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sha256OfText } from '../domain/delivery.js'
import { RuleViolationError } from '../domain/errors.js'

export interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export function runCommand(command: string, args: readonly string[], cwd: string, timeoutMs = 120_000): CommandResult {
  try {
    const stdout = execFileSync(command, [...args], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string }
    return {
      code: typeof failure.status === 'number' ? failure.status : 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : (failure.message ?? ''),
    }
  }
}

export function git(cwd: string, args: readonly string[]): CommandResult {
  return runCommand('git', args, cwd)
}

export function requireGit(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args)
  if (result.code !== 0) {
    throw new RuleViolationError(`git ${args.join(' ')} 失败：${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout.trim()
}

export function headCommit(projectPath: string): string {
  return requireGit(projectPath, ['rev-parse', 'HEAD'])
}

export function ensureWorktree(projectPath: string, worktreePath: string, baseline: string): void {
  mkdirSync(dirname(worktreePath), { recursive: true })
  // 旧副本可能残留：先按 worktree 注册信息移除，再兜底删除目录。
  git(projectPath, ['worktree', 'remove', '--force', worktreePath])
  rmSync(worktreePath, { recursive: true, force: true })
  requireGit(projectPath, ['worktree', 'add', '--detach', worktreePath, baseline])
}

export function removeWorktree(projectPath: string, worktreePath: string): void {
  git(projectPath, ['worktree', 'remove', '--force', worktreePath])
  git(projectPath, ['worktree', 'prune'])
}

export interface SnapshotResult {
  readonly baselineCommit: string
  readonly snapshotSha256: string
  readonly fileCount: number
  readonly workspacePath: string
}

function listSnapshotFiles(projectPath: string): string[] {
  const tracked = requireGit(projectPath, ['ls-files', '-z']).split('\0')
  const untracked = requireGit(projectPath, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort()
}

/**
 * 在当前工作树（含未提交在途改动）上建立独立执行副本。
 *
 * 不能用 `git worktree`：本轮基线包含其他执行方尚未提交的实现，只从 HEAD 取树会漏掉它们。
 * 因此按 Git 跟踪清单 + 未忽略的新文件逐个复制到任务目录，再在该副本里初始化一个
 * 仅用于采集 diff 的临时仓库；产品仓库不会因此产生提交或引用。
 */
export function prepareSnapshotWorkspace(input: {
  projectPath: string
  workspacePath: string
  baselineCommit: string
}): SnapshotResult {
  rmSync(input.workspacePath, { recursive: true, force: true })
  mkdirSync(input.workspacePath, { recursive: true })
  const files = listSnapshotFiles(input.projectPath)
  const digestParts: string[] = []
  for (const relative of files) {
    // legacy/ 是明确隔离的历史快照，不进入候选开发副本，避免无谓复制与误改。
    if (relative === 'legacy' || relative.startsWith('legacy/')) continue
    const source = join(input.projectPath, relative)
    let stat
    try {
      stat = statSync(source)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const target = join(input.workspacePath, relative)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    digestParts.push(`${relative}:${stat.size}:${stat.mtimeMs}`)
  }
  requireGit(input.workspacePath, ['init', '-q'])
  requireGit(input.workspacePath, ['config', 'user.email', 'forgeloop@localhost'])
  requireGit(input.workspacePath, ['config', 'user.name', 'ForgeLoop Snapshot'])
  requireGit(input.workspacePath, ['add', '-A'])
  requireGit(input.workspacePath, ['commit', '-qm', 'forgeloop baseline snapshot'])
  return {
    baselineCommit: input.baselineCommit,
    snapshotSha256: sha256OfText(digestParts.join('\n')),
    fileCount: digestParts.length,
    workspacePath: input.workspacePath,
  }
}

export interface CandidateCapture {
  readonly diff: string
  readonly diffSha256: string
  readonly changedFiles: readonly string[]
  readonly violations: readonly string[]
  readonly diffPath: string
}

/** 暂存全部改动并生成候选 diff；同时给出越出批准文件清单的改动。 */
export function captureCandidate(input: {
  worktreePath: string
  allowedFiles: readonly string[]
  diffPath: string
}): CandidateCapture {
  requireGit(input.worktreePath, ['add', '-A'])
  const rawDiff = git(input.worktreePath, ['diff', '--cached', '--binary'])
  if (rawDiff.code !== 0) {
    throw new RuleViolationError(`生成候选 diff 失败：${rawDiff.stderr.trim()}`)
  }
  const changed = requireGit(input.worktreePath, ['diff', '--cached', '--name-only'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  // 保留原始换行：`patch`/`git apply` 要求 diff 以换行结束，不能 trim。
  const diff = rawDiff.stdout.endsWith('\n') ? rawDiff.stdout : `${rawDiff.stdout}\n`
  const allowed = new Set(input.allowedFiles)
  const violations = changed.filter((file) => !allowed.has(file))
  const diffSha256 = sha256OfText(diff)
  mkdirSync(dirname(input.diffPath), { recursive: true })
  writeFileSync(input.diffPath, diff, 'utf8')
  return { diff, diffSha256, changedFiles: changed, violations, diffPath: input.diffPath }
}

/** 采集副本相对快照基线的新增文件（用于“无改动”判定）。 */
export function changedSinceBaseline(worktreePath: string): string[] {
  return requireGit(worktreePath, ['status', '--porcelain'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 工作副本是否相对基线有改动（用于开发步骤的“无改动”判定）。 */
export function hasChanges(worktreePath: string): boolean {
  const status = requireGit(worktreePath, ['status', '--porcelain'])
  return status.length > 0
}