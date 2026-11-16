import { describe, expect, it } from 'vitest'
import { parseLibraryEntry } from '../src/domain/library.js'
import {
  candidateEntryPath,
  candidateFingerprint,
  candidateSource,
  orderEvidence,
  parseRebuildCandidates,
  planRebuild,
  renderCandidateEntry,
  summarizeRebuildPlan,
  validateCandidate,
  type PreviousPublishedEntry,
  type RebuildCandidate,
  type RebuildEntrySnapshot,
  type RebuildEvidence,
} from '../src/domain/library-rebuild.js'

const ID = 'rules.cancel-shipped-order'

function evidence(overrides: Partial<RebuildEvidence> = {}): RebuildEvidence {
  return {
    kind: 'doc',
    ref: 'docs/order.md',
    locator: '订单取消规则',
    time: '2026-11-01',
    digest: 'sha256:abc',
    ...overrides,
  }
}

function candidate(overrides: Partial<RebuildCandidate> = {}): RebuildCandidate {
  return {
    id: ID,
    title: '已发货订单的取消',
    topics: ['order.cancel', 'order.shipping'],
    summary: '已发货订单仅允许在签收前取消，取消后进入退款流程。',
    scope: '订单履约，2026-11 版本',
    goal: '允许用户在签收前取消已发货订单。',
    actors: ['下单用户', '客服'],
    trigger: '订单状态为已发货且未签收时发起取消。',
    behavior: '系统接受取消并生成退款。',
    rules: ['签收后不允许取消'],
    exceptions: ['已签收：拒绝并提示联系客服'],
    acceptance: ['用户发起取消后看到“已取消，退款处理中”'],
    evidence: [evidence()],
    confidence: 'high',
    gaps: [],
    ...overrides,
  }
}

function snapshot(overrides: Partial<RebuildEntrySnapshot> = {}): RebuildEntrySnapshot {
  return {
    id: ID,
    status: 'draft',
    path: candidateEntryPath(ID),
    sha256: 'file-sha',
    source: candidateSource('run-1', ID),
    ...overrides,
  }
}

function previous(fingerprint: string, sha256 = 'file-sha'): Map<string, PreviousPublishedEntry> {
  return new Map([[ID, { id: ID, sha256, fingerprint }]])
}

function plan(input: {
  candidates?: RebuildCandidate[]
  existing?: RebuildEntrySnapshot[]
  previous?: Map<string, PreviousPublishedEntry>
  capacity?: number
}) {
  return planRebuild({
    candidates: input.candidates ?? [candidate()],
    existing: input.existing ?? [],
    previous: input.previous ?? new Map(),
    runId: 'run-1',
    updatedAt: '2026-11-16',
    ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
  })
}

describe('rebuild candidate validation', () => {
  it('accepts a complete candidate', () => {
    expect(() => validateCandidate(candidate())).not.toThrow()
  })

  it('rejects an invalid identity, topics and summary', () => {
    expect(() => validateCandidate(candidate({ id: 'Bad Id' }))).toThrow(/id/)
    expect(() => validateCandidate(candidate({ topics: [] }))).toThrow(/topics/)
    expect(() => validateCandidate(candidate({ topics: ['a', 'A'] }))).toThrow(/topics/)
    expect(() => validateCandidate(candidate({ summary: 'x'.repeat(241) }))).toThrow(/summary/)
  })

  it('rejects candidates without actors, acceptance or evidence', () => {
    expect(() => validateCandidate(candidate({ actors: [] }))).toThrow(/actors/)
    expect(() => validateCandidate(candidate({ acceptance: [] }))).toThrow(/验收/)
    expect(() => validateCandidate(candidate({ evidence: [] }))).toThrow(/证据/)
  })

  it('rejects unknown source kinds and malformed evidence time', () => {
    expect(() =>
      validateCandidate(candidate({ evidence: [evidence({ kind: 'chat' as never })] })),
    ).toThrow(/kind/)
    expect(() =>
      validateCandidate(candidate({ evidence: [evidence({ time: '2026/11/01' })] })),
    ).toThrow(/time/)
  })

  it('rejects an unknown confidence', () => {
    expect(() => validateCandidate(candidate({ confidence: 'certain' as never }))).toThrow(
      /confidence/,
    )
  })
})

