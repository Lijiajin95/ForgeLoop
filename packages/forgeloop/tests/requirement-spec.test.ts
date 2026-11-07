import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import {
  analysisSpecOf,
  parseSpecFields,
  planCoverageIssues,
  specChanges,
  validateSpec,
} from '../src/domain/spec.js'
import { parseAnalysisDraft, type RequirementAnalysis } from '../src/domain/requirement.js'
import {
  validateRequirementVerificationPlan,
  type VerificationPlan,
} from '../src/domain/verification.js'
import { validateBusinessReview, parseBusinessReview } from '../src/domain/business-review.js'
import {
  buildProjectFacts,
  relatedProjectHistory,
  PROJECT_FACTS_RELATED_LIMIT,
} from '../src/runtime/board.js'
import { requirementDetailExtras } from '../src/runtime/requirement-detail.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

const point = (overrides: Record<string, unknown> = {}) => ({
  id: 'BP-1',
  basis: 'user_requirement',
  source: '用户原文：门店按状态处理订单',
  actor: '店长',
  trigger: '打开订单列表时',
  behavior: '按状态筛选订单',
  rules: ['只有店长可以批量取消订单'],
  exceptions: { status: 'assessed', items: ['支付回调延迟时订单保持待确认'], reason: '' },
  ...overrides,
})

const acceptance = (overrides: Record<string, unknown> = {}) => ({
  id: 'AC-1',
  point_ids: ['BP-1'],
  given: '订单列表存在三种状态的订单',
  when: '店长选择“已完成”筛选',
  then: '列表只显示已完成的订单',
  ...overrides,
})

const specDraft = (overrides: Record<string, unknown> = {}) => ({
  input_kind: 'requirement',
  goal: '门店按状态处理订单',
  scenarios: ['店长在订单列表按状态筛选'],
  business_rules: ['只有店长可以批量取消订单'],
  exceptions: ['支付回调延迟时订单保持待确认'],
  non_goals: ['不改造支付渠道'],
  business_points: [point()],
  acceptance_criteria: [acceptance()],
  assumptions: [],
  clarifications: [],
  ...overrides,
})

function parsed(overrides: Record<string, unknown> = {}) {
  return parseAnalysisDraft(JSON.stringify(specDraft(overrides)))
}

function analysisOf(overrides: Partial<RequirementAnalysis> = {}): RequirementAnalysis {
  const draft = parsed()
  return {
    analysisVersion: 1,
    requirementVersion: 1,
    inputKind: 'requirement',
    goal: draft.goal,
    scenarios: draft.scenarios,
    businessRules: draft.businessRules,
    exceptions: draft.exceptions,
    nonGoals: draft.nonGoals,
    acceptanceCriteria: draft.acceptanceCriteria,
    businessPoints: draft.businessPoints,
    acceptanceItems: draft.acceptanceItems,
    assumptions: draft.assumptions,
    clarifications: [],
    createdAt: '2026-11-05T00:00:00.000Z',
    ...overrides,
  }
}

