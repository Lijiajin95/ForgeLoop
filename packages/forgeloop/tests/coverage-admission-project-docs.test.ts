import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildAdmissionFacts, decideAdmission } from '../src/domain/admission.js'
import {
  projectDocExists,
  resolveProjectDoc,
  writeProjectDoc,
} from '../src/runtime/project-docs.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-store-branches-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const policy = {
  enabled: true,
  allowCodeCommit: true,
  trustedSources: ['dsh-session:'],
  allowAnySource: false,
  requireOwner: true,
} as const

describe('admission facts and decisions', () => {
  const base = {
    requirementStatus: 'specified',
    requirementVersion: 2,
    project: 'demo',
    projectPath: '/tmp/demo',
    source: 'dsh-session:s1',
    submittedBy: 'owner',
    owner: 'owner',
  }

  it('defaults analysis-derived facts when no analysis exists yet', () => {
    const facts = buildAdmissionFacts({ ...base, analysis: null })
    expect(facts).toMatchObject({
      analysisVersion: null,
      analysisRequirementVersion: null,
      clarifications: 0,
      conflicts: 0,
      conflictSummaries: [],
    })
    expect(decideAdmission(facts, policy)).toMatchObject({
      admit: false,
      code: 'analysis_required',
    })
  })

  it('treats a missing conflict list as no conflict and admits a clean analysis', () => {
    const facts = buildAdmissionFacts({
      ...base,
      analysis: { analysisVersion: 1, requirementVersion: 2, clarifications: [] },
    })
    expect(facts.conflicts).toBe(0)
    expect(facts.conflictSummaries).toEqual([])
    expect(decideAdmission(facts, policy)).toMatchObject({ admit: true, code: 'admitted' })
  })

  it('blocks a conflict without summaries using the bare count', () => {
    const facts = {
      ...buildAdmissionFacts({
        ...base,
        analysis: { analysisVersion: 1, requirementVersion: 2, clarifications: [] },
      }),
      conflicts: 2,
    }
    const decision = decideAdmission(facts, policy)
    expect(decision).toMatchObject({ admit: false, code: 'commitment_conflict' })
    expect(decision.reason).toContain('与已有承诺冲突 2 处')
    expect(decision.reason).not.toContain('：')
  })

  it('falls back to an empty summary list when the caller omits it', () => {
    const facts = buildAdmissionFacts({
      ...base,
      analysis: { analysisVersion: 1, requirementVersion: 2, clarifications: [] },
    })
    // 旧调用方可能没有摘要字段：口径必须与“无摘要”一致，不能拼出空冒号。
    const decision = decideAdmission(
      { ...facts, conflicts: 1, conflictSummaries: undefined } as unknown as typeof facts,
      policy,
    )
    expect(decision).toMatchObject({ admit: false, code: 'commitment_conflict' })
    expect(decision.reason).toContain('与已有承诺冲突 1 处')
    expect(decision.reason).not.toContain('：')
  })

  it('summarises conflicts with their options when present', () => {
    const facts = buildAdmissionFacts({
      ...base,
      analysis: {
        analysisVersion: 1,
        requirementVersion: 2,
        clarifications: [],
        conflicts: [{ existingReqId: 'req-9', conflict: '共享入口', options: ['保留', '替换'] }],
      },
    })
    const decision = decideAdmission(facts, policy)
    expect(decision.code).toBe('commitment_conflict')
    expect(decision.reason).toContain('req-9：共享入口（取舍：保留 / 替换）')
  })
})

describe('project document edge branches', () => {
  it('rejects a project root that cannot be resolved', () => {
    const missing = join(root, 'missing-root')
    expect(resolveProjectDoc(missing, 'docs/a.md')).toMatchObject({
      ok: false,
      reason: '项目目录不存在或不可解析',
    })
    expect(projectDocExists(missing, 'docs/a.md')).toBe(false)
  })

  it('rejects non-Markdown targets that do not exist yet', () => {
    expect(resolveProjectDoc(root, 'docs/note.txt')).toMatchObject({
      ok: false,
      reason: '只允许读写 Markdown 文档（.md）',
    })
  })

  it('rejects a symlinked ancestor that escapes the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'forgeloop-outside-'))
    try {
      writeFileSync(join(outside, 'secret.md'), '# 外部\n')
      symlinkSync(outside, join(root, 'linked'), 'dir')
      expect(resolveProjectDoc(root, 'linked/secret.md')).toMatchObject({
        ok: false,
        reason: '文档路径超出项目目录',
      })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('reports a write failure instead of pretending the document was saved', () => {
    mkdirSync(join(root, 'readonly'), { recursive: true })
    chmodSync(join(root, 'readonly'), 0o500)
    try {
      const written = writeProjectDoc(root, 'readonly/blocked.md', '# x\n')
      expect(written).toMatchObject({ ok: false })
      if (!written.ok) expect(written.reason).toContain('文档写入失败')
    } finally {
      chmodSync(join(root, 'readonly'), 0o700)
    }
  })
})
