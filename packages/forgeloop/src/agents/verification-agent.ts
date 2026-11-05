/**
 * 验证 Agent：同一会话先设计验证方案，研发产物交付后再由该会话通过工具执行方案并做业务验收。
 *
 * 1. 方案：只依据需求说明（原文与分析）与已准入任务包的任务目标设计结构化验证方案；
 *    不读取任务包实现细节、候选 diff 或源码，防止验证被实现方式反向约束。
 * 2. 执行与验收：产物交付后由同一个会话调用运行时提供的执行工具，逐条执行方案中的命令；
 *    通过与否只按真实退出码、超时、中止与输出判定，模型自述不构成证据。
 *
 * 本类只负责方案阶段；执行与业务验收提示词由运行时投递到同一个会话。
 */

import { MalformedError } from '../domain/errors.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import type { TaskPlan } from '../domain/task-plan.js'
import {
  parseRequirementVerificationPlan,
  validateRequirementVerificationPlan,
  type VerificationPlan,
} from '../domain/verification.js'

/** 宿主会话的最小表面：同一会话多轮投递，模型与工具由宿主提供。 */
export interface VerificationSessionResult {
  readonly status: 'completed' | 'aborted' | 'timeout' | 'error'
  readonly text: string
  readonly reason: string
}

export interface VerificationSessionTurn {
  readonly prompt: string
  readonly timeoutMs: number
  readonly transcriptPath: string
  readonly signal?: AbortSignal
}

export interface VerificationSession {
  readonly sessionId: string
  send(turn: VerificationSessionTurn): Promise<VerificationSessionResult>
}

export interface VerificationAgentOptions {
  readonly session: VerificationSession
  readonly timeoutMs: number
}

/**
 * 只依据需求说明与已准入任务目标设计验证方案。这里刻意不提供候选、diff 或实现代码，
 * 也不要求模型在方案阶段执行命令——执行发生在产物交付之后、同一个会话里。
 */
export function verificationPlanPrompt(input: {
  readonly requirement: Requirement
  readonly analysis: RequirementAnalysis
  readonly plan: TaskPlan
}): string {
  const versions = input.requirement.versions
    .map((version) => `### 版本 ${version.version}（${version.createdAt}）\n${version.text}`)
    .join('\n\n')
  const rules = input.analysis.businessRules ?? []
  const exceptions = input.analysis.exceptions ?? []
  const nonGoals = input.analysis.nonGoals ?? []
  const tasks = input.plan.tasks.map((task) => `- ${task.taskId}：${task.goal}`).join('\n')
  const points = (input.analysis.businessPoints ?? [])
    .map((point) => {
      const exceptions =
        point.exceptions.status === 'assessed'
          ? point.exceptions.items.join('；') || '（已评估，无额外项目）'
          : `${point.exceptions.status}：${point.exceptions.reason}`
      return `- ${point.id}｜${point.actor}｜${point.trigger}｜${point.behavior}
  规则：${point.rules.join('；') || '（无）'}；异常与边界：${exceptions}`
    })
    .join('\n')
  const acceptance = (input.analysis.acceptanceItems ?? [])
    .map(
      (item) =>
        `- ${item.id}｜覆盖 ${item.pointIds.join('、')}｜给定 ${item.given}；当 ${item.when}；则 ${item.then}`,
    )
    .join('\n')
  const structured = points
    ? `\n结构化业务要点（验证必须按编号覆盖）：
${points}
可观察验收：
${acceptance || '（无）'}`
    : ''
  return `你是 ForgeLoop 的验证 Agent。现在只依据需求说明与已准入任务包的任务目标设计验证方案：不读取实现代码、不接触候选 diff，也不要调用任何工具。研发产物交付后，你会在同一个会话里通过工具执行这份方案并做业务验收。

需求身份：${input.requirement.reqId}
项目：${input.requirement.project}

原始需求：
${versions}

需求说明（分析 v${input.analysis.analysisVersion}，依据需求 v${input.analysis.requirementVersion}）：
- 目标：${input.analysis.goal}
- 业务场景：
${input.analysis.scenarios.map((scenario) => `  - ${scenario}`).join('\n')}
- 业务规则：
${rules.map((rule) => `  - ${rule}`).join('\n') || '  - （没有额外业务规则）'}
- 异常与边界：
${exceptions.map((item) => `  - ${item}`).join('\n') || '  - （没有额外异常或边界）'}
- 非目标（只作背景，不得写成验收场景）：
${nonGoals.map((item) => `  - ${item}`).join('\n') || '  - （未声明非目标）'}
- 验收标准：
${input.analysis.acceptanceCriteria.map((criterion) => `  - ${criterion}`).join('\n')}${structured}

已准入任务包 v${input.plan.planVersion} 的任务目标（只用于核对覆盖面，不要按实现方式设计验证）：
${tasks}

请设计正常、异常/边界与回归场景，并只输出一个 JSON 对象：
{
  "scenarios": [
    {
      "scenario": "业务场景原文（必须逐字包含需求说明中的场景，可补充说明）",
      "acceptance_criterion": "验收标准原文（必须逐字包含需求说明中的标准，可补充说明）",
      "method": "如何执行：前置条件、操作、预期结果与证据",
      "required": true,
      "point_ids": ["本场景覆盖的业务要点编号，例如 BP-1"],
      "acceptance_ids": ["本场景覆盖的验收项编号，例如 AC-1"],
      "checks": [
        {
          "label": "全局唯一的命令标签",
          "argv": ["可执行程序", "参数"],
          "expected_output": "期望在输出中逐字出现的片段；可省略"
        }
      ]
    }
  ]
}

规则：
- 有结构化业务要点时，每个必过场景必须用 point_ids 和 acceptance_ids 明确引用它覆盖的要点与验收项；所有要点和验收项都必须至少被一个 required=true 的场景覆盖，编号必须真实存在。不要重排或编造编号。
- 方案还必须覆盖需求说明中的每条业务规则、每条异常与边界：把原文写进对应场景的 scenario、acceptance_criterion 或 method（可附带补充说明）。非目标不是验收项。
- 至少包含一个 required=true 的场景；每个场景至少一条可执行命令；命令总数为 1 到 10 条，label 不能重复。
- 命令会在独立的候选工作区直接执行，不允许交互输入、网络依赖或修改被验证代码；验证脚本可以放在 \`verification/\`。
- expected_output 省略时只按退出码判定；填写时必须是命令正常输出里会逐字出现的片段。
- 本阶段只设计划，不执行命令；不要臆造实现细节或候选状态。
- 只输出 JSON，不要输出解释或 Markdown 围栏。`
}

