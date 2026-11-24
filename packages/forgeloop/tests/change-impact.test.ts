import { describe, expect, it } from 'vitest'
import { classifySpecChange, parseSpecFields, type AnalysisSpec } from '../src/domain/spec.js'

const base = () =>
  parseSpecFields({
    business_points: [
      {
        id: 'BP-1',
        basis: 'user_requirement',
        source: '订单页按状态筛选',
        actor: '店长',
        trigger: '打开订单列表时',
        behavior: '按状态筛选订单',
        rules: [],
        exceptions: { status: 'not_applicable', items: [], reason: '纯展示筛选' },
      },
    ],
    acceptance_criteria: [
      {
        id: 'AC-1',
        point_ids: ['BP-1'],
        given: '订单列表存在三种状态的订单',
        when: '店长选择已完成筛选',
        then: '列表只显示已完成的订单',
      },
    ],
  })

function specOf(fields: ReturnType<typeof base>): AnalysisSpec {
  return {
    points: fields.points,
    acceptance: fields.acceptance,
    assumptions: [],
    conflicts: [],
    references: [],
    uiMap: [],
    samples: [],
    quality: [],
    data: [],
  }
}

function changedAcceptance(): AnalysisSpec {
  const fields = base()
  return {
    ...specOf(fields),
    acceptance: [{ ...fields.acceptance[0]!, then: '列表只显示已完成的订单并显示共 N 条' }],
  }
}

function changedQuality(): AnalysisSpec {
  const fields = base()
  return {
    ...specOf(fields),
    quality: [
      {
        id: 'QA-1',
        kind: 'performance',
        metric: '首屏加载时间',
        target: 'P95 ≤ 2 秒',
        measure: '压测取 P95',
        pointIds: ['BP-1'],
        acceptanceIds: ['AC-1'],
      },
    ],
  }
}

describe('spec change classification', () => {
  it('treats identical specs as no structural change', () => {
    expect(classifySpecChange(specOf(base()), specOf(base()))).toEqual({
      kind: 'none',
      changed: [],
    })
  })

  it('marks changed acceptance as requiring revalidation', () => {
    const impact = classifySpecChange(specOf(base()), changedAcceptance())
    expect(impact.kind).toBe('invalid')
    expect(impact.changed).toEqual(['AC-1'])
  })

  it('reports added and removed artifacts by id', () => {
    const removed = classifySpecChange(changedQuality(), specOf(base()))
    expect(removed.kind).toBe('invalid')
    expect(removed.changed).toEqual(['QA-1'])
    const added = classifySpecChange(specOf(base()), changedQuality())
    expect(added.changed).toEqual(['QA-1'])
  })

  it('treats a first analysis as a structural change covering every artifact', () => {
    expect(classifySpecChange(null, specOf(base()))).toEqual({
      kind: 'invalid',
      changed: ['BP-1', 'AC-1'],
    })
  })

  it('keeps the previous state when the latest analysis is missing', () => {
    expect(classifySpecChange(specOf(base()), null)).toEqual({ kind: 'none', changed: [] })
  })
})
