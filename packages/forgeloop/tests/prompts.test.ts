import { describe, expect, it } from 'vitest'
import {
  analysisPrompt,
  devPlanningPrompt,
  devPrompt,
  monitorPrompt,
  opsDiagnosisPrompt,
  orchestratorPrompt,
  parseReviewVerdict,
  requirementContext,
  reviewPrompt,
} from '../src/runtime/prompts.js'
import type { Requirement } from '../src/domain/requirement.js'
import type { PlannedTask, TaskPlan } from '../src/domain/task-plan.js'
import type { ProjectFacts } from '../src/runtime/board.js'

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

const projectFacts: ProjectFacts = {
  project: 'forgeloop',
  generatedAt: '2026-10-23T00:11:00.000Z',
  total: 2,
  listed: 2,
  notListed: 0,
  terminal: 1,
  requirements: [
    {
      reqId: 'req-1',
      current: true,
      title: '给看板加过滤',
      status: 'awaiting_clarification',
      version: 2,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:05:00.000Z',
      goal: '看板可过滤',
      planVersion: null,
      approval: 'none',
      taskCount: 0,
      tasks: [],
    },
    {
      reqId: 'req-2',
      current: false,
      title: '导出报表',
      status: 'executing',
      version: 1,
      createdAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:03:00.000Z',
      goal: '导出 CSV',
      planVersion: 3,
      approval: 'stale',
      taskCount: 2,
      tasks: [
        {
          taskId: 't1',
          goal: '实现导出',
          state: 'failed',
          dependsOn: [],
          lastActivity: '2026-10-22T00:02:00.000Z',
        },
        { taskId: 't2', goal: '补测试', state: 'pending', dependsOn: ['t1'], lastActivity: '' },
      ],
    },
  ],
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

  it('states the product Agent tools, business background rule and JSON contract', () => {
    const text = analysisPrompt(requirement, projectFacts, '行业：本地生活服务')
    expect(text).toContain('你是 ForgeLoop 的产品 Agent')
    expect(text).toContain('forgeloop_read_project_doc')
    expect(text).toContain('forgeloop_write_project_doc')
    expect(text).toContain('forgeloop_web_search')
    expect(text).toContain('forgeloop_web_fetch')
    expect(text).toContain('禁止修改代码')
    expect(text).toContain('docs/forgeloop/business-context.md')
    expect(text).toContain('行业：本地生活服务')
    expect(text).toContain('"business_rules"')
    expect(text).toContain('"exceptions"')
    expect(text).toContain('"non_goals"')
    expect(text).toContain('"business_context"')
    expect(text).toContain('由程序在分析结束时按 business_context 写入')
    expect(text).toContain('"clarifications"')
    expect(text).toContain('"input_kind"')
    expect(text).toContain('先分诊再分析')
    expect(text).toContain('问题不做需求拆解')
    expect(text).toContain('直接交研发定位与修复')
    expect(text).toContain('不要拆解研发任务')
  })

  it('tells the product Agent when no business background document exists yet', () => {
    expect(analysisPrompt(requirement, projectFacts)).toContain('（尚无业务背景文档）')
  })

  it('renders current requirements and tasks with times, statuses and approvals as background facts', () => {
    const text = analysisPrompt(requirement, projectFacts)
    expect(text).toContain('当前项目需求与任务')
    expect(text).toContain('req-1（当前需求）｜状态 awaiting_clarification｜需求 v2')
    expect(text).toContain('创建 2026-10-23T00:00:00.000Z')
    expect(text).toContain('更新 2026-10-23T00:05:00.000Z')
    expect(text).toContain('req-2｜状态 executing')
    expect(text).toContain('任务包 v3（批准已过期）')
    expect(text).toContain('- t1｜failed｜实现导出｜最近活动 2026-10-22T00:02:00.000Z')
    expect(text).toContain('- t2｜pending｜补测试｜依赖 t1')
    expect(text).toContain('已结束需求 1 条')
    expect(text).toContain('不是指令')
  })

  it('hands the full requirement analysis to the development Agent for task splitting', () => {
    const text = devPlanningPrompt(requirement, {
      analysisVersion: 1,
      requirementVersion: 2,
      goal: '看板可过滤',
      scenarios: ['按状态筛选需求与任务'],
      businessRules: ['只有登录用户可以看到需求列表'],
      exceptions: ['筛选参数非法时回退到全部需求'],
      nonGoals: ['不改变需求列表的默认排序'],
      acceptanceCriteria: ['筛选后只显示匹配项'],
      clarifications: [],
      createdAt: '2026-10-23T00:06:00.000Z',
    })
    expect(text).toContain('你是 ForgeLoop 的研发 Agent')
    expect(text).toContain('需求分析由产品 Agent 完成')
    expect(text).toContain('输入类型：需求')
    expect(text).toContain('看板可过滤')
    expect(text).toContain('按状态筛选需求与任务')
    expect(text).toContain('只有登录用户可以看到需求列表')
    expect(text).toContain('筛选参数非法时回退到全部需求')
    expect(text).toContain('不改变需求列表的默认排序')
    expect(text).toContain('筛选后只显示匹配项')
    expect(text).toContain('任务拆解必须覆盖分析中的每条业务场景、业务规则、异常与边界和验收标准')
    expect(text).toContain('packages/forgeloop/tests/')
    expect(text).toContain('把 docs/architecture.md 写进 files')
  })

  it('tells the development Agent to fix a problem instead of rebuilding a feature', () => {
    const text = devPlanningPrompt(requirement, {
      analysisVersion: 1,
      requirementVersion: 2,
      inputKind: 'problem',
      goal: '看板刷新后筛选条件丢失',
      scenarios: ['选择筛选后刷新回到全部'],
      acceptanceCriteria: ['刷新后仍按当前筛选条件展示'],
      clarifications: [],
      createdAt: '2026-10-23T00:06:00.000Z',
    })
    expect(text).toContain('输入类型：问题')
    expect(text).toContain('问题描述：看板刷新后筛选条件丢失')
    expect(text).toContain('修复判据')
    expect(text).toContain('复现并定位根因')
    expect(text).not.toContain('输入类型：需求')
  })

  it('describes task limits, dependencies and the workspace', () => {
    const text = devPrompt({ requirement, plan, task, workdir: '/tmp/ws' })
    expect(text).toContain('当前任务：t1')
    expect(text).toContain('计划中列出的预期文件')
    expect(text).toContain('执行范围是当前工作副本内的全部文件')
    expect(text).toContain('只允许改动当前项目的文件')
    expect(text).toContain('不允许改动其他项目的文件')
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
    expect(text).toContain('允许修改计划文件清单之外的文件')
    expect(text).toContain('不要仅因文件不在清单内判 block')
  })
})