describe('structured requirement spec parsing', () => {
  it('parses stable ids, basis and observable acceptance', () => {
    const draft = parsed()
    expect(draft.businessPoints).toEqual([
      expect.objectContaining({
        id: 'BP-1',
        basis: 'user_requirement',
        actor: '店长',
        trigger: '打开订单列表时',
      }),
    ])
    expect(draft.acceptanceItems).toEqual([
      expect.objectContaining({
        id: 'AC-1',
        pointIds: ['BP-1'],
        given: '订单列表存在三种状态的订单',
        when: '店长选择“已完成”筛选',
        then: '列表只显示已完成的订单',
      }),
    ])
    // 兼容文本仍保留可观察结果，便于既有看板与验证文本核对。
    expect(draft.acceptanceCriteria).toEqual(['列表只显示已完成的订单'])
  })

  it('keeps legacy string criteria readable for records without structured points', () => {
    const fields = parseSpecFields({ acceptance_criteria: ['刷新后仍显示'] })
    expect(fields.points).toEqual([])
    expect(fields.acceptance).toEqual([])
    expect(fields.acceptanceCriteria).toEqual(['刷新后仍显示'])
  })

  it('rejects mixed legacy strings and structured acceptance objects', () => {
    expect(() => parseSpecFields({ acceptance_criteria: ['a', acceptance()] })).toThrow(
      '不能混用字符串与对象',
    )
    expect(parseSpecFields({ acceptance_criteria: [acceptance()] }).acceptance).toHaveLength(1)
  })

  it('rejects inferred rules written as business points instead of assumptions', () => {
    expect(() => parsed({ business_points: [point({ basis: 'inference' })] })).toThrow(
      '模型推断只能放进 assumptions',
    )
  })

  it('requires a reason and empty items when exceptions are not assessed', () => {
    expect(() =>
      parsed({
        business_points: [
          point({ exceptions: { status: 'not_applicable', items: [], reason: '' } }),
        ],
      }),
    ).toThrow('必须说明理由')
    expect(() =>
      parsed({
        business_points: [
          point({ exceptions: { status: 'not_applicable', items: ['x'], reason: '无外键' } }),
        ],
      }),
    ).toThrow('items 必须为空')
  })

  it('does not let a problem input carry business points', () => {
    const draft = parsed({
      input_kind: 'problem',
      acceptance_criteria: [acceptance({ then: '打印当前筛选结果' })],
    })
    expect(draft.businessPoints).toHaveLength(1)
    expect(() =>
      validateSpec({
        spec: analysisSpecOf({
          ...analysisOf(),
          inputKind: 'problem',
          businessPoints: draft.businessPoints,
          acceptanceItems: draft.acceptanceItems,
        }),
        complete: true,
        inputKind: 'problem',
      }),
    ).toThrow('问题输入不做业务要点拆解')
  })
})

