/**
 * 各阶段提示词与结构化结果解析。
 * 提示词只提供事实与边界；通过/失败由程序判定，模型自评不构成验收。
 */

import type { Requirement } from '../domain/requirement.js'
import type { PlannedTask, TaskPlan } from '../domain/task-plan.js'
import { MalformedError } from '../domain/errors.js'
import { parseJsonLoose } from '../domain/requirement.js'

export function requirementContext(requirement: Requirement): string {
  const versions = requirement.versions
    .map((version) => `### 版本 ${version.version}（${version.createdAt}）\n${version.text}`)
    .join('\n\n')
  return `需求身份：${requirement.reqId}\n项目：${requirement.project}\n当前状态：${requirement.status}\n\n${versions}`
}

export function analysisPrompt(requirement: Requirement): string {
  return `你是 ForgeLoop 的需求分析者。你的输出会被程序解析并落库。你没有可用工具：不要尝试读取或修改任何文件，也不要调用工具。

${requirementContext(requirement)}

请只输出一个 JSON 对象，字段如下（不要代码围栏之外的说明）：
{
  "goal": "一句话目标",
  "scenarios": ["可验收的业务场景，至少一条"],
  "acceptance_criteria": ["可检查的验收标准，至少一条"],
  "clarifications": ["确实阻塞实施的待澄清问题；没有就留空数组"]
}

规则：
- 不要臆造所有者未表达的范围；信息不足时把问题放进 clarifications，而不是猜。
- clarifications 非空表示需要人工回答，程序不会进入实现。
- 只输出 JSON。`
}

export function planningPrompt(requirement: Requirement, analysisGoal: string): string {
  return `你是 ForgeLoop 的任务规划者。你的输出会被程序校验并落库。你没有可用工具：不要尝试读取或修改任何文件，也不要调用工具。

${requirementContext(requirement)}

分析结论目标：${analysisGoal}

已知工程事实（以此为准，不要臆造目录）：
- 插件活动源码在 packages/forgeloop/src/（入口 src/index.ts，运行时 src/runtime/service.ts，工具 src/tools.ts，记录 src/records/，领域 src/domain/）
- 行为测试在 packages/forgeloop/tests/（vitest）
- 正式检查命令：["npm","run","check","--workspace","forgeloop-dsh"]
- 仓库根目录另有 docs/、contracts/、config/、Makefile 与根 package.json
- 不存在 packages/dsh 或 packages/forgeloop-dsh；不要新建并行插件包

请只输出一个 JSON 对象：
{
  "tasks": [
    {
      "task_id": "短身份，例如 core",
      "goal": "这个任务要实现什么",
      "files": ["允许修改的项目内相对路径"],
      "acceptance": "这个任务完成的可检查标准",
      "test_command": ["实际可执行的 argv"],
      "depends_on": ["依赖的任务 id，可为空"]
    }
  ]
}

硬性规则（程序会拒绝不合规的任务包）：
- 至少 2 个任务，且至少一条 depends_on 依赖；
- 依赖必须存在且无环；task_id 唯一；
- files 只能是项目内相对路径，不能是绝对路径或包含 ..；
- files 必须逐个列出具体文件路径（例如 packages/forgeloop/src/runtime/service.ts），不能写目录、不能以 / 结尾；新增文件也写完整路径；
- 每个任务必须给出非空 test_command，且是真正的 argv 数组；
- 不要输出 authorization_source；授权只由真实批准写入；
- 本轮活动工程是仓库根下的 TypeScript 工程：允许修改 packages/、docs/、contracts/、config/、scripts/ts/ 与根配置文件；
- 禁止把 Python 解释器、旧 .venv、旧 forgeloop CLI、src/forgeloop/、tests/（旧 Python 测试）、frontend/src/ 写进 files 或 test_command；
- 正式测试命令必须是 TypeScript 工程可执行的真实 argv，例如 ["npm","run","check","--workspace","forgeloop-dsh"]；
- 只输出 JSON。`
}

