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
})