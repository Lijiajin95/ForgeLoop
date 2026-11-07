/**
 * 验证会话的命令执行上下文。
 *
 * 验证 Agent 在产物交付后通过 `forgeloop_run_verification_check` 工具逐条执行
 * 当前验证方案中的命令；运行时只接受“当前候选 + 当前方案”里已列出的 label，
 * 不允许模型任意输入命令。退出码、超时、中止、输出与日志全部由程序记录，
 * 模型自述不能替代真实执行结果。同一 label 在一个候选上幂等，重复调用返回已有结果。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
  VerificationCheckPlan,
  VerificationCheckRun,
  VerificationPlan,
} from '../domain/verification.js'
import { RuleViolationError, errorMessage } from '../domain/errors.js'
import { sha256OfText } from '../domain/delivery.js'
import type { runFormalTest } from './formal-test.js'
import {
  VERIFICATION_MATERIAL_DIR,
  businessReviewEvidenceWindow,
  workspaceChanges,
} from './service-helpers.js'
import { requireGit } from './workspace.js'
import { executeVerificationControls } from './verification-controls.js'
import {
  parseVerificationControls,
  validateControlPatch,
  type VerificationControlSpec,
} from '../domain/verification-controls.js'

export const VERIFICATION_CHECK_TOOL = 'forgeloop_run_verification_check'
export const VERIFICATION_CONTROL_TOOL = 'forgeloop_write_verification_control'
export const VERIFICATION_MATERIAL_TOOL = 'forgeloop_write_verification_material'

/** 一条通过工具执行并落日志的验证命令。 */
export interface VerificationCheckRecord extends VerificationCheckRun {
  readonly logPath: string
  readonly logSha256: string
}

/** 一个候选上的验证执行上下文；方案与会话由调用方固定。 */
export interface VerificationCheckActivation {
  readonly reqId: string
  readonly candidateSha256: string
  readonly workspace: string
  readonly dir: string
  readonly head: string
  readonly plan: VerificationPlan
  readonly signal: AbortSignal
  /** 单条验证命令的宿主超时；由运行时按正式测试上限注入。 */
  readonly timeoutMs: number
  /** 宿主提供的验证会话身份；工具调用必须与之一致。 */
  readonly sessionId?: string
  /** 本候选的验证尝试身份；工具调用必须与之一致。 */
  readonly attemptId?: string
}

export interface VerificationCheckSnapshot {
  readonly runs: readonly VerificationCheckRecord[]
  readonly integrityIssues: readonly string[]
  readonly startedAt: string
}

export interface VerificationCheckActivationHandle {
  readonly token: string
  release(): void
}

export interface VerificationCheckOutcome {
  readonly ok: boolean
  readonly text: string
  readonly data?: Record<string, unknown>
}

interface ActiveContext {
  readonly token: string
  readonly activation: VerificationCheckActivation
  readonly runs: Map<string, VerificationCheckRecord>
  readonly integrityIssues: string[]
  readonly startedAt: string
  /** 第一条命令执行前封存的 verification/ 材料摘要。 */
  materialsSha256?: string
}

export interface VerificationCheckRegistryDeps {
  readonly ctx: NonNullable<Parameters<typeof runFormalTest>[0]['ctx']>
  readonly formalTest: typeof runFormalTest
  readonly now: () => string
}

function planChecks(plan: VerificationPlan): VerificationCheckPlan[] {
  return plan.scenarios.flatMap((scenario) => scenario.checks)
}

/** 验证材料摘要：排除 controls（对照单独按补丁摘要绑定），用于发现正向之后的换脚本。 */
export function verificationMaterialsDigest(workspace: string): string {
  const root = join(workspace, VERIFICATION_MATERIAL_DIR)
  if (!existsSync(root)) return ''
  const entries: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name
      if (relative === 'controls' || relative === 'controls.json') continue
      const path = join(dir, item.name)
      if (item.isDirectory()) {
        walk(path, relative)
        continue
      }
      const digest = item.isSymbolicLink()
        ? `link:${readlinkSync(path)}`
        : createHash('sha256').update(readFileSync(path)).digest('hex')
      entries.push(`${relative}:${digest}`)
    }
  }
  walk(root, '')
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

