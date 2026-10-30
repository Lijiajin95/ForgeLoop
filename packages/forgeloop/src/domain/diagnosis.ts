import { parseJsonLoose } from './requirement.js'
import { MalformedError } from './errors.js'

/**
 * 未知请求的根因诊断：把“结果未知、不敢重放”的原因说清楚，并给出可执行的处置。
 *
 * 两个面向所有人的字段各限 100 字节（UTF-8），超长直接拒绝——诊断结论要能一眼看完，
 * 不能靠长篇叙述掩盖“其实没核对”。判定由程序做，不采信模型自述。
 */
export const DIAGNOSIS_TEXT_MAX_BYTES = 100

export interface UnknownDiagnosis {
  readonly rootCause: string
  readonly solution: string
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** 校验并截断检查：超长、空串、缺字段都是畸形材料，不做静默截断。 */
export function parseUnknownDiagnosis(text: string): UnknownDiagnosis {
  const payload = parseJsonLoose(text, '未知请求诊断')
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new MalformedError('未知请求诊断必须是 JSON 对象')
  }
  const data = payload as Record<string, unknown>
  const rootCause = field(data.root_cause ?? data.rootCause, 'root_cause')
  const solution = field(data.solution, 'solution')
  return { rootCause, solution }
}

function field(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MalformedError(`未知请求诊断的 ${name} 必须是非空字符串`)
  }
  const trimmed = value.trim()
  const bytes = byteLength(trimmed)
  if (bytes > DIAGNOSIS_TEXT_MAX_BYTES) {
    throw new MalformedError(
      `未知请求诊断的 ${name} 超过 ${DIAGNOSIS_TEXT_MAX_BYTES} 字节（实际 ${bytes} 字节）：${trimmed}`,
    )
  }
  return trimmed
}

/** 工作副本里的未收口痕迹：用于判断“重放是否安全”，由运行时采集，不来自模型。 */
export interface UnknownWorkspaceFact {
  readonly taskId: string
  readonly workspacePath: string
  readonly exists: boolean
  /** 快照 HEAD 是否仍是基线提交（false 表示执行者自己提交过）。 */
  readonly headIsBaseline: boolean
  readonly changedFiles: readonly string[]
  readonly untrackedFiles: readonly string[]
}

export interface UnknownRequestFact {
  readonly requestId: string
  readonly action: string
  readonly planVersion: number
  readonly createdAt: string
}

export interface UnknownFacts {
  readonly requests: readonly UnknownRequestFact[]
  readonly workspaces: readonly UnknownWorkspaceFact[]
  readonly blockedReason: string
  readonly taskRuns: readonly { taskId: string; state: string; reason: string }[]
}

/**
 * 重放安全性只由程序判定：只要执行者没有在快照里自己提交，工作副本就是一次性的，
 * 重跑不会重复外部副作用；出现提交说明执行者越过了约定的边界，必须停下来。
 */
export function replaySafe(facts: UnknownFacts): { safe: boolean; reason: string } {
  const committed = facts.workspaces.filter((workspace) => workspace.exists && !workspace.headIsBaseline)
  if (committed.length > 0) {
    return {
      safe: false,
      reason: `工作副本出现非基线提交：${committed.map((item) => item.taskId).join('、')}；需人工处置`,
    }
  }
  return { safe: true, reason: '工作副本只有未提交改动，全部位于一次性快照内' }
}

/** 给诊断 Agent 的事实摘要：只给可核对的内容，不给“请确认安全”这种诱导。 */
export function renderUnknownFacts(facts: UnknownFacts): string {
  const lines: string[] = []
  lines.push(`需求阻塞原因：${facts.blockedReason || '（未记录）'}`)
  lines.push('结果未知的请求：')
  for (const request of facts.requests) {
    lines.push(`- ${request.requestId}（${request.action}，任务包 v${request.planVersion}，创建于 ${request.createdAt}）`)
  }
  lines.push('任务运行：')
  if (facts.taskRuns.length === 0) lines.push('- （无运行记录）')
  for (const run of facts.taskRuns) lines.push(`- ${run.taskId}：${run.state}；${run.reason || '无原因'}`)
  lines.push('工作副本（一次性快照）：')
  if (facts.workspaces.length === 0) lines.push('- （没有任务工作副本）')
  for (const workspace of facts.workspaces) {
    if (!workspace.exists) {
      lines.push(`- ${workspace.taskId}：不存在`)
      continue
    }
    lines.push(
      `- ${workspace.taskId}：HEAD ${workspace.headIsBaseline ? '仍是基线提交' : '已被执行者提交'}；已修改 ${
        workspace.changedFiles.length
      } 个、未跟踪 ${workspace.untrackedFiles.length} 个${
        workspace.changedFiles.length + workspace.untrackedFiles.length > 0
          ? `（${[...workspace.changedFiles, ...workspace.untrackedFiles].slice(0, 8).join('、')}）`
          : ''
      }`,
    )
  }
  return lines.join('\n')
}