export class VerificationAgent {
  private readonly session: VerificationSession
  private readonly timeoutMs: number

  /** 方案修复重试：模型漏抄需求原文时，把缺失条目反馈回去再要一次；仍不合格则 fail-closed。 */
  static readonly MAX_PLAN_ATTEMPTS = 2

  constructor(options: VerificationAgentOptions) {
    this.session = options.session
    this.timeoutMs = options.timeoutMs
  }

  get sessionId(): string {
    return this.session.sessionId
  }

  /**
   * 仅凭需求说明生成并校验验证方案。
   * 模型未完成、结构畸形或未覆盖需求说明、业务规则或异常边界时 fail-closed，不返回半成品方案。
   */
  async plan(input: {
    readonly requirement: Requirement
    readonly analysis: RequirementAnalysis
    readonly plan: TaskPlan
    readonly transcriptPath: string
    readonly signal?: AbortSignal
  }): Promise<VerificationPlan> {
    let feedback = ''
    let lastIssues: string[] = []
    for (let attempt = 1; attempt <= VerificationAgent.MAX_PLAN_ATTEMPTS; attempt += 1) {
      const transcriptPath =
        attempt === 1
          ? input.transcriptPath
          : input.transcriptPath.replace(/\.jsonl$/, `-a${attempt}.jsonl`)
      const run = await this.session.send({
        prompt: verificationPlanPrompt(input) + feedback,
        timeoutMs: this.timeoutMs,
        transcriptPath,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      if (run.status !== 'completed') {
        throw new MalformedError(`验证方案生成未完成（${run.status}）：${run.reason}`)
      }
      const plan = parseRequirementVerificationPlan(run.text)
      const issues = validateRequirementVerificationPlan(input.analysis, plan)
      if (issues.length === 0) return plan
      lastIssues = issues
      feedback = `\n\n上一次方案未通过覆盖校验，缺少以下需求说明原文（必须逐字写进对应场景的 scenario、acceptance_criterion 或 method，可附带补充说明）：\n${issues.map((issue) => `- ${issue}`).join('\n')}\n请补全后重新输出完整 JSON。`
    }
    throw new MalformedError(`验证方案未覆盖需求说明：${lastIssues.join('；')}`)
  }
}
