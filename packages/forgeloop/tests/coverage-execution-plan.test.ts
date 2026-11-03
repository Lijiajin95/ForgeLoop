import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExecutionPlan } from '../src/runtime/execution-plan.js'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import type { AgentRunResult } from '../src/runtime/agent-runner.js'
import type { Requirement, RequirementAnalysis } from '../src/domain/requirement.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

const NOW = '2026-11-03T10:00:00.000Z'

let root = ''
let config: ForgeLoopConfig
let requirement: Requirement | null
let analysis: RequirementAnalysis | null
let latestPlan: TaskPlan | null
let approved: boolean
let responses: AgentRunResult[]
let statuses: Array<[string, string, string]>
let plan: TaskPlan | null
let runnerCalls: Array<{ prompt: string }>

const validPlan = {
  tasks: [
    {
      task_id: 'a',
      goal: '写文档',
      files: ['docs/a.md'],
      acceptance: '文档存在',
      test_command: ['node', '-e', 'process.exit(0)'],
      depends_on: [],
    },
    {
      task_id: 'b',
      goal: '写示例',
      files: ['docs/b.md'],
      acceptance: '示例存在',
      test_command: ['node', '-e', 'process.exit(0)'],
      depends_on: ['a'],
    },
  ],
}

const pythonPlan = {
  tasks: [
    {
      task_id: 'a',
      goal: '写脚本',
      files: ['scripts/old.py'],
      acceptance: '脚本存在',
      test_command: ['python3', 'scripts/old.py'],
      depends_on: [],
    },
    {
      task_id: 'b',
      goal: '再写脚本',
      files: ['scripts/older.py'],
      acceptance: '脚本存在',
      test_command: ['python3', 'scripts/older.py'],
      depends_on: ['a'],
    },
  ],
}

function result(text: string, status: AgentRunResult['status'] = 'completed'): AgentRunResult {
  return {
    status,
    text,
    sessionId: 'session-fake',
    reason: status === 'completed' ? '' : 'runner failed',
    transcriptPath: join(root, 'transcript.jsonl'),
    durationMs: 1,
    toolCalls: [],
  }
}

function executionPlan(): ExecutionPlan {
  const repo = {
    getRequirement: () => requirement,
    latestTaskPlan: () => latestPlan,
    planApproval: () => (approved ? { planVersion: 1 } : null),
    latestAnalysis: () => analysis,
    nextPlanVersion: () => 1,
    recordTaskPlan: (value: TaskPlan) => {
      plan = value
      latestPlan = value
    },
    setStatus: (reqId: string, status: string, detail = '') => {
      statuses.push([reqId, status, detail])
    },
  }
  return new ExecutionPlan({
    config,
    repo: repo as never,
    now: () => NOW,
    charge: () => undefined,
    runner: {
      run: (request: { prompt: string }) => {
        runnerCalls.push({ prompt: request.prompt })
        return Promise.resolve(responses.shift() ?? result('{}'))
      },
    },
    existingPackages: () => [],
    admitRequirement: () => {
      throw new Error('not used')
    },
    reviewPlan: () =>
      Promise.resolve({ state: 'done', review: { verdict: 'block', blocking: ['范围太大'] } }),
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-plan-'))
  config = resolveConfig({
    project: 'demo',
    projectPath: root,
    recordsRoot: join(root, '.forgeloop'),
    agent: { timeoutSeconds: 10 },
  })
  requirement = {
    reqId: 'req-1',
    project: 'demo',
    status: 'draft',
    source: 'test',
    submittedBy: 'owner',
    createdAt: NOW,
    versions: [{ version: 1, text: '实现一个改动', at: NOW, revisedBy: 'owner', source: 'test' }],
  } as never
  analysis = {
    reqId: 'req-1',
    analysisVersion: 1,
    requirementVersion: 1,
    goal: '实现改动',
    scenarios: ['完成'],
    acceptanceCriteria: ['通过'],
    clarifications: [],
    at: NOW,
  } as never
  latestPlan = null
  approved = false
  responses = []
  statuses = []
  plan = null
  runnerCalls = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('execution plan failure paths', () => {
  it('fails planning when the requirement does not exist', async () => {
    requirement = null
    const outcome = await executionPlan().executeDevPlanning('req-1', new AbortController().signal)
    expect(outcome).toEqual({ state: 'failed', detail: '未找到需求 req-1' })
  })

  it('fails planning before an analysis exists', async () => {
    analysis = null
    const outcome = await executionPlan().executeDevPlanning('req-1', new AbortController().signal)
    expect(outcome).toEqual({ state: 'failed', detail: '尚无分析结论，不能规划' })
  })

  it('fails planning when the analysis is stale', async () => {
    analysis = { ...analysis, requirementVersion: 0 } as never
    const outcome = await executionPlan().executeDevPlanning('req-1', new AbortController().signal)
    expect(outcome.detail).toContain('请重新分析')
  })

  it('fails planning while clarifications remain', async () => {
    analysis = { ...analysis, clarifications: ['需要确认范围'] } as never
    const outcome = await executionPlan().executeDevPlanning('req-1', new AbortController().signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '分析仍有待澄清项；回答后修订需求并重新分析',
    })
  })

  it('rejects changing an approved plan without explicit permission', async () => {
    latestPlan = { planVersion: 1 } as never
    approved = true
    const outcome = await executionPlan().executeDevPlanning('req-1', new AbortController().signal)
    expect(outcome.detail).toContain('已批准并冻结')
  })

  it('returns the runner failure reason', async () => {
    responses = [result('', 'timeout')]
    const outcome = await executionPlan().executeDevPlanning('req-1', new AbortController().signal)
    expect(outcome).toEqual({ state: 'failed', detail: 'runner failed' })
  })

  it('feeds a malformed plan back and blocks after three attempts', async () => {
    responses = [result('not json'), result('still not json'), result('{}')]
    const outcome = await executionPlan().executeDevPlanning('req-1', new AbortController().signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('任务包不合规')
    expect(runnerCalls.at(-1)?.prompt).toContain('被程序拒绝')
    expect(statuses.at(-1)).toEqual(['req-1', 'blocked', outcome.detail])
  })

  it('feeds language boundary violations back with each offending field', async () => {
    responses = [
      result(JSON.stringify(pythonPlan)),
      result(JSON.stringify(pythonPlan)),
      result(JSON.stringify(pythonPlan)),
    ]
    const outcome = await executionPlan().executeDevPlanning('req-1', new AbortController().signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('TypeScript 语言/工程边界')
    expect(outcome.detail).toContain('a.files=scripts/old.py')
    expect(runnerCalls.at(-1)?.prompt).toContain('不得使用 Python')
    expect(statuses.at(-1)?.[1]).toBe('blocked')
  })

  it('records a generated plan and leaves it proposed when review blocks', async () => {
    responses = [
      result(JSON.stringify(validPlan)),
      result(JSON.stringify(validPlan)),
      result(JSON.stringify(validPlan)),
    ]
    const outcome = await executionPlan().executeDevPlanning('req-1', new AbortController().signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('实现前评审阻断')
    expect(plan?.tasks).toHaveLength(2)
    expect(statuses.at(-1)?.[1]).toBe('plan_proposed')
  })
})
