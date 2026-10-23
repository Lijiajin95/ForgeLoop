/**
 * 人类 slash 命令：可信的决定入口（批准/验收/停止只在这里出现，模型工具不能调用）。
 * 命令参数是原始文本，由本模块解析；失败显式返回错误，不静默改变业务状态。
 */

import type { ForgeLoopRuntime, OperationResult } from './runtime/service.js'
import type { Coordinator } from './runtime/coordinator.js'
import type { ForgeLoopConfig } from './config.js'
import { MAX_ROUNDS_PER_GRANT } from './domain/counting.js'

interface CommandInvocationLike {
  readonly rawInput: string
  readonly agent?: { readonly id?: string }
  readonly signal?: AbortSignal
}

export interface CommandRegistration {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: CommandInvocationLike) => Promise<{ kind: 'success' | 'error'; text: string }>
}

const HELP = `ForgeLoop 命令（对象、版本与效果都写在结果里）：
  /fl help
  /fl status [需求身份]                    查看需求列表或单条状态
  /fl submit <需求原文>                    受理新需求（版本 1）
  /fl revise <需求身份> <新原文>           追加修订版本（旧任务包/批准随之过期）
  /fl analyze <需求身份> [--wait]          排队结构化分析
  /fl plan <需求身份> [--wait]             排队任务包规划（需已分析）
  /fl show <需求身份>                      查看需求、方案与批准
  /fl impact <需求身份> [--explain]        查看修订影响事实（可选模型推断，默认不调用模型）
  /fl plan-show <需求身份> [版本]          查看任务包与授权判定
  /fl approve <需求身份> <任务包版本>      人类批准：绑定需求版本与任务包版本
  /fl advance <需求身份> [--wait]          排队推进（需已批准）
  /fl grant <需求身份>                     追加一次失败轮次授权（+3，累计不清零）
  /fl accept <需求身份> [产物SHA256]       人类整体验收：绑定实际交付材料
  /fl candidate <需求身份> [x.y.z]         从已交付 diff 构建候选安装包并记录摘要
  /fl evidence <需求身份>                  查看交付证据与路径
  /fl requests [需求身份]                  查看持久操作请求
  /fl recover <需求身份> [confirm]         核对未收口请求（不自动重放）
  /fl stop <需求身份> <原因>               停止推进（保留记录，可再次排队）
  /fl cancel <需求身份> <原因>             取消需求（终态，保留全部历史）
  /fl config                               查看记录根、项目与模型选择`

function result(command: string, outcome: OperationResult): { kind: 'success' | 'error'; text: string } {
  const body = outcome.data === undefined ? '' : `\n${JSON.stringify(outcome.data, null, 2)}`
  return {
    kind: outcome.ok ? 'success' : 'error',
    text: `[${command}] ${outcome.ok ? '成功' : `拒绝(${outcome.code})`}：${outcome.message}${body}`,
  }
}

function sessionSource(invocation: CommandInvocationLike): string {
  const session = invocation.agent?.id
  return session ? `dsh-command:${session}` : 'dsh-command'
}

function takeText(parts: readonly string[], from: number): string {
  return parts.slice(from).join(' ').trim()
}

export class CommandSurface {
  private readonly runtime: ForgeLoopRuntime
  private readonly coordinator: Coordinator
  private readonly config: ForgeLoopConfig

  constructor(runtime: ForgeLoopRuntime, coordinator: Coordinator, config: ForgeLoopConfig) {
    this.runtime = runtime
    this.coordinator = coordinator
    this.config = config
  }

  registrations(): CommandRegistration[] {
    return [
      {
        name: 'fl',
        description: 'ForgeLoop：提交/修订需求、分析规划、批准推进、验收停止',
        input: { hint: '子命令，例如 submit <需求原文> 或 status' },
        handler: (invocation) => this.handle(invocation),
      },
    ]
  }

