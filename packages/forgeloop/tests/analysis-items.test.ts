import { describe, expect, it } from 'vitest'
import {
  analysisItems,
  parseAnalysisDraft,
  type RequirementAnalysis,
} from '../src/domain/requirement.js'
import { parseTaskPlanDraft, validateTaskPlanCoverage } from '../src/domain/task-plan.js'

const base = {
  goal: '实现费用报销',
  scenarios: ['提交报销单'],
  business_rules: ['金额必须含税'],
  exceptions: ['空输入给出明确错误'],
  acceptance_criteria: ['保存成功并可查询'],
  clarifications: [],
}

describe('requirement analysis items', () => {
  it('keeps stable ids and basis when the model supplies items', () => {
    const draft = parseAnalysisDraft({
      ...base,
      items: [
        { item_id: 's1', kind: 'scenario', text: '提交报销单', basis: 'customer_explicit' },
        { item_id: 'r1', kind: 'business_rule', text: '金额必须含税', basis: 'verified_fact' },
        { item_id: 'e1', kind: 'exception', text: '空输入给出明确错误', basis: 'assumption' },
        { item_id: 'a1', kind: 'acceptance', text: '保存成功并可查询', basis: 'customer_explicit' },
      ],
    })
    expect(draft.itemsProvided).toBe(true)
    expect(draft.items.map((item) => [item.itemId, item.basis])).toEqual([
      ['s1', 'customer_explicit'],
      ['r1', 'verified_fact'],
      ['e1', 'assumption'],
      ['a1', 'customer_explicit'],
    ])
    expect(draft.exceptions).toEqual(['空输入给出明确错误'])
  })

  it('derives deterministic ids for legacy analyses without inventing a basis', () => {
    const analysis = {
      analysisVersion: 1,
      requirementVersion: 1,
      goal: '旧分析',
      scenarios: base.scenarios,
      businessRules: base.business_rules,
      exceptions: base.exceptions,
      acceptanceCriteria: base.acceptance_criteria,
      clarifications: [],
      createdAt: '2026-11-05T00:00:00.000Z',
    } satisfies RequirementAnalysis
    expect(analysisItems(analysis).map((item) => item.itemId)).toEqual([
      'scenario-1',
      'rule-1',
      'exception-1',
      'acceptance-1',
    ])
    expect(analysisItems(analysis).every((item) => item.basis === 'unknown')).toBe(true)
  })

  it('rejects duplicate ids and unknown basis', () => {
    expect(() =>
      parseAnalysisDraft({
        ...base,
        items: [
          { item_id: 'same', kind: 'scenario', text: '提交报销单', basis: 'customer_explicit' },
          { item_id: 'same', kind: 'acceptance', text: '保存成功并可查询', basis: 'unknown' },
        ],
      }),
    ).toThrow('item_id 不能重复')
    expect(() =>
      parseAnalysisDraft({
        ...base,
        items: [
          { item_id: 's1', kind: 'scenario', text: '提交报销单', basis: 'made_up' },
          { item_id: 'a1', kind: 'acceptance', text: '保存成功并可查询', basis: 'unknown' },
        ],
      }),
    ).toThrow('basis 只能是')
  })

  it('allows problem clarifications only when the dev escalation path opts in', () => {
    const problem = {
      ...base,
      input_kind: 'problem',
      clarifications: ['业务规则是否包含历史单据？'],
    }
    expect(() => parseAnalysisDraft(problem)).toThrow('不能带待澄清项')
    expect(
      parseAnalysisDraft(problem, { allowProblemClarifications: true }).clarifications,
    ).toEqual(['业务规则是否包含历史单据？'])
  })
})

describe('requirement item coverage', () => {
  it('requires tasks to cover every non-goal analysis item', () => {
    const analysis = parseAnalysisDraft({
      ...base,
      non_goals: ['不修改其他项目'],
      items: [
        { item_id: 's1', kind: 'scenario', text: '提交报销单', basis: 'customer_explicit' },
        { item_id: 'r1', kind: 'business_rule', text: '金额必须含税', basis: 'verified_fact' },
        { item_id: 'e1', kind: 'exception', text: '空输入给出明确错误', basis: 'assumption' },
        { item_id: 'a1', kind: 'acceptance', text: '保存成功并可查询', basis: 'customer_explicit' },
        { item_id: 'n1', kind: 'non_goal', text: '不修改其他项目', basis: 'customer_explicit' },
      ],
    })
    const plan = parseTaskPlanDraft(
      {
        tasks: [
          {
            task_id: 'only',
            goal: '实现并自验',
            files: ['packages/forgeloop/src/x.ts'],
            acceptance: '自验通过',
            test_command: ['node', '-e', 'process.exit(0)'],
            covers: ['s1', 'r1', 'e1', 'a1'],
          },
        ],
      },
      { requirementId: 'req-x', project: 'p', planVersion: 1, requirementVersion: 1, now: 't' },
    )
    expect(validateTaskPlanCoverage(analysis, plan)).toEqual([])
    const missing = { ...plan, tasks: [{ ...plan.tasks[0]!, covers: ['s1'] }] }
    expect(validateTaskPlanCoverage(analysis, missing).join('\n')).toContain(
      '需求条目未被任何任务覆盖',
    )
    const nonGoal = { ...plan, tasks: [{ ...plan.tasks[0]!, covers: ['n1'] }] }
    expect(validateTaskPlanCoverage(analysis, nonGoal).join('\n')).toContain('不能把非目标条目')
  })
})