describe('deterministic spec validation', () => {
  const specOf = (overrides: Record<string, unknown> = {}) => analysisSpecOf(analysisOf(overrides))

  it('accepts a complete spec and rejects a point without acceptance', () => {
    expect(() =>
      validateSpec({
        spec: specOf(),
        complete: true,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
      }),
    ).not.toThrow()
    expect(() =>
      validateSpec({
        spec: specOf({ acceptanceCriteria: [], acceptanceItems: [] }),
        complete: true,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
      }),
    ).toThrow('没有对应的可观察验收项')
  })

  it('rejects duplicate ids, bad id shapes and unknown acceptance references', () => {
    const draft = parsed()
    const base = analysisSpecOf(analysisOf())
    expect(() =>
      validateSpec({
        spec: { ...base, points: [base.points[0]!, base.points[0]!] },
        complete: true,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
      }),
    ).toThrow('编号不能重复')
    expect(() =>
      validateSpec({
        spec: {
          ...base,
          acceptance: [{ ...base.acceptance[0]!, pointIds: ['BP-9'] }],
        },
        complete: true,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
      }),
    ).toThrow('引用了不存在的业务要点')
    expect(() =>
      validateSpec({
        spec: { ...base, points: [{ ...base.points[0]!, id: 'X-1' }] },
        complete: true,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
      }),
    ).toThrow('编号必须形如')
    expect(draft.businessPoints).toHaveLength(1)
  })

  it('requires new ids to be greater than the historical maximum', () => {
    const previous = analysisSpecOf(analysisOf())
    const next = {
      ...previous,
      points: [...previous.points, { ...previous.points[0]!, id: 'BP-1' }],
    }
    expect(() =>
      validateSpec({
        spec: next,
        complete: true,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
        previous,
      }),
    ).toThrow('编号不能重复')
    expect(() =>
      validateSpec({
        spec: {
          ...previous,
          points: [...previous.points, { ...previous.points[0]!, id: 'BP-2' }],
          acceptance: [
            ...previous.acceptance,
            { ...previous.acceptance[0]!, id: 'AC-2', pointIds: ['BP-2'] },
          ],
        },
        complete: true,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
        previous,
      }),
    ).not.toThrow()
    expect(() =>
      validateSpec({
        spec: {
          ...previous,
          points: [previous.points[0]!, { ...previous.points[0]!, id: 'BP-2' }],
          acceptance: [
            { ...previous.acceptance[0]!, id: 'AC-2', pointIds: ['BP-2'] },
            { ...previous.acceptance[0]!, id: 'AC-3', pointIds: ['BP-1'] },
          ],
        },
        complete: true,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
        previous: {
          ...previous,
          assumptions: [
            {
              id: 'AS-2',
              statement: '默认单店',
              basis: 'inference',
              source: '推断',
              impact: '范围',
              needsConfirmation: false,
            },
          ],
        },
      }),
    ).not.toThrow()
  })

  it('blocks completion while exceptions are unanalyzed or assumptions need confirmation', () => {
    const base = analysisSpecOf(analysisOf())
    expect(() =>
      validateSpec({
        spec: {
          ...base,
          points: [
            {
              ...base.points[0]!,
              exceptions: { status: 'unanalyzed', items: [], reason: '还没问' },
            },
          ],
        },
        complete: false,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
      }),
    ).not.toThrow()
    expect(() =>
      validateSpec({
        spec: {
          ...base,
          points: [
            {
              ...base.points[0]!,
              exceptions: { status: 'unanalyzed', items: [], reason: '还没问' },
            },
          ],
        },
        complete: true,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
      }),
    ).toThrow('异常与边界尚未分析')
    expect(() =>
      validateSpec({
        spec: {
          ...base,
          assumptions: [
            {
              id: 'AS-1',
              statement: '默认单店',
              basis: 'inference',
              source: '推断',
              impact: '多店支持范围',
              needsConfirmation: true,
            },
          ],
        },
        complete: true,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
      }),
    ).toThrow('仍需所有者确认')
  })

  it('requires project conventions to cite a project document path', () => {
    const base = analysisSpecOf(analysisOf())
    expect(() =>
      validateSpec({
        spec: {
          ...base,
          points: [{ ...base.points[0]!, basis: 'project_convention', source: '团队口头约定' }],
        },
        complete: true,
        inputKind: 'requirement',
        requirementTexts: ['门店按状态处理订单'],
      }),
    ).toThrow('必须给出项目文档路径')
  })
})