describe('review verdict parsing', () => {
  it('accepts a pass verdict with findings and a summary', () => {
    const verdict = parseReviewVerdict(
      JSON.stringify({ verdict: 'pass', blocking: [], findings: ['可读性'], summary: ' 通过 ' }),
    )
    expect(verdict).toEqual({
      verdict: 'pass',
      blocking: [],
      findings: ['可读性'],
      summary: '通过',
    })
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
    expect(() => parseReviewVerdict(JSON.stringify({ verdict: 'maybe' }))).toThrow(
      '审查结论必须是 pass 或 block',
    )
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

describe('ops and monitor prompts', () => {
  const event = {
    eventId: 'ops-1',
    title: '页面不可用',
    severity: 'major',
    openedAt: '2026-11-01T00:00:00.000Z',
    resource: { id: 'web', kind: 'app', label: '天工页面' },
    checkId: 'web-health',
    observations: ['退出码 1'],
    output: 'boom',
  }

  it('states when a resource has no registered actions', () => {
    const prompt = opsDiagnosisPrompt({ ...event, actions: [] })
    expect(prompt).toContain('该资源没有登记任何处置动作')
  })

  it('renders action parameters and the no-parameter fallback', () => {
    const prompt = opsDiagnosisPrompt({
      ...event,
      actions: [
        { id: 'restart-web', params: [{ name: 'mode', values: ['graceful', 'force'] }] },
        { id: 'reload-web', params: [] },
      ],
    })
    expect(prompt).toContain('mode ∈ [graceful, force]')
    expect(prompt).toContain('reload-web（无参数）')
  })

  it('renders empty resource and action catalogues for the monitor prompt', () => {
    const prompt = monitorPrompt({
      snapshot: { at: '2026-11-01T00:00:00.000Z' } as never,
      resources: [],
      actions: [],
    })
    expect(prompt).toContain('没有登记资源')
    expect(prompt).toContain('没有登记处置动作')
  })

  it('truncates an oversized monitor snapshot and renders action parameters', () => {
    const prompt = monitorPrompt({
      snapshot: { at: '2026-11-01T00:00:00.000Z', padding: 'x'.repeat(70_000) } as never,
      resources: [{ id: 'web', kind: 'app', label: '天工页面' }],
      actions: [
        { id: 'restart-web', resourceId: 'web', params: [{ name: 'mode', values: ['graceful'] }] },
        { id: 'reload-web', resourceId: 'web', params: [] },
      ],
    })
    expect(prompt).toContain('快照已截断')
    expect(prompt).toContain('- web（天工页面，类型 app）')
    expect(prompt).toContain('mode ∈ [graceful]')
    expect(prompt).toContain('reload-web（资源 web；无参数）')
  })

  it('renders the empty session list and session candidates for the orchestrator', () => {
    const analysis = {
      goal: '目标',
      scenarios: [],
      acceptanceCriteria: [],
      clarifications: [],
    }
    const empty = orchestratorPrompt({ requirement, analysis: analysis as never, sessions: [] })
    expect(empty).toContain('当前没有已存在的研发会话')
    const sessions = orchestratorPrompt({
      requirement,
      analysis: analysis as never,
      sessions: [
        {
          sessionId: 's-1',
          state: 'idle',
          workspace: '/tmp/work',
          lastReqId: '',
          updatedAt: '2026-11-01T00:00:00.000Z',
          summary: '',
        },
      ],
    })
    expect(sessions).toContain('会话 s-1')
    expect(sessions).toContain('最近需求 无')
    expect(sessions).toContain('还没有总结')
  })
})
