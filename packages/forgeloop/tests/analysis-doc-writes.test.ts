import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import { BUSINESS_CONTEXT_DOC } from '../src/domain/analysis.js'
import { readProjectDoc, writeProjectDoc } from '../src/runtime/project-docs.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { structuredSpecOf } from './spec-fixture.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function makeRuntime(root: string, text: string): ForgeLoopRuntime {
  const runner: AgentLike = {
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      return {
        status: 'completed',
        text,
        sessionId: 'session-product',
        reason: '',
        transcriptPath: request.transcriptPath,
        durationMs: 1,
        toolCalls: [],
      }
    },
  }
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      owner: 'owner',
      agent: { provider: 'fake', model: 'fake-model', timeoutSeconds: 30 },
    },
    root,
  )
  return new ForgeLoopRuntime({ ctx: {}, config, runner })
}

function submit(runtime: ForgeLoopRuntime, text = '门店订单列表支持按状态筛选'): string {
  const submitted = runtime.submit({ text, by: 'owner', source: 'test:source', analyze: false })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

const CONTEXT = '# 业务背景\n\n行业：本地生活服务；业务目标：门店订单处理。\n'

function analysisWith(
  business: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> = {},
): string {
  return structuredSpecOf({
    goal: '门店订单列表支持按状态筛选',
    scenarios: ['店长在订单列表按状态筛选'],
    acceptance_criteria: ['筛选后只显示匹配状态的订单'],
    clarifications: [],
    ...(business ? { business_context: business } : {}),
    ...overrides,
  })
}

describe('project Markdown tools follow real paths', () => {
  it('blocks reading and writing through a file symlink that escapes the project', () => {
    const root = tempRoot('forgeloop-docs-')
    const outside = tempRoot('forgeloop-docs-outside-')
    writeFileSync(join(outside, 'secret.md'), 'outside secret\n')
    mkdirSync(join(root, 'docs'), { recursive: true })
    symlinkSync(join(outside, 'secret.md'), join(root, 'docs/escape.md'))

    expect(readProjectDoc(root, 'docs/escape.md')).toMatchObject({ ok: false })
    expect(writeProjectDoc(root, 'docs/escape.md', 'overwritten\n')).toMatchObject({ ok: false })
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('outside secret\n')
  })

  it('blocks a symlinked parent directory even when the file name is Markdown', () => {
    const root = tempRoot('forgeloop-docs-')
    const outside = tempRoot('forgeloop-docs-outside-')
    writeFileSync(join(outside, 'note.md'), 'outside note\n')
    mkdirSync(join(root, 'docs'), { recursive: true })
    symlinkSync(outside, join(root, 'docs/linked'))

    expect(readProjectDoc(root, 'docs/linked/note.md')).toMatchObject({ ok: false })
    expect(writeProjectDoc(root, 'docs/linked/new.md', 'new\n')).toMatchObject({ ok: false })
    expect(existsSync(join(outside, 'new.md'))).toBe(false)
  })

  it('blocks a Markdown symlink whose real target is not Markdown', () => {
    const root = tempRoot('forgeloop-docs-')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/real.txt'), 'plain text\n')
    symlinkSync(join(root, 'docs/real.txt'), join(root, 'docs/notes.md'))

    expect(readProjectDoc(root, 'docs/notes.md')).toMatchObject({ ok: false })
    expect(writeProjectDoc(root, 'docs/notes.md', 'overwrite\n')).toMatchObject({ ok: false })
    expect(readFileSync(join(root, 'docs/real.txt'), 'utf8')).toBe('plain text\n')
  })

  it('still allows normal nested Markdown reads and writes inside the project', () => {
    const root = tempRoot('forgeloop-docs-')
    const written = writeProjectDoc(root, 'docs/nested/guide.md', '# 指南\n')
    expect(written.ok).toBe(true)
    expect(readProjectDoc(root, 'docs/nested/guide.md')).toMatchObject({
      ok: true,
      content: '# 指南\n',
    })
  })
})

describe('business context drafts', () => {
  it('keeps a draft and never writes the official document when validation fails', async () => {
    const root = tempRoot('forgeloop-context-')
    // 验收项没有引用业务要点：通过解析后会在确定性校验阶段失败。
    const broken = analysisWith(
      { changed: true, document: CONTEXT, reason: '识别到门店行业背景' },
      {
        acceptance_criteria: [
          { id: 'AC-1', point_ids: [], given: '前置条件', when: '操作', then: '可观察结果' },
        ],
      },
    )
    const runtime = makeRuntime(root, broken)
    const reqId = submit(runtime)
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('analysis_failed')
    expect(existsSync(join(root, BUSINESS_CONTEXT_DOC))).toBe(false)
    expect(runtime.repo.businessContextChanges(reqId)).toMatchObject([
      { status: 'draft', requirementVersion: 1, reason: '识别到门店行业背景' },
    ])
    runtime.close()
  })

  it('keeps a draft while clarifications are still open', async () => {
    const root = tempRoot('forgeloop-context-')
    const pending = analysisWith(
      { changed: true, document: CONTEXT, reason: '识别到门店行业背景' },
      { clarifications: ['退款是否需要店长二次确认？'] },
    )
    const runtime = makeRuntime(root, pending)
    const reqId = submit(runtime)
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok, outcome.message).toBe(true)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('awaiting_clarification')
    expect(existsSync(join(root, BUSINESS_CONTEXT_DOC))).toBe(false)
    expect(runtime.repo.businessContextChanges(reqId)).toMatchObject([
      { status: 'draft', requirementVersion: 1 },
    ])
    runtime.close()
  })

  it('writes the official document only after validation and records version plus basis', async () => {
    const root = tempRoot('forgeloop-context-')
    const runtime = makeRuntime(
      root,
      analysisWith({ changed: true, document: CONTEXT, reason: '业务背景首次建立；依据需求原文' }),
    )
    const reqId = submit(runtime)
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok, outcome.message).toBe(true)
    expect(readFileSync(join(root, BUSINESS_CONTEXT_DOC), 'utf8')).toBe(CONTEXT)
    expect(runtime.repo.businessContextChanges(reqId)).toMatchObject([
      {
        status: 'applied',
        requirementVersion: 1,
        analysisVersion: 1,
        reason: '业务背景首次建立；依据需求原文',
        changed: true,
      },
    ])
    const detail = runtime.requirementDetail(reqId)
    expect(detail.ok).toBe(true)
    expect((detail.data as { businessContext: unknown[] }).businessContext).toHaveLength(1)
    runtime.close()
  })

  it('fails the analysis and keeps the draft when the official document cannot be written', async () => {
    const root = tempRoot('forgeloop-context-')
    const runtime = makeRuntime(
      root,
      analysisWith({
        changed: true,
        document: `# 业务背景\n\n${'x'.repeat(200 * 1024)}`,
        reason: '超大背景',
      }),
    )
    const reqId = submit(runtime)
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(runtime.repo.latestAnalysis(reqId)).toBeNull()
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('analysis_failed')
    expect(runtime.repo.businessContextChanges(reqId)).toMatchObject([{ status: 'draft' }])
    expect(existsSync(join(root, BUSINESS_CONTEXT_DOC))).toBe(false)
    runtime.close()
  })

  it('rejects a business context change without a traceable reason', async () => {
    const root = tempRoot('forgeloop-context-')
    const runtime = makeRuntime(root, analysisWith({ changed: true, document: CONTEXT }))
    const reqId = submit(runtime)
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('reason')
    expect(existsSync(join(root, BUSINESS_CONTEXT_DOC))).toBe(false)
    runtime.close()
  })
})
