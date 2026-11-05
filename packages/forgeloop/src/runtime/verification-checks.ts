/**
 * 验证会话的命令执行上下文。
 *
 * 验证 Agent 在产物交付后通过 `forgeloop_run_verification_check` 工具逐条执行
 * 当前验证方案中的命令；运行时只接受“当前候选 + 当前方案”里已列出的 label，
 * 不允许模型任意输入命令。退出码、超时、中止、输出与日志全部由程序记录，
 * 模型自述不能替代真实执行结果。同一 label 在一个候选上幂等，重复调用返回已有结果。
 */

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  VerificationCheckPlan,
  VerificationCheckRun,
  VerificationPlan,
} from '../domain/verification.js'
import { RuleViolationError, errorMessage } from '../domain/errors.js'
import type { runFormalTest } from './formal-test.js'
import {
  VERIFICATION_MATERIAL_DIR,
  businessReviewEvidenceWindow,
  workspaceChanges,
} from './service-helpers.js'
import { requireGit } from './workspace.js'
import { executeVerificationControls } from './verification-controls.js'
import type { VerificationControlSpec } from '../domain/verification-controls.js'

export const VERIFICATION_CHECK_TOOL = 'forgeloop_run_verification_check'

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
}

export interface VerificationCheckRegistryDeps {
  readonly ctx: NonNullable<Parameters<typeof runFormalTest>[0]['ctx']>
  readonly formalTest: typeof runFormalTest
  readonly now: () => string
}

function planChecks(plan: VerificationPlan): VerificationCheckPlan[] {
  return plan.scenarios.flatMap((scenario) => scenario.checks)
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
  async run(reqId: string, label: string): Promise<VerificationCheckOutcome> {
    const context = this.contexts.get(reqId)
    if (!context) {
      return {
        ok: false,
        text: `没有正在进行的验证：${reqId}。只有验证会话在研发产物交付后可以执行验证方案中的命令。`,
      }
    }
    const check = planChecks(context.activation.plan).find((item) => item.label === label)
    if (!check) {
      return {
        ok: false,
        text: `命令 ${label} 不在当前验证方案中；只能执行方案里已经列出的 label。`,
      }
    }
    const existing = context.runs.get(label)
    if (existing) return this.outcome(existing, context, true)
    if (context.activation.signal.aborted) {
      const aborted: VerificationCheckRecord = {
        label,
        argv: check.argv,
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
   * 在隔离副本上执行敏感性对照；只读当前候选，正式工作区不被修改。
   * 未登记上下文时返回 null，由调用方按证据不足阻断。
   */
  async executeControls(
    reqId: string,
    token: string,
    commands: readonly { label: string; argv: readonly string[] }[],
    controls: readonly VerificationControlSpec[],
  ): Promise<Awaited<ReturnType<typeof executeVerificationControls>> | null> {
    const context = this.contexts.get(reqId)
    if (!context || context.token !== token) return null
    return executeVerificationControls({
      workspace: context.activation.workspace,
      dir: context.activation.dir,
      commands,
      controls,
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