describe('spec coverage across research inputs', () => {
  const planWith = (covers: readonly string[]): TaskPlan => ({
    taskPlanId: 'plan-1',
    requirementId: 'req-1',
    project: 'demo',
    planVersion: 1,
    requirementVersion: 1,
    createdAt: '2026-11-05T00:00:00.000Z',
    tasks: [
      {
        taskId: 'a',
        goal: '实现',
        files: ['docs/a.md'],
        acceptance: '可验收',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
        covers,
      },
      {
        taskId: 'b',
        goal: '补测试',
        files: ['docs/b.md'],
        acceptance: '测试通过',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: ['a'],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
        covers: [],
      },
    ],
  })

  it('requires every business point to be covered by a task', () => {
    const analysis = analysisOf()
    expect(planCoverageIssues(analysis, planWith(['BP-1']))).toEqual([])
    expect(planCoverageIssues(analysis, planWith([]))).toEqual([
      expect.objectContaining({ code: 'missing_point', detail: expect.stringContaining('BP-1') }),
    ])
    expect(planCoverageIssues(analysis, planWith(['BP-1', 'BP-2']))).toEqual([
      expect.objectContaining({ code: 'unknown_point', detail: expect.stringContaining('BP-2') }),
    ])
    // 旧分析没有结构化要点时不套用新规则。
    expect(planCoverageIssues(analysisOf({ businessPoints: undefined }), planWith([]))).toEqual([])
  })

  const verificationPlan = (pointIds: readonly string[]): VerificationPlan => ({
    scenarios: [
      {
        scenario: '店长筛选订单',
        acceptanceCriterion: '只显示已完成订单',
        method:
          '运行冒烟命令；业务规则：只有店长可以批量取消订单；异常与边界：支付回调延迟时订单保持待确认',
        required: true,
        pointIds,
        acceptanceIds: ['AC-1'],
        checks: [{ label: 'smoke', argv: ['node', '-e', 'exit 0'], expectedOutput: '' }],
      },
    ],
  })

  it('requires verification plans to reference and cover business point ids', () => {
    const analysis = analysisOf()
    expect(validateRequirementVerificationPlan(analysis, verificationPlan(['BP-1']))).toEqual([])
    expect(validateRequirementVerificationPlan(analysis, verificationPlan([]))).toContain(
      '验证方案缺少必过场景覆盖业务要点：BP-1',
    )
    expect(validateRequirementVerificationPlan(analysis, verificationPlan(['BP-9']))).toContain(
      '验证方案引用了不存在的业务要点：BP-9',
    )
  })

  it('requires the business review to report each business point', () => {
    const review = parseBusinessReview(
      JSON.stringify({
        verdict: 'pass',
        summary: '通过',
        findings: [],
        blocking: [],
        scenarios: [],
        acceptance: [],
        points: [{ id: 'BP-1', status: 'pass', evidence: 'verified ok', commands: ['smoke'] }],
      }),
    )
    const runs = [{ label: 'smoke', output: 'verified ok', exitCode: 0 }]
    expect(
      validateBusinessReview({
        scenarios: ['店长筛选订单'],
        acceptanceCriteria: ['只显示已完成订单'],
        businessPoints: [{ id: 'BP-1' }],
        acceptanceItems: [],
        review,
        runs,
      }),
    ).toEqual([])
    const missing = parseBusinessReview(
      JSON.stringify({
        verdict: 'pass',
        summary: '通过',
        findings: [],
        blocking: [],
        scenarios: [],
        acceptance: [],
      }),
    )
    expect(
      validateBusinessReview({
        scenarios: ['店长筛选订单'],
        acceptanceCriteria: ['只显示已完成订单'],
        businessPoints: [{ id: 'BP-1' }],
        review: missing,
        runs,
      }),
    ).toContain('业务终审缺少业务要点：BP-1')
  })
})

describe('spec changes and history', () => {
  it('reports added, changed and resolved items deterministically', () => {
    const before = analysisOf()
    const after = analysisOf({
      analysisVersion: 2,
      requirementVersion: 2,
      goal: '门店按状态与时间处理订单',
      businessPoints: [
        { ...before.businessPoints![0]!, behavior: '按状态与时间筛选订单' },
        { ...before.businessPoints![0]!, id: 'BP-2', behavior: '导出筛选结果' },
      ],
      acceptanceItems: [
        ...before.acceptanceItems!,
        { ...before.acceptanceItems![0]!, id: 'AC-2', pointIds: ['BP-2'] },
      ],
      clarifications: ['导出格式？'],
    })
    const changes = specChanges(before, after)
    expect(changes.addedPoints).toEqual(['BP-2'])
    expect(changes.changedPoints).toEqual(['BP-1'])
    expect(changes.addedAcceptance).toEqual(['AC-2'])
    expect(changes.remainingClarifications).toEqual([])
    expect(changes.newClarifications).toEqual(['导出格式？'])
    const resolved = specChanges(after, { ...after, clarifications: [] })
    expect(resolved.resolvedClarifications).toEqual(['导出格式？'])
  })
})

