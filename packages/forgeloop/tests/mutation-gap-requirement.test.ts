import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INPUT_KIND,
  INPUT_KINDS,
  latestVersion,
  parseAnalysisDraft,
  parseJsonLoose,
  statusForAnalysis,
  validateAnalysis,
  validateRequirement,
  type Requirement,
  type RequirementAnalysis,
} from '../src/domain/requirement.js'

function requirement(versions = 1): Requirement {
  return {
    reqId: 'req-1',
    project: 'demo',
    status: 'draft',
    blockedReason: '',
    submittedBy: 'owner',
    source: 'test',
    versions: Array.from({ length: versions }, (_value, index) => ({
      version: index + 1,
      text: `原文 ${index + 1}`,
      createdAt: '2026-11-04T00:00:00.000Z',
      revisedBy: 'owner',
      source: 'test',
    })),
  }
}

describe('requirement structure', () => {
  it('validates identity, project, versions and text', () => {
    expect(() =>
      validateRequirement({ reqId: ' ', project: 'p', versions: requirement().versions }),
    ).toThrow('需求身份不能为空')
    expect(() =>
      validateRequirement({ reqId: 'r', project: ' ', versions: requirement().versions }),
    ).toThrow('需求必须绑定一个项目')
    expect(() => validateRequirement({ reqId: 'r', project: 'p', versions: [] })).toThrow(
      '需求至少要有原始输入这一版本',
    )
    expect(() =>
      validateRequirement({
        reqId: 'r',
        project: 'p',
        versions: [requirement().versions[0]!, { ...requirement().versions[0]!, version: 3 }],
      }),
    ).toThrow('需求版本号必须从 1 起连续递增，历史版本不得覆盖')
    expect(() =>
      validateRequirement({
        reqId: 'r',
        project: 'p',
        versions: [{ ...requirement().versions[0]!, text: '  ' }],
      }),
    ).toThrow('需求版本原文不能为空')
    expect(() =>
      validateRequirement({ reqId: 'r', project: 'p', versions: requirement(2).versions }),
    ).not.toThrow()
  })

  it('returns the latest version and exposes stable vocabularies', () => {
    expect(latestVersion(requirement(2)).version).toBe(2)
    expect(() => latestVersion({ ...requirement(), versions: [] })).toThrow(
      '需求至少要有原始输入这一版本',
    )
    expect(DEFAULT_INPUT_KIND).toBe('requirement')
    expect(INPUT_KINDS).toEqual(['requirement', 'problem'])
  })
})

describe('analysis validation', () => {
  const analysis: RequirementAnalysis = {
    analysisVersion: 1,
    requirementVersion: 1,
    goal: '目标',
    scenarios: ['场景'],
    acceptanceCriteria: ['标准'],
    clarifications: [],
    createdAt: '2026-11-04T00:00:00.000Z',
  }

  it('rejects invalid versions, empty goals and problem clarifications', () => {
    expect(() => validateAnalysis({ ...analysis, analysisVersion: 0 }, 1)).toThrow(
      '分析版本号必须从 1 开始',
    )
    expect(() => validateAnalysis({ ...analysis, requirementVersion: 0 }, 1)).toThrow(
      '分析必须绑定一个需求版本',
    )
    expect(() => validateAnalysis({ ...analysis, requirementVersion: 2 }, 1)).toThrow(
      '分析绑定的需求版本超出实际版本',
    )
    expect(() => validateAnalysis({ ...analysis, goal: '  ' }, 1)).toThrow('分析缺少非空目标')
    expect(() =>
      validateAnalysis({ ...analysis, inputKind: 'problem', clarifications: ['待澄清'] }, 1),
    ).toThrow('问题输入不能带待澄清项；需要澄清时按需求处理')
    expect(() => validateAnalysis(analysis, 1)).not.toThrow()
  })

  it('derives status from clarifications and defaults input kind', () => {
    expect(statusForAnalysis({ clarifications: [] })).toBe('draft')
    expect(statusForAnalysis({ clarifications: ['q'] })).toBe('awaiting_clarification')
  })
})

