/**
 * 任务包领域规则（迁移自旧 `domain/task_plan.py`）：
 * - 每个任务有目标、允许修改文件、验收标准、正式测试命令、依赖与限额；
 * - 文件清单必须是项目内相对路径，不得越界；测试命令是非空 argv；
 * - 依赖必须存在且无环，task_id 唯一；
 * - 批准绑定需求身份与任务包版本；旧版本批准不能驱动新任务包，授权来源只由真实批准写入。
 */

import { asRecord as recordOf } from './json.js'
import { MalformedError, NotFoundError, RuleViolationError, errorMessage } from './errors.js'

/** 任务工时预算的默认值：-1 表示不限，仍记录实际消耗。 */
export const DEFAULT_TASK_LIMIT_SECONDS = -1
/** 任务失败轮次的默认值：-1 表示不限，仍逐轮记录。 */
export const DEFAULT_MAX_FAILURE_ROUNDS = -1

export interface TaskLimits {
  readonly limitSeconds: number
  readonly maxFailureRounds: number
}

export const DEFAULT_TASK_LIMITS: TaskLimits = {
  limitSeconds: DEFAULT_TASK_LIMIT_SECONDS,
  maxFailureRounds: DEFAULT_MAX_FAILURE_ROUNDS,
}

export interface PlannedTask {
  readonly taskId: string
  readonly goal: string
  readonly files: readonly string[]
  readonly acceptance: string
  readonly testCommand: readonly string[]
  readonly dependsOn: readonly string[]
  readonly limits: TaskLimits
  /** 本任务覆盖的业务要点编号（BP-x）；旧任务包没有该字段。 */
  readonly covers?: readonly string[]
  readonly authorizationSource: string
}

export interface TechnicalSolution {
  readonly summary: string
  readonly approach: readonly string[]
  readonly risks: readonly string[]
}

/** 需求级工时：任一任务不限（-1）则整体不限，否则累加任务限额。 */
export function planLimitSeconds(tasks: readonly PlannedTask[]): number {
  if (tasks.some((task) => task.limits.limitSeconds < 0)) return -1
  return tasks.reduce((sum, task) => sum + task.limits.limitSeconds, 0)
}

export interface TaskPlan {
  readonly taskPlanId: string
  readonly requirementId: string
  readonly project: string
  readonly planVersion: number
  readonly requirementVersion: number
  readonly tasks: readonly PlannedTask[]
  /** 研发 Agent 给出的技术方案；新任务包应提供，历史记录可能没有。 */
  readonly technicalSolution?: TechnicalSolution
  readonly createdAt: string
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RuleViolationError(`任务包字段 ${field} 必须是非空字符串`)
  }
  return value.trim()
}

function toStringList(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value)) throw new RuleViolationError(`任务包字段 ${field} 必须是字符串数组`)
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new RuleViolationError(`任务包字段 ${field} 只能包含非空字符串`)
    }
    items.push(item.trim())
  }
  if (!allowEmpty && items.length === 0) {
    throw new RuleViolationError(`任务包字段 ${field} 不能为空`)
  }
  if (new Set(items).size !== items.length) {
    throw new RuleViolationError(`任务包字段 ${field} 不能包含重复项`)
  }
  return items
}

/** 文件清单必须是项目根下的相对路径；拒绝绝对路径与 `..` 越界。 */
export function validateFiles(files: readonly string[]): void {
  if (files.length === 0) throw new RuleViolationError('任务的准许修改文件清单不能为空')
  for (const relative of files) {
    if (relative.startsWith('/') || relative.startsWith('\\')) {
      throw new RuleViolationError(`文件清单必须是项目内相对路径: ${relative}`)
    }
    const parts = relative.split(/[\\/]+/)
    if (parts.some((part) => part === '' || part === '..')) {
      throw new RuleViolationError(`文件清单不得越出项目根: ${relative}`)
    }
  }
}

