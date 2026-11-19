import { createHash } from 'node:crypto'
import { bestEffort } from './best-effort.js'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { controlPatchTargets } from '../domain/verification-controls.js'
import type { VerificationCommand } from '../domain/verification.js'
import { matchesCommandOutput } from '../domain/verification.js'
import type { VerificationControlSpec } from '../domain/verification-controls.js'
import { validateControlPatch } from '../domain/verification-controls.js'
import { errorMessage } from '../domain/errors.js'
import { runCommand } from './workspace.js'
import { verificationMaterialDigest } from './verification-materials.js'

export interface ControlExecutionResult {
  readonly label: string
  readonly patch: string
  readonly controlDir: string
  readonly applied: boolean
  readonly changedFiles: readonly string[]
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly durationMs: number
  readonly output: string
  readonly logPath: string
  readonly logSha256: string
  readonly issue: string
}

export interface ControlCommandRun {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly durationMs: number
  readonly output: string
  readonly logPath: string
  readonly logSha256: string
}

export interface ExecuteControlsInput {
  readonly workspace: string
  readonly dir: string
  readonly commands: readonly Pick<VerificationCommand, 'label' | 'argv'>[]
  readonly controls: readonly VerificationControlSpec[]
  readonly dependencyRoot?: string
  readonly expectedMaterialsSha256?: string
  readonly run: (input: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly logPath: string
  }) => Promise<ControlCommandRun>
}

function judgeControlRun(run: ControlCommandRun, control: VerificationControlSpec): string {
  if (run.aborted) return `敏感性对照被中止：${control.label}`
  if (run.timedOut) return `敏感性对照超时：${control.label}`
  if (run.exitCode === null) return `敏感性对照没有取得退出码：${control.label}`
  if (run.exitCode === 0) {
    return `必过用例在已知错误实现上仍然通过，不能证明它能发现错误行为：${control.label}`
  }
  if (!matchesCommandOutput(run.output, control.expectedFailureOutput)) {
    return `敏感性对照的失败输出未包含目标业务规则证据：${control.label}（预期 ${control.expectedFailureOutput}）`
  }
  return ''
}

function safeName(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
  return cleaned || 'control'
}

function copyCandidate(workspace: string, controlDir: string, dependencyRoot?: string): void {
  rmSync(controlDir, { recursive: true, force: true })
  mkdirSync(controlDir, { recursive: true })
  cpSync(workspace, controlDir, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(workspace.length).replace(/^[/\\]/, '')
      const segment = relative.split(/[/\\]/)[0]
      return segment !== 'node_modules' && segment !== '.git'
    },
  })
  const initialized = runCommand('git', ['init', '-q'], controlDir, 30_000)
  if (initialized.code !== 0) {
    throw new Error(`无法初始化对照副本：${initialized.stderr.trim()}`)
  }
  runCommand('git', ['add', '-A'], controlDir, 60_000)
  runCommand(
    'git',
    [
      '-c',
      'user.email=forgeloop@example.invalid',
      '-c',
      'user.name=ForgeLoop',
      'commit',
      '-qm',
      'control baseline',
    ],
    controlDir,
    60_000,
  )
  const candidates = [join(workspace, 'node_modules')]
  if (dependencyRoot) candidates.push(join(dependencyRoot, 'node_modules'))
  const modules = candidates.find((path) => existsSync(path))
  if (modules) {
    bestEffort(() => {
      symlinkSync(modules, join(controlDir, 'node_modules'), 'dir')
    })
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 目标文件的内容摘要；补丁只有真的改了这些内容才算生效。 */
function targetDigests(root: string, targets: readonly string[]): Map<string, string> {
  const digests = new Map<string, string>()
  for (const target of targets) {
    const path = join(root, target)
    // 也不能把目录当成补丁目标。
    const present = existsSync(path) && statSync(path).isFile()
    digests.set(
      target,
      present ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'missing',
    )
  }
  return digests
}

/**
 * 对照副本必须落在候选之外：默认 recordsRoot 在项目内，直接复制到候选子目录会递归复制，
 * 补丁也会在候选自己的仓库里执行，出现“git 返回成功但候选没被隔离”的假证据。
 */
function isolatedControlDir(workspace: string, controlDir: string): string {
  if (!inside(workspace, controlDir)) return controlDir
  return mkdtempSync(join(tmpdir(), 'forgeloop-control-'))
}

function applyControlPatch(
  workspace: string,
  controlDirInput: string,
  patchPath: string,
  dependencyRoot?: string,
): { applied: boolean; changedFiles: string[]; issue: string; controlDir: string } {
  const controlDir = isolatedControlDir(workspace, controlDirInput)
  const targets = controlPatchTargets(readFileSync(patchPath, 'utf8'))
  copyCandidate(workspace, controlDir, dependencyRoot)
  const before = targetDigests(controlDir, targets)
  const candidateBefore = targetDigests(workspace, targets)
  const check = runCommand('git', ['apply', '--check', patchPath], controlDir, 30_000)
  if (check.code !== 0) {
    return {
      applied: false,
      changedFiles: [],
      issue: `敏感性对照补丁无法应用：${(check.stderr || check.stdout).trim() || `退出码 ${check.code}`}`,
      controlDir,
    }
  }
  const applied = runCommand('git', ['apply', patchPath], controlDir, 30_000)
  if (applied.code !== 0) {
    return {
      applied: false,
      changedFiles: [],
      issue: `敏感性对照补丁应用失败：${(applied.stderr || applied.stdout).trim()}`,
      controlDir,
    }
  }
  const after = targetDigests(controlDir, targets)
  const unchanged = targets.filter((target) => before.get(target) === after.get(target))
  if (unchanged.length > 0) {
    return {
      applied: false,
      changedFiles: [],
      issue: `敏感性对照补丁应用后目标文件内容没有变化：${unchanged.join(',')}`,
      controlDir,
    }
  }
  const candidateAfter = targetDigests(workspace, targets)
  const touched = targets.filter(
    (target) => candidateBefore.get(target) !== candidateAfter.get(target),
  )
  if (touched.length > 0) {
    return {
      applied: false,
      changedFiles: [],
      issue: `敏感性对照改动了原候选：${touched.join(',')}`,
      controlDir,
    }
  }
  const status = runCommand('git', ['status', '--porcelain'], controlDir, 30_000)
  const changedFiles = status.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0)
  return {
    applied: true,
    changedFiles,
    issue: changedFiles.length === 0 ? '敏感性对照补丁没有改变任何业务文件' : '',
    controlDir,
  }
}