describe('bounded related history', () => {
  let project = ''
  let runtime: ForgeLoopRuntime
  let responses: string[] = []

  function runner(): AgentLike {
    return {
      async run(request: AgentRunRequest): Promise<AgentRunResult> {
        return {
          status: 'completed',
          text: responses.shift() ?? JSON.stringify({}),
          sessionId: 'session-product',
          reason: '',
          transcriptPath: request.transcriptPath,
          durationMs: 1,
          toolCalls: [],
        }
      },
    }
  }

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'forgeloop-spec-'))
    responses = []
    const config = resolveConfig(
      {
        project: 'demo',
        projectPath: project,
        recordsRoot: join(project, '.forgeloop'),
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      },
      project,
    )
    runtime = new ForgeLoopRuntime({ ctx: {}, config, runner: runner() })
  })

  afterEach(() => {
    runtime.close()
    rmSync(project, { recursive: true, force: true })
  })

  it('finds few related requirements, including finished ones, without the whole history', () => {
    for (let index = 0; index < 12; index += 1) {
      runtime.submit({
        text: `看板筛选需求 ${index}`,
        by: 'owner',
        source: `test:${index}`,
        analyze: false,
      })
    }
    const unrelated = runtime.submit({
      text: '支付渠道改造',
      by: 'owner',
      source: 'test:pay',
      analyze: false,
    })
    const unrelatedId = (unrelated.data as { reqId: string }).reqId
    runtime.repo.setStatus(unrelatedId, 'committed', '')
    const facts = buildProjectFacts({
      repository: runtime.repo,
      project: 'demo',
      currentReqId: 'req-current',
      currentText: '看板需要按状态筛选需求',
      limit: 2,
    })
    expect(facts.relatedHistory?.length).toBeLessThanOrEqual(PROJECT_FACTS_RELATED_LIMIT)
    expect(facts.relatedHistory?.every((item) => item.matchedTerms.length > 0)).toBe(true)
    expect(facts.relatedHistory?.some((item) => item.reqId === unrelatedId)).toBe(false)
    const finished = relatedProjectHistory({
      repository: runtime.repo,
      project: 'demo',
      currentReqId: 'req-current',
      currentText: '支付渠道改造',
    })
    expect(finished.map((item) => item.reqId)).toContain(unrelatedId)
    expect(finished[0]?.terminal).toBe(true)
  })

  it('reads back a stored spec that contains assumptions without losing the analysis', async () => {
    responses = [
      JSON.stringify(
        specDraft({
          assumptions: [
            {
              id: 'AS-1',
              statement: '门店只有一个仓库',
              basis: 'inference',
              source: '需求未提多仓',
              impact: '多仓筛选范围',
              needs_confirmation: false,
            },
          ],
          non_goals: ['不改造支付渠道'],
        }),
      ),
    ]
    const submitted = runtime.submit({
      text: '门店按状态处理订单',
      by: 'owner',
      source: 'test:spec-read',
      analyze: false,
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    expect((await runtime.analyzeRequirement(reqId)).ok).toBe(true)
    // 读回必须与分析写入前一致；否则后续项目的每次分析都会因为读到损坏规格而失败。
    const analysis = runtime.repo.latestAnalysis(reqId)!
    expect(analysis.assumptions).toEqual([
      expect.objectContaining({ id: 'AS-1', needsConfirmation: false }),
    ])
    expect(runtime.repo.analyses(reqId)).toHaveLength(1)
  })

  it('stores the structured spec and exposes history plus changes in requirement detail', async () => {
    responses = [
      JSON.stringify(specDraft()),
      JSON.stringify(specDraft({ goal: '门店按状态处理订单并支持导出' })),
    ]
    const submitted = runtime.submit({
      text: '门店按状态处理订单',
      by: 'owner',
      source: 'test:spec',
      analyze: false,
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    expect((await runtime.analyzeRequirement(reqId)).ok).toBe(true)
    const analysis = runtime.repo.latestAnalysis(reqId)!
    expect(analysis.businessPoints?.[0]?.id).toBe('BP-1')

    const extras = requirementDetailExtras(runtime.repo, reqId)
    expect(extras.analysisHistory).toHaveLength(1)
    expect(extras.specChanges.addedPoints).toEqual(['BP-1'])
    expect(extras.clarificationHistory.questions).toEqual([])
    const detail = runtime.requirementDetail(reqId)
    expect(detail.ok).toBe(true)
    expect(detail.data).toMatchObject({
      analysisHistory: [expect.objectContaining({ analysisVersion: 1 })],
      specChanges: expect.objectContaining({ addedPoints: ['BP-1'] }),
    })
  })
})