/** 工具路径只能经过真实目录；任何符号链接都拒绝，避免写出工作区。 */
function safeMaterialTarget(workspace: string, relative: string): string {
  if (!relative.startsWith('verification/') || relative.includes('..')) {
    throw new RuleViolationError('验证材料路径必须位于 verification/ 下')
  }
  let current = realpathSync(workspace)
  const parts = relative.split('/').filter(Boolean)
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink()) {
        throw new RuleViolationError(`验证材料路径不能经过符号链接：${relative}`)
      }
      continue
    }
    mkdirSync(current)
  }
  const target = join(current, parts[parts.length - 1] ?? '')
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new RuleViolationError(`验证材料文件不能是符号链接：${relative}`)
  }
  const verification = join(realpathSync(workspace), 'verification')
  const parent = realpathSync(current)
  if (parent !== verification && !parent.startsWith(`${verification}/`)) {
    throw new RuleViolationError(`验证材料路径越出 verification/：${relative}`)
  }
  return target
}

function callerIssue(
  context: ActiveContext,
  caller?: { readonly sessionId?: string; readonly attemptId?: string },
): string | null {
  const expectedSession = context.activation.sessionId
  if (caller?.sessionId && expectedSession && caller.sessionId !== expectedSession) {
    return `验证会话不一致：当前上下文属于 ${expectedSession}，调用来自 ${caller.sessionId}`
  }
  const expectedAttempt = context.activation.attemptId
  if (caller?.attemptId && expectedAttempt && caller.attemptId !== expectedAttempt) {
    return `验证尝试不一致：当前上下文属于 ${expectedAttempt}，调用来自 ${caller.attemptId}`
  }
  return null
}

function safeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
  return cleaned || 'check'
}

export class VerificationCheckRegistry {
  private readonly contexts = new Map<string, ActiveContext>()

  constructor(private readonly deps: VerificationCheckRegistryDeps) {}

  /** 为一个候选登记执行上下文；返回的释放函数必须在该候选验证结束时调用。 */
  activate(activation: VerificationCheckActivation): VerificationCheckActivationHandle {
    const existing = this.contexts.get(activation.reqId)
    if (existing) {
      throw new RuleViolationError(
        `需求 ${activation.reqId} 已有进行中的验证执行上下文；不能并发验证同一需求`,
      )
    }
    const token = randomUUID()
    this.contexts.set(activation.reqId, {
      token,
      activation,
      runs: new Map(),
      integrityIssues: [],
      startedAt: this.deps.now(),
    })
    return {
      token,
      release: () => {
        const current = this.contexts.get(activation.reqId)
        if (current?.token === token) this.contexts.delete(activation.reqId)
      },
    }
  }

  /** 读取并固定本次执行的命令结果；之后释放上下文也不会丢证据。 */
  snapshot(reqId: string, token: string): VerificationCheckSnapshot | null {
    const context = this.contexts.get(reqId)
    if (!context || context.token !== token) return null
    return {
      runs: [...context.runs.values()],
      integrityIssues: [...context.integrityIssues],
      startedAt: context.startedAt,
    }
  }

