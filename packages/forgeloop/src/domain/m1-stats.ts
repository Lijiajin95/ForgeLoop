/**
 * M1 统计口径（docs/product.md §12）的纯计算部分：
 * 从记录事实判定人工介入与自主成功，避免脚本里散落判定而无法测试。
 */

export interface RequirementFacts {
  readonly reqId: string
  readonly status: string
  readonly versions: number
  /** requirement_grants 行数：任何一行都是一次显式追加授权。 */
  readonly grants: number
  readonly budgetExtensions: number
  readonly stops: number
  readonly cancellations: number
  readonly clarificationQuestions: number
  readonly committed: boolean
  readonly verification: string
  /** 该需求是否有 verified 的部署记录。 */
  readonly deployed: boolean
}

export interface OpsEventFacts {
  readonly eventId: string
  readonly resourceId: string
  readonly checkId: string
  readonly fixRequirementId: string
  readonly state: string
  readonly humanInvolved: boolean
  readonly closedAt: string
  readonly recoveredAt: string
}

/** 人工介入事实；空数组表示记录中没有任何介入依据。 */
export function interventionsOf(facts: RequirementFacts): string[] {
  const items: string[] = []
  if (facts.versions > 1) items.push(`需求修订 ${facts.versions - 1} 次`)
  if (facts.grants > 0) items.push(`追加授权 ${facts.grants} 次`)
  if (facts.budgetExtensions > 0) items.push(`工时延长 ${facts.budgetExtensions} 次`)
  if (facts.stops > 0) items.push(`停止 ${facts.stops} 次`)
  if (facts.cancellations > 0) items.push(`取消 ${facts.cancellations} 次`)
  if (facts.clarificationQuestions > 0) {
    items.push(`产品澄清 ${facts.clarificationQuestions} 次`)
  }
  return items
}

/**
 * 自主成功：无人工介入、已受控提交、测试通过、部署 verified、
 * 且需求处于已提交/已验收状态。已提交但未部署不算成功。
 */
export function isAutonomousSuccess(facts: RequirementFacts): boolean {
  return (
    interventionsOf(facts).length === 0 &&
    facts.committed &&
    facts.verification === 'pass' &&
    facts.deployed &&
    (facts.status === 'committed' || facts.status === 'accepted')
  )
}

/** 百分比：空分母显示“无样本”，绝不把 1/1 显示成 1.0%。 */
export function formatRatio(numerator: number, denominator: number): string {
  if (denominator === 0) return '无样本'
  const percent = (numerator / denominator) * 100
  return `${numerator}/${denominator} = ${percent.toFixed(1)}%`
}

/** 同一对象在多份归档中出现时只计一次；返回去重后的键与重复项。 */
export function dedupeByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): { unique: T[]; duplicates: string[] } {
  const seen = new Set<string>()
  const unique: T[] = []
  const duplicates: string[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) {
      duplicates.push(key)
      continue
    }
    seen.add(key)
    unique.push(item)
  }
  return { unique, duplicates }
}

/** 同一故障的告警归并：资源+检查+修复需求相同即视为同一次故障。 */
export function groupIncidents(events: readonly OpsEventFacts[]): Array<{
  key: string
  eventIds: string[]
  humanInvolved: boolean
  closed: boolean
  recovered: boolean
}> {
  const groups = new Map<string, OpsEventFacts[]>()
  for (const event of events) {
    const key = [event.resourceId, event.checkId, event.fixRequirementId].join('|')
    const list = groups.get(key) ?? []
    list.push(event)
    groups.set(key, list)
  }
  return [...groups.entries()]
    .map(([key, list]) => ({
      key,
      eventIds: list.map((event) => event.eventId),
      humanInvolved: list.some((event) => event.humanInvolved),
      closed: list.some((event) => event.closedAt !== ''),
      recovered: list.some((event) => event.recoveredAt !== ''),
    }))
    .sort((left, right) => left.key.localeCompare(right.key))
}
