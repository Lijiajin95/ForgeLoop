/**
 * 测试夹具适配：把既有用例里“只有目标/场景/验收字符串”的分析载荷补成
 * 结构化业务要点，使测试继续验证原业务流程，而不是每个测试重复手写规格。
 *
 * 这里只服务测试；生产解析不会从旧字符串反推业务要点，也不允许无依据补造。
 */

type Json = Record<string, unknown>

function parse(raw: string): Json | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Json
  } catch {
    return null
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
}

/** 给无结构化规格的需求分析补一个可验证的要点与验收。 */
export function withStructuredSpec(raw: string): string {
  const data = parse(raw)
  if (!data) return raw
  if (data.business_points !== undefined) return raw
  if (data.input_kind === 'problem') return raw
  const criteria = strings(data.acceptance_criteria)
  if (criteria.length === 0) return raw
  const scenarios = strings(data.scenarios)
  const rules = strings(data.business_rules)
  const exceptions = strings(data.exceptions)
  return JSON.stringify({
    ...data,
    business_points: [
      {
        id: 'BP-1',
        basis: 'user_requirement',
        source: '需求原文（测试夹具）',
        actor: '业务用户',
        trigger: '使用该能力时',
        behavior: String(data.goal ?? '需求目标'),
        rules,
        exceptions:
          exceptions.length > 0
            ? { status: 'assessed', items: exceptions, reason: '' }
            : { status: 'not_applicable', items: [], reason: '测试夹具未声明额外异常路径' },
      },
    ],
    acceptance_criteria: criteria.map((text, index) => ({
      id: `AC-${index + 1}`,
      point_ids: ['BP-1'],
      given: scenarios[0] ?? '前置条件满足',
      when: '执行需求描述的操作',
      then: text,
    })),
    assumptions: [],
  })
}

/** 给任务包补 covers，使结构化分析下的覆盖校验可通过。 */
export function withStructuredPlan(raw: string): string {
  const data = parse(raw)
  if (!data || !Array.isArray(data.tasks)) return raw
  return JSON.stringify({
    ...data,
    tasks: data.tasks.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
      const task = item as Json
      return task.covers === undefined ? { ...task, covers: ['BP-1'] } : task
    }),
  })
}

/** 给验证方案/报告的 scenarios 或 verification_plan 补编号引用。 */
export function withStructuredVerificationPlan(raw: string): string {
  const data = parse(raw)
  if (!data) return raw
  const withIds = (items: unknown): unknown => {
    if (!Array.isArray(items)) return items
    return items.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
      const entry = item as Json
      return {
        ...entry,
        point_ids: entry.point_ids ?? ['BP-1'],
        acceptance_ids: entry.acceptance_ids ?? ['AC-1'],
      }
    })
  }
  return JSON.stringify({
    ...data,
    ...(data.scenarios === undefined ? {} : { scenarios: withIds(data.scenarios) }),
    ...(data.verification_plan === undefined
      ? {}
      : { verification_plan: withIds(data.verification_plan) }),
  })
}

/** 给业务终审报告补业务要点结果；证据沿用首条场景/验收的实际命令记录。 */
export function withStructuredBusinessReview(raw: string): string {
  const data = parse(raw)
  if (!data || data.points !== undefined) return raw
  const first = Array.isArray(data.scenarios)
    ? data.scenarios[0]
    : Array.isArray(data.acceptance)
      ? data.acceptance[0]
      : undefined
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return raw
  const item = first as Json
  const acceptance = Array.isArray(data.acceptance)
    ? data.acceptance.map((entry) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
        return (entry as Json).id === undefined ? { ...(entry as Json), id: 'AC-1' } : entry
      })
    : data.acceptance
  return JSON.stringify({
    ...data,
    ...(acceptance === undefined ? {} : { acceptance }),
    points: [
      {
        id: 'BP-1',
        status: item.status ?? (data.verdict === 'pass' ? 'pass' : 'fail'),
        evidence: item.evidence ?? '',
        commands: Array.isArray(item.commands) ? item.commands : [],
      },
    ],
  })
}
export function structuredSpecOf(value: Json): string {
  return withStructuredSpec(JSON.stringify(value))
}

export function structuredPlanOf(value: Json): string {
  return withStructuredPlan(JSON.stringify(value))
}

export function structuredVerificationOf(value: Json): string {
  return withStructuredVerificationPlan(JSON.stringify(value))
}

export function structuredReviewOf(value: Json): string {
  return withStructuredBusinessReview(JSON.stringify(value))
}
