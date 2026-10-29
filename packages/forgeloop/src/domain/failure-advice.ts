/**
 * 任务失败建议：把已记录的任务运行原因、正式测试日志与审查结论整理成
 * “发生了什么、下一步做什么”。只做确定性归因，不调用模型；
 * 证据不足时如实说明，不编造修复方案，也不把重试当成绕过规则的入口。
 */

export interface TaskFailureAdvice {
  /** 依据证据得到的失败原因摘要。 */
  readonly cause: string
  /** 可执行的下一步；按建议顺序展示。 */
  readonly actions: readonly string[]
  /** 建议聚焦的文件或模块（契约登记、越界改动等），没有则为空。 */
  readonly scope: readonly string[]
}

export interface TaskFailureInput {
  readonly state: string
  readonly reason: string
  readonly files: readonly string[]
  /** 当前授权下剩余的失败轮次；0 表示必须先追加授权或重新规划。 */
  readonly remainingRounds: number
  /** 正式测试日志尾部；用于定位失败用例与契约检查原因。 */
  readonly testLogTail?: string
  /** review.json 的解析结果；只有 verdict=block 时作为阻断依据。 */
  readonly review?: unknown
}

const FAILURE_STATES = new Set<string>(['failed', 'blocked', 'awaiting_user'])

function unique(items: readonly string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))]
}

/** 契约检查失败时日志会逐行给出未登记模块；只读取明确的模块路径。 */
function contractModules(log: string): string[] {
  const modules: string[] = []
  for (const match of log.matchAll(/\[contracts\][^\n]*modules[：:]\s*([^\n]+)/g)) {
    const line = match[1] ?? ''
    modules.push(...line.split(/[、,，]/))
  }
  return unique(modules)
}

/** 正式测试日志里的测试文件路径；用于把“测试失败”落到具体用例。 */
function testFiles(log: string): string[] {
  const files: string[] = []
  for (const match of log.matchAll(/(?:FAIL|❯)\s+(tests\/[^\s:()]+\.test\.ts)/g)) {
    files.push(match[1] ?? '')
  }
  return unique(files)
}

/** 运行记录里的越界文件清单。 */
function outOfScopeFiles(reason: string): string[] {
  const match = /改动越出批准文件清单[：:]\s*([^；;]+)/.exec(reason)
  if (!match) return []
  return unique((match[1] ?? '').split(/[、,，]/))
}

/** 独立审查的阻断项；畸形记录不当作通过。 */
function reviewBlocking(review: unknown): string[] {
  if (typeof review !== 'object' || review === null) return []
  const record = review as Record<string, unknown>
  if (record.verdict !== 'block' || !Array.isArray(record.blocking)) return []
  return unique(
    record.blocking.filter((item): item is string => typeof item === 'string'),
  )
}

/**
 * 根据任务运行证据生成失败建议；非失败状态返回 null。
 * 只读纯函数：不写记录、不改状态、不执行重试。
 */
export function buildTaskFailureAdvice(input: TaskFailureInput): TaskFailureAdvice | null {
  if (!FAILURE_STATES.has(input.state)) return null

  const reason = input.reason.trim()
  const log = input.testLogTail ?? ''
  const modules = contractModules(log)
  const boundaries = outOfScopeFiles(reason)
  // 只有当前失败确实是审查阻断时才采用 review.json；避免用上一次尝试的旧审查结论解释新的测试失败。
  const blocking = /审查/.test(reason) ? reviewBlocking(input.review) : []
  const files = testFiles(log)

  let cause = reason || '任务运行未记录失败原因。'
  let scope: string[] = []
  const actions: string[] = []

  if (modules.length > 0) {
    cause = `架构契约未登记新增模块：${modules.join('、')}。`
    scope = modules
    actions.push(`在 contracts/architecture.json 的 modules 中登记：${modules.join('、')}，并同步架构说明。`)
    actions.push('把 contracts/architecture.json 纳入该任务的允许文件清单；这改变了已批准边界，必须重新规划并取得批准。')
    actions.push('完成上述变更后再重试；若仍按当前范围直接重试，会再次被同一契约检查阻断。')
  } else if (boundaries.length > 0) {
    cause = `任务改动越出批准文件清单：${boundaries.join('、')}。`
    scope = boundaries
    actions.push('若确需修改这些文件，重新规划任务包把它们纳入，并对新版本取得批准。')
    actions.push('若不需要这些改动，恢复越界文件后重试。')
    actions.push('不要在重试中绕过文件边界；清单外改动会被再次拒绝。')
  } else if (blocking.length > 0) {
    cause = `独立审查阻断：${blocking.join('；')}。`
    actions.push(`按审查阻断项逐条修复：${blocking.join('；')}。`)
    actions.push('修复后重试；重试保留失败轮次和审查证据。')
  } else if (reason.includes('没有产生任何文件改动')) {
    cause = '开发回合没有产生任何文件改动。'
    actions.push(`核对允许文件清单（${input.files.join('、') || '空'}）与任务目标是否匹配。`)
    actions.push('重试时要求实现产生允许清单内的实际改动；目标本身不可实现时应重新规划。')
  } else if (/被停止|超时|中断/.test(reason)) {
    actions.push('先核对工作副本、Git 与证据，确认没有未收口改动或外部副作用。')
    actions.push('确认后再重试；未核对前不得盲目重放。')
  } else if (reason.includes('正式测试') || reason.includes('退出码')) {
    if (files.length > 0) {
      actions.push(`失败用例位于：${files.join('、')}；查看正式测试日志定位断言，修复后重试。`)
    } else {
      actions.push('查看正式测试日志，定位并修复失败用例后重试。')
    }
    actions.push('重试保留既有失败轮次与证据，不会清零；不要修改测试来绕过检查。')
  } else if (reason) {
    actions.push('查看任务执行过程、审查结论与日志，定位失败原因后重试。')
  } else {
    actions.push('查看任务执行过程与证据；原因缺失时不要假定已经通过。')
    actions.push('补齐失败原因后再决定重试或重新规划。')
  }

  if (input.remainingRounds <= 0) {
    actions.push('失败轮次额度已用尽：需要追加授权或重新规划后再重试，重试不能绕过额度。')
  }
  if (input.state === 'awaiting_user') {
    actions.push('自动尝试次数已用尽；这是一次人工决定，确认范围与证据后再重试。')
  }

  return { cause, actions, scope }
}