describe('analysis draft parsing', () => {
  const base = {
    goal: '目标',
    scenarios: ['场景'],
    acceptance_criteria: ['标准'],
  }

  it('parses requirement and problem drafts with defaults', () => {
    expect(parseAnalysisDraft(JSON.stringify(base))).toEqual({
      inputKind: 'requirement',
      goal: '目标',
      scenarios: ['场景'],
      businessRules: [],
      exceptions: [],
      nonGoals: [],
      acceptanceCriteria: ['标准'],
      clarifications: [],
      businessContext: { changed: false, document: '' },
    })
    expect(
      parseAnalysisDraft(
        JSON.stringify({
          input_kind: 'problem',
          goal: '问题',
          acceptance_criteria: ['修复判据'],
          scenarios: [],
        }),
      ),
    ).toMatchObject({
      inputKind: 'problem',
      goal: '问题',
      acceptanceCriteria: ['修复判据'],
    })
    expect(
      parseAnalysisDraft(
        JSON.stringify({
          ...base,
          clarifications: ['待澄清'],
          business_rules: ['规则'],
          exceptions: ['异常'],
          non_goals: ['非目标'],
          business_context: { changed: true, document: '# 背景' },
        }),
      ),
    ).toMatchObject({
      clarifications: ['待澄清'],
      businessRules: ['规则'],
      exceptions: ['异常'],
      nonGoals: ['非目标'],
      businessContext: { changed: true, document: '# 背景' },
    })
  })

  it('rejects malformed drafts with stable messages', () => {
    expect(() => parseAnalysisDraft('[]')).toThrow('分析结果必须是 JSON 对象')
    expect(() => parseAnalysisDraft('{"goal":"  "}')).toThrow('分析缺少非空目标')
    expect(() => parseAnalysisDraft('{"goal":"g","scenarios":"x"}')).toThrow(
      '分析字段 scenarios 必须是字符串数组',
    )
    expect(() => parseAnalysisDraft('{"goal":"g","scenarios":[""]}')).toThrow(
      '分析字段 scenarios 只能包含非空字符串',
    )
    expect(() =>
      parseAnalysisDraft('{"goal":"g","scenarios":["s"],"acceptance_criteria":[]}'),
    ).toThrow('没有待澄清项时必须给出业务场景与验收标准')
    expect(() =>
      parseAnalysisDraft('{"goal":"g","scenarios":[],"acceptance_criteria":["a"]}'),
    ).toThrow('没有待澄清项时必须给出业务场景与验收标准')
    expect(() =>
      parseAnalysisDraft(
        '{"input_kind":"problem","goal":"g","acceptance_criteria":["a"],"clarifications":["q"]}',
      ),
    ).toThrow('问题直接交研发处理，不能带待澄清项；需要澄清时按需求处理')
    expect(() =>
      parseAnalysisDraft('{"input_kind":"problem","goal":"g","acceptance_criteria":[]}'),
    ).toThrow('问题必须给出可检查的修复判据（acceptance_criteria）')
    expect(() => parseAnalysisDraft('{"goal":"g","input_kind":"other"}')).toThrow(
      '分析字段 input_kind 只能是 requirement 或 problem',
    )
    expect(() =>
      parseAnalysisDraft(
        '{"goal":"g","scenarios":["s"],"acceptance_criteria":["a"],"business_context":[]}',
      ),
    ).toThrow('分析字段 business_context 必须是对象')
    expect(() =>
      parseAnalysisDraft(
        '{"goal":"g","scenarios":["s"],"acceptance_criteria":["a"],"business_context":{"changed":"x"}}',
      ),
    ).toThrow('分析字段 business_context.changed 必须是布尔值')
    expect(() =>
      parseAnalysisDraft(
        '{"goal":"g","scenarios":["s"],"acceptance_criteria":["a"],"business_context":{"changed":true}}',
      ),
    ).toThrow('business_context.changed 为 true 时必须给出完整的业务背景文档')
    expect(() =>
      parseAnalysisDraft(
        '{"goal":"g","scenarios":["s"],"acceptance_criteria":["a"],"business_context":{"changed":false,"document":"x"}}',
      ),
    ).toThrow('business_context.changed 为 false 时 document 必须为空')
    expect(() =>
      parseAnalysisDraft(
        '{"goal":"g","scenarios":["s"],"acceptance_criteria":["a"],"business_context":{"changed":false,"document":1}}',
      ),
    ).toThrow('分析字段 business_context.document 必须是字符串')
  })
})

describe('loose JSON parsing', () => {
  it('accepts fenced JSON, prose around objects, bare arrays and whitespace', () => {
    expect(
      parseJsonLoose(['```json', '{"a":1}', '```'].join(String.fromCharCode(10)), 'x'),
    ).toEqual({ a: 1 })
    expect(parseJsonLoose('说明 {"a":1} 结束', 'x')).toEqual({ a: 1 })
    expect(parseJsonLoose('  [{"a":1},{"b":2}]  ', 'x')).toEqual([{ a: 1 }, { b: 2 }])
    expect(parseJsonLoose('[]', 'x')).toEqual([])
    expect(parseJsonLoose('"text"', 'x')).toBe('text')
  })

  it('fails with the caller name and parse reason', () => {
    expect(() => parseJsonLoose('not json', '分析结果')).toThrow(/^分析结果不是可解析的 JSON：/)
    expect(() =>
      parseJsonLoose(['```json', '{nope}', '```'].join(String.fromCharCode(10)), '分析结果'),
    ).toThrow(/^分析结果不是可解析的 JSON：/)
  })
})