describe('rebuild evidence ordering and fingerprints', () => {
  it('orders evidence from newest to oldest, unknown last, ties stable', () => {
    const ordered = orderEvidence([
      evidence({ ref: 'b', time: '' }),
      evidence({ ref: 'a', time: '2026-11-10' }),
      evidence({ ref: 'c', time: '2026-11-12' }),
      evidence({ ref: 'd', time: '2026-11-12', locator: 'z' }),
    ])
    expect(ordered.map((item) => item.ref)).toEqual(['c', 'd', 'a', 'b'])
  })

  it('ignores evidence order but changes when a rule changes', () => {
    const first = candidate({ evidence: [evidence({ ref: 'a' }), evidence({ ref: 'b' })] })
    const second = candidate({ evidence: [evidence({ ref: 'b' }), evidence({ ref: 'a' })] })
    expect(candidateFingerprint(first)).toBe(candidateFingerprint(second))
    expect(candidateFingerprint(candidate({ rules: ['新规则'] }))).not.toBe(
      candidateFingerprint(candidate()),
    )
  })
})

describe('rebuild entry rendering', () => {
  it('renders a draft entry that parses back with evidence in the body', () => {
    const text = renderCandidateEntry(candidate(), { runId: 'run-1', updatedAt: '2026-11-16' })
    const parsed = parseLibraryEntry(text, candidateEntryPath(ID))
    expect(parsed).toMatchObject({
      id: ID,
      status: 'draft',
      summary: candidate().summary,
      source: candidateSource('run-1', ID),
      updatedAt: '2026-11-16',
    })
    expect(parsed.source.startsWith('library-rebuild:run-1#')).toBe(true)
    expect(parsed.body).toContain('## 业务规则')
    expect(parsed.body).toContain('## 可观察验收')
    expect(parsed.body).toContain('docs/order.md')
  })

  it('rejects an entry whose body exceeds the library read limit', () => {
    const rules = Array.from({ length: 200 }, () => 'x'.repeat(400))
    expect(() =>
      renderCandidateEntry(candidate({ rules }), { runId: 'run-1', updatedAt: '2026-11-16' }),
    ).toThrow(/字节/)
  })

  it('rejects a malformed updatedAt and renders evidence gaps', () => {
    expect(() =>
      renderCandidateEntry(candidate(), { runId: 'run-1', updatedAt: '2026/11/16' }),
    ).toThrow(/updatedAt/)
    const text = renderCandidateEntry(candidate({ gaps: ['源码无法确定运行环境'] }), {
      runId: 'run-1',
      updatedAt: '2026-11-16',
    })
    expect(text).toContain('## 证据缺口与待澄清')
    expect(text).toContain('源码无法确定运行环境')
    expect(candidateEntryPath(ID)).toBe(`docs/product/library/${ID}.md`)
    expect(candidateSource('run-1', ID)).toBe(`library-rebuild:run-1#${ID}`)
  })
})

