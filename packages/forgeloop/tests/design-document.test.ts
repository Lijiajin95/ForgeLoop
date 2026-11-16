import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { SessionIntake } from '../src/session/intake.js'
import {
  MAX_DOCUMENT_TITLE_CHARS,
  designDocumentSnapshot,
  documentDirectiveOf,
  documentIntakeResultOf,
} from '../src/domain/design-document.js'
import { designDocumentIntakeOf } from '../src/runtime/design-document-intake.js'
import { structuredSpecOf, withPromptRequirementSource } from './spec-fixture.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-doc-'))
  roots.push(root)
  return root
}

function writeDoc(root: string, path: string, body: string): void {
  const target = join(root, ...path.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body, 'utf8')
}

function configFor(root: string) {
  return resolveConfig(
    {
      project: 'testproj',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
    },
    root,
  )
}

const analysisText = structuredSpecOf({
  goal: '按设计文档交付可安装包',
  scenarios: ['用户提交设计文档后自动进入研发'],
  acceptance_criteria: ['提交后产生需求并排队研发'],
  clarifications: [],
})

function runtimeFor(root: string) {
  const runner: AgentLike = {
    async run(request) {
      return {
        status: 'completed',
        text: withPromptRequirementSource(request.prompt, analysisText),
        sessionId: 'session-doc-agent',
        reason: '',
        transcriptPath: request.transcriptPath,
        durationMs: 1,
        toolCalls: [],
      }
    },
  }
  return new ForgeLoopRuntime({
    ctx: {},
    config: configFor(root),
    runner,
    now: () => new Date('2026-11-16T10:00:00.000Z'),
  })
}

const DOC = '# 可安装交付\n\n用户提交设计文档，系统保存快照并自动研发。'
const DOC_REVISED = '# 可安装交付\n\n用户提交设计文档，系统保存快照、自动研发并留下试装证据。'

type IntakeData = {
  reqId: string
  requirementVersion: number
  outcome: 'created' | 'duplicate' | 'revised' | 'recreated'
  document: { path: string; sha256: string; title: string }
}

function dataOf(result: {
  ok: boolean
  data?: unknown
  message: string
  code: string
}): IntakeData {
  if (!result.ok) throw new Error(result.message)
  return result.data as IntakeData
}

describe('design document directive and snapshot', () => {
  it('only treats an explicit leading reference as a project document', () => {
    expect(documentDirectiveOf('文档：docs/product/a.md')).toEqual({ path: 'docs/product/a.md' })
    expect(documentDirectiveOf('设计文档:  docs/product/b.md ')).toEqual({
      path: 'docs/product/b.md',
    })
    expect(documentDirectiveOf('给看板加过滤')).toBeNull()
    expect(documentDirectiveOf('请参考 文档：docs/a.md')).toBeNull()
    // 前缀存在但路径为空仍按文档入口解析，由受理层明确报错，不静默当成普通需求。
    expect(documentDirectiveOf('文档：')).toEqual({ path: '' })
  })

  it('captures digest, size and a stable title for the snapshot', () => {
    const snapshot = designDocumentSnapshot(DOC, {
      kind: 'project-doc',
      path: 'docs/product/feature.md',
    })
    expect(snapshot).toMatchObject({
      kind: 'project-doc',
      path: 'docs/product/feature.md',
      title: '可安装交付',
    })
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshot.bytes).toBe(Buffer.byteLength(DOC, 'utf8'))

    const inline = designDocumentSnapshot('没有标题的正文\n第二行')
    expect(inline.kind).toBe('inline')
    expect(inline.path).toBe('')
    expect(inline.title).toBe('没有标题的正文')
  })

  it('falls back to a placeholder title and bounds the title length', () => {
    expect(designDocumentSnapshot('   ').title).toBe('未命名设计文档')
    const long = `# ${'标题'.repeat(200)}`
    expect(designDocumentSnapshot(long).title).toHaveLength(MAX_DOCUMENT_TITLE_CHARS)
  })
})