/**
 * 模型有时把多个编号拼成一条（例如 `BP-1: BP-1: AC-1`）：
 * 拆开、去重；AC 编号不属于本字段（验收项另有字段），其余非法编号仍交给校验拒绝。
 */
function normalizeCovers(covers: readonly string[]): string[] {
  const ids = covers
    .flatMap((item) => item.split(/[:：,，;；\s]+/))
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !/^AC-\d+$/.test(item))
  return [...new Set(ids)]
}

function validateCovers(covers: readonly string[] | undefined): void {
  if (covers === undefined) return
  if (new Set(covers).size !== covers.length) {
    throw new RuleViolationError('任务覆盖的业务要点不能重复')
  }
  for (const pointId of covers) {
    if (!/^BP-\d+$/.test(pointId)) {
      throw new RuleViolationError(`任务覆盖的业务要点编号必须形如 BP-1: ${pointId}`)
    }
  }
}

export function validateTask(task: PlannedTask): void {
  requireNonEmpty(task.taskId, 'task_id')
  requireNonEmpty(task.goal, 'goal')
  requireNonEmpty(task.acceptance, 'acceptance')
  validateFiles(task.files)
  if (task.testCommand.length === 0)
    throw new RuleViolationError('任务必须给出可执行的正式测试命令')
  for (const argument of task.testCommand) requireNonEmpty(argument, 'test_command')
  if (task.dependsOn.includes(task.taskId)) {
    throw new RuleViolationError(`任务不能依赖自身: ${task.taskId}`)
  }
  if (new Set(task.files).size !== task.files.length) {
    throw new RuleViolationError('任务的准许修改文件清单不能包含重复项')
  }
  if (new Set(task.dependsOn).size !== task.dependsOn.length) {
    throw new RuleViolationError('任务依赖不能包含重复项')
  }
  validateCovers(task.covers)
  for (const dependency of task.dependsOn) requireNonEmpty(dependency, 'depends_on')
  if (
    !Number.isFinite(task.limits.limitSeconds) ||
    (task.limits.limitSeconds !== -1 && task.limits.limitSeconds <= 0)
  ) {
    throw new RuleViolationError('任务执行限额必须为 -1 或正数（-1 表示不限）')
  }
  if (
    !Number.isInteger(task.limits.maxFailureRounds) ||
    (task.limits.maxFailureRounds !== -1 && task.limits.maxFailureRounds <= 0)
  ) {
    throw new RuleViolationError('任务失败轮次上限必须为 -1 或正整数（-1 表示不限）')
  }
}

/** 按依赖拓扑序返回任务身份；声明顺序作为同层稳定顺序。 */
export function executionOrder(plan: Pick<TaskPlan, 'tasks'>): string[] {
  const order: string[] = []
  const remaining = new Map(plan.tasks.map((task) => [task.taskId, new Set(task.dependsOn)]))
  while (remaining.size > 0) {
    const ready = plan.tasks
      .filter((task) => remaining.has(task.taskId) && (remaining.get(task.taskId)?.size ?? 0) === 0)
      .map((task) => task.taskId)
    if (ready.length === 0) throw new RuleViolationError('任务包依赖存在环，无法形成执行顺序')
    for (const taskId of ready) {
      order.push(taskId)
      remaining.delete(taskId)
    }
    for (const dependencies of remaining.values()) {
      for (const taskId of ready) dependencies.delete(taskId)
    }
  }
  return order
}