  async handle(invocation: CommandInvocationLike): Promise<{ kind: 'success' | 'error'; text: string }> {
    const raw = invocation.rawInput.trim()
    if (!raw) return { kind: 'success', text: HELP }
    const parts = raw.split(/\s+/)
    const sub = parts[0] ?? ''
    const source = sessionSource(invocation)
    const owner = this.config.owner
    try {
      switch (sub) {
        case 'help':
          return { kind: 'success', text: HELP }
        case 'status':
          return result(sub, this.status(parts[1]))
        case 'submit': {
          const text = takeText(parts, 1)
          if (!text) return { kind: 'error', text: '用法：/fl submit <需求原文>' }
          return result(sub, this.runtime.submit({ text, by: owner, source }))
        }
        case 'revise': {
          const reqId = parts[1]
          const text = takeText(parts, 2)
          if (!reqId || !text) return { kind: 'error', text: '用法：/fl revise <需求身份> <新原文>' }
          return result(sub, this.runtime.revise({ reqId, text, by: owner, source }))
        }
        case 'analyze': {
          const reqId = parts[1]
          if (!reqId) return { kind: 'error', text: '用法：/fl analyze <需求身份> [--wait]' }
          return this.queued(sub, reqId, 'analyze', parts.includes('--wait'), invocation)
        }
        case 'plan': {
          const reqId = parts[1]
          if (!reqId) return { kind: 'error', text: '用法：/fl plan <需求身份> [--wait]' }
          return this.queued(sub, reqId, 'plan', parts.includes('--wait'), invocation)
        }
        case 'advance': {
          const reqId = parts[1]
          if (!reqId) return { kind: 'error', text: '用法：/fl advance <需求身份> [--wait]' }
          return this.queued(sub, reqId, 'advance', parts.includes('--wait'), invocation)
        }
        case 'show': {
          if (!parts[1]) return { kind: 'error', text: '用法：/fl show <需求身份>' }
          return result(sub, this.runtime.status(parts[1]))
        }
        case 'impact': {
          const reqId = parts[1]
          if (!reqId) return { kind: 'error', text: '用法：/fl impact <需求身份> [--explain]' }
          return result(sub, await this.runtime.impact(reqId, { explain: parts.includes('--explain') }))
        }
        case 'plan-show': {
          const reqId = parts[1]
          if (!reqId) return { kind: 'error', text: '用法：/fl plan-show <需求身份> [版本]' }
          const version = parts[2] ? Number(parts[2]) : undefined
          if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
            return { kind: 'error', text: '任务包版本必须是正整数' }
          }
          return result(sub, this.runtime.showPlan(reqId, version))
        }
        case 'approve': {
          const reqId = parts[1]
          const version = Number(parts[2])
          if (!reqId || !Number.isInteger(version) || version < 1) {
            return { kind: 'error', text: '用法：/fl approve <需求身份> <任务包版本>' }
          }
          return result(sub, this.runtime.approvePlan({ reqId, planVersion: version, by: owner, source }))
        }
        case 'grant':
          if (!parts[1]) return { kind: 'error', text: '用法：/fl grant <需求身份>' }
          return result(sub, this.runtime.grant({ reqId: parts[1], by: owner }))
        case 'accept': {
          const reqId = parts[1]
          if (!reqId) return { kind: 'error', text: '用法：/fl accept <需求身份> [产物SHA256]' }
          const artifact = parts[2]
          if (artifact !== undefined && !/^[0-9a-f]{64}$/.test(artifact)) {
            return { kind: 'error', text: '产物摘要必须是 64 位小写十六进制 SHA-256' }
          }
          return result(sub, this.runtime.accept({ reqId, by: owner, source, artifactSha256: artifact }))
        }
        case 'candidate': {
          if (!parts[1]) return { kind: 'error', text: '用法：/fl candidate <需求身份> [x.y.z]' }
          return result(
            sub,
            this.runtime.buildCandidate({ reqId: parts[1], by: owner, version: parts[2] }),
          )
        }
        case 'evidence':
          if (!parts[1]) return { kind: 'error', text: '用法：/fl evidence <需求身份>' }
          return result(sub, this.runtime.evidence(parts[1]))
        case 'requests':
          return result(sub, this.runtime.listRequests(parts[1]))
        case 'recover': {
          if (!parts[1]) return { kind: 'error', text: '用法：/fl recover <需求身份> [confirm]' }
          return result(
            sub,
            this.runtime.recover({ reqId: parts[1], by: owner, confirm: parts[2] === 'confirm' }),
          )
        }
        case 'stop': {
          const reqId = parts[1]
          const reason = takeText(parts, 2)
          if (!reqId) return { kind: 'error', text: '用法：/fl stop <需求身份> <原因>' }
          return result(sub, this.runtime.stop({ reqId, by: owner, reason }))
        }
        case 'cancel': {
          const reqId = parts[1]
          const reason = takeText(parts, 2)
          if (!reqId) return { kind: 'error', text: '用法：/fl cancel <需求身份> <原因>' }
          return result(sub, this.runtime.cancel({ reqId, by: owner, reason }))
        }
        case 'config':
          return {
            kind: 'success',
            text: `[config] ${JSON.stringify(
              { ...(this.runtime.directorySummary() as Record<string, unknown>), coordinator: this.coordinator.snapshot() },
              null,
              2,
            )}`,
          }
        default:
          return { kind: 'error', text: `未知子命令 ${sub}\n\n${HELP}` }
      }
    } catch (error) {
      return { kind: 'error', text: `[${sub}] 执行失败：${(error as Error).message}` }
    }
  }

  /**
   * /fl status 的输出契约：保留既有字段，并稳定给出失败轮次明细与授权额度。
   * 数据从权威记录读取（与运行时视图同源），确保所有者执行 /fl grant 前能直接判断。
   */
  private status(reqId?: string): OperationResult {
    const outcome = this.runtime.status(reqId)
    if (!outcome.ok || reqId === undefined) return outcome
    const failureRoundDetails = this.runtime.repo.failureRounds(reqId).map((round) => ({
      roundId: round.roundId,
      stage: round.stage,
      summary: round.summary,
      occurredAt: round.occurredAt,
    }))
    const grants = this.runtime.repo.grantCount(reqId)
    const used = failureRoundDetails.length
    return {
      ...outcome,
      data: {
        ...(outcome.data as Record<string, unknown>),
        failureRoundDetails,
        grantQuota: {
          grants,
          used,
          remaining: Math.max(0, grants * MAX_ROUNDS_PER_GRANT - used),
        },
      },
    }
  }

  private async queued(
    sub: string,
    reqId: string,
    action: 'analyze' | 'plan' | 'advance',
    wait: boolean,
    invocation: CommandInvocationLike,
  ): Promise<{ kind: 'success' | 'error'; text: string }> {
    const outcome = this.runtime.requestOperation({
      reqId,
      action,
      by: this.config.owner,
      source: sessionSource(invocation),
    })
    if (!outcome.ok) return result(sub, outcome)
    if (!wait) return result(sub, outcome)
    await this.coordinator.kick()
    const after = this.runtime.listRequests(reqId)
    return result(sub, {
      ok: true,
      code: 'ok',
      message: `${outcome.message}；已等待本轮执行收口`,
      data: after.data,
    })
  }
}

export function registerCommands(
  commands: { register(definition: unknown): () => void },
  surface: CommandSurface,
): Array<() => void> {
  return surface.registrations().map((definition) =>
    commands.register({
      name: definition.name,
      description: definition.description,
      input: definition.input,
      handler: definition.handler,
    }),
  )
}