export async function executeVerificationControls(
  input: ExecuteControlsInput,
): Promise<{ results: ControlExecutionResult[]; issues: string[] }> {
  const byLabel = new Map(input.commands.map((command) => [command.label, command]))
  const issues: string[] = []
  if (
    input.expectedMaterialsSha256 !== undefined &&
    input.expectedMaterialsSha256 !== verificationMaterialDigest(input.workspace)
  ) {
    const detail = '测试材料在正向执行后发生变化；旧结果不能与新材料拼成敏感性对照'
    issues.push(detail)
    return {
      results: [],
      issues: [detail],
    }
  }
  const results: ControlExecutionResult[] = []
  for (const control of input.controls) {
    const command = byLabel.get(control.label)
    if (!command) {
      issues.push(`敏感性对照引用了未声明的命令：${control.label}`)
      continue
    }
    const patchPath = join(input.workspace, control.patch)
    if (!existsSync(patchPath)) {
      issues.push(`敏感性对照补丁不存在：${control.patch}`)
      continue
    }
    const patch = readFileSync(patchPath, 'utf8')
    const patchIssues = validateControlPatch(patch)
    if (patchIssues.length > 0) {
      issues.push(...patchIssues.map((issue) => `${control.label}：${issue}`))
      continue
    }
    const requestedDir = join(input.dir, 'controls', safeName(control.label))
    let controlDir = requestedDir
    let applied = false
    let changedFiles: string[] = []
    let run: ControlCommandRun = {
      exitCode: null,
      timedOut: false,
      aborted: false,
      durationMs: 0,
      output: '敏感性对照未执行',
      logPath: '',
      logSha256: '',
    }
    let issue = ''
    try {
      const prepared = applyControlPatch(
        input.workspace,
        requestedDir,
        patchPath,
        input.dependencyRoot,
      )
      controlDir = prepared.controlDir
      applied = prepared.applied
      changedFiles = prepared.changedFiles
      issue = prepared.issue
      if (!issue) {
        run = await input.run({
          argv: command.argv,
          cwd: controlDir,
          logPath: join(controlDir, '..', `${safeName(control.label)}.log`),
        })
        issue = judgeControlRun(run, control)
      }
    } catch (error) {
      issue = `敏感性对照执行异常：${errorMessage(error)}`
    }
    if (issue) issues.push(issue)
    results.push({
      label: control.label,
      patch: control.patch,
      controlDir,
      applied,
      changedFiles,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      aborted: run.aborted,
      durationMs: run.durationMs,
      output: run.output.slice(0, 4000),
      logPath: run.logPath,
      logSha256: run.logSha256,
      issue,
    })
  }
  return { results, issues }
}
