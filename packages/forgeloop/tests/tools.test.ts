import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildTools, registerTools } from '../src/tools.js'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { render(args: unknown, value: unknown): unknown[]; schema: Record<string, unknown> }
  execute(
    args: unknown,
    exec: Record<string, unknown>,
  ): Promise<{ ok: boolean; text: string; data?: unknown }>
}

let dir = ''
let runtime: ForgeLoopRuntime
let config: ForgeLoopConfig
let tools: ToolDefinition[]

function tool(name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

async function call(name: string, args: unknown) {
  return tool(name).execute(args, {})
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-tools-'))
  config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 3600,
      owner: 'owner',
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
    },
    dir,
  )
  runtime = new ForgeLoopRuntime({ ctx: {}, config })
  tools = buildTools(runtime, config) as ToolDefinition[]
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

function submitRequirement(text = '工具面测试'): string {
  const submitted = runtime.submit({ text, by: 'owner', source: 'test' })
  return (submitted.data as { reqId: string }).reqId
}

function plan(reqId: string): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}-1`,
    requirementId: reqId,
    project: 'testproj',
    planVersion: 1,
    requirementVersion: 1,
    createdAt: '2026-10-23T00:00:01.000Z',
    tasks: [
      {
        taskId: 't1',
        goal: '写文档',
        files: ['docs/a.md'],
        acceptance: '文档存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
      {
        taskId: 't2',
        goal: '补测试',
        files: ['docs/b.md'],
        acceptance: '测试存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: ['t1'],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
    ],
  }
}

describe('tool surface', () => {
  it('exposes exactly the thirteen documented tools with renderable output', () => {
    expect(tools.map((definition) => definition.name)).toEqual([
      'forgeloop_status',
      'forgeloop_show_requirement',
      'forgeloop_show_plan',
      'forgeloop_evidence',
      'forgeloop_requests',
      'forgeloop_impact',
      'forgeloop_ops',
      'forgeloop_run_verification_check',
      'forgeloop_read_project_doc',
      'forgeloop_write_project_doc',
      'forgeloop_web_search',
      'forgeloop_web_fetch',
      'forgeloop_submit_requirement',
    ])
    const rendered = tool('forgeloop_status').output.render(
      {},
      { ok: true, text: '标题', data: { a: 1 } },
    )
    expect(rendered).toHaveLength(1)
    const block = rendered[0] as { type: string; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('标题')
    expect(block.text).toContain('"a": 1')
  })

  it('lists requirements and reads one by id', async () => {
    const list = await call('forgeloop_status', {})
    expect(list.ok).toBe(true)
    const reqId = submitRequirement()
    const single = await call('forgeloop_status', { req_id: reqId })
    expect(single.ok).toBe(true)
    expect(single.text).toContain(reqId)
    expect((await call('forgeloop_status', { req_id: 'req-missing' })).ok).toBe(false)
  })

  it('requires req_id for the per-requirement readers', async () => {
    for (const name of [
      'forgeloop_show_requirement',
      'forgeloop_show_plan',
      'forgeloop_evidence',
      'forgeloop_impact',
    ]) {
      const result = await call(name, {})
      expect(result.ok, name).toBe(false)
      expect(result.text).toContain('req_id is required')
    }
  })

  it('reads the latest plan and rejects an unknown requirement', async () => {
    const reqId = submitRequirement()
    runtime.repo.recordTaskPlan(plan(reqId))
    const shown = await call('forgeloop_show_plan', { req_id: reqId })
    expect(shown.ok).toBe(true)
    expect(shown.text).toContain('任务包 v1')
    expect((await call('forgeloop_show_plan', { req_id: 'req-missing' })).ok).toBe(false)
  })

  it('reads delivery evidence and request lists', async () => {
    const reqId = submitRequirement()
    runtime.repo.recordTaskPlan(plan(reqId))
    expect((await call('forgeloop_evidence', { req_id: reqId })).ok).toBe(true)
    expect((await call('forgeloop_requests', { req_id: reqId })).ok).toBe(true)
    expect((await call('forgeloop_requests', {})).ok).toBe(true)
  })

  it('returns impact facts without calling a model unless explain is explicit', async () => {
    const reqId = submitRequirement()
    const facts = await call('forgeloop_impact', { req_id: reqId })
    expect(facts.ok).toBe(true)
    expect(facts.text).toContain('影响摘要')
    expect((await call('forgeloop_impact', { req_id: 'req-missing' })).ok).toBe(false)
  })

  it('reads and writes project Markdown documents, and nothing else', async () => {
    const written = await call('forgeloop_write_project_doc', {
      path: 'docs/forgeloop/notes.md',
      content: '# 业务背景\n\n行业：本地生活服务\n',
    })
    expect(written.ok, written.text).toBe(true)
    const read = await call('forgeloop_read_project_doc', {
      path: 'docs/forgeloop/notes.md',
    })
    expect(read.ok, read.text).toBe(true)
    expect(read.data).toMatchObject({
      path: 'docs/forgeloop/notes.md',
      truncated: false,
    })
    expect((read.data as { content: string }).content).toContain('本地生活服务')

    // 业务背景文档只由运行时按分析结果写，工具入口一律拒绝。
    const refused = await call('forgeloop_write_project_doc', {
      path: './docs/forgeloop/business-context.md',
      content: '# 业务背景\n\n行业：本地生活服务\n',
    })
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('由程序在分析结束时同步')
    expect(refused.text).toContain('business_context')
    // 大小写不敏感的文件系统上，换个写法也不能绕过。
    expect(
      (
        await call('forgeloop_write_project_doc', {
          path: 'docs/forgeloop/BUSINESS-CONTEXT.MD',
          content: 'x',
        })
      ).ok,
    ).toBe(false)

    expect((await call('forgeloop_read_project_doc', {})).text).toContain('path is required')
    expect((await call('forgeloop_read_project_doc', { path: 'docs/missing.md' })).ok).toBe(false)
    expect((await call('forgeloop_read_project_doc', { path: '../outside.md' })).text).toContain(
      '超出项目目录',
    )
    expect(
      (await call('forgeloop_write_project_doc', { path: 'src/index.ts', content: 'x' })).text,
    ).toContain('只允许读写 Markdown')
    expect(
      (await call('forgeloop_write_project_doc', { path: 'docs/a.md', content: '内容' })).ok,
    ).toBe(true)
    expect((await call('forgeloop_write_project_doc', { path: 'docs/b.md' })).text).toContain(
      'content is required',
    )
    expect(
      (await call('forgeloop_write_project_doc', { path: '/etc/a.md', content: 'x' })).ok,
    ).toBe(false)
  })
})

describe('requirement intake tool', () => {
  it('reads the operations view without exposing decisions', async () => {
    const outcome = await call('forgeloop_ops', {})
    expect(outcome.ok).toBe(true)
    expect(outcome.data).toMatchObject({ summary: { enabled: false }, events: [] })
    expect((await call('forgeloop_ops', { event_id: 'ops-missing' })).ok).toBe(false)
  })

  it('requires text and records the tool identity, never the caller claims', async () => {
    const missing = await call('forgeloop_submit_requirement', {})
    expect(missing.ok).toBe(false)
    expect(missing.text).toContain('text is required')

    const submitted = await call('forgeloop_submit_requirement', {
      text: '新增看板过滤',
      by: 'owner',
      approved: true,
      source: 'forged',
    })
    expect(submitted.ok).toBe(true)
    const reqId = (submitted.data as { reqId: string }).reqId
    const record = runtime.repo.getRequirement(reqId)!
    expect(record.submittedBy).toBe('agent:owner')
    expect(record.source).toBe('dsh-tool:submit_requirement')
    expect(record.versions[0]!.source).toBe('dsh-tool:submit_requirement')
    expect(record.status).toBe('draft')
  })

  it('reuses a client key for the same text and rejects a different one', async () => {
    const first = await call('forgeloop_submit_requirement', {
      text: '幂等需求',
      client_key: 'k-1',
    })
    expect(first.ok).toBe(true)
    const again = await call('forgeloop_submit_requirement', {
      text: '幂等需求',
      client_key: 'k-1',
    })
    expect(again.ok).toBe(true)
    expect(again.text).toContain('未重复创建')
    await expect(
      call('forgeloop_submit_requirement', { text: '不同内容', client_key: 'k-1' }),
    ).rejects.toThrow('拒绝猜用户想改哪一条')
  })

  it('normalizes non-object arguments and registers every definition', async () => {
    const list = await tool('forgeloop_status').execute(null, {})
    expect(list.ok).toBe(true)

    const registered: string[] = []
    const disposers = registerTools(
      {
        register(definition: unknown) {
          registered.push((definition as { name: string }).name)
          return () => undefined
        },
      },
      tools,
    )
    expect(registered).toHaveLength(13)
    expect(disposers).toHaveLength(13)
  })

  it('explains the key requirement without a DeepSeek key, and never stores the key', async () => {
    const saved = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      const search = await call('forgeloop_web_search', { query: '本地生活服务' })
      expect(search.ok).toBe(false)
      expect(search.text).toContain('DEEPSEEK_API_KEY')
      expect(search.text).toContain('不写入 DSH 配置或环境')
      expect(search.text).toContain('未发出任何网络请求')
      const fetch = await call('forgeloop_web_fetch', { url: 'https://example.com/a' })
      expect(fetch.ok).toBe(false)
      expect(fetch.text).toContain('DEEPSEEK_API_KEY')
      // 工具描述本身也说明密钥来源与只读口径，模型可以据此向用户解释。
      expect(tool('forgeloop_web_search').description).toContain('DEEPSEEK_API_KEY')
      expect(tool('forgeloop_web_search').description).toContain('never written into DSH')
      expect(tool('forgeloop_web_fetch').description).toContain('DEEPSEEK_API_KEY')
      expect(process.env.DEEPSEEK_API_KEY).toBeUndefined()
    } finally {
      if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved
    }
    expect((await call('forgeloop_web_search', {})).text).toContain('query is required')
    expect((await call('forgeloop_web_fetch', {})).text).toContain('url is required')
  })

  it('states the key requirement on successful calls and keeps the key out of the result', async () => {
    const savedKey = process.env.DEEPSEEK_API_KEY
    const savedBase = process.env.FORGELOOP_WEB_BASE_URL
    process.env.DEEPSEEK_API_KEY = 'tool-test-key'
    process.env.FORGELOOP_WEB_BASE_URL = 'http://127.0.0.1:9'
    const answer = {
      results: [
        {
          title: '门店结算',
          url: 'https://example.com/settle',
          snippet: '摘要',
          summary: '较长摘要',
          site_name: '示例',
          date: '2026-06-01T00:00:00+00:00',
          authority: 3,
        },
      ],
    }
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(answer),
    }))
    try {
      const search = await call('forgeloop_web_search', { query: '门店结算', count: 1 })
      expect(search.ok, search.text).toBe(true)
      expect(search.text).toContain('联网说明')
      expect(search.text).toContain('DEEPSEEK_API_KEY')
      expect(search.text).not.toContain('tool-test-key')
      expect(JSON.stringify(search.data)).not.toContain('tool-test-key')
      expect(process.env.DEEPSEEK_API_KEY).toBe('tool-test-key')
    } finally {
      vi.unstubAllGlobals()
      if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = savedKey
      if (savedBase === undefined) delete process.env.FORGELOOP_WEB_BASE_URL
      else process.env.FORGELOOP_WEB_BASE_URL = savedBase
    }
  })

  it('runs verification checks only for the active requirement context', async () => {
    expect((await call('forgeloop_run_verification_check', {})).text).toContain(
      'req_id is required',
    )
    expect((await call('forgeloop_run_verification_check', { req_id: 'req-1' })).text).toContain(
      'label is required',
    )
    const outcome = await call('forgeloop_run_verification_check', {
      req_id: 'req-1',
      label: 'unit',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('没有正在进行的验证')
  })
})