  /** 工具入口：只执行当前方案中的 label；未登记上下文或方案外命令一律拒绝。 */
  async run(
    reqId: string,
    label: string,
    caller?: { readonly sessionId?: string; readonly attemptId?: string },
  ): Promise<VerificationCheckOutcome> {
    const context = this.contexts.get(reqId)
    if (!context) {
      return {
        ok: false,
        text: `没有正在进行的验证：${reqId}。只有验证会话在研发产物交付后可以执行验证方案中的命令。`,
      }
    }
    const identity = callerIssue(context, caller)
    if (identity) return { ok: false, text: identity }
    const check = planChecks(context.activation.plan).find((item) => item.label === label)
    if (!check) {
      return {
        ok: false,
        text: `命令 ${label} 不在当前验证方案中；只能执行方案里已经列出的 label。`,
      }
    }
    const existing = context.runs.get(label)
    if (existing) return this.outcome(existing, context, true)
    context.materialsSha256 ??= verificationMaterialsDigest(context.activation.workspace)
    if (context.activation.signal.aborted) {
      const aborted: VerificationCheckRecord = {
        label,
        argv: check.argv,
        expectFailure: check.expectFailure,
        ...(check.category ? { category: check.category } : {}),
        materialsSha256: context.materialsSha256,
        exitCode: null,
        timedOut: false,
        aborted: true,
        durationMs: 0,
        output: '验证命令未执行：收到停止请求',
        logPath: '',
        logSha256: '',
      }
      context.runs.set(label, aborted)
      return this.outcome(aborted, context, false)
    }
    const headBefore = this.headOf(context)
    if (headBefore !== context.activation.head) {
      this.addIntegrityIssue(context, '验证期间候选提交发生变化')
      return {
        ok: false,
        text: '候选提交在验证开始后发生变化；本次命令没有执行，验证将被阻断。',
        data: { label, integrityIssues: [...context.integrityIssues] },
      }
    }
    const index = context.runs.size + 1
    const logPath = join(context.activation.dir, `verification-${index}-${safeLabel(label)}.log`)
    let execution: VerificationCheckRun
    try {
      const test = await this.deps.formalTest({
        ctx: this.deps.ctx,
        cwd: context.activation.workspace,
        argv: check.argv,
        timeoutMs: context.activation.timeoutMs,
        logPath,
        signal: context.activation.signal,
      })
      execution = {
        label,
        argv: check.argv,
        expectFailure: check.expectFailure,
        ...(check.category ? { category: check.category } : {}),
        materialsSha256: context.materialsSha256,
        exitCode: test.exitCode,
        timedOut: test.timedOut,
        aborted: test.aborted,
        durationMs: test.durationMs,
        output: test.output,
      }
      const record: VerificationCheckRecord = {
        ...execution,
        logPath: test.logPath,
        logSha256: test.logSha256,
      }
      context.runs.set(label, record)
      this.checkIntegrity(context)
      return this.outcome(record, context, false)
    } catch (error) {
      execution = {
        label,
        argv: check.argv,
        expectFailure: check.expectFailure,
        ...(check.category ? { category: check.category } : {}),
        materialsSha256: context.materialsSha256,
        exitCode: null,
        timedOut: false,
        aborted: false,
        durationMs: 0,
        output: `验证命令执行异常：${errorMessage(error)}`,
      }
      const record: VerificationCheckRecord = {
        ...execution,
        logPath: '',
        logSha256: '',
      }
      context.runs.set(label, record)
      return this.outcome(record, context, false)
    }
  }

