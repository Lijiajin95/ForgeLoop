import { asRecord } from './json.js'
import { FAILURE_IMPLEMENTATION_REVIEW, type FailureStage } from './counting.js'

export interface TaskFailureAdvice {
  readonly cause: string
  readonly actions: readonly string[]
  readonly scope: readonly string[]
}

export interface TaskFailureInput {
  readonly state: string
  readonly reason: string
  readonly files: readonly string[]
  readonly remainingRounds: number
  readonly testLogTail?: string
  readonly review?: unknown
  readonly failureStage?: FailureStage | undefined
}

const FAILURE_STATES = new Set<string>(['failed', 'blocked', 'awaiting_user'])

function unique(items: readonly string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))]
}

function contractModules(log: string): string[] {
  const modules: string[] = []
  for (const match of log.matchAll(/\[contracts\][^\n]*modules[：:]\s*([^\n]+)/g)) {
    const line = match[1] ?? ''
    modules.push(...line.split(/[、,，]/))
  }
  return unique(modules)
}

function testFiles(log: string): string[] {
  const files: string[] = []
  for (const match of log.matchAll(/(?:FAIL|❯)\s+(tests\/[^\s:()]+\.test\.ts)/g)) {
    files.push(match[1] ?? '')
  }
  return unique(files)
}

function outOfScopeFiles(reason: string): string[] {
  const match = /改动越出批准文件清单[：:]\s*([^；;]+)/.exec(reason)
  if (!match) return []
  return unique((match[1] ?? '').split(/[、,，]/))
}

function reviewBlocking(review: unknown): string[] {
  if (typeof review !== 'object' || review === null) return []
  const record = asRecord(review) ?? {}
  const blocking = Array.isArray(record.blocking) ? record.blocking : []
  if (record.verdict !== 'block') return []
  return unique(blocking.filter((item: unknown): item is string => typeof item === 'string'))
}

export function buildTaskFailureAdvice(input: TaskFailureInput): TaskFailureAdvice | null {
  if (!FAILURE_STATES.has(input.state)) return null
  const facts = collectAdviceFacts(input)
  const advice = buildAdvice(facts)
  return { ...advice, actions: appendBudgetAdvice(advice.actions, input) }
}

interface AdviceFacts {
  readonly input: TaskFailureInput
  readonly reason: string
  readonly modules: string[]
  readonly boundaries: string[]
  readonly blocking: string[]
  readonly files: string[]
}

function collectAdviceFacts(input: TaskFailureInput): AdviceFacts {
  const reason = input.reason.trim()
  const log = input.testLogTail ?? ''
  return {
    input,
    reason,
    modules: contractModules(log),
    boundaries: outOfScopeFiles(reason),
    blocking:
      input.failureStage === FAILURE_IMPLEMENTATION_REVIEW ? reviewBlocking(input.review) : [],
    files: testFiles(log),
  }
}

function buildAdvice(facts: AdviceFacts): TaskFailureAdvice {
  const { input, reason, modules, boundaries, blocking, files } = facts
  if (modules.length > 0) return adviceForModules(modules)
  if (boundaries.length > 0) return adviceForBoundaries(boundaries)
  if (blocking.length > 0) return adviceForBlocking(blocking)
  if (reason.includes('没有产生任何文件改动')) return adviceForNoChanges(input.files)
  if (/被停止|超时|中断/.test(reason)) return adviceForInterrupted()
  if (reason.includes('正式测试') || reason.includes('退出码')) return adviceForFormalTest(files)
  if (reason) return adviceForOther()
  return adviceForMissingReason()
}

function adviceForModules(modules: readonly string[]): TaskFailureAdvice {
  return {
    cause: `架构契约未登记新增模块：${modules.join('、')}。`,
    scope: modules,
    actions: [
      `在 contracts/architecture.json 的 modules 中登记：${modules.join('、')}，并同步架构说明。`,
      '把 contracts/architecture.json 纳入该任务的允许文件清单；这改变了已批准边界，必须重新规划并取得批准。',
      '完成上述变更后再重试；若仍按当前范围直接重试，会再次被同一契约检查阻断。',
    ],
  }
}

function adviceForBoundaries(boundaries: readonly string[]): TaskFailureAdvice {
  return {
    cause: `任务改动越出批准文件清单：${boundaries.join('、')}。`,
    scope: boundaries,
    actions: [
      '若确需修改这些文件，重新规划任务包把它们纳入，并对新版本取得批准。',
      '若不需要这些改动，恢复越界文件后重试。',
      '不要在重试中绕过文件边界；清单外改动会被再次拒绝。',
    ],
  }
}

function adviceForBlocking(blocking: readonly string[]): TaskFailureAdvice {
  return {
    cause: `独立审查阻断：${blocking.join('；')}。`,
    scope: [],
    actions: [
      `按审查阻断项逐条修复：${blocking.join('；')}。`,
      '修复后重试；重试保留失败轮次和审查证据。',
    ],
  }
}

function adviceForNoChanges(files: readonly string[]): TaskFailureAdvice {
  return {
    cause: '开发回合没有产生任何文件改动。',
    scope: [],
    actions: [
      `核对允许文件清单（${files.join('、') || '空'}）与任务目标是否匹配。`,
      '重试时要求实现产生允许清单内的实际改动；目标本身不可实现时应重新规划。',
    ],
  }
}

function adviceForInterrupted(): TaskFailureAdvice {
  return {
    cause: '任务运行被停止、超时或中断。',
    scope: [],
    actions: [
      '先核对工作副本、Git 与证据，确认没有未收口改动或外部副作用。',
      '确认后再重试；未核对前不得盲目重放。',
    ],
  }
}

function adviceForFormalTest(files: readonly string[]): TaskFailureAdvice {
  const actions =
    files.length > 0
      ? [`失败用例位于：${files.join('、')}；查看正式测试日志定位断言，修复后重试。`]
      : ['查看正式测试日志，定位并修复失败用例后重试。']
  actions.push('重试保留既有失败轮次与证据，不会清零；不要修改测试来绕过检查。')
  return { cause: '正式测试失败。', scope: [], actions }
}

function adviceForOther(): TaskFailureAdvice {
  return {
    cause: '任务运行失败，未归类到已知失败模式。',
    scope: [],
    actions: ['查看任务执行过程、审查结论与日志，定位失败原因后重试。'],
  }
}

function adviceForMissingReason(): TaskFailureAdvice {
  return {
    cause: '任务运行未记录失败原因。',
    scope: [],
    actions: [
      '查看任务执行过程与证据；原因缺失时不要假定已经通过。',
      '补齐失败原因后再决定重试或重新规划。',
    ],
  }
}

function appendBudgetAdvice(actions: readonly string[], input: TaskFailureInput): string[] {
  const result = [...actions]
  if (input.remainingRounds === 0) {
    result.push('失败轮次额度已用尽：需要追加授权或重新规划后再重试，重试不能绕过额度。')
  }
  if (input.state === 'awaiting_user') {
    result.push('自动尝试次数已用尽；这是一次人工决定，确认范围与证据后再重试。')
  }
  return result
}
