import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const REQUIREMENT = '门店订单列表支持按状态筛选'

function point(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'BP-1',
    basis: 'user_requirement',
    source: REQUIREMENT,
    actor: '店长',
    trigger: '打开订单列表时',
    behavior: '按状态筛选订单',
    rules: [],
    exceptions: { status: 'not_applicable', items: [], reason: '无额外异常路径' },
    ...overrides,
  }
}

function acceptance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'AC-1',
    point_ids: ['BP-1'],
    given: '订单列表有三种状态的订单',
    when: '店长选择已完成筛选',
    then: '列表只显示已完成订单',
    ...overrides,
  }
}

function requirementAnalysis(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    input_kind: 'requirement',
    goal: '门店订单列表按状态筛选',
    scenarios: ['店长在订单列表按状态筛选'],
    business_points: [point()],
    acceptance_criteria: [acceptance()],
    assumptions: [],
    conflicts: [],
    clarifications: [],
    ...overrides,
  })
}

function problemAnalysis(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    input_kind: 'problem',
    goal: '看板刷新后筛选条件丢失',
    scenarios: ['刷新后回到全部'],
    acceptance_criteria: ['刷新后仍按当前筛选条件展示'],
    business_points: [],
    assumptions: [],
    conflicts: [],
    clarifications: [],
    ...overrides,
  })
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

function submit(runtime: ForgeLoopRuntime, text = REQUIREMENT, source = 'test:source'): string {
  const submitted = runtime.submit({ text, by: 'owner', source, analyze: false })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-spec-verify-'))
  roots.push(root)
  return root
}

describe('business point sources', () => {
  it('accepts a user requirement quote that appears verbatim in the requirement text', async () => {
    const root = tempProject()
    const runtime = makeRuntime(root, requirementAnalysis())
    const reqId = submit(runtime)
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok, outcome.message).toBe(true)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('specified')
    runtime.close()
  })

  it('rejects a user requirement source that cannot be found in the requirement versions', async () => {
    const root = tempProject()
    const runtime = makeRuntime(
      root,
      requirementAnalysis({
        business_points: [point({ source: '用户想要一个更好的列表' })],
      }),
    )
    const reqId = submit(runtime)
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('用户原文依据无法在需求版本中逐字核对')
    expect(runtime.repo.latestAnalysis(reqId)).toBeNull()
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('analysis_failed')
    runtime.close()
  })

  it('accepts a project convention only when the Markdown document exists', async () => {
    const root = tempProject()
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/conventions.md'), '# 约定\n\n批量操作需二次确认。\n')
    const okRuntime = makeRuntime(
      root,
      requirementAnalysis({
        business_points: [
          point({ basis: 'project_convention', source: 'docs/conventions.md#批量操作' }),
        ],
      }),
    )
    const reqId = submit(okRuntime)
    expect((await okRuntime.analyzeRequirement(reqId)).ok).toBe(true)
    okRuntime.close()

    const missingRuntime = makeRuntime(
      root,
      requirementAnalysis({
        business_points: [point({ basis: 'project_convention', source: 'docs/missing.md' })],
      }),
    )
    const missingReq = submit(missingRuntime)
    const outcome = await missingRuntime.analyzeRequirement(missingReq)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('项目约定文档不存在或不可读')
    missingRuntime.close()
  })

  it('requires external material to be an http(s) URL', async () => {
    const root = tempProject()
    const runtime = makeRuntime(
      root,
      requirementAnalysis({
        business_points: [point({ basis: 'external_material', source: '某行业报告 2026' })],
      }),
    )
    const reqId = submit(runtime)
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('外部资料必须是 http(s) 地址')
    runtime.close()
  })
})