describe('design document intake', () => {
  it('creates one requirement from a project document and snapshots it', () => {
    const root = projectRoot()
    writeDoc(root, 'docs/product/feature.md', DOC)
    const runtime = runtimeFor(root)

    const result = designDocumentIntakeOf(runtime).intake({
      path: 'docs/product/feature.md',
      by: 'owner',
      source: 'dsh-session:s1:m1',
      analyze: false,
    })
    const data = dataOf(result)
    expect(data.outcome).toBe('created')
    expect(data.requirementVersion).toBe(1)
    expect(data.document).toMatchObject({ path: 'docs/product/feature.md', title: '可安装交付' })

    const requirement = runtime.repo.getRequirement(data.reqId)
    expect(requirement?.versions).toHaveLength(1)
    // 需求原文就是文档快照正文，产品分析看到完整文档。
    expect(requirement?.versions[0]?.text).toBe(DOC)
    expect(runtime.repo.documentsOf(data.reqId)).toEqual([
      expect.objectContaining({
        requirementVersion: 1,
        kind: 'project-doc',
        path: 'docs/product/feature.md',
        title: '可安装交付',
        sha256: data.document.sha256,
      }),
    ])
    expect(runtime.repo.latestDocumentByPath('testproj', 'docs/product/feature.md')).toMatchObject({
      reqId: data.reqId,
      requirementVersion: 1,
      sha256: data.document.sha256,
    })
    runtime.close()
  })

  it('returns the original requirement for a repeated delivery of the same document', () => {
    const root = projectRoot()
    writeDoc(root, 'docs/product/feature.md', DOC)
    const runtime = runtimeFor(root)

    const first = dataOf(
      designDocumentIntakeOf(runtime).intake({
        path: 'docs/product/feature.md',
        by: 'owner',
        source: 'dsh-session:s1:m1',
        analyze: false,
      }),
    )
    const again = dataOf(
      designDocumentIntakeOf(runtime).intake({
        path: 'docs/product/feature.md',
        by: 'owner',
        source: 'dsh-session:s1:m2',
        analyze: false,
      }),
    )

    expect(again.outcome).toBe('duplicate')
    expect(again.reqId).toBe(first.reqId)
    expect(again.requirementVersion).toBe(1)
    expect(runtime.repo.getRequirement(first.reqId)?.versions).toHaveLength(1)
    expect(runtime.repo.listRequirements('testproj')).toHaveLength(1)
    runtime.close()
  })

  it('appends a new requirement version when the document is revised', () => {
    const root = projectRoot()
    writeDoc(root, 'docs/product/feature.md', DOC)
    const runtime = runtimeFor(root)

    const first = dataOf(
      designDocumentIntakeOf(runtime).intake({
        path: 'docs/product/feature.md',
        by: 'owner',
        source: 'dsh-session:s1:m1',
        analyze: false,
      }),
    )
    writeDoc(root, 'docs/product/feature.md', DOC_REVISED)
    const revised = dataOf(
      designDocumentIntakeOf(runtime).intake({
        path: 'docs/product/feature.md',
        by: 'owner',
        source: 'dsh-session:s1:m2',
        analyze: false,
      }),
    )

    expect(revised.outcome).toBe('revised')
    expect(revised.reqId).toBe(first.reqId)
    expect(revised.requirementVersion).toBe(2)
    const requirement = runtime.repo.getRequirement(first.reqId)
    expect(requirement?.versions.map((version) => version.text)).toEqual([DOC, DOC_REVISED])
    // 旧快照保留，新快照绑定新版本。
    const documents = runtime.repo.documentsOf(first.reqId)
    expect(documents.map((document) => document.requirementVersion)).toEqual([1, 2])
    expect(documents[0]?.sha256).not.toBe(documents[1]?.sha256)
    expect(documents[1]?.sha256).toBe(revised.document.sha256)
    runtime.close()
  })

  it('starts a new requirement when the bound requirement is already terminal', () => {
    const root = projectRoot()
    writeDoc(root, 'docs/product/feature.md', DOC)
    const runtime = runtimeFor(root)
    const first = dataOf(
      designDocumentIntakeOf(runtime).intake({
        path: 'docs/product/feature.md',
        by: 'owner',
        source: 'dsh-session:s1:m1',
        analyze: false,
      }),
    )
    runtime.repo.setStatus(first.reqId, 'committed', '')
    writeDoc(root, 'docs/product/feature.md', DOC_REVISED)

    const next = dataOf(
      designDocumentIntakeOf(runtime).intake({
        path: 'docs/product/feature.md',
        by: 'owner',
        source: 'dsh-session:s1:m2',
        analyze: false,
      }),
    )

    expect(next.outcome).toBe('recreated')
    expect(next.reqId).not.toBe(first.reqId)
    expect(runtime.repo.getRequirement(next.reqId)?.versions).toHaveLength(1)
    // 已交付需求的快照不被覆盖，最新绑定指向新需求。
    expect(runtime.repo.documentsOf(first.reqId)[0]?.sha256).not.toBe(next.document.sha256)
    expect(runtime.repo.latestDocumentByPath('testproj', 'docs/product/feature.md')?.reqId).toBe(
      next.reqId,
    )
    runtime.close()
  })

  it('rejects unusable document references without creating a requirement', () => {
    const root = projectRoot()
    writeDoc(root, 'docs/code.ts', 'not markdown')
    const runtime = runtimeFor(root)

    const missing = designDocumentIntakeOf(runtime).intake({
      path: 'docs/product/missing.md',
      by: 'owner',
      source: 'dsh-session:s1:m1',
    })
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe('document_not_found')

    for (const path of ['docs/code.ts', '../outside.md', '/abs.md', 'docs/.git/x.md', '']) {
      const rejected = designDocumentIntakeOf(runtime).intake({
        path,
        by: 'owner',
        source: 'dsh-session:s1:m2',
      })
      expect(rejected.ok, path).toBe(false)
      expect(rejected.code).toBe('document_invalid')
    }
    expect(runtime.repo.listRequirements('testproj')).toEqual([])
    runtime.close()
  })

  it('snapshots a pasted body as an inline design document', () => {
    const root = projectRoot()
    const runtime = runtimeFor(root)
    const submitted = runtime.submit({
      text: DOC,
      by: 'owner',
      source: 'dsh-session:s1:m1',
      clientKey: 'dsh-session:s1:m1',
      analyze: false,
    })
    const reqId = String((submitted.data as { reqId: string }).reqId)

    expect(runtime.repo.documentsOf(reqId)).toEqual([
      expect.objectContaining({
        requirementVersion: 1,
        kind: 'inline',
        path: '',
        title: '可安装交付',
      }),
    ])
    runtime.close()
  })
})

