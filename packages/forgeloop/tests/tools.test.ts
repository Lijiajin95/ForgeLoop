import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  execute(args: unknown, exec: Record<string, unknown>): Promise<{ ok: boolean; text: string; data?: unknown }>
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

describe('read-only tool surface', () => {
  it('exposes exactly the seven documented tools with renderable output', () => {
    expect(tools.map((definition) => definition.name)).toEqual([
      'forgeloop_status',
      'forgeloop_show_requirement',
      'forgeloop_show_plan',
      'forgeloop_evidence',
      'forgeloop_requests',
      'forgeloop_impact',
      'forgeloop_submit_requirement',
    ])
    const rendered = tool('forgeloop_status').output.render({}, { ok: true, text: '标题', data: { a: 1 } })
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
    for (const name of ['forgeloop_show_requirement', 'forgeloop_show_plan', 'forgeloop_evidence', 'forgeloop_impact']) {
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
})

describe('requirement intake tool', () => {
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
    const first = await call('forgeloop_submit_requirement', { text: '幂等需求', client_key: 'k-1' })
    expect(first.ok).toBe(true)
    const again = await call('forgeloop_submit_requirement', { text: '幂等需求', client_key: 'k-1' })
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
    expect(registered).toHaveLength(7)
    expect(disposers).toHaveLength(7)
  })
})
