/**
 * 执行敏感性对照：把声明的受控错误补丁应用到候选的隔离副本，重跑同一必过命令，
 * 要求它按目标业务规则失败。正式候选不被修改；对照副本、日志与结果作为证据保留。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
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
  /** 依赖根（通常是项目工作树）；验证副本人造工作区缺少 node_modules 时回退到它。 */
  readonly dependencyRoot?: string
  /** 正向执行时冻结的材料摘要；对照必须使用同一份材料。 */
  readonly expectedMaterialsSha256?: string
  readonly run: (input: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly logPath: string
  }) => Promise<ControlCommandRun>
}

/** 只有“非零退出且输出命中目标规则证据”才算对照成立。 */
function judgeControlRun(run: ControlCommandRun, control: VerificationControlSpec): string {
  if (run.aborted) return `敏感性对照被中止：${control.label}`
  if (run.timedOut) return `敏感性对照超时：${control.label}`
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

/**
 * 复制候选到隔离副本：保留 Git 元数据的一份独立仓库，验证命令可检查 git status/diff，
 * 但补丁只能落在副本内。先复制源码与验证材料，再初始化并提交基线，最后应用错误补丁。
 */
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
    try {
      symlinkSync(modules, join(controlDir, 'node_modules'), 'dir')
    } catch {
      // 依赖无法链接时让对照命令自己失败；环境问题会由分类器识别，不伪造成敏感性证明。
    }
  }
}

/**
 * 逐条执行对照。任何一条无法证明敏感性都返回 issue；调用方仍可保留通过的主命令结果，
 * 但整体验证不得通过。
 */
export async function executeVerificationControls(
  input: ExecuteControlsInput,
): Promise<{ results: ControlExecutionResult[]; issues: string[] }> {
  const byLabel = new Map(input.commands.map((command) => [command.label, command]))
  const issues: string[] = []
  if (
    input.expectedMaterialsSha256 !== undefined &&
    input.expectedMaterialsSha256 !== verificationMaterialDigest(input.workspace)
  ) {
    const detail = '验证材料在正向执行后发生变化；旧结果不能与新材料拼成敏感性对照'
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
    const controlDir = join(input.dir, 'controls', safeName(control.label))
    let applied = false
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
      copyCandidate(input.workspace, controlDir, input.dependencyRoot)
      const check = runCommand('git', ['apply', '--check', patchPath], controlDir, 30_000)
      if (check.code !== 0) {
        issue = `敏感性对照补丁无法应用：${(check.stderr || check.stdout).trim() || `退出码 ${check.code}`}`
      } else {
        const appliedResult = runCommand('git', ['apply', patchPath], controlDir, 30_000)
        if (appliedResult.code !== 0) {
          issue = `敏感性对照补丁应用失败：${(appliedResult.stderr || appliedResult.stdout).trim()}`
        } else {
          applied = true
          run = await input.run({
            argv: command.argv,
            cwd: controlDir,
            logPath: join(input.dir, 'controls', `${safeName(control.label)}.log`),
          })
          issue = judgeControlRun(run, control)
        }
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