export function validateTaskPlan(plan: TaskPlan): void {
  requireNonEmpty(plan.taskPlanId, 'task_plan_id')
  if (plan.technicalSolution !== undefined) {
    requireNonEmpty(plan.technicalSolution.summary, 'technical_solution.summary')
    toStringList(plan.technicalSolution.approach, 'technical_solution.approach', false)
    toStringList(plan.technicalSolution.risks, 'technical_solution.risks', true)
  }
  requireNonEmpty(plan.requirementId, 'requirement_id')
  requireNonEmpty(plan.project, 'project')
  if (plan.planVersion < 1) throw new RuleViolationError('任务包版本号必须从 1 开始')
  if (plan.requirementVersion < 1) throw new RuleViolationError('任务包必须绑定一个需求版本')
  if (plan.tasks.length === 0) throw new RuleViolationError('任务包至少要有一个任务')
  const ids = plan.tasks.map((task) => task.taskId)
  if (new Set(ids).size !== ids.length)
    throw new RuleViolationError('同一任务包内 task_id 必须唯一')
  const known = new Set(ids)
  for (const task of plan.tasks) {
    validateTask(task)
    for (const dependency of task.dependsOn) {
      if (!known.has(dependency)) {
        throw new RuleViolationError(`任务 ${task.taskId} 依赖不存在的任务: ${dependency}`)
      }
    }
  }
  executionOrder(plan)
}

export interface TaskPlanApproval {
  readonly requirementId: string
  readonly planVersion: number
  readonly approvedBy: string
  readonly approvedAt: string
  readonly source: string
}

export function authorizationSourceOf(approval: TaskPlanApproval): string {
  return `plan-approval:${approval.requirementId}:v${approval.planVersion}:${approval.approvedBy}`
}

export type AuthorizationStatus = 'missing' | 'stale' | 'approved'

export interface PlanAuthorization {
  readonly status: AuthorizationStatus
  readonly approval: TaskPlanApproval | null
  readonly reason: string
}

/** 判定任务包能否据此批准开始执行（纯函数）。 */
export function authorizePlan(
  plan: TaskPlan,
  approval: TaskPlanApproval | null,
): PlanAuthorization {
  if (approval === null) {
    return { status: 'missing', approval: null, reason: '未找到该需求的任务包批准；未批准不执行' }
  }
  if (approval.requirementId !== plan.requirementId) {
    return { status: 'stale', approval, reason: '批准不绑定该需求；不能驱动本任务包' }
  }
  if (approval.planVersion !== plan.planVersion) {
    return {
      status: 'stale',
      approval,
      reason: `批准绑定任务包 v${approval.planVersion}，当前任务包 v${plan.planVersion}；旧版本批准不能驱动新任务包`,
    }
  }
  return { status: 'approved', approval, reason: '' }
}

/** 把真实批准的授权来源写入任务包内每个任务；不匹配时明确拒绝。 */
export function bindAuthorization(plan: TaskPlan, approval: TaskPlanApproval): TaskPlan {
  const authorization = authorizePlan(plan, approval)
  if (authorization.status !== 'approved') {
    throw new RuleViolationError(authorization.reason)
  }
  const source = authorizationSourceOf(approval)
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({ ...task, authorizationSource: source })),
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  const record = recordOf(value)
  if (!record) throw new MalformedError(`任务包字段 ${field} 必须是对象`)
  return record
}

function limitsFrom(value: unknown): TaskLimits {
  if (value === undefined || value === null) return DEFAULT_TASK_LIMITS
  const data = asRecord(value, 'limits')
  const limitSeconds = data.limit_seconds ?? DEFAULT_TASK_LIMIT_SECONDS
  if (
    typeof limitSeconds !== 'number' ||
    !Number.isFinite(limitSeconds) ||
    (limitSeconds !== -1 && limitSeconds <= 0)
  ) {
    throw new MalformedError('任务包字段 limits.limit_seconds 必须为 -1 或正数（-1 表示不限）')
  }
  const maxFailureRounds = data.max_failure_rounds ?? DEFAULT_MAX_FAILURE_ROUNDS
  if (
    typeof maxFailureRounds !== 'number' ||
    !Number.isInteger(maxFailureRounds) ||
    (maxFailureRounds !== -1 && maxFailureRounds <= 0)
  ) {
    throw new MalformedError(
      '任务包字段 limits.max_failure_rounds 必须为 -1 或正整数（-1 表示不限）',
    )
  }
  return { limitSeconds, maxFailureRounds }
}