class FakeSession {
  readonly id = 'session-forgeloop-1'
  readonly header: Record<string, unknown>
  readonly events: Array<{ type: string; data: Record<string, unknown> }> = []
  readonly append = vi.fn((type: string, data: Record<string, unknown>) => {
    this.events.push({ type, data })
  })
  constructor(header: Record<string, unknown> = { agentPreset: 'forgeloop' }) {
    this.header = header
  }
}

function human(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

describe('design document session intake', () => {
  it('submits and analyzes a referenced project document', async () => {
    const root = projectRoot()
    writeDoc(root, 'docs/product/feature.md', DOC)
    const runtime = runtimeFor(root)
    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = new FakeSession()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    const decision = await intake.handlePreStep(
      { agent: { session }, messages: [human('msg-1', '文档：docs/product/feature.md')], turn: 1 },
      next,
    )

    expect(decision).toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
    expect(session.events.map((event) => event.type)).toEqual([
      'plugin:forgeloop/intake',
      'plugin:forgeloop/analysis',
    ])
    const intakeEvent = session.events[0]!.data
    expect(intakeEvent).toMatchObject({
      reqId: expect.stringMatching(/^req-/),
      status: 'accepted',
      sessionId: 'session-forgeloop-1',
      document: { path: 'docs/product/feature.md', title: '可安装交付' },
    })
    const reqId = String(intakeEvent.reqId)
    expect(runtime.repo.getRequirement(reqId)?.versions[0]?.text).toBe(DOC)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('specified')
    runtime.close()
  })

  it('reports a repeated document as the same requirement without a second analysis', async () => {
    const root = projectRoot()
    writeDoc(root, 'docs/product/feature.md', DOC)
    const runtime = runtimeFor(root)
    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = new FakeSession()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
    const payload = (messageId: string) => ({
      agent: { session },
      messages: [human(messageId, '文档：docs/product/feature.md')],
      turn: 1,
    })

    await intake.handlePreStep(payload('msg-1'), next)
    session.events.length = 0
    await intake.handlePreStep(payload('msg-2'), next)

    expect(session.events.map((event) => event.type)).toEqual(['plugin:forgeloop/intake'])
    expect(session.events[0]!.data).toMatchObject({ status: 'duplicate' })
    expect(runtime.repo.listRequirements('testproj')).toHaveLength(1)
    runtime.close()
  })

  it('shows a clear error when the referenced document cannot be used', async () => {
    const root = projectRoot()
    const runtime = runtimeFor(root)
    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = new FakeSession()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    await intake.handlePreStep(
      { agent: { session }, messages: [human('msg-1', '文档：docs/missing.md')], turn: 1 },
      next,
    )

    expect(session.events.map((event) => event.type)).toEqual(['plugin:forgeloop/error'])
    expect(String(session.events[0]!.data.message)).toContain('docs/missing.md')
    expect(runtime.repo.listRequirements('testproj')).toEqual([])
    runtime.close()
  })
})

describe('design document intake result parsing', () => {
  it('parses every known outcome and rejects malformed payloads', () => {
    const snapshot = {
      kind: 'project-doc',
      path: 'docs/a.md',
      sha256: 'abc',
      bytes: 3,
      title: '标题',
    }
    for (const outcome of ['created', 'duplicate', 'revised', 'recreated'] as const) {
      expect(
        documentIntakeResultOf({
          reqId: 'req-1',
          requirementVersion: 2,
          outcome,
          document: snapshot,
        }),
      ).toEqual({ reqId: 'req-1', requirementVersion: 2, outcome, document: snapshot })
    }
    expect(documentIntakeResultOf(null)).toBeNull()
    expect(documentIntakeResultOf({})).toBeNull()
    expect(documentIntakeResultOf({ reqId: '', outcome: 'created', document: {} })).toBeNull()
    expect(documentIntakeResultOf({ reqId: 'r', outcome: 'other', document: {} })).toBeNull()
    expect(documentIntakeResultOf({ reqId: 'r', outcome: 'created' })).toBeNull()
    expect(
      documentIntakeResultOf({
        reqId: 'r',
        outcome: 'created',
        document: { kind: 'inline', bytes: 'x' },
        requirementVersion: 'x',
      }),
    ).toEqual({
      reqId: 'r',
      requirementVersion: 0,
      outcome: 'created',
      document: { kind: 'inline', path: '', sha256: '', bytes: 0, title: '' },
    })
  })
})

describe('design document unusable inputs', () => {
  it('rejects a directory, an oversized document and a blank document', () => {
    const root = projectRoot()
    mkdirSync(join(root, 'docs', 'dir.md'), { recursive: true })
    writeDoc(root, 'docs/big.md', 'x'.repeat(70 * 1024))
    writeDoc(root, 'docs/blank.md', '   ')
    const runtime = runtimeFor(root)
    const intake = designDocumentIntakeOf(runtime)

    const directory = intake.intake({ path: 'docs/dir.md', by: 'owner', source: 'test' })
    expect(directory.ok).toBe(false)
    expect(directory.code).toBe('document_invalid')

    const oversized = intake.intake({ path: 'docs/big.md', by: 'owner', source: 'test' })
    expect(oversized.code).toBe('document_too_large')

    const blank = intake.intake({ path: 'docs/blank.md', by: 'owner', source: 'test' })
    expect(blank.code).toBe('document_invalid')
    expect(runtime.repo.listRequirements('testproj')).toEqual([])
    runtime.close()
  })

  it('accepts the document entry after an explicit new-requirement prefix', async () => {
    const root = projectRoot()
    writeDoc(root, 'docs/product/feature.md', DOC)
    const runtime = runtimeFor(root)
    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = new FakeSession()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    await intake.handlePreStep(
      {
        agent: { session },
        messages: [human('msg-1', '新需求：文档：docs/product/feature.md')],
        turn: 1,
      },
      next,
    )
    expect(session.events.map((event) => event.type)).toEqual([
      'plugin:forgeloop/intake',
      'plugin:forgeloop/analysis',
    ])
    expect(runtime.repo.listRequirements('testproj')).toHaveLength(1)

    session.events.length = 0
    await intake.handlePreStep(
      { agent: { session }, messages: [human('msg-2', '文档：')], turn: 1 },
      next,
    )
    expect(session.events.map((event) => event.type)).toEqual(['plugin:forgeloop/error'])
    expect(String(session.events[0]!.data.message)).toContain('Markdown 路径')
    runtime.close()
  })
})
