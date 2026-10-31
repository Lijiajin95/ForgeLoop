/**
 * 验证 Agent：两个分离的阶段，避免“先看实现再设计验证”的自我证明。
 *
 * 1. 方案：只依据需求说明（原文与分析）由模型产出结构化验证方案；
 *    不读取任务包、候选 diff 或实现代码。方案必须逐字覆盖业务场景与验收标准。
 * 2. 执行：接收研发 Agent 自验证后的产物工作区，由程序实际执行方案中的命令，
 *    记录退出码、耗时、输出与环境快照，再按确定性规则判定 passed / failed。
 *
 * 只有方案生成使用模型；通过与否完全由真实命令执行结果决定，模型自述不构成证据。
 */

import { existsSync } from 'node:fs'
import { AGENT_VERIFY } from '../domain/agents.js'
import { MalformedError, RuleViolationError } from '../domain/errors.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import {
  judgeVerificationResult,
  parseRequirementVerificationPlan,
  validateRequirementVerificationPlan,
  type VerificationArtifact,
  type VerificationCheckRun,
  type VerificationPlan,
  type VerificationResult,
} from '../domain/verification.js'

/** 宿主提供的单轮模型执行；结构上与运行时 AgentRunner 兼容。 */
export interface VerificationPlannerRequest {
  readonly role: typeof AGENT_VERIFY
  readonly cwd: string
  readonly prompt: string
  readonly permission: 'workspace-write'
  readonly timeoutMs: number
  readonly transcriptPath: string
  readonly signal?: AbortSignal
  readonly tools: 'none'
}

export interface VerificationPlannerResult {
  readonly status: 'completed' | 'aborted' | 'timeout' | 'error'
  readonly text: string
  readonly reason: string
}

export interface VerificationPlanner {
  run(request: VerificationPlannerRequest): Promise<VerificationPlannerResult>
}

/** 一条验证命令的真实执行结果；退出码、超时与输出都由执行器记录。 */
export interface VerificationCheckExecution {
  readonly exitCode: number | null
  readonly output: string
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly durationMs: number
}

/** 注入真实命令执行（运行时用正式测试执行器；测试可注入确定性替身）。 */
export interface VerificationCheckExecutor {
  (input: {
    readonly cwd: string
    readonly argv: readonly string[]
    readonly timeoutMs: number
    readonly signal?: AbortSignal
  }): Promise<VerificationCheckExecution>
}

export interface VerificationAgentOptions {
  readonly runner: VerificationPlanner
  readonly executeCheck: VerificationCheckExecutor
  readonly projectPath: string
  readonly timeoutMs: number
  readonly now?: () => Date
  readonly platform?: string
  readonly nodeVersion?: string
}

/**
 * 只依据需求说明设计验证方案的提示词。这里刻意不提供任务包、候选或实现代码，
 * 防止验证方案被实现方式反向约束。
 */
export function verificationPlanPrompt(input: {
  readonly requirement: Requirement
  readonly analysis: RequirementAnalysis
}): string {
  const versions = input.requirement.versions
    .map((version) => `### 版本 ${version.version}（${version.createdAt}）\n${version.text}`)
    .join('\n\n')
  return `你是 ForgeLoop 的验证 Agent。现在只依据需求说明设计验证方案：不接触任何实现产物，不读取工作区，不使用工具，也不修改任何文件。

需求身份：${input.requirement.reqId}
项目：${input.requirement.project}

原始需求：
${versions}

需求说明（分析 v${input.analysis.analysisVersion}，依据需求 v${input.analysis.requirementVersion}）：
- 目标：${input.analysis.goal}
- 业务场景：
${input.analysis.scenarios.map((scenario) => `  - ${scenario}`).join('\n')}
- 验收标准：
${input.analysis.acceptanceCriteria.map((criterion) => `  - ${criterion}`).join('\n')}

请设计正常、异常/边界与回归场景，并只输出一个 JSON 对象：
{
  "scenarios": [
    {
      "scenario": "业务场景原文（必须逐字包含需求说明中的场景，可补充说明）",
      "acceptance_criterion": "验收标准原文（必须逐字包含需求说明中的标准，可补充说明）",
      "method": "如何执行：前置条件、操作、预期结果与证据",
      "required": true,
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
- 方案必须覆盖需求说明中的每个业务场景与验收标准，并至少包含一个 required=true 的场景。
- 每个场景至少一条可执行命令；命令总数为 1 到 10 条，label 不能重复。
- 命令必须在独立验证工作区直接执行，不允许交互输入、网络依赖或修改被验证代码；验证脚本可以放在 \`verification/\`。
- expected_output 省略时只按退出码判定；填写时必须是命令正常输出里会出现的原文片段。
- 只输出 JSON，不要输出解释或 Markdown 围栏。`
}

export class VerificationAgent {
  private readonly runner: VerificationPlanner
  private readonly executeCheck: VerificationCheckExecutor
  private readonly projectPath: string
  private readonly timeoutMs: number
  private readonly now: () => Date
  private readonly platform: string
  private readonly nodeVersion: string

  constructor(options: VerificationAgentOptions) {
    this.runner = options.runner
    this.executeCheck = options.executeCheck
    this.projectPath = options.projectPath
    this.timeoutMs = options.timeoutMs
    this.now = options.now ?? (() => new Date())
    this.platform = options.platform ?? process.platform
    this.nodeVersion = options.nodeVersion ?? process.version
  }

  /**
   * 仅凭需求说明生成并校验验证方案。
   * 模型未完成、结构畸形或未覆盖需求说明时 fail-closed，不返回半成品方案。
   */
  async plan(input: {
    readonly requirement: Requirement
    readonly analysis: RequirementAnalysis
    readonly transcriptPath: string
    readonly signal?: AbortSignal
  }): Promise<VerificationPlan> {
    const run = await this.runner.run({
      role: AGENT_VERIFY,
      cwd: this.projectPath,
      prompt: verificationPlanPrompt(input),
      permission: 'workspace-write',
      timeoutMs: this.timeoutMs,
      transcriptPath: input.transcriptPath,
      tools: 'none',
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (run.status !== 'completed') {
      throw new MalformedError(`验证方案生成未完成（${run.status}）：${run.reason}`)
    }
    const plan = parseRequirementVerificationPlan(run.text)
    const issues = validateRequirementVerificationPlan(input.analysis, plan)
    if (issues.length > 0) {
      throw new MalformedError(`验证方案未覆盖需求说明：${issues.join('；')}`)
    }
    return plan
  }

  /**
   * 在研发产物工作区执行方案，返回含命令退出码、输出、环境与判定结果的 VerificationResult。
   * 命令被中止后不再继续执行剩余命令；缺失的执行结果会被判为失败。
   */
  async execute(input: {
    readonly plan: VerificationPlan
    readonly artifact: VerificationArtifact
    readonly signal?: AbortSignal
  }): Promise<VerificationResult> {
    if (!existsSync(input.artifact.workspace)) {
      throw new RuleViolationError(`验证产物工作区不存在：${input.artifact.workspace}`)
    }
    const startedAt = this.now().toISOString()
    const checks: VerificationCheckRun[] = []
    let stopped = false
    for (const scenario of input.plan.scenarios) {
      if (stopped) break
      for (const check of scenario.checks) {
        let execution: VerificationCheckExecution
        try {
          execution = await this.executeCheck({
            cwd: input.artifact.workspace,
            argv: check.argv,
            timeoutMs: this.timeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
          })
        } catch (error) {
          execution = {
            exitCode: null,
            output: `验证命令执行异常：${(error as Error).message}`,
            timedOut: false,
            aborted: false,
            durationMs: 0,
          }
        }
        checks.push({ label: check.label, argv: check.argv, ...execution })
        if (execution.aborted) {
          stopped = true
          break
        }
      }
    }
    return judgeVerificationResult({
      plan: input.plan,
      artifact: input.artifact,
      checks,
      environment: {
        platform: this.platform,
        nodeVersion: this.nodeVersion,
        startedAt,
      },
      finishedAt: this.now().toISOString(),
    })
  }
}
