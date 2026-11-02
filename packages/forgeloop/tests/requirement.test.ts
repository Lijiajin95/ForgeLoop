import { describe, expect, it } from 'vitest'
import {
  parseAnalysisDraft,
  statusForAnalysis,
  validateRequirement,
} from '../src/domain/requirement.js'
import type { RequirementVersion } from '../src/domain/requirement.js'
import { MalformedError, RuleViolationError } from '../src/domain/errors.js'

function version(n: number, text = `v${n}`): RequirementVersion {
  return {
    version: n,
    text,
    createdAt: '2026-10-22T00:00:00.000Z',
    revisedBy: 'owner',
    source: 'test',
  }
}

describe('requirement identity and versions', () => {
  it('accepts contiguous versions starting at 1', () => {
    expect(() =>
      validateRequirement({ reqId: 'req-1', project: 'p', versions: [version(1), version(2)] }),
    ).not.toThrow()
  })

  it('rejects a gap or reordering in version history', () => {
    expect(() =>
      validateRequirement({ reqId: 'req-1', project: 'p', versions: [version(1), version(3)] }),
    ).toThrow(RuleViolationError)
    expect(() =>
      validateRequirement({ reqId: 'req-1', project: 'p', versions: [version(2), version(1)] }),
    ).toThrow(/连续递增/)
  })

  it('rejects empty text and missing project', () => {
    expect(() =>
      validateRequirement({ reqId: 'req-1', project: 'p', versions: [version(1, '  ')] }),
    ).toThrow(RuleViolationError)
    expect(() =>
      validateRequirement({ reqId: 'req-1', project: '', versions: [version(1)] }),
    ).toThrow(/项目/)
  })
})

describe('analysis payload parsing', () => {
  it('parses a structured analysis and derives status', () => {
    const analysis = parseAnalysisDraft({
      goal: 'g',
      scenarios: ['s'],
      acceptance_criteria: ['a'],
      clarifications: [],
    })
    expect(statusForAnalysis(analysis)).toBe('draft')
  })

  it('waits for clarification when clarifications are present', () => {
    const analysis = parseAnalysisDraft({ goal: 'g', clarifications: ['which repo?'] })
    expect(statusForAnalysis(analysis)).toBe('awaiting_clarification')
  })

  it('accepts fenced JSON from a model reply', () => {
    const analysis = parseAnalysisDraft(
      '说明文字\n```json\n{"goal":"g","scenarios":["s"],"acceptance_criteria":["a"],"clarifications":[]}\n```',
    )
    expect(analysis.goal).toBe('g')
  })

  it('rejects a payload with no scenarios/acceptance and no clarifications', () => {
    expect(() => parseAnalysisDraft({ goal: 'g', clarifications: [] })).toThrow(MalformedError)
  })

  it('rejects an unparseable reply instead of treating it as empty', () => {
    expect(() => parseAnalysisDraft('not json')).toThrow(MalformedError)
  })

  it('rejects non-string list entries', () => {
    expect(() => parseAnalysisDraft({ goal: 'g', clarifications: [3] })).toThrow(MalformedError)
  })

  it('reads business rules, exceptions and non-goals from the business scenarios', () => {
    const analysis = parseAnalysisDraft({
      goal: 'g',
      scenarios: ['门店按状态筛选订单'],
      business_rules: ['只有店长可以批量取消'],
      exceptions: ['支付回调延迟时订单保持待确认'],
      non_goals: ['不改造支付渠道'],
      acceptance_criteria: ['a'],
      clarifications: [],
    })
    expect(analysis.businessRules).toEqual(['只有店长可以批量取消'])
    expect(analysis.exceptions).toEqual(['支付回调延迟时订单保持待确认'])
    expect(analysis.nonGoals).toEqual(['不改造支付渠道'])
  })

  it('defaults the new business fields for analyses written before them', () => {
    const analysis = parseAnalysisDraft({
      goal: 'g',
      scenarios: ['s'],
      acceptance_criteria: ['a'],
      clarifications: [],
    })
    expect(analysis.businessRules).toEqual([])
    expect(analysis.exceptions).toEqual([])
    expect(analysis.nonGoals).toEqual([])
  })

  it('rejects malformed business rule fields instead of dropping them', () => {
    expect(() =>
      parseAnalysisDraft({
        goal: 'g',
        scenarios: ['s'],
        acceptance_criteria: ['a'],
        clarifications: [],
        business_rules: 'only one',
      }),
    ).toThrow(MalformedError)
  })

  it('defaults the business context to unchanged when the model omits it', () => {
    const analysis = parseAnalysisDraft({
      goal: 'g',
      scenarios: ['s'],
      acceptance_criteria: ['a'],
      clarifications: [],
    })
    expect(analysis.businessContext).toEqual({ changed: false, document: '' })
  })

  it('accepts a full business context document when it changed', () => {
    const document = '# 业务背景\n\n行业：本地生活服务\n'
    const analysis = parseAnalysisDraft({
      goal: 'g',
      scenarios: ['s'],
      acceptance_criteria: ['a'],
      clarifications: [],
      business_context: { changed: true, document },
    })
    expect(analysis.businessContext).toEqual({ changed: true, document })
  })

  it('rejects a changed flag without a document, or a document without the flag', () => {
    for (const businessContext of [
      { changed: true, document: '   ' },
      { changed: true },
      { changed: false, document: '# 旧内容' },
      { changed: 'yes', document: '' },
      { changed: false, document: 3 },
      'business context',
    ]) {
      expect(() =>
        parseAnalysisDraft({
          goal: 'g',
          scenarios: ['s'],
          acceptance_criteria: ['a'],
          clarifications: [],
          business_context: businessContext,
        }),
      ).toThrow(MalformedError)
    }
  })
})