/** 解析模型给出的任务包载荷；不允许载荷自带 authorization_source。 */
function parseTechnicalSolution(value: unknown): TechnicalSolution {
  const data = asRecord(value, 'technical_solution')
  return {
    summary: requireNonEmpty(data.summary, 'technical_solution.summary'),
    approach: toStringList(data.approach, 'technical_solution.approach', false),
    risks: toStringList(data.risks ?? [], 'technical_solution.risks', true),
  }
}

export function parseTaskPlanDraft(
  raw: unknown,
  context: {
    requirementId: string
    project: string
    planVersion: number
    requirementVersion: number
    now: string
  },
): TaskPlan {
  let payload = raw
  if (typeof payload === 'string') {
    payload = (() => {
      const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(payload)
      const body = fenced?.[1] ?? payload
      try {
        const parsed: unknown = JSON.parse(body)
        return parsed
      } catch (error) {
        // 模型偶尔把 JSON 包在工具调用标记或说明文字里；只接受唯一一段完整对象，
        // 不猜测多个候选，也不放宽任务包校验。
        const start = body.indexOf('{')
        const end = body.lastIndexOf('}')
        if (start >= 0 && end > start) {
          try {
            const parsed: unknown = JSON.parse(body.slice(start, end + 1))
            return parsed
          } catch {
            // 落到统一的畸形错误。
          }
        }
        throw new MalformedError(`任务包不是可解析的 JSON：${errorMessage(error)}`)
      }
    })()
  }
  const data = asRecord(payload, 'payload')
  if (!Array.isArray(data.tasks) || data.tasks.length === 0) {
    throw new MalformedError('任务包必须给出非空 tasks 数组')
  }
  const tasks = data.tasks.map((item, index) => {
    const task = asRecord(item, `tasks[${index}]`)
    if ('authorization_source' in task) {
      throw new MalformedError('任务包不得自带 authorization_source；授权来源由真实批准绑定')
    }
    if ('verification' in task) {
      throw new MalformedError('验证任务类型已删除；请按实际实现拆任务并给出可修改文件')
    }
    return {
      taskId: requireNonEmpty(task.task_id ?? task.taskId, 'task_id'),
      goal: requireNonEmpty(task.goal, 'goal'),
      files: toStringList(task.files, 'files', false),
      acceptance: requireNonEmpty(task.acceptance, 'acceptance'),
      testCommand: toStringList(task.test_command ?? task.testCommand, 'test_command', false),
      dependsOn: toStringList(task.depends_on ?? task.dependsOn ?? [], 'depends_on', true),
      limits: limitsFrom(task.limits),
      authorizationSource: '',
      ...(task.covers === undefined
        ? {}
        : { covers: normalizeCovers(toStringList(task.covers, 'covers', true)) }),
    } satisfies PlannedTask
  })
  const solution =
    data.technical_solution === undefined
      ? undefined
      : parseTechnicalSolution(data.technical_solution)
  const plan: TaskPlan = {
    taskPlanId: `plan-${context.requirementId}-${context.planVersion}`,
    requirementId: context.requirementId,
    project: context.project,
    planVersion: context.planVersion,
    requirementVersion: context.requirementVersion,
    tasks,
    ...(solution === undefined ? {} : { technicalSolution: solution }),
    createdAt: context.now,
  }
  validateTaskPlan(plan)
  return plan
}

export function findTask(plan: TaskPlan, taskId: string): PlannedTask {
  const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
  if (!task) throw new NotFoundError(`任务包内没有任务 ${taskId}`)
  return task
}

/** 某任务的全部上游任务（递归去重），按执行顺序返回。 */
export function ancestorTaskIds(plan: TaskPlan, taskId: string): string[] {
  const target = findTask(plan, taskId)
  const seen = new Set<string>()
  const visit = (id: string): void => {
    const task = findTask(plan, id)
    for (const dependency of task.dependsOn) {
      if (!seen.has(dependency)) {
        seen.add(dependency)
        visit(dependency)
      }
    }
  }
  visit(target.taskId)
  return executionOrder(plan).filter((id) => seen.has(id))
}
