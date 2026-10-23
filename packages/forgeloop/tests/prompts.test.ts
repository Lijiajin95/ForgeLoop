import { describe, expect, it } from 'vitest'
import {
  analysisPrompt,
  devPrompt,
  parseReviewVerdict,
  planningPrompt,
  requirementContext,
  reviewPrompt,
} from '../src/runtime/prompts.js'
import type { Requirement } from '../src/domain/requirement.js'
import type { PlannedTask, TaskPlan } from '../src/domain/task-plan.js'

const requirement: Requirement = {
  reqId: 'req-1',
  project: 'forgeloop',
  status: 'draft',
  blockedReason: '',
  submittedBy: 'owner',
  source: 'test',
  versions: [
    {
      version: 1,
      text: '给看板加过滤',
      createdAt: '2026-10-23T00:00:00.000Z',
      revisedBy: 'owner',
      source: 'test',
    },
    {
      version: 2,
      text: '给看板加过滤，并保留状态',
      createdAt: '2026-10-23T00:05:00.000Z',
      revisedBy: 'owner',
      source: 'test',
    },
  ],
}

const task: PlannedTask = {
  taskId: 't1',
  goal: '实现过滤',
  files: ['packages/forgeloop/client.js'],
  acceptance: '过滤可用',
  testCommand: ['node', '-e', 'process.exit(0)'],
  dependsOn: [],
  limits: { limitSeconds: 60, maxFailureRounds: 2 },
  authorizationSource: 'plan-approval:req-1:v1:owner',
}

const plan: TaskPlan = {
  taskPlanId: 'plan-req-1-1',
  requirementId: 'req-1',
  project: 'forgeloop',
  planVersion: 1,
  requirementVersion: 2,
  tasks: [task],
  createdAt: '2026-10-23T00:10:00.000Z',
}

describe('prompt builders', () => {
  it('renders every requirement version with identity and status', () => {
    const text = requirementContext(requirement)
    expect(text).toContain('需求身份：req-1')
    expect(text).toContain('当前状态：draft')
    expect(text).toContain('### 版本 1')
    expect(text).toContain('### 版本 2')
    expect(text).toContain('给看板加过滤，并保留状态')
  })

  it('states the tool-less analysis rules and JSON contract', () => {
    const text = analysisPrompt(requirement)
    expect(text).toContain('没有可用工具')
    expect(text).toContain('"clarifications"')
  })

  it('binds the plan prompt to the analyzed goal', () => {
    expect(planningPrompt(requirement, '看板可过滤')).toContain('看板可过滤')
  })

  it('describes task limits, dependencies and the workspace', () => {
    const text = devPrompt({ requirement, plan, task, workdir: '/tmp/ws' })
    expect(text).toContain('当前任务：t1')
    expect(text).toContain('允许修改的文件')
    expect(text).toContain('依赖任务：无')
    expect(text).toContain('工作目录：/tmp/ws')
  })

  it('shows the reviewed files and the empty-diff placeholder', () => {
    const text = reviewPrompt({
      requirement,
      plan,
      task,
      diff: '',
      changedFiles: [],
      diffPath: '/tmp/diff.patch',
    })
    expect(text).toContain('（无）')
    expect(text).toContain('（空 diff）')
    expect(text).toContain('/tmp/diff.patch')
  })
})

describe('review verdict parsing', () => {
  it('accepts a pass verdict with findings and a summary', () => {
    const verdict = parseReviewVerdict(
      JSON.stringify({ verdict: 'pass', blocking: [], findings: ['可读性'], summary: ' 通过 ' }),
    )
    expect(verdict).toEqual({ verdict: 'pass', blocking: [], findings: ['可读性'], summary: '通过' })
  })

  it('accepts a block verdict with blocking reasons and defaults missing lists', () => {
    const verdict = parseReviewVerdict(JSON.stringify({ verdict: 'block', blocking: ['缺少测试'] }))
    expect(verdict).toEqual({ verdict: 'block', blocking: ['缺少测试'], findings: [], summary: '' })
  })

  it('drops blank entries from both lists', () => {
    const verdict = parseReviewVerdict(
      JSON.stringify({ verdict: 'block', blocking: ['问题', '  '], findings: ['', '观察'] }),
    )
    expect(verdict.blocking).toEqual(['问题'])
    expect(verdict.findings).toEqual(['观察'])
  })

  it('rejects malformed JSON and non-object payloads', () => {
    expect(() => parseReviewVerdict('not json')).toThrow('不是可解析的 JSON')
    expect(() => parseReviewVerdict('[]')).toThrow('审查结果必须是 JSON 对象')
    expect(() => parseReviewVerdict('null')).toThrow('审查结果必须是 JSON 对象')
  })

  it('rejects an unknown verdict', () => {
    expect(() => parseReviewVerdict(JSON.stringify({ verdict: 'maybe' }))).toThrow('审查结论必须是 pass 或 block')
    expect(() => parseReviewVerdict(JSON.stringify({}))).toThrow('审查结论必须是 pass 或 block')
  })

  it('rejects non-array or non-string list fields', () => {
    expect(() => parseReviewVerdict(JSON.stringify({ verdict: 'pass', blocking: 'x' }))).toThrow(
      'blocking 必须是字符串数组',
    )
    expect(() => parseReviewVerdict(JSON.stringify({ verdict: 'pass', findings: [1] }))).toThrow(
      'findings 只能包含字符串',
    )
  })

  it('enforces the pass/block invariants', () => {
    expect(() =>
      parseReviewVerdict(JSON.stringify({ verdict: 'pass', blocking: ['不应存在'] })),
    ).toThrow('pass 时 blocking 必须为空')
    expect(() => parseReviewVerdict(JSON.stringify({ verdict: 'block', blocking: [] }))).toThrow(
      'block 时必须给出至少一条阻断原因',
    )
  })
})
