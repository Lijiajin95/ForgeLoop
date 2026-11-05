/**
 * 深层行为测试：提示词构建的条件分支（完整字符串快照），以及需求视图/任务视图
 * 在真实 Repository + 临时目录上的返回值与错误原文。
 *
 * 只通过公共接口观察行为：提示词整段快照；视图断言公开字段、错误码与消息。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import type { Requirement, RequirementAnalysis } from '../src/domain/requirement.js'
import type { ClarificationAnswer, ClarificationQuestion } from '../src/domain/analysis.js'
import type { PlannedTask, TaskPlan } from '../src/domain/task-plan.js'
import type { OperationResult } from '../src/runtime/operation-result.js'
import {
  analysisHistoryContext,
  analysisPrompt,
  analysisSpecContext,
  businessReviewPrompt,
  clarificationContext,
  devPlanningPrompt,
  devPrompt,
  devSessionSummaryPrompt,
  monitorPrompt,
  opsDiagnosisPrompt,
  opsInterruptionPrompt,
  orchestratorPrompt,
  planReviewPrompt,
  projectFactsContext,
  requirementContext,
  reviewPrompt,
  verificationExecutionPrompt,
  verificationPrompt,
} from '../src/runtime/prompts.js'
import type { ProjectFacts } from '../src/runtime/board.js'
import {
  buildRequirementView,
  deliveryProgress,
  planReviewView,
  verificationView,
} from '../src/runtime/requirement-views.js'
import { TaskViews } from '../src/runtime/task-views.js'

// ---------------------------------------------------------------------------
// 提示词：夹具
// ---------------------------------------------------------------------------

function promptRequirement(): Requirement {
  return {
    reqId: 'req-1',
    project: 'demo',
    status: 'draft',
    blockedReason: '',
    submittedBy: 'owner',
    source: 'test',
    versions: [
      {
        version: 1,
        text: '给看板加过滤',
        createdAt: '2026-11-01T00:00:00.000Z',
        revisedBy: 'owner',
        source: 'test',
      },
    ],
  }
}

const requirementAnalysis: RequirementAnalysis = {
  analysisVersion: 2,
  requirementVersion: 1,
  inputKind: 'requirement',
  goal: '看板可按状态过滤',
  scenarios: ['按状态筛选需求与任务', '清空筛选恢复全部'],
  businessRules: ['只有登录用户可以看到需求列表'],
  exceptions: ['筛选参数非法时回退到全部需求'],
  nonGoals: ['不改变默认排序'],
  acceptanceCriteria: ['筛选后只显示匹配项'],
  clarifications: [],
  createdAt: '2026-11-04T00:00:00.000Z',
}

const problemAnalysis: RequirementAnalysis = {
  analysisVersion: 3,
  requirementVersion: 1,
  inputKind: 'problem',
  goal: '看板刷新后筛选条件丢失',
  scenarios: ['选择筛选后刷新回到全部'],
  businessRules: ['刷新不得清空已选筛选'],
  exceptions: ['筛选条件指向已删除状态时回退'],
  nonGoals: ['不新增筛选维度'],
  acceptanceCriteria: ['刷新后仍按当前筛选条件展示'],
  clarifications: [],
  createdAt: '2026-11-04T01:00:00.000Z',
}

const structuredAnalysis: RequirementAnalysis = {
  ...requirementAnalysis,
  businessPoints: [
    {
      id: 'BP-1',
      basis: 'user_requirement',
      source: '用户原文“给看板加过滤”',
      actor: '业务用户',
      trigger: '打开看板并选择状态',
      behavior: '只看到匹配的需求与任务',
      rules: ['只显示当前用户可见需求'],
      exceptions: { status: 'assessed', items: ['筛选值非法时回退'], reason: '' },
    },
    {
      id: 'BP-2',
      basis: 'project_convention',
      source: 'docs/product.md',
      actor: '管理员',
      trigger: '清空筛选',
      behavior: '恢复全部需求',
      rules: [],
      exceptions: { status: 'not_applicable', items: [], reason: '该要点没有额外异常' },
    },
    {
      id: 'BP-3',
      basis: 'external_material',
      source: 'docs/a.md',
      actor: '审计员',
      trigger: '导出筛选结果',
      behavior: '导出与筛选一致',
      rules: ['导出只包含当前筛选结果'],
      exceptions: { status: 'assessed', items: [], reason: '' },
    },
  ],
  acceptanceItems: [
    {
      id: 'AC-1',
      pointIds: ['BP-1'],
      given: '已有需求',
      when: '选择状态',
      then: '只显示匹配项',
    },
    { id: 'AC-2', pointIds: ['BP-2'], given: '筛选生效', when: '清空', then: '显示全部' },
  ],
  assumptions: [
    {
      id: 'AS-1',
      statement: '状态字段稳定',
      basis: 'inference',
      source: '现有记录',
      impact: '筛选实现',
      needsConfirmation: true,
    },
    {
      id: 'AS-2',
      statement: '默认排序不变',
      basis: 'external_material',
      source: 'docs/a.md',
      impact: '无',
      needsConfirmation: false,
    },
  ],
}

function promptTask(taskId: string, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    taskId,
    goal: '实现 ' + taskId,
    files: ['packages/forgeloop/src/' + taskId + '.ts'],
    acceptance: taskId + ' 可验收',
    testCommand: ['node', '-e', 'process.exit(0)'],
    dependsOn: [],
    limits: { limitSeconds: 60, maxFailureRounds: 2 },
    authorizationSource: '',
    ...overrides,
  }
}

const planWithSolution: TaskPlan = {
  taskPlanId: 'plan-req-1-1',
  requirementId: 'req-1',
  project: 'demo',
  planVersion: 1,
  requirementVersion: 1,
  tasks: [
    promptTask('core'),
    promptTask('ui', { dependsOn: ['core'] }),
    promptTask('verify', { dependsOn: ['core'], files: [], verification: true }),
  ],
  technicalSolution: {
    summary: '先改运行时再补界面',
    approach: ['拆分任务', '按依赖执行'],
    risks: ['兼容旧记录'],
  },
  createdAt: '2026-11-04T02:00:00.000Z',
}

const planWithoutSolution: TaskPlan = {
  taskPlanId: 'plan-req-1-2',
  requirementId: 'req-1',
  project: 'demo',
  planVersion: 2,
  requirementVersion: 1,
  tasks: [promptTask('only', { files: [] })],
  createdAt: '2026-11-04T03:00:00.000Z',
}

const projectFacts: ProjectFacts = {
  project: 'demo',
  generatedAt: '2026-11-04T04:00:00.000Z',
  total: 1,
  listed: 1,
  notListed: 0,
  terminal: 0,
  requirements: [
    {
      reqId: 'req-1',
      current: true,
      title: '给看板加过滤',
      status: 'draft',
      version: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      goal: '看板可过滤',
      planVersion: null,
      approval: 'none',
      taskCount: 0,
      tasks: [],
    },
  ],
}

describe('prompt builders: full-string branches', () => {
  it('renders requirement and problem planning prompts with both tool modes', () => {
    expect(
      devPlanningPrompt(promptRequirement(), requirementAnalysis, { tools: 'none' }),
    ).toMatchSnapshot('dev-planning-requirement-none')
    expect(
      devPlanningPrompt(promptRequirement(), problemAnalysis, { tools: 'read' }),
    ).toMatchSnapshot('dev-planning-problem-read')
  })

  it('renders structured business points with assessed and not-applicable exceptions', () => {
    const prompt = devPlanningPrompt(promptRequirement(), structuredAnalysis)
    expect(prompt).toContain('业务要点')
    expect(prompt).toContain('异常与边界：（已评估，无额外项目）')
    expect(prompt).toContain('异常与边界：筛选值非法时回退')
    expect(prompt).toContain('异常与边界：not_applicable：该要点没有额外异常')
    expect(prompt).toMatchSnapshot('dev-planning-structured-points')
  })

  it('renders plan review for a plan with a technical solution and verification task', () => {
    expect(
      planReviewPrompt({
        requirement: promptRequirement(),
        analysis: requirementAnalysis,
        plan: planWithSolution,
      }),
    ).toMatchSnapshot('plan-review-with-solution')
  })

  it('renders plan review and verification without a technical solution or diff', () => {
    expect(
      planReviewPrompt({
        requirement: promptRequirement(),
        analysis: problemAnalysis,
        plan: planWithoutSolution,
      }),
    ).toMatchSnapshot('plan-review-without-solution-problem')
    expect(
      verificationPrompt({
        requirement: promptRequirement(),
        analysis: problemAnalysis,
        plan: planWithoutSolution,
        planReview: {
          verdict: 'pass',
          blocking: [],
          findings: [],
          summary: '可验证',
          verificationPlan: [
            {
              scenario: '刷新保留筛选',
              acceptanceCriterion: '刷新后仍筛选',
              method: '手动',
              required: true,
            },
          ],
        },
        candidateSha256: 'c'.repeat(64),
        workspaceSha256: 'w'.repeat(64),
        workspacePath: '/tmp/ws',
        diff: '',
      }),
    ).toMatchSnapshot('verification-without-solution-empty-diff')
  })

  it('renders verification execution plans with required flags and optional expected output', () => {
    expect(
      verificationExecutionPrompt({
        reqId: 'req-1',
        candidateSha256: 'c'.repeat(64),
        plan: {
          scenarios: [
            {
              scenario: '场景一',
              acceptanceCriterion: '标准一',
              method: '方法一',
              required: true,
              checks: [
                { label: 'check-1', argv: ['node', '-e', '0'], expectedOutput: 'ok' },
                { label: 'check-2', argv: ['node', '-e', '1'], expectedOutput: '' },
              ],
            },
            {
              scenario: '场景二',
              acceptanceCriterion: '标准二',
              method: '方法二',
              required: false,
              checks: [{ label: 'check-3', argv: ['npm', 'test'], expectedOutput: '' }],
            },
          ],
        },
      }),
    ).toMatchSnapshot('verification-execution-plan')
  })

  it('renders business review with executed commands and structured or legacy analysis', () => {
    expect(
      businessReviewPrompt({
        requirement: promptRequirement(),
        analysis: structuredAnalysis,
        plan: planWithSolution,
        verificationPlan: {
          scenarios: [
            {
              scenario: '按状态筛选',
              acceptanceCriterion: '只显示匹配项',
              method: '运行筛选命令',
              required: true,
              checks: [{ label: 'check-1', argv: ['node', '-e', '0'], expectedOutput: 'ok' }],
            },
          ],
        },
        candidateSha256: 'c'.repeat(64),
        commands: [
          { label: 'check-1', argv: ['node', '-e', '0'], exitCode: 0, logTail: 'ok' },
          { label: 'check-2', argv: ['node', '-e', '1'], exitCode: null, logTail: '' },
        ],
      }),
    ).toMatchSnapshot('business-review-structured-commands')
    expect(
      businessReviewPrompt({
        requirement: promptRequirement(),
        analysis: {
          ...requirementAnalysis,
          businessRules: [],
          exceptions: [],
          nonGoals: [],
        },
        plan: planWithoutSolution,
        candidateSha256: 'd'.repeat(64),
        commands: [],
      }),
    ).toMatchSnapshot('business-review-legacy-empty-commands')
  })

  it('renders dev session summaries with no plan and with multiple tasks', () => {
    expect(
      devSessionSummaryPrompt({ requirement: promptRequirement(), plan: null, outcome: '被停止' }),
    ).toMatchSnapshot('dev-summary-no-plan')
    expect(
      devSessionSummaryPrompt({
        requirement: promptRequirement(),
        plan: planWithSolution,
        outcome: '已交付',
      }),
    ).toMatchSnapshot('dev-summary-multi-task')
    expect(
      devSessionSummaryPrompt({
        requirement: promptRequirement(),
        plan: { ...planWithSolution, tasks: [] },
        outcome: '空任务包',
      }),
    ).toMatchSnapshot('dev-summary-empty-tasks')
  })

  it('renders orchestrator routing with no sessions and with sparse sessions', () => {
    expect(
      orchestratorPrompt({
        requirement: promptRequirement(),
        analysis: requirementAnalysis,
        sessions: [],
      }),
    ).toMatchSnapshot('orchestrator-no-sessions')
    expect(
      orchestratorPrompt({
        requirement: promptRequirement(),
        analysis: problemAnalysis,
        sessions: [
          {
            sessionId: 'sess-a',
            workspace: '/tmp/a',
            state: 'busy',
            lastReqId: '',
            updatedAt: '2026-11-04T05:00:00.000Z',
            summary: '',
          },
          {
            sessionId: 'sess-b',
            workspace: '/tmp/b',
            state: 'idle',
            lastReqId: 'req-0',
            updatedAt: '2026-11-04T06:00:00.000Z',
            summary: '上次完成看板过滤',
          },
        ],
      }),
    ).toMatchSnapshot('orchestrator-sparse-sessions')
  })

  it('renders ops diagnosis and interruption prompts with empty and filled facts', () => {
    const resource = { id: 'res-1', kind: 'http', label: '接口' }
    expect(
      opsDiagnosisPrompt({
        eventId: 'evt-1',
        title: '接口超时',
        severity: 'major',
        openedAt: '2026-11-04T07:00:00.000Z',
        resource,
        checkId: 'latency',
        observations: [],
        output: 'timeout',
        actions: [],
      }),
    ).toMatchSnapshot('ops-diagnosis-empty')
    expect(
      opsDiagnosisPrompt({
        eventId: 'evt-2',
        title: '接口持续超时',
        severity: 'critical',
        openedAt: '2026-11-04T07:10:00.000Z',
        resource,
        checkId: 'latency',
        observations: ['连续三次超时', 'CPU 正常'],
        output: 'timeout\nretry',
        actions: [
          { id: 'restart', params: [] },
          { id: 'scale', params: [{ name: 'replicas', values: ['2', '3'] }] },
        ],
        deployments: [
          { id: 'prod', requirementId: 'req-1' },
          { id: 'staging', requirementId: 'req-2' },
        ],
      }),
    ).toMatchSnapshot('ops-diagnosis-filled')
    expect(
      opsInterruptionPrompt({
        eventId: 'evt-3',
        title: '动作中断',
        severity: 'critical',
        openedAt: '2026-11-04T08:00:00.000Z',
        resource,
        checkId: 'alive',
        observations: [],
        attempt: {
          actionId: 'restart',
          params: {},
          authorizationSource: 'owner',
          startedAt: '2026-11-04T08:01:00.000Z',
          detail: '',
          evidencePath: '',
        },
        logTail: '',
      }),
    ).toMatchSnapshot('ops-interruption-empty')
    expect(
      opsInterruptionPrompt({
        eventId: 'evt-4',
        title: '动作中断',
        severity: 'critical',
        openedAt: '2026-11-04T08:10:00.000Z',
        resource,
        checkId: 'alive',
        observations: ['宿主机重启'],
        attempt: {
          actionId: 'restart',
          params: { force: 'true', mode: 'safe' },
          authorizationSource: 'owner',
          startedAt: '2026-11-04T08:11:00.000Z',
          detail: '进程被中断',
          evidencePath: '/tmp/evidence',
        },
        logTail: 'line one\nline two',
      }),
    ).toMatchSnapshot('ops-interruption-filled')
  })

  it('renders monitor prompt and cuts the snapshot text at the documented limit', () => {
    expect(
      monitorPrompt({
        snapshot: { hosts: 1, issues: 0 } as never,
        resources: [],
        actions: [],
      }),
    ).toMatchSnapshot('monitor-empty-catalog')
    expect(
      monitorPrompt({
        snapshot: { hosts: 2 } as never,
        resources: [{ id: 'res-1', kind: 'http', label: '接口' }],
        actions: [
          { id: 'restart', resourceId: 'res-1', params: [] },
          { id: 'scale', resourceId: 'res-1', params: [{ name: 'n', values: ['1', '2'] }] },
        ],
      }),
    ).toMatchSnapshot('monitor-filled-catalog')

    const huge = { data: 'x'.repeat(70_000) }
    const rendered = monitorPrompt({ snapshot: huge as never, resources: [], actions: [] })
    const expected = JSON.stringify(huge, null, 2).slice(0, 60_000)
    expect(rendered).toContain(expected + '\n…（快照已截断）')
    expect(rendered).not.toContain('x'.repeat(60_001))
  })

  it('renders clarification history and prior structured specification branches', () => {
    const questions: ClarificationQuestion[] = [
      {
        reqId: 'req-1',
        analysisVersion: 2,
        questionIndex: 1,
        questionId: 'Q2-1',
        text: '筛选范围是否包含已归档需求？',
        status: 'resolved',
        resolution: '不包含已归档需求',
        resolvedAnalysisVersion: 3,
        resolvedRequirementVersion: 2,
        createdAt: '2026-11-04T00:00:00.000Z',
      },
      {
        reqId: 'req-1',
        analysisVersion: 2,
        questionIndex: 2,
        questionId: 'Q2-2',
        text: '清空筛选后是否保留排序？',
        status: 'open',
        resolution: '',
        resolvedAnalysisVersion: null,
        resolvedRequirementVersion: null,
        createdAt: '2026-11-04T00:00:00.000Z',
      },
    ]
    const answers: ClarificationAnswer[] = [
      {
        reqId: 'req-1',
        analysisVersion: 2,
        requirementVersion: 1,
        answeredVersion: 2,
        questionIds: ['Q2-1'],
        answer: '不包含已归档需求',
        source: 'owner',
        answeredAt: '2026-11-04T00:10:00.000Z',
      },
    ]
    expect(clarificationContext({ questions: [], answers: [] })).toMatchSnapshot(
      'clarification-no-history',
    )
    expect(clarificationContext({ questions, answers })).toMatchSnapshot('clarification-mixed')
    expect(analysisSpecContext(null)).toMatchSnapshot('spec-context-empty')
    expect(analysisSpecContext(structuredAnalysis)).toMatchSnapshot('spec-context-structured')
    expect(analysisHistoryContext({})).toMatchSnapshot('analysis-history-defaults')
  })

  it('renders dev and review prompts with empty lists and diff', () => {
    expect(
      devPrompt({
        requirement: promptRequirement(),
        plan: planWithoutSolution,
        task: promptTask('only', { files: [], dependsOn: [] }),
        workdir: '/tmp/ws',
      }),
    ).toMatchSnapshot('dev-prompt-empty-files')
    expect(
      reviewPrompt({
        requirement: promptRequirement(),
        plan: planWithSolution,
        task: promptTask('core'),
        diff: '',
        changedFiles: [],
        diffPath: '/tmp/evidence/diff.patch',
      }),
    ).toMatchSnapshot('review-prompt-empty-diff')
  })

  it('keeps the analysis prompt stable while embedding facts and requirement context', () => {
    expect(requirementContext(promptRequirement())).toMatchSnapshot('requirement-context')
    expect(projectFactsContext(projectFacts)).toMatchSnapshot('project-facts-context')
    expect(analysisPrompt(promptRequirement(), projectFacts, '行业背景：本地生活')).toMatchSnapshot(
      'analysis-prompt',
    )
  })
})

// ---------------------------------------------------------------------------
// 需求视图与任务视图：真实 Repository + 临时目录
// ---------------------------------------------------------------------------

let root = ''
let config: ReturnType<typeof resolveConfig>
let repo: Repository

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-views-deep-'))
  config = resolveConfig(
    {
      project: 'demo',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      pollSeconds: 60,
      owner: 'owner',
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
    },
    root,
  )
  repo = new Repository(Database.open(join(config.recordsRoot, 'records.sqlite')))
})

afterEach(() => {
  repo.close()
  rmSync(root, { recursive: true, force: true })
})

function submitRequirement(reqId = 'req-1', source = 'test'): Requirement {
  return repo.submit({
    reqId,
    project: 'demo',
    text: '需求 ' + reqId + '：给看板加过滤',
    submittedBy: 'owner',
    source,
    now: '2026-11-01T00:00:00.000Z',
  }).requirement
}

function viewTask(taskId: string, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    taskId,
    goal: '实现 ' + taskId,
    files: ['packages/forgeloop/src/' + taskId + '.ts'],
    acceptance: taskId + ' 可验收',
    testCommand: ['node', '-e', 'process.exit(0)'],
    dependsOn: [],
    limits: { limitSeconds: 60, maxFailureRounds: 2 },
    authorizationSource: '',
    ...overrides,
  }
}

function viewPlan(
  planVersion: number,
  tasks: readonly PlannedTask[],
  extra: Partial<TaskPlan> = {},
): TaskPlan {
  return {
    taskPlanId: 'plan-req-1-' + planVersion,
    requirementId: 'req-1',
    project: 'demo',
    planVersion,
    requirementVersion: 1,
    tasks,
    createdAt: '2026-11-0' + planVersion + 'T00:00:00.000Z',
    ...extra,
  }
}

function recordAnalysisFor(reqId = 'req-1'): void {
  repo.recordAnalysis({
    reqId,
    analysisVersion: 1,
    requirementVersion: 1,
    inputKind: 'requirement',
    goal: '看板可过滤',
    scenarios: ['按状态筛选'],
    businessRules: ['规则'],
    exceptions: ['异常'],
    nonGoals: ['非目标'],
    acceptanceCriteria: ['只显示匹配项'],
    clarifications: [],
    createdAt: '2026-11-01T00:05:00.000Z',
  })
}

function evidencePath(reqId: string, planVersion: number, taskId: string): string {
  return join(
    config.recordsRoot,
    'projects',
    config.project,
    'evidence',
    reqId,
    'v' + planVersion,
    taskId,
  )
}

function writeEvidenceFiles(
  reqId: string,
  planVersion: number,
  taskId: string,
  files: Readonly<Record<string, string>>,
): string {
  const dir = evidencePath(reqId, planVersion, taskId)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8')
  }
  return dir
}

function dataOf(result: OperationResult): Record<string, any> {
  expect(result.ok).toBe(true)
  return result.data as Record<string, any>
}

function seedTaskPlan(): { requirement: Requirement; plan: TaskPlan } {
  const requirement = submitRequirement()
  const plan = viewPlan(1, [viewTask('t1')])
  repo.recordTaskPlan(plan)
  return { requirement, plan }
}

describe('requirement views on real records', () => {
  it('returns null for a missing plan review and falls back on a malformed report', () => {
    submitRequirement()
    expect(planReviewView(repo, 'req-1', 9)).toBeNull()

    repo.recordPlanReview({
      requirementId: 'req-1',
      planVersion: 1,
      requirementVersion: 1,
      planSha256: 'p'.repeat(64),
      verdict: 'pass',
      reportJson: JSON.stringify({
        verdict: 'pass',
        summary: '方案可行',
        findings: ['小风险'],
        blocking: [],
        verification_plan: [
          {
            scenario: '按状态筛选',
            acceptance_criterion: '只显示匹配项',
            method: '手动验证',
            required: true,
          },
        ],
      }),
      reportPath: '/tmp/evidence/plan-review.json',
      reportSha256: 'r'.repeat(64),
      sessionId: 'sess-review',
      reviewedAt: '2026-11-02T00:00:00.000Z',
    })
    expect(planReviewView(repo, 'req-1', 1)).toEqual({
      verdict: 'pass',
      summary: '方案可行',
      blocking: [],
      findings: ['小风险'],
      verificationPlan: [
        {
          scenario: '按状态筛选',
          acceptanceCriterion: '只显示匹配项',
          method: '手动验证',
          required: true,
        },
      ],
      reportPath: '/tmp/evidence/plan-review.json',
      reportSha256: 'r'.repeat(64),
      sessionId: 'sess-review',
      reviewedAt: '2026-11-02T00:00:00.000Z',
    })

    repo.recordPlanReview({
      requirementId: 'req-1',
      planVersion: 1,
      requirementVersion: 1,
      planSha256: 'p'.repeat(64),
      verdict: 'block',
      reportJson: '{not json',
      reportPath: '/tmp/evidence/bad.json',
      reportSha256: 'b'.repeat(64),
      sessionId: '',
      reviewedAt: '2026-11-02T01:00:00.000Z',
    })
    expect(planReviewView(repo, 'req-1', 1)).toEqual({
      verdict: 'block',
      summary: '',
      blocking: [],
      findings: [],
      verificationPlan: [],
      reportPath: '/tmp/evidence/bad.json',
      reportSha256: 'b'.repeat(64),
      sessionId: '',
      reviewedAt: '2026-11-02T01:00:00.000Z',
    })
  })

  it('reports verification as fresh only for the recorded candidate commit', () => {
    submitRequirement()
    const plan = viewPlan(1, [viewTask('t1')])
    repo.recordTaskPlan(plan)
    const reportJson = JSON.stringify({
      verdict: 'pass',
      summary: '验证通过',
      findings: ['非阻断发现'],
      blocking: [],
      scenarios: [
        { scenario: '按状态筛选', status: 'pass', evidence: '筛选输出正确', commands: ['check'] },
      ],
    })
    repo.recordVerification({
      requirementId: 'req-1',
      planVersion: 1,
      candidateSha256: 'cand-1',
      requirementVersion: 1,
      workspaceSha256: 'ws-1',
      verdict: 'pass',
      reportJson,
      reportPath: '/tmp/evidence/verification.json',
      reportSha256: 'v'.repeat(64),
      evidenceDir: '/tmp/evidence',
      sessionId: 'sess-verify',
      verifiedAt: '2026-11-03T00:00:00.000Z',
    })
    repo.recordCommit({
      requirementId: 'req-1',
      planVersion: 1,
      candidateSha256: 'cand-1',
      commitSha: 'a'.repeat(40),
      commitMessage: 'feat: 过滤',
      checkCommand: ['npm', 'run', 'check'],
      checkLogPath: '/tmp/check.log',
      checkSha256: 'k'.repeat(64),
      files: ['packages/forgeloop/src/a.ts'],
      committedAt: '2026-11-03T01:00:00.000Z',
    })

    expect(
      verificationView(repo, () => 'never-used', { reqId: 'req-1', plan, artifacts: [] }),
    ).toEqual({
      verdict: 'pass',
      summary: '验证通过',
      blocking: [],
      findings: ['非阻断发现'],
      scenarios: [
        { scenario: '按状态筛选', status: 'pass', evidence: '筛选输出正确', commands: ['check'] },
      ],
      candidateSha256: 'cand-1',
      workspaceSha256: 'ws-1',
      reportPath: '/tmp/evidence/verification.json',
      reportSha256: 'v'.repeat(64),
      sessionId: 'sess-verify',
      verifiedAt: '2026-11-03T00:00:00.000Z',
      fresh: true,
    })

    expect(
      verificationView(repo, () => 'x', { reqId: 'req-1', plan: viewPlan(2, []), artifacts: [] }),
    ).toBeNull()
  })

  it('derives freshness from the candidate identity, including failures and mismatches', () => {
    submitRequirement()
    const plan = viewPlan(1, [viewTask('t1')])
    repo.recordVerification({
      requirementId: 'req-1',
      planVersion: 1,
      candidateSha256: 'sha-a',
      requirementVersion: 1,
      workspaceSha256: 'ws-a',
      verdict: 'block',
      reportJson: '{malformed',
      reportPath: '/tmp/evidence/bad.json',
      reportSha256: 'x'.repeat(64),
      evidenceDir: '/tmp/evidence',
      sessionId: '',
      verifiedAt: '2026-11-03T02:00:00.000Z',
    })
    const base = { reqId: 'req-1', plan, artifacts: [] }
    const same = verificationView(repo, () => 'sha-a', base) as Record<string, any>
    expect(same).toMatchObject({
      verdict: 'block',
      summary: '',
      blocking: [],
      findings: [],
      scenarios: [],
      candidateSha256: 'sha-a',
      fresh: true,
    })
    expect((verificationView(repo, () => 'sha-b', base) as Record<string, any>).fresh).toBe(false)
    expect(
      (
        verificationView(
          repo,
          () => {
            throw new Error('identity unavailable')
          },
          base,
        ) as Record<string, any>
      ).fresh,
    ).toBe(false)
  })

  it('builds a full requirement view from real analysis, plans, approval, runs and failures', () => {
    const requirement = submitRequirement()
    recordAnalysisFor()
    const planV1 = viewPlan(1, [viewTask('t1')])
    const planV2 = viewPlan(2, [viewTask('t2'), viewTask('t3')], {
      technicalSolution: { summary: '方案', approach: ['步骤'], risks: [] },
    })
    repo.recordTaskPlan(planV1)
    repo.recordTaskPlan(planV2)
    repo.recordPlanApproval({
      requirementId: 'req-1',
      planVersion: 2,
      approvedBy: 'owner',
      source: 'owner',
      approvedAt: '2026-11-02T00:00:00.000Z',
    })
    repo.recordTaskRun({
      requirementId: 'req-1',
      planVersion: 2,
      taskId: 't2',
      state: 'running',
      reason: '正在实现',
      executedSeconds: 12,
      updatedAt: '2026-11-02T01:00:00.000Z',
    })
    repo.recordTaskArtifact({
      requirementId: 'req-1',
      planVersion: 2,
      taskId: 't2',
      candidateSha256: 'cand-t2',
      testEvidenceSha256: 't'.repeat(64),
      reviewSha256: 'r'.repeat(64),
      acceptance: '通过',
      authorizationSource: 'plan-approval:req-1:v2:owner',
      recordedAt: '2026-11-02T02:00:00.000Z',
      baselineCommit: 'a'.repeat(40),
    })
    repo.recordCandidate({
      reqId: 'req-1',
      planVersion: 2,
      sha256: 'cand-t2',
      tarball: '/tmp/cand.tgz',
      files: ['packages/forgeloop/src/t2.ts'],
      gitHead: 'b'.repeat(40),
      builtAt: '2026-11-02T03:00:00.000Z',
      evidenceDir: '/tmp/evidence',
    })
    repo.recordFailureRound('req-1', {
      roundId: 't2-formal-1',
      stage: 'formal_test',
      summary: '测试失败',
      occurredAt: '2026-11-02T04:00:00.000Z',
    })
    repo.recordFailureRound('req-1', {
      roundId: 'oracle-1',
      stage: 'verification',
      summary: '无关轮次',
      occurredAt: '2026-11-02T05:00:00.000Z',
    })
    repo.appendGrant('req-1', 'owner', '2026-11-02T06:00:00.000Z')
    repo.recordRequest({
      requestId: 'sr-1',
      reqId: 'req-1',
      project: 'demo',
      planVersion: 2,
      action: 'retry',
      requestedBy: 'owner',
      source: 'owner',
      now: '2026-11-02T07:00:00.000Z',
    })
    repo.resolveRequest('sr-1', 'done', '已处理', '2026-11-02T07:10:00.000Z')
    repo.recordRequest({
      requestId: 'sr-2',
      reqId: 'req-1',
      project: 'demo',
      planVersion: 2,
      action: 'stop',
      requestedBy: 'owner',
      source: 'owner',
      now: '2026-11-02T07:20:00.000Z',
    })

    const view = buildRequirementView(repo, {
      requirement,
      candidateIdentityOf: () => 'cand-t2',
      requestView: (request) => ({
        requestId: request.requestId,
        action: request.action,
        state: request.state,
      }),
    }) as Record<string, any>

    expect(view.reqId).toBe('req-1')
    expect(view.project).toBe('demo')
    expect(view.status).toBe('draft')
    expect(view.blockedReason).toBe('')
    expect(view.source).toBe('test')
    expect(view.submittedBy).toBe('owner')
    expect(view.createdAt).toBe('2026-11-01T00:00:00.000Z')
    expect(view.versions).toEqual([
      {
        version: 1,
        text: '需求 req-1：给看板加过滤',
        createdAt: '2026-11-01T00:00:00.000Z',
        revisedBy: 'owner',
      },
    ])
    expect(view.analysis).toMatchObject({ analysisVersion: 1, goal: '看板可过滤' })
    expect(view.plans).toEqual([
      {
        planVersion: 1,
        requirementVersion: 1,
        tasks: ['t1'],
        createdAt: '2026-11-01T00:00:00.000Z',
      },
      {
        planVersion: 2,
        requirementVersion: 1,
        tasks: ['t2', 't3'],
        createdAt: '2026-11-02T00:00:00.000Z',
      },
    ])
    expect(view.approval).toEqual({
      planVersion: 2,
      approvedBy: 'owner',
      approvedAt: '2026-11-02T00:00:00.000Z',
    })
    expect(view.planReview).toBeNull()
    expect(view.verification).toBeNull()
    expect(view.candidate).toMatchObject({ planVersion: 2, sha256: 'cand-t2' })
    expect(view.delivered).toEqual(['t2'])
    expect(view.runs).toEqual([{ taskId: 't2', state: 'running', reason: '正在实现' }])
    expect(view.failureRounds).toBe(2)
    expect(view.grants).toBe(2)
    expect(view.failureRoundDetails).toEqual([
      {
        roundId: 't2-formal-1',
        stage: 'formal_test',
        summary: '测试失败',
        occurredAt: '2026-11-02T04:00:00.000Z',
        taskId: 't2',
      },
      {
        roundId: 'oracle-1',
        stage: 'verification',
        summary: '无关轮次',
        occurredAt: '2026-11-02T05:00:00.000Z',
      },
    ])
    expect(view.grantQuota).toEqual({ grants: 2, used: 2, remaining: 4 })
    expect(view.pendingRequests).toEqual([{ requestId: 'sr-2', action: 'stop', state: 'pending' }])
  })

  it('defaults an unplanned requirement and honours the remaining-rounds hook', () => {
    const requirement = submitRequirement()
    const view = buildRequirementView(repo, {
      requirement,
      candidateIdentityOf: () => '',
      requestView: () => ({}),
      remainingFailureRounds: () => Number.POSITIVE_INFINITY,
    }) as Record<string, any>
    expect(view.plans).toEqual([])
    expect(view.approval).toBeNull()
    expect(view.planReview).toBeNull()
    expect(view.verification).toBeNull()
    expect(view.candidate).toBeNull()
    expect(view.delivered).toEqual([])
    expect(view.runs).toEqual([])
    expect(view.failureRounds).toBe(0)
    expect(view.grants).toBe(1)
    expect(view.failureRoundDetails).toEqual([])
    expect(view.grantQuota).toEqual({ grants: 1, used: 0, remaining: null })
    expect(view.pendingRequests).toEqual([])

    const finite = buildRequirementView(repo, {
      requirement,
      candidateIdentityOf: () => '',
      requestView: () => ({}),
      remainingFailureRounds: () => 5,
    }) as Record<string, any>
    expect(finite.grantQuota).toEqual({ grants: 1, used: 0, remaining: 5 })
  })

  it('classifies delivery progress by delivered first and then run state', () => {
    const tasks = [
      viewTask('delivered'),
      viewTask('ask'),
      viewTask('running'),
      viewTask('failed'),
      viewTask('blocked'),
      viewTask('awaiting'),
      viewTask('pending'),
    ]
    const plan = viewPlan(1, tasks)
    const runs = [
      {
        taskId: 'delivered',
        state: 'failed' as const,
        reason: '',
        requirementId: 'req-1',
        planVersion: 1,
        executedSeconds: 0,
        updatedAt: '',
      },
      {
        taskId: 'ask',
        state: 'running' as const,
        reason: 'ask_user_question: 确认范围',
        requirementId: 'req-1',
        planVersion: 1,
        executedSeconds: 0,
        updatedAt: '',
      },
      {
        taskId: 'running',
        state: 'running' as const,
        reason: 'working',
        requirementId: 'req-1',
        planVersion: 1,
        executedSeconds: 0,
        updatedAt: '',
      },
      {
        taskId: 'failed',
        state: 'failed' as const,
        reason: '',
        requirementId: 'req-1',
        planVersion: 1,
        executedSeconds: 0,
        updatedAt: '',
      },
      {
        taskId: 'blocked',
        state: 'blocked' as const,
        reason: '',
        requirementId: 'req-1',
        planVersion: 1,
        executedSeconds: 0,
        updatedAt: '',
      },
      {
        taskId: 'awaiting',
        state: 'awaiting_user' as const,
        reason: '',
        requirementId: 'req-1',
        planVersion: 1,
        executedSeconds: 0,
        updatedAt: '',
      },
    ]
    expect(deliveryProgress(plan, new Set(['delivered']), runs)).toEqual({
      total: 7,
      delivered: 1,
      failed: 1,
      awaitingUser: 1,
      awaitingInput: 1,
      blocked: 1,
      running: 1,
      pending: 1,
    })
    expect(deliveryProgress(null, new Set(), [])).toEqual({
      total: 0,
      delivered: 0,
      failed: 0,
      awaitingUser: 0,
      awaitingInput: 0,
      blocked: 0,
      running: 0,
      pending: 0,
    })
  })
})

describe('task views on real records and evidence files', () => {
  function views(
    deps: {
      remainingFailureRounds?: (reqId: string) => number
      retryEligibility?: ConstructorParameters<typeof TaskViews>[0]['retryEligibility']
    } = {},
  ): TaskViews {
    return new TaskViews({
      config,
      repo,
      now: () => '2026-11-05T00:00:00.000Z',
      remainingFailureRounds: deps.remainingFailureRounds ?? (() => 1),
      retryEligibility:
        deps.retryEligibility ??
        (() => ({
          ok: false as const,
          code: 'not_ready',
          message: '任务尚未失败或未到可重试状态',
        })),
    })
  }

  it('reports missing requirement, plan and task with stable error text', () => {
    expect(views().taskDetail('req-missing', 't1')).toEqual({
      ok: false,
      code: 'not_found',
      message: '未找到需求 req-missing',
    })

    submitRequirement()
    expect(views().taskDetail('req-1', 't1')).toEqual({
      ok: false,
      code: 'plan_missing',
      message: '需求 req-1 没有任务包',
    })

    repo.recordTaskPlan(viewPlan(1, [viewTask('t1')]))
    expect(views().taskDetail('req-1', 't2')).toEqual({
      ok: false,
      code: 'task_missing',
      message: '任务包内没有任务 t2',
    })
    expect(views().taskDetail('req-1', 't1', 9)).toEqual({
      ok: false,
      code: 'plan_missing',
      message: '需求 req-1 没有任务包',
    })
  })

  it('exposes failure details, truncated logs, stop state and retry denial', () => {
    const { plan } = seedTaskPlan()
    const longLog = [
      'started: 2026-11-04T00:00:00.000Z',
      'duration_ms: 1234',
      'timed_out: false',
      'aborted: false',
      'exit_code: 1',
      'x'.repeat(5000),
      'FAIL tests/foo.test.ts',
      'TAIL-MARKER',
    ].join('\n')
    writeEvidenceFiles('req-1', 1, 't1', {
      'dev.jsonl': [
        JSON.stringify({ type: 'turn/start', time: 1793750400000, seq: 1 }),
        JSON.stringify({
          type: 'assistant/message',
          time: 1793750401000,
          seq: 2,
          data: { message: { content: [{ type: 'text', text: '已修改文件' }] } },
        }),
        JSON.stringify({
          type: 'tool/call',
          time: 1793750402000,
          seq: 3,
          data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
        }),
        JSON.stringify({
          type: 'tool/result',
          time: 1793750403000,
          seq: 4,
          data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } },
        }),
      ].join('\n'),
      'review.json': JSON.stringify({
        verdict: 'block',
        blocking: ['需要补测试'],
        summary: '阻断',
      }),
      'formal-test.log': longLog,
    })
    repo.recordTaskRun({
      requirementId: 'req-1',
      planVersion: 1,
      taskId: 't1',
      state: 'failed',
      reason: '正式测试失败：退出码 1',
      executedSeconds: 5,
      updatedAt: '2026-11-04T00:20:00.000Z',
    })
    repo.recordTaskArtifact({
      requirementId: 'req-1',
      planVersion: 1,
      taskId: 't1',
      candidateSha256: 'cand-1',
      testEvidenceSha256: 't'.repeat(64),
      reviewSha256: 'r'.repeat(64),
      acceptance: '通过',
      authorizationSource: 'plan-approval:req-1:v1:owner',
      recordedAt: '2026-11-04T00:30:00.000Z',
      baselineCommit: 'a'.repeat(40),
    })
    repo.recordEvidence({
      requirementId: 'req-1',
      planVersion: 1,
      taskId: 't1',
      baselineCommit: 'a'.repeat(40),
      workspacePath: '/tmp/ws',
      candidatePath: '/tmp/cand',
      testLogPath: '/tmp/log',
      reviewPath: '/tmp/review.json',
      devSession: 'sess-dev',
      reviewSession: 'sess-review',
      recordedAt: '2026-11-04T00:40:00.000Z',
    })
    repo.recordFailureRound('req-1', {
      roundId: 't1-formal-1',
      stage: 'formal_test',
      summary: '测试失败',
      occurredAt: '2026-11-04T00:50:00.000Z',
    })
    repo.recordRequest({
      requestId: 'sr-1',
      reqId: 'req-1',
      project: 'demo',
      planVersion: plan.planVersion,
      action: 'retry',
      requestedBy: 'owner',
      source: 'owner',
      now: '2026-11-04T01:00:00.000Z',
    })
    repo.recordStop({
      requirementId: 'req-1',
      requestedBy: 'owner',
      reason: '先停一下',
      requestedAt: '2026-11-04T01:10:00.000Z',
    })

    const data = dataOf(views().taskDetail('req-1', 't1'))
    expect(data.planVersion).toBe(1)
    expect(data.generatedAt).toBe('2026-11-05T00:00:00.000Z')
    expect(data.requirement).toEqual({
      status: 'draft',
      blockedReason: '',
      stopRequested: true,
    })
    expect(data.task).toEqual({
      taskId: 't1',
      goal: '实现 t1',
      files: ['packages/forgeloop/src/t1.ts'],
      acceptance: 't1 可验收',
      testCommand: ['node', '-e', 'process.exit(0)'],
      dependsOn: [],
      verification: false,
    })
    expect(data.run.state).toBe('failed')
    expect(data.artifact.candidateSha256).toBe('cand-1')
    expect(data.evidence.devSession).toBe('sess-dev')
    expect(data.activity).toEqual([
      { type: 'turn/start', at: '2026-11-04T00:00:00.000Z', summary: '回合开始' },
      {
        type: 'assistant/message',
        at: '2026-11-04T00:00:01.000Z',
        summary: '模型回复: 已修改文件',
      },
      { type: 'tool/call', at: '2026-11-04T00:00:02.000Z', summary: '调用 bash: {"command":"ls"}' },
      { type: 'tool/result', at: '2026-11-04T00:00:03.000Z', summary: '工具返回结果' },
    ])
    expect(data.activityTotal).toBe(4)
    expect(data.activityTruncated).toBe(false)
    expect(data.review).toEqual({ verdict: 'block', blocking: ['需要补测试'], summary: '阻断' })
    expect(data.reviewPath).toBe(join(evidencePath('req-1', 1, 't1'), 'review.json'))
    expect(data.testLogPath).toBe(join(evidencePath('req-1', 1, 't1'), 'formal-test.log'))
    expect(data.testLogBytes).toBe(Buffer.byteLength(longLog, 'utf8'))
    expect(data.testLogTail).toHaveLength(4000)
    expect(data.testLogTail.endsWith('TAIL-MARKER')).toBe(true)
    expect(data.testLogTruncated).toBe(true)
    expect(data.testExitCode).toBe(1)
    expect(data.testStartedAt).toBe('2026-11-04T00:00:00.000Z')
    expect(data.testDurationMs).toBe(1234)
    expect(data.testTimedOut).toBe(false)
    expect(data.testAborted).toBe(false)
    expect(data.failureRounds).toEqual([
      {
        roundId: 't1-formal-1',
        stage: 'formal_test',
        summary: '测试失败',
        occurredAt: '2026-11-04T00:50:00.000Z',
      },
    ])
    expect(data.remainingRounds).toBe(1)
    expect(data.activeRequests).toBe(1)
    expect(data.waitingForInput).toBe(false)
    expect(data.advice).toEqual({
      cause: '正式测试失败。',
      scope: [],
      actions: [
        '失败用例位于：tests/foo.test.ts；查看正式测试日志定位断言，修复后重试。',
        '重试保留既有失败轮次与证据，不会清零；不要修改测试来绕过检查。',
      ],
    })
    expect(data.retry).toEqual({ allowed: false, reason: '任务尚未失败或未到可重试状态' })
  })

  it('marks a waiting task, allows retry and falls back to pending without records', () => {
    const { plan } = seedTaskPlan()
    repo.recordTaskRun({
      requirementId: 'req-1',
      planVersion: 1,
      taskId: 't1',
      state: 'running',
      reason: 'ask_user_question: 确认范围',
      executedSeconds: 1,
      updatedAt: '2026-11-04T02:00:00.000Z',
    })
    const allowed = views({
      remainingFailureRounds: () => 0,
      retryEligibility: () => ({
        ok: true,
        plan,
        task: plan.tasks[0]!,
        run: {
          requirementId: 'req-1',
          planVersion: 1,
          taskId: 't1',
          state: 'running',
          reason: 'ask_user_question: 确认范围',
          executedSeconds: 1,
          updatedAt: '2026-11-04T02:00:00.000Z',
        },
        remainingRounds: 0,
      }),
    }).taskDetail('req-1', 't1')
    const data = dataOf(allowed)
    expect(data.waitingForInput).toBe(true)
    expect(data.remainingRounds).toBe(0)
    expect(data.retry).toEqual({ allowed: true, reason: '' })
    expect(data.activity).toEqual([])
    expect(data.activityTotal).toBe(0)
    expect(data.testLogBytes).toBe(0)
    expect(data.testExitCode).toBeNull()
    expect(data.review).toBeNull()
    expect(data.advice).toBeNull()

    repo.recordTaskPlan(viewPlan(2, [viewTask('t2')]))
    repo.recordTaskArtifact({
      requirementId: 'req-1',
      planVersion: 2,
      taskId: 't2',
      candidateSha256: 'cand-2',
      testEvidenceSha256: '',
      reviewSha256: '',
      acceptance: '通过',
      authorizationSource: '',
      recordedAt: '2026-11-04T03:00:00.000Z',
      baselineCommit: '',
    })
    const delivered = dataOf(views().taskDetail('req-1', 't2'))
    expect(delivered.run).toBeNull()
    expect(delivered.artifact.taskId).toBe('t2')
    expect(delivered.advice).toBeNull()
    expect(delivered.requirement.stopRequested).toBe(false)
  })

  it('reports execution lookup errors with stable text', () => {
    expect(views().taskExecution({ reqId: 'req-missing', taskId: 't1' })).toEqual({
      ok: false,
      code: 'not_found',
      message: '未找到需求 req-missing',
    })
    submitRequirement()
    expect(views().taskExecution({ reqId: 'req-1', taskId: 't1' })).toEqual({
      ok: false,
      code: 'plan_missing',
      message: '需求 req-1 没有任务包',
    })
    repo.recordTaskPlan(viewPlan(1, [viewTask('t1')]))
    expect(views().taskExecution({ reqId: 'req-1', taskId: 't9' })).toEqual({
      ok: false,
      code: 'task_missing',
      message: '任务包内没有任务 t9',
    })
  })

  it('pages public execution events and resolves sessions from evidence', () => {
    const { plan } = seedTaskPlan()
    const devLog = [
      JSON.stringify({ type: 'step/start', time: 1793750400000, seq: 0, data: { step: 1 } }),
      JSON.stringify({ type: 'turn/start', time: 1793750401000, seq: 1 }),
      JSON.stringify({
        type: 'assistant/message',
        time: 1793750402000,
        seq: 2,
        data: { message: { content: [{ type: 'text', text: '开始实现' }] } },
      }),
      JSON.stringify({
        type: 'tool/call',
        time: 1793750403000,
        seq: 3,
        data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
      }),
      JSON.stringify({
        type: 'tool/result',
        time: 1793750404000,
        seq: 4,
        data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } },
      }),
      JSON.stringify({
        type: 'assistant/message',
        time: 1793750405000,
        seq: 5,
        data: { message: { content: [{ type: 'text', text: '完成修改' }] } },
      }),
    ].join('\n')
    const longLog = 'started: 2026-11-04T00:00:00.000Z\nexit_code: 0\n' + 'y'.repeat(5000)
    writeEvidenceFiles('req-1', 1, 't1', {
      'dev.jsonl': devLog,
      'review.json': JSON.stringify({ verdict: 'pass', blocking: [], summary: '通过' }),
      'formal-test.log': longLog,
    })
    repo.recordEvidence({
      requirementId: 'req-1',
      planVersion: 1,
      taskId: 't1',
      baselineCommit: 'a'.repeat(40),
      workspacePath: '/tmp/ws',
      candidatePath: '/tmp/cand',
      testLogPath: '/tmp/log',
      reviewPath: '/tmp/review.json',
      devSession: 'sess-dev',
      reviewSession: 'sess-review',
      recordedAt: '2026-11-04T00:40:00.000Z',
    })
    repo.recordTaskRun({
      requirementId: 'req-1',
      planVersion: 1,
      taskId: 't1',
      state: 'running',
      reason: '正在实现',
      executedSeconds: 1,
      updatedAt: '2026-11-04T00:45:00.000Z',
    })
    repo.recordTaskArtifact({
      requirementId: 'req-1',
      planVersion: 1,
      taskId: 't1',
      candidateSha256: 'cand-1',
      testEvidenceSha256: '',
      reviewSha256: '',
      acceptance: '通过',
      authorizationSource: '',
      recordedAt: '2026-11-04T00:50:00.000Z',
      baselineCommit: '',
    })

    const outcome = views().taskExecution({
      reqId: 'req-1',
      taskId: 't1',
      planVersion: plan.planVersion,
      offset: 1,
      limit: 2,
    })
    const data = dataOf(outcome)
    expect(outcome.message).toBe('任务 t1 执行过程')
    expect(data.task).toMatchObject({ taskId: 't1', planVersion: 1, verification: false })
    expect(data.requirement).toEqual({ version: 1, status: 'draft', blockedReason: '' })
    expect(data.session).toEqual({
      dev: 'sess-dev',
      review: 'sess-review',
      jumpAvailable: false,
      note: '当前 Web 接缝没有可公开的 DSH 原始会话跳转地址；只展示已记录身份与证据。',
    })
    expect(data.total).toBe(4)
    expect(data.offset).toBe(1)
    expect(data.limit).toBe(2)
    expect(data.truncated).toBe(true)
    expect(data.events).toHaveLength(2)
    expect(data.events[0]).toMatchObject({ kind: 'message', title: '公开消息', text: '开始实现' })
    expect(data.stepCount).toBe(1)
    expect(data.startedAt).toBe('2026-11-04T00:00:00.000Z')
    expect(data.lastActivity).toBe('2026-11-04T00:00:05.000Z')
    expect(data.reason).toBe('')
    expect(data.review).toEqual({ verdict: 'pass', blocking: [], summary: '通过' })
    expect(data.test).toMatchObject({
      available: true,
      bytes: Buffer.byteLength(longLog, 'utf8'),
      exitCode: 0,
      truncated: true,
    })
    expect(data.attempts[0]).toMatchObject({
      attemptId: 'session:sess-dev',
      state: 'running',
      available: true,
      eventTotal: 4,
      reason: '',
    })
    expect(data.stages[0]).toMatchObject({ id: 'dev', state: 'running', total: 4, stepCount: 1 })
    expect(data.stages[1]).toMatchObject({
      id: 'review',
      available: true,
      verdict: 'pass',
      sessionId: 'sess-review',
    })
    expect(data.stages[2]).toMatchObject({ id: 'formal_test', available: true, exitCode: 0 })
    expect(data.stages[3]).toMatchObject({ id: 'delivery', delivered: true })
  })

  it('states when no execution record exists and keeps only this task failure rounds', () => {
    const { plan } = seedTaskPlan()
    writeEvidenceFiles('req-1', 1, 't1', {
      'review.json': JSON.stringify({ verdict: 'block', blocking: ['缺证据'], summary: '阻断' }),
    })
    repo.recordEvidence({
      requirementId: 'req-1',
      planVersion: 1,
      taskId: 't1',
      baselineCommit: '',
      workspacePath: '',
      candidatePath: '',
      testLogPath: '',
      reviewPath: '',
      devSession: '',
      reviewSession: 'sess-review',
      recordedAt: '2026-11-04T00:00:00.000Z',
    })
    repo.recordFailureRound('req-1', {
      roundId: 't1-formal-1',
      stage: 'formal_test',
      summary: '测试失败',
      occurredAt: '2026-11-04T00:10:00.000Z',
    })
    repo.recordFailureRound('req-1', {
      roundId: 'other-task-1',
      stage: 'verification',
      summary: '其他任务',
      occurredAt: '2026-11-04T00:20:00.000Z',
    })

    const data = dataOf(
      views().taskExecution({ reqId: 'req-1', taskId: 't1', planVersion: plan.planVersion }),
    )
    expect(data.reason).toBe('没有找到该任务的执行记录')
    expect(data.session.dev).toBe('')
    expect(data.events).toEqual([])
    expect(data.total).toBe(0)
    expect(data.truncated).toBe(false)
    expect(data.test.available).toBe(false)
    expect(data.attempts).toHaveLength(2)
    expect(data.attempts[0]).toMatchObject({
      attemptId: 'recent-recording',
      state: 'pending',
      available: false,
      reason: '没有找到该任务的执行记录文件 dev.jsonl',
    })
    expect(data.attempts[1]).toMatchObject({
      attemptId: 'round:t1-formal-1',
      state: 'failed',
      stage: 'formal_test',
      summary: '测试失败',
      reason: '历史失败轮次只保留摘要；该次独立执行记录未单独保留，不能伪造会话事件',
    })
    expect(data.stages[1]).toMatchObject({ id: 'review', available: true, verdict: 'block' })
    expect(data.stages[3]).toMatchObject({ id: 'delivery', delivered: false })
  })

  it('summarises only requirements submitted by the requested DSH session', () => {
    submitRequirement('req-s1', 'dsh-session:sess-1:req-s1')
    submitRequirement('req-s2', 'dsh-session:sess-2:req-s2')
    submitRequirement('req-s3', 'dsh-session:sess-1:req-s3')
    recordAnalysisFor('req-s1')
    const plan = viewPlan(1, [viewTask('t1')], { requirementId: 'req-s1' })
    repo.recordTaskPlan(plan)
    repo.recordPlanApproval({
      requirementId: 'req-s1',
      planVersion: 1,
      approvedBy: 'owner',
      source: 'owner',
      approvedAt: '2026-11-02T00:00:00.000Z',
    })
    repo.recordTaskArtifact({
      requirementId: 'req-s1',
      planVersion: 1,
      taskId: 't1',
      candidateSha256: 'cand',
      testEvidenceSha256: '',
      reviewSha256: '',
      acceptance: '通过',
      authorizationSource: '',
      recordedAt: '2026-11-02T01:00:00.000Z',
      baselineCommit: '',
    })

    const summary = views().sessionSummary('sess-1')
    expect(summary.sessionId).toBe('sess-1')
    expect(summary.generatedAt).toBe('2026-11-05T00:00:00.000Z')
    expect(summary.requirements.map((item) => item.reqId).sort()).toEqual(['req-s1', 'req-s3'])
    expect(summary.requirements.find((item) => item.reqId === 'req-s1')).toMatchObject({
      title: '需求 req-s1：给看板加过滤',
      status: 'draft',
      version: 1,
      updatedAt: '2026-11-01T00:00:00.000Z',
      goal: '看板可过滤',
      planVersion: 1,
      approved: true,
      delivered: 1,
      taskCount: 1,
    })
    expect(summary.requirements.find((item) => item.reqId === 'req-s3')).toMatchObject({
      goal: '',
      planVersion: null,
      approved: false,
      delivered: 0,
      taskCount: 0,
    })
    expect(views().sessionSummary('missing').requirements).toEqual([])
  })
})
