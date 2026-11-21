import { spawn } from 'node:child_process'
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256OfText } from '../domain/delivery.js'
import { RuleViolationError } from '../domain/errors.js'

export interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunCommandOptions {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  options: number | RunCommandOptions = 120_000,
): Promise<CommandResult> {
  const timeoutMs = typeof options === 'number' ? options : (options.timeoutMs ?? 120_000)
  const extraEnv = typeof options === 'number' ? {} : (options.env ?? {})
  // 研发副本与快照工作区在临时目录下会复制 `docs/verification/evidence/**` 里的长文件名；
  // Windows 默认 260 字符上限会让 `git add -A` 直接失败。按次传 `-c`，不改全局配置。
  const commandArgs = command === 'git' ? ['-c', 'core.longpaths=true', ...args] : [...args]
  return new Promise<CommandResult>((resolve) => {
    let settled = false
    let timedOut = false
    let overflow = false
    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let captured = 0
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      if (overflow) return
      captured += chunk.length
      if (captured > MAX_OUTPUT_BYTES) {
        overflow = true
        child.kill('SIGTERM')
        return
      }
      sink.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    // 限额 -1（不限）与 0 都不建超时；不能把「不限」变成立即失败。
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            child.kill('SIGTERM')
          }, timeoutMs)
        : undefined
    timer?.unref()
    const text = (chunks: readonly Buffer[]): string => Buffer.concat([...chunks]).toString('utf8')
    child.once('error', (error: Error) => {
      if (timer) clearTimeout(timer)
      finish({ code: 1, stdout: text(stdout), stderr: error.message })
    })
    child.once('close', (code: number | null) => {
      if (timer) clearTimeout(timer)
      const out = text(stdout)
      const err = text(stderr)
      if (timedOut) {
        finish({ code: 1, stdout: out, stderr: err || `命令超时（${timeoutMs} 毫秒）` })
        return
      }
      if (overflow) {
        finish({ code: 1, stdout: out, stderr: err || `命令输出超过 ${MAX_OUTPUT_BYTES} 字节` })
        return
      }
      finish({ code: code ?? 1, stdout: out, stderr: code === 0 ? '' : err })
    })
  })
}

export async function git(cwd: string, args: readonly string[]): Promise<CommandResult> {
  return await runCommand('git', args, cwd)
}

export async function requireGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args)
  if (result.code !== 0) {
    throw new RuleViolationError(
      `git ${args.join(' ')} 失败：${result.stderr.trim() || result.stdout.trim()}`,
    )
  }
  return result.stdout.trim()
}

export async function headCommit(projectPath: string): Promise<string> {
  return await requireGit(projectPath, ['rev-parse', 'HEAD'])
}

export interface SnapshotResult {
  readonly baselineCommit: string
  readonly snapshotSha256: string
  readonly fileCount: number
  readonly workspacePath: string
}

async function listSnapshotFiles(projectPath: string): Promise<string[]> {
  const tracked = (await requireGit(projectPath, ['ls-files', '-z'])).split('\0')
  const untracked = (
    await requireGit(projectPath, ['ls-files', '--others', '--exclude-standard', '-z'])
  ).split('\0')
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort()
}

export async function prepareSnapshotWorkspace(input: {
  projectPath: string
  workspacePath: string
  baselineCommit: string
}): Promise<SnapshotResult> {
  await rm(input.workspacePath, { recursive: true, force: true })
  await mkdir(input.workspacePath, { recursive: true })
  const files = await listSnapshotFiles(input.projectPath)
  const digestParts: string[] = []
  for (const relative of files) {
    const source = join(input.projectPath, relative)
    let metadata
    try {
      metadata = await stat(source)
    } catch {
      continue
    }
    if (!metadata.isFile()) continue
    const target = join(input.workspacePath, relative)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    digestParts.push(`${relative}:${metadata.size}:${metadata.mtimeMs}`)
  }
  await requireGit(input.workspacePath, ['init', '-q'])
  await requireGit(input.workspacePath, ['config', 'user.email', 'forgeloop@localhost'])
  await requireGit(input.workspacePath, ['config', 'user.name', 'ForgeLoop Snapshot'])
  // 副本本身也写入 longpaths，后续由 Agent 或测试发起的 git 命令同样受益。
  await requireGit(input.workspacePath, ['config', 'core.longpaths', 'true'])
  await requireGit(input.workspacePath, ['add', '-A'])
  await requireGit(input.workspacePath, ['commit', '-qm', 'forgeloop baseline snapshot'])
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

export async function captureCandidate(input: {
  worktreePath: string
  allowedFiles?: readonly string[]
  diffPath: string
}): Promise<CandidateCapture> {
  await requireGit(input.worktreePath, ['add', '-A'])
  const rawDiff = await git(input.worktreePath, ['diff', '--cached', '--binary'])
  if (rawDiff.code !== 0) {
    throw new RuleViolationError(`生成候选 diff 失败：${rawDiff.stderr.trim()}`)
  }
  const changed = (await requireGit(input.worktreePath, ['diff', '--cached', '--name-only']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  // 保留原始换行：`patch`/`git apply` 要求 diff 以换行结束，不能 trim。
  const diff = rawDiff.stdout.endsWith('\n') ? rawDiff.stdout : `${rawDiff.stdout}\n`
  const allowed = input.allowedFiles ? new Set(input.allowedFiles) : null
  const violations = allowed ? changed.filter((file) => !allowed.has(file)) : []
  const diffSha256 = sha256OfText(diff)
  await mkdir(dirname(input.diffPath), { recursive: true })
  await writeFile(input.diffPath, diff, 'utf8')
  return { diff, diffSha256, changedFiles: changed, violations, diffPath: input.diffPath }
}
