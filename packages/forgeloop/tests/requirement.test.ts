import { describe, expect, it } from 'vitest'
import {
  allocateRequirementId,
  parseAnalysisDraft,
  requireFound,
  statusForAnalysis,
  validateRequirement,
} from '../src/domain/requirement.js'
import type { RequirementVersion } from '../src/domain/requirement.js'
import { MalformedError, NotFoundError, RuleViolationError } from '../src/domain/errors.js'

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
  it('allocates distinct ids with the stable req- prefix', () => {
    const ids = new Set(Array.from({ length: 20 }, () => allocateRequirementId()))
    expect(ids.size).toBe(20)
    for (const id of ids) expect(id).toMatch(/^req-\d{14}-[0-9a-f]{6}$/)
  })

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

  it('fails explicitly for an unknown id instead of returning empty', () => {
    expect(() => requireFound(undefined, 'req-x')).toThrow(NotFoundError)
    expect(requireFound('value', 'req-x')).toBe('value')
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