export function devPrompt(input: {
  requirement: Requirement
  plan: TaskPlan
  task: PlannedTask
  workdir: string
}): string {
  const { requirement, plan, task, workdir } = input
  const dependencies = task.dependsOn.length > 0 ? task.dependsOn.join('、') : '无'
  return `你是 ForgeLoop 的实现者，在一个隔离的 Git 工作副本中完成一个已批准任务。

${requirementContext(requirement)}

任务包：${plan.taskPlanId}（方案版本 v${plan.planVersion}，需求版本 v${plan.requirementVersion}）
当前任务：${task.taskId}
任务目标：${task.goal}
验收标准：${task.acceptance}
允许修改的文件（只能改这些）：${task.files.join('、')}
正式测试命令（批准时固定）：${JSON.stringify(task.testCommand)}
依赖任务：${dependencies}
工作目录：${workdir}

要求：
1. 只在当前工作目录内修改；不得改动允许清单之外的文件。
2. 不要执行 git commit / git push / 修改远端；程序会自行采集 diff。
3. 实现后用上面的正式测试命令自测；失败要修到通过或如实说明。
4. 不要伪造测试结果，不要修改测试以绕过检查，除非任务本身要求。
5. 完成后用简短文本报告：改了什么、跑了什么命令、结果如何、还有什么风险。`
}

export function reviewPrompt(input: {
  requirement: Requirement
  plan: TaskPlan
  task: PlannedTask
  diff: string
  changedFiles: readonly string[]
  diffPath: string
}): string {
  const { requirement, task, diff, changedFiles, diffPath } = input
  return `你是 ForgeLoop 的独立审查者。你只看到固定的候选改动，没有实现者的上下文。
你没有可用工具：不要调用工具，也不得修改任何文件；你的结论由程序解析并绑定候选摘要。

${requirementContext(requirement)}

任务：${task.taskId} — ${task.goal}
任务验收标准：${task.acceptance}
允许修改的文件：${task.files.join('、')}
实际改动文件：${changedFiles.join('、') || '（无）'}

完整候选 diff 已保存到：${diffPath}
以下是 diff 原文：

${diff || '（空 diff）'}

请只输出一个 JSON 对象：
{
  "verdict": "pass" 或 "block",
  "blocking": ["必须修复才能通过的问题；没有就留空数组"],
  "findings": ["非阻断的观察、风险或建议"],
  "summary": "一句话结论"
}

规则：
- 只依据 diff 与任务验收标准判断；不臆造未出现的代码。
- 越出允许文件清单、伪造测试、削弱校验、缺失关键实现，应判 block。
- verdict=pass 时 blocking 必须为空。
- 只输出 JSON。`
}

export interface ReviewVerdict {
  readonly verdict: 'pass' | 'block'
  readonly blocking: readonly string[]
  readonly findings: readonly string[]
  readonly summary: string
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new MalformedError(`审查结果字段 ${field} 必须是字符串数组`)
  return value.map((item) => {
    if (typeof item !== 'string') throw new MalformedError(`审查结果字段 ${field} 只能包含字符串`)
    return item.trim()
  })
}

export function parseReviewVerdict(raw: string): ReviewVerdict {
  const parsed = parseJsonLoose(raw, '审查结果')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MalformedError('审查结果必须是 JSON 对象')
  }
  const data = parsed as Record<string, unknown>
  const verdict = data.verdict
  if (verdict !== 'pass' && verdict !== 'block') {
    throw new MalformedError(`审查结论必须是 pass 或 block，实际 ${JSON.stringify(verdict)}`)
  }
  const blocking = stringList(data.blocking, 'blocking').filter(Boolean)
  const findings = stringList(data.findings, 'findings').filter(Boolean)
  const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
  if (verdict === 'pass' && blocking.length > 0) {
    throw new MalformedError('审查结论为 pass 时 blocking 必须为空')
  }
  if (verdict === 'block' && blocking.length === 0) {
    throw new MalformedError('审查结论为 block 时必须给出至少一条阻断原因')
  }
  return { verdict, blocking, findings, summary }
}