  /**
   * 工具入口：为一条已登记命令写入敏感性对照并立即自检。
   * 补丁只能落在 verification/controls/，且必须修改 verification/ 之外的业务文件；
   * controls.json 由运行时合并。自检返回真实失败输出，模型可据此修正 expected_failure_output。
   */
  async writeControl(
    reqId: string,
    input: { label: string; patch: string; expectedFailureOutput: string },
    caller?: { readonly sessionId?: string; readonly attemptId?: string },
  ): Promise<VerificationCheckOutcome> {
    const context = this.contexts.get(reqId)
    if (!context) {
      return {
        ok: false,
        text: `没有正在进行的验证：${reqId}。只有验证会话可以为已登记命令写入敏感性对照。`,
      }
    }
    const identity = callerIssue(context, caller)
    if (identity) return { ok: false, text: identity }
    const check = planChecks(context.activation.plan).find((item) => item.label === input.label)
    if (!check) {
      return {
        ok: false,
        text: `命令 ${input.label} 不在当前验证方案中；敏感性对照只能绑定方案里的 label。`,
      }
    }
    if (input.expectedFailureOutput.trim().length < 8) {
      return {
        ok: false,
        text: 'expected_failure_output 至少 8 个字符，必须能核对到目标业务规则。',
      }
    }
    const issues = validateControlPatch(input.patch)
    if (issues.length > 0) return { ok: false, text: issues.join('；') }
    const relative = `verification/controls/${safeLabel(input.label)}.patch`
    const spec: VerificationControlSpec = {
      label: input.label,
      patch: relative,
      expectedFailureOutput: input.expectedFailureOutput.trim(),
      patchSha256: sha256OfText(input.patch.trimEnd()),
    }
    let patchPath = ''
    let controlsPath = ''
    try {
      patchPath = safeMaterialTarget(context.activation.workspace, relative)
      writeFileSync(patchPath, `${input.patch.trimEnd()}\n`, 'utf8')
      controlsPath = safeMaterialTarget(context.activation.workspace, 'verification/controls.json')
      const current = existsSync(controlsPath)
        ? parseVerificationControls(readFileSync(controlsPath, 'utf8'))
        : []
      const next = current.filter((item) => item.label !== input.label)
      next.push(spec)
      writeFileSync(controlsPath, `${JSON.stringify({ controls: next }, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, text: `写入敏感性对照失败：${errorMessage(error)}` }
    }
    const selfCheck = await this.runControl(context, check, spec)
    const actual = selfCheck.result
    const detail = actual
      ? `受控副本退出码 ${actual.exitCode === null ? 'null' : actual.exitCode}；输出：\n${actual.output.slice(0, 800)}`
      : '未取得执行结果'
    if (selfCheck.issues.length > 0) {
      // 自检失败不能留下“看起来已登记”的对照：撤销本次写入，要求模型修正后重试。
      try {
        const remaining = parseVerificationControls(readFileSync(controlsPath, 'utf8')).filter(
          (item) => item.label !== input.label,
        )
        writeFileSync(controlsPath, `${JSON.stringify({ controls: remaining }, null, 2)}\n`, 'utf8')
        rmSync(patchPath, { force: true })
      } catch {
        // 回滚失败也按未通过处理；下一轮验证会重新读取材料。
      }
      return {
        ok: false,
        text: `对照自检未通过，已撤销本次对照：${selfCheck.issues.join('；')}。${detail}\n请修正补丁或 expected_failure_output 后重新调用本工具。`,
        data: { label: input.label, issues: selfCheck.issues },
      }
    }
    return {
      ok: true,
      text: `已写入并自检通过敏感性对照 ${relative}；受控副本按预期失败。${detail}`,
      data: { label: input.label, patch: relative },
    }
  }

  /** 工具入口：把验证脚本写到当前候选的 verification/ 下；候选源码不可写。 */
  writeMaterial(
    reqId: string,
    input: { path: string; content: string },
    caller?: { readonly sessionId?: string; readonly attemptId?: string },
  ): VerificationCheckOutcome {
    const context = this.contexts.get(reqId)
    if (!context) {
      return {
        ok: false,
        text: `没有正在进行的验证：${reqId}。只有验证会话可以写入验证材料。`,
      }
    }
    const identity = callerIssue(context, caller)
    if (identity) return { ok: false, text: identity }
    const relative = input.path.trim().replace(/^[/\\]+/, '')
    if (
      !relative.startsWith('verification/') ||
      relative.includes('..') ||
      relative.startsWith('verification/controls')
    ) {
      return {
        ok: false,
        text: '验证材料只能写到 verification/ 下，且不能覆盖 controls/；对照补丁请用敏感性对照工具。',
      }
    }
    try {
      const target = safeMaterialTarget(context.activation.workspace, relative)
      writeFileSync(target, input.content, 'utf8')
      return { ok: true, text: `已写入验证材料 ${relative}。`, data: { path: relative } }
    } catch (error) {
      return { ok: false, text: `写入验证材料失败：${errorMessage(error)}` }
    }
  }

  private async runControl(
    context: ActiveContext,
    check: VerificationCheckPlan,
    spec: VerificationControlSpec,
  ): Promise<{
    issues: string[]
    result: Awaited<ReturnType<typeof executeVerificationControls>>['results'][number] | undefined
  }> {
    const outcome = await executeVerificationControls({
      workspace: context.activation.workspace,
      dir: context.activation.dir,
      commands: [{ label: check.label, argv: check.argv }],
      controls: [spec],
      dependencyRoot: context.activation.workspace,
      run: async ({ argv, cwd, logPath }) => {
        const test = await this.deps.formalTest({
          ctx: this.deps.ctx,
          cwd,
          argv,
          timeoutMs: context.activation.timeoutMs,
          logPath,
          signal: context.activation.signal,
        })
        return {
          exitCode: test.exitCode,
          timedOut: test.timedOut,
          aborted: test.aborted,
          durationMs: test.durationMs,
          output: test.output,
          logPath: test.logPath,
          logSha256: test.logSha256,
        }
      },
    })
    return { issues: outcome.issues, result: outcome.results[0] }
  }

  /**
   * 在隔离副本上执行敏感性对照；只读当前候选，正式工作区不被修改。
   * 未登记上下文时返回 null，由调用方按证据不足阻断。
   */
  async executeControls(
    reqId: string,
    token: string,
    input: {
      readonly commands: readonly { label: string; argv: readonly string[] }[]
      readonly controls: readonly VerificationControlSpec[]
      readonly caller?: { readonly sessionId?: string; readonly attemptId?: string }
    },
  ): Promise<Awaited<ReturnType<typeof executeVerificationControls>> | null> {
    const context = this.contexts.get(reqId)
    if (!context || context.token !== token) return null
    const identity = callerIssue(context, input.caller)
    if (identity) {
      return {
        results: [],
        issues: [identity],
      }
    }
    const current = verificationMaterialsDigest(context.activation.workspace)
    if (context.materialsSha256 && current !== context.materialsSha256) {
      return {
        results: [],
        issues: ['验证材料在正向执行后发生变化；正向与对照必须使用同一版材料'],
      }
    }
    const swapped = input.controls.filter((control) => {
      if (!control.patchSha256) return false
      const path = join(context.activation.workspace, control.patch)
      return (
        !existsSync(path) ||
        sha256OfText(readFileSync(path, 'utf8').trimEnd()) !== control.patchSha256
      )
    })
    if (swapped.length > 0) {
      return {
        results: [],
        issues: swapped.map((control) => `敏感性对照补丁在登记后发生变化：${control.label}`),
      }
    }
    return executeVerificationControls({
      workspace: context.activation.workspace,
      dir: context.activation.dir,
      commands: input.commands,
      controls: input.controls,
      dependencyRoot: context.activation.workspace,
      run: async ({ argv, cwd, logPath }) => {
        const test = await this.deps.formalTest({
          ctx: this.deps.ctx,
          cwd,
          argv,
          timeoutMs: context.activation.timeoutMs,
          logPath,
          signal: context.activation.signal,
        })
        return {
          exitCode: test.exitCode,
          timedOut: test.timedOut,
          aborted: test.aborted,
          durationMs: test.durationMs,
          output: test.output,
          logPath: test.logPath,
          logSha256: test.logSha256,
        }
      },
    })
  }

  private headOf(context: ActiveContext): string | null {
    try {
      return requireGit(context.activation.workspace, ['rev-parse', 'HEAD'])
    } catch {
      this.addIntegrityIssue(context, '无法读取候选提交；验证工作区可能已损坏')
      return null
    }
  }

  private checkIntegrity(context: ActiveContext): void {
    const head = this.headOf(context)
    if (head !== null && head !== context.activation.head) {
      this.addIntegrityIssue(context, '验证期间候选提交发生变化')
    }
    try {
      const outside = workspaceChanges(context.activation.workspace).filter(
        (path) => !path.startsWith(VERIFICATION_MATERIAL_DIR),
      )
      if (outside.length > 0) {
        this.addIntegrityIssue(context, `验证命令修改了固定候选：${outside.join('、')}`)
      }
    } catch (error) {
      this.addIntegrityIssue(context, `无法核对候选完整性：${errorMessage(error)}`)
    }
  }

  private addIntegrityIssue(context: ActiveContext, issue: string): void {
    if (!context.integrityIssues.includes(issue)) context.integrityIssues.push(issue)
  }

  private outcome(
    record: VerificationCheckRecord,
    context: ActiveContext,
    repeated: boolean,
  ): VerificationCheckOutcome {
    const status = record.aborted
      ? '已中止'
      : record.timedOut
        ? '超时'
        : record.exitCode === null
          ? '没有退出码'
          : `退出码 ${record.exitCode}`
    const prefix = repeated ? '该命令已在本候选上执行过，返回上一次的真实结果。' : '命令已执行。'
    const issues =
      context.integrityIssues.length > 0
        ? `\n候选完整性告警：${context.integrityIssues.join('；')}`
        : ''
    return {
      ok: true,
      text: `${prefix}${record.label}：${status}\nargv: ${JSON.stringify(record.argv)}\n日志：${record.logPath || '（无）'}\n输出（开头与末尾，中间可能省略）：\n${businessReviewEvidenceWindow(record.output) || '（无输出）'}${issues}`,
      data: {
        label: record.label,
        argv: record.argv,
        exitCode: record.exitCode,
        timedOut: record.timedOut,
        aborted: record.aborted,
        durationMs: record.durationMs,
        logPath: record.logPath,
        logSha256: record.logSha256,
        integrityIssues: [...context.integrityIssues],
      },
    }
  }
}