describe('rebuild planning against the existing library', () => {
  it('creates a new draft when the id is new', () => {
    const result = plan({})
    expect(result.reviews).toEqual([{ kind: 'create', candidate: candidate() }])
    expect(result.publish).toHaveLength(1)
    expect(result.publish[0]).toMatchObject({ action: 'create', id: ID, replacesSha: '' })
    expect(result.overflow).toEqual([])
  })

  it('keeps an unchanged published entry without rewriting it', () => {
    const result = plan({
      existing: [snapshot()],
      previous: previous(candidateFingerprint(candidate())),
    })
    expect(result.reviews[0]).toMatchObject({ kind: 'unchanged', id: ID })
    expect(result.publish).toEqual([])
  })

  it('updates a rebuild draft whose rule changed and file digest still matches', () => {
    const result = plan({
      candidates: [candidate({ rules: ['签收前可取消，签收后拒绝'] })],
      existing: [snapshot()],
      previous: previous(candidateFingerprint(candidate())),
    })
    expect(result.reviews[0]).toMatchObject({ kind: 'update', id: ID, replacesSha: 'file-sha' })
    expect(result.publish[0]).toMatchObject({ action: 'update', replacesSha: 'file-sha' })
  })

  it('treats a rebuild draft whose digest changed as a human edit', () => {
    const result = plan({
      existing: [snapshot({ sha256: 'edited-sha' })],
      previous: previous(candidateFingerprint(candidate())),
    })
    expect(result.reviews[0]).toMatchObject({ kind: 'conflict', id: ID })
    expect(result.publish).toEqual([])
  })

  it('never overwrites a confirmed or manually authored entry', () => {
    const confirmed = plan({ existing: [snapshot({ status: 'confirmed' })] })
    expect(confirmed.reviews[0]).toMatchObject({ kind: 'conflict', id: ID })
    const manual = plan({
      existing: [snapshot({ source: 'docs/order.md' })],
      previous: previous(candidateFingerprint(candidate())),
    })
    expect(manual.reviews[0]).toMatchObject({ kind: 'conflict', id: ID })
  })

  it('keeps a rebuild draft without a previous publication record unresolved', () => {
    const result = plan({ existing: [snapshot()] })
    expect(result.reviews[0]).toMatchObject({ kind: 'unresolved', id: ID })
    expect(result.publish).toEqual([])
  })

  it('publishes in confidence order and reports overflow beyond capacity', () => {
    const low = candidate({ id: 'rules.low', confidence: 'low' })
    const high = candidate({ id: 'rules.high', confidence: 'high' })
    const result = plan({ candidates: [low, high], capacity: 1 })
    expect(result.publish.map((item) => item.id)).toEqual(['rules.high'])
    expect(result.overflow).toEqual(['rules.low'])
    expect(result.reviews).toHaveLength(2)
  })

  it('summarizes review outcomes', () => {
    const result = plan({
      candidates: [candidate(), candidate({ id: 'rules.other' })],
      capacity: 1,
    })
    expect(summarizeRebuildPlan(result)).toEqual({
      unchanged: 0,
      created: 1,
      updated: 0,
      conflicts: 0,
      unresolved: 0,
      overflow: 1,
    })
  })

  it('counts unchanged, updated, conflicted and unresolved reviews', () => {
    const unchanged = plan({
      existing: [snapshot()],
      previous: previous(candidateFingerprint(candidate())),
    })
    expect(summarizeRebuildPlan(unchanged)).toMatchObject({ unchanged: 1 })

    const updated = plan({
      candidates: [candidate({ rules: ['新规则'] })],
      existing: [snapshot()],
      previous: previous(candidateFingerprint(candidate())),
    })
    expect(summarizeRebuildPlan(updated)).toMatchObject({ updated: 1 })

    const conflicted = plan({ existing: [snapshot({ status: 'confirmed' })] })
    expect(summarizeRebuildPlan(conflicted)).toMatchObject({ conflicts: 1 })

    const unresolved = plan({ existing: [snapshot()] })
    expect(summarizeRebuildPlan(unresolved)).toMatchObject({ unresolved: 1 })
  })
})

describe('rebuild model output parsing', () => {
  function payload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ candidates: [{ ...candidate(), ...overrides }] })
  }

  it('parses fenced JSON and returns validated candidates', () => {
    const parsed = parseRebuildCandidates(`\`\`\`json\n${payload()}\n\`\`\``)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ id: ID, confidence: 'high' })
    expect(parsed[0]?.evidence[0]?.ref).toBe('docs/order.md')
  })

  it('accepts an empty candidate list', () => {
    expect(parseRebuildCandidates('{"candidates":[]}')).toEqual([])
  })

  it('rejects non-JSON, missing candidates and non-object entries', () => {
    expect(() => parseRebuildCandidates('not json')).toThrow(/JSON/)
    expect(() => parseRebuildCandidates('{"candidates":{}}')).toThrow(/candidates/)
    expect(() => parseRebuildCandidates('{"candidates":[null]}')).toThrow(/对象/)
    expect(() => parseRebuildCandidates('[]')).toThrow(/JSON 对象/)
  })

  it('rejects invalid candidate fields from the model', () => {
    expect(() => parseRebuildCandidates(payload({ id: 'Bad Id' }))).toThrow(/id/)
    expect(() => parseRebuildCandidates(payload({ confidence: 'certain' }))).toThrow(/confidence/)
    expect(() => parseRebuildCandidates(payload({ topics: [] }))).toThrow(/topics/)
    expect(() => parseRebuildCandidates(payload({ acceptance: [] }))).toThrow(/验收/)
    expect(() => parseRebuildCandidates(payload({ evidence: [] }))).toThrow(/证据/)
  })

  it('defaults missing gaps and rejects a non-array topics field', () => {
    const withoutGaps = Object.fromEntries(
      Object.entries(candidate()).filter(([key]) => key !== 'gaps'),
    )
    const parsed = parseRebuildCandidates(JSON.stringify({ candidates: [withoutGaps] }))
    expect(parsed[0]?.gaps).toEqual([])
    expect(() => parseRebuildCandidates(payload({ topics: 'rule' }))).toThrow(/topics/)
  })
})