describe('commitment conflicts pause admission', () => {
  it('lists each conflict with options and blocks admission until the owner decides', async () => {
    const root = tempProject()
    // 先受理一条已有承诺；冲突引用必须指向真实存在的其他需求。
    const setup = makeRuntime(root, requirementAnalysis())
    const existing = submit(setup, '只有店长可以批量取消订单', 'test:existing')
    setup.close()

    const runtime = makeRuntime(
      root,
      requirementAnalysis({
        business_points: [
          point({
            source: '所有店员都可以批量取消订单',
            behavior: '所有店员都可以批量取消订单',
          }),
        ],
        conflicts: [
          {
            existing_req_id: existing,
            commitment: '只有店长可以批量取消订单',
            conflict: '新要求允许所有店员批量取消，与已有权限承诺不能同时满足',
            options: ['保留仅店长可取消', '放开给所有店员并撤销旧承诺'],
            decision_needed: '是否放弃“仅店长可取消”的既有承诺',
          },
        ],
      }),
    )
    const reqId = submit(runtime, '所有店员都可以批量取消订单', 'test:new')
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok, outcome.message).toBe(true)
    expect(runtime.repo.latestAnalysis(reqId)?.conflicts).toHaveLength(1)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
    expect(runtime.repo.getRequirement(reqId)?.blockedReason).toContain(existing)
    expect(runtime.repo.getRequirement(reqId)?.blockedReason).toContain('取舍')
    const admission = runtime.repo.admissionsFor(reqId).at(-1)
    expect(admission).toMatchObject({ decision: 'block' })
    expect(admission?.reason).toContain('需要所有者决定取舍')
    expect(runtime.autoAdvanceRequests()).not.toContain(reqId)
    runtime.close()
  })

  it('rejects a conflict that cites an unknown or the current requirement', async () => {
    const root = tempProject()
    const runtime = makeRuntime(
      root,
      requirementAnalysis({
        conflicts: [
          {
            existing_req_id: 'req-does-not-exist',
            commitment: '旧承诺',
            conflict: '冲突',
            options: ['保留旧承诺', '采用新要求'],
            decision_needed: '取舍',
          },
        ],
      }),
    )
    const reqId = submit(runtime)
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('不是项目中已存在的其他需求')
    expect(runtime.repo.latestAnalysis(reqId)).toBeNull()
    runtime.close()
  })

  it('requires at least two comparable options for a conflict', async () => {
    const root = tempProject()
    const runtime = makeRuntime(
      root,
      requirementAnalysis({
        conflicts: [
          {
            existing_req_id: 'req-x',
            commitment: '旧承诺',
            conflict: '冲突',
            options: ['只有一种'],
            decision_needed: '取舍',
          },
        ],
      }),
    )
    const reqId = submit(runtime)
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('至少两种可比较的取舍')
    runtime.close()
  })
})

describe('problem fast path', () => {
  it('rejects blank repair criteria', async () => {
    const root = tempProject()
    const runtime = makeRuntime(root, problemAnalysis({ acceptance_criteria: ['   ', ''] }))
    const reqId = submit(runtime, '看板刷新后筛选条件丢失')
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('只能包含非空字符串')
    runtime.close()
  })

  it('keeps the phenomenon and concrete repair criteria without product spec fields', async () => {
    const root = tempProject()
    const runtime = makeRuntime(root, problemAnalysis())
    const reqId = submit(runtime, '看板刷新后筛选条件丢失')
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok, outcome.message).toBe(true)
    const analysis = runtime.repo.latestAnalysis(reqId)!
    expect(analysis.inputKind).toBe('problem')
    expect(analysis.businessPoints ?? []).toEqual([])
    expect(analysis.acceptanceCriteria).toEqual(['刷新后仍按当前筛选条件展示'])
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('specified')
    runtime.close()
  })

  it('rejects business points on a problem input', async () => {
    const root = tempProject()
    const runtime = makeRuntime(
      root,
      problemAnalysis({
        business_points: [point({ id: 'BP-1' })],
        acceptance_criteria: [acceptance()],
      }),
    )
    const reqId = submit(runtime, '看板刷新后筛选条件丢失')
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('问题输入不做业务要点拆解')
    runtime.close()
  })
})
