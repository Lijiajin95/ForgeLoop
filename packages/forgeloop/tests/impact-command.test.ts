import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildTools } from '../src/tools.js'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import type { PlannedTask, TaskPlan, TaskPlanApproval } from '../src/domain/task-plan.js'
import type { TaskArtifact } from '../src/domain/work.js'
import { INFERENCE_NOT_REQUESTED_NOTICE } from '../src/domain/impact-explain.js'

const T0 = '2026-10-22T00:00:00.000Z'
const T1 = '2026-10-22T00:10:00.000Z'

interface ImpactReason {
  readonly code: string
  readonly message: string
}

interface ImpactCheckView {
  readonly state: string
  readonly stale: boolean
  readonly pending: boolean
  readonly staleReasons: readonly ImpactReason[]
  readonly pendingReasons: readonly ImpactReason[]
}

interface DeliveryMaterialView {
  readonly candidateSha256: string
  readonly testEvidenceSha256: string
  readonly reviewSha256: string
  readonly baselineCommit: string
  readonly authorizationSource: string
  readonly acceptance: string
  readonly recordedAt: string
}

interface ImpactFactsView extends ImpactCheckView {
  readonly kind: 'facts'
  readonly reqId: string
  readonly status: string
  readonly latestRequirementVersion: number
  readonly requirementVersions: readonly {
    readonly version: number
    readonly createdAt: string
    readonly revisedBy: string
    readonly source: string
    readonly latest: boolean
  }[]
  readonly latestAnalysisVersion: number | null
  readonly latestPlanVersion: number | null
  readonly currentApprovalPlanVersion: number | null
  readonly analyses: readonly (ImpactCheckView & {
    readonly analysisVersion: number
    readonly requirementVersion: number
    readonly latest: boolean
  })[]
  readonly plans: readonly (ImpactCheckView & {
    readonly planVersion: number
    readonly requirementVersion: number
    readonly latest: boolean
    readonly tasks: readonly (ImpactCheckView & {
      readonly taskId: string
      readonly delivered: boolean
      readonly material: DeliveryMaterialView | null
    })[]
  })[]
  readonly approvals: readonly (ImpactCheckView & {
    readonly planVersion: number
    readonly requirementVersion: number | null
    readonly current: boolean
  })[]
  readonly currentApproval: (ImpactCheckView & {
    readonly planVersion: number
    readonly requirementVersion: number | null
  }) | null
  readonly deliveries: readonly (ImpactCheckView & {
    readonly planVersion: number
    readonly taskId: string
    readonly material: DeliveryMaterialView
  })[]
  readonly requests: readonly (ImpactCheckView & {
    readonly requestId: string
    readonly action: string
    readonly requestState: string
    readonly planVersion: number
  })[]
  readonly coverage: {
    readonly analyzed: boolean
    readonly planned: boolean
    readonly approved: boolean
    readonly fullyDelivered: boolean
  }
  readonly summary: {
    readonly requirementVersions: number
    readonly analyses: number
    readonly plans: number
    readonly approvals: number
    readonly deliveredTasks: number
    readonly requests: number
    readonly gaps: number
    readonly staleItems: number
    readonly pendingItems: number
  }
}

interface ImpactInferenceView {
  readonly kind: 'inference'
  readonly title: string
  readonly label: string
  readonly provenance: string
  readonly inference: true
  readonly status: string
  readonly text: string
  readonly reason: string
  readonly sessionId: string | null
  readonly toolCalls: readonly string[]
  readonly disclaimer: string
}

interface ImpactDataView {
  readonly kind: 'impact-explain'
  readonly reqId: string
  readonly explainRequested: boolean
  readonly facts: ImpactFactsView
  readonly inference: ImpactInferenceView | null
  readonly sections: readonly { readonly kind: 'facts' | 'inference' }[]
  readonly notice: string
}

interface ToolResultView {
  readonly ok: boolean
  readonly text: string
  readonly data?: ImpactDataView
}

interface RecordingRunner {
  readonly calls: AgentRunRequest[]
  readonly runner: AgentLike
}

function recordingRunner(text = '分析 v1 已过期，建议优先重新分析；任务包 v1 可能需要返工。'): RecordingRunner {
  const calls: AgentRunRequest[] = []
  return {
    calls,
    runner: {
      async run(request): Promise<AgentRunResult> {
        calls.push(request)
        return {
          status: 'completed',
          text,
          sessionId: 'session-impact',
          reason: '',
          transcriptPath: request.transcriptPath,
          durationMs: 1,
          toolCalls: [],
        }
      },
    },
  }
}

let dir = ''
let runtime: ForgeLoopRuntime
let recorder: RecordingRunner

function makeRuntime(runner: AgentLike): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config, runner })
}

async function impact(
  reqId: string,
  explain = false,
): Promise<{ kind: 'success' | 'error'; text: string; data: ImpactDataView }> {
  const outcome = await runtime.impact(reqId, { explain })
  expect(outcome.ok, outcome.message).toBe(true)
  return {
    kind: outcome.ok ? 'success' : 'error',
    text: outcome.message,
    data: outcome.data as ImpactDataView,
  }
}

async function impactTool(args: Record<string, unknown>): Promise<ToolResultView> {
  const definition = buildTools(runtime, runtime.config).find(
    (tool) => tool.name === 'forgeloop_impact',
  )
  expect(definition, 'forgeloop_impact must be registered').toBeDefined()
  return (await definition!.execute(args, {})) as ToolResultView
}

function submitRequirement(): string {
  const submitted = runtime.submit({ text: '增加需求修订影响摘要', by: 'owner', source: 'test' })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

function reviseRequirement(reqId: string): void {
  const revised = runtime.revise({
    reqId,
    text: '增加需求修订影响摘要，并标出过期事实',
    by: 'owner',
    source: 'test-revise',
  })
  expect(revised.ok, revised.message).toBe(true)
}

function recordAnalysis(reqId: string, analysisVersion: number, requirementVersion: number): void {
  runtime.repo.recordAnalysis({
    reqId,
    analysisVersion,
    requirementVersion,
    goal: `分析 v${analysisVersion}`,
    scenarios: ['查看影响摘要'],
    acceptanceCriteria: ['事实区标注过期与待核对'],
    clarifications: [],
    createdAt: T0,
  })
}

function task(taskId: string, dependsOn: string[] = []): PlannedTask {
  return {
    taskId,
    goal: `完成 ${taskId}`,
    files: [`packages/forgeloop/src/${taskId}.ts`],
    acceptance: `${taskId} 可用`,
    testCommand: ['node', '-e', 'process.exit(0)'],
    dependsOn,
    limits: { limitSeconds: 7200, maxFailureRounds: 3 },
    authorizationSource: '',
  }
}

function recordPlan(
  reqId: string,
  planVersion: number,
  requirementVersion: number,
  tasks: PlannedTask[],
): TaskPlan {
  const plan: TaskPlan = {
    taskPlanId: `plan-${reqId}-${planVersion}`,
    requirementId: reqId,
    project: 'testproj',
    planVersion,
    requirementVersion,
    tasks,
    createdAt: T0,
  }
  runtime.repo.recordTaskPlan(plan)
  return plan
}

function recordApproval(reqId: string, planVersion: number): TaskPlanApproval {
  const approval: TaskPlanApproval = {
    requirementId: reqId,
    planVersion,
    approvedBy: 'owner',
    approvedAt: T1,
    source: 'dsh-command:test',
  }
  runtime.repo.recordPlanApproval(approval)
  return approval
}

function recordDelivery(reqId: string, planVersion: number, taskId: string): TaskArtifact {
  const artifact = {
    requirementId: reqId,
    planVersion,
    taskId,
    candidateSha256: 'a'.repeat(64),
    testEvidenceSha256: 'b'.repeat(64),
    reviewSha256: 'c'.repeat(64),
    acceptance: `${taskId} 可用`,
    authorizationSource: `plan-approval:${reqId}:v${planVersion}:owner`,
    recordedAt: T1,
    baselineCommit: 'abc1234',
  }
  runtime.repo.recordTaskArtifact(artifact)
  runtime.repo.recordEvidence({
    requirementId: reqId,
    planVersion,
    taskId,
    baselineCommit: 'abc1234',
    workspacePath: `/tmp/${taskId}`,
    candidatePath: `/tmp/${taskId}/candidate.diff`,
    testLogPath: `/tmp/${taskId}/formal-test.log`,
    reviewPath: `/tmp/${taskId}/review.json`,
    devSession: 'session-dev',
    reviewSession: 'session-review',
    recordedAt: T1,
  })
  return artifact
}

function recordRequest(reqId: string, requestId: string, state: 'done' | 'failed'): void {
  runtime.repo.recordRequest({
    requestId,
    reqId,
    project: 'testproj',
    planVersion: 1,
    action: 'advance',
    requestedBy: 'owner',
    source: 'test',
    now: T1,
  })
  runtime.repo.resolveRequest(requestId, state, state, T1)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-impact-command-'))
  recorder = recordingRunner()
  runtime = makeRuntime(recorder.runner)
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('forgeloop_impact: requirement revision is stale', () => {
  it('shows all versions, basis versions, delivery materials and stale/pending marks on the tool surface', async () => {
    const reqId = submitRequirement()
    recordAnalysis(reqId, 1, 1)
    recordPlan(reqId, 1, 1, [task('a'), task('b', ['a'])])
    recordApproval(reqId, 1)
    recordDelivery(reqId, 1, 'a')
    recordRequest(reqId, 'rq-done', 'done')
    reviseRequirement(reqId)

    const output = await impact(reqId)
    const facts = output.data.facts

    expect(output.data.kind).toBe('impact-explain')
    expect(output.data.explainRequested).toBe(false)
    expect(output.data.inference).toBeNull()
    expect(output.data.sections.map((section) => section.kind)).toEqual(['facts'])
    expect(output.data.notice).toBe(INFERENCE_NOT_REQUESTED_NOTICE)
    expect(output.text).toContain('未请求推断')
    expect(output.text).toContain('未调用任何模型')

    expect(facts.kind).toBe('facts')
    expect(facts.reqId).toBe(reqId)
    expect(facts.latestRequirementVersion).toBe(2)
    expect(facts.requirementVersions).toEqual([
      {
        version: 1,
        createdAt: expect.any(String),
        revisedBy: 'owner',
        source: 'test',
        latest: false,
      },
      {
        version: 2,
        createdAt: expect.any(String),
        revisedBy: 'owner',
        source: 'test-revise',
        latest: true,
      },
    ])

    expect(facts.analyses[0]).toMatchObject({
      analysisVersion: 1,
      requirementVersion: 1,
      latest: true,
      stale: true,
    })
    expect(facts.analyses[0]?.staleReasons.map((reason) => reason.code)).toContain(
      'analysis_requirement_stale',
    )

    expect(facts.plans[0]).toMatchObject({
      planVersion: 1,
      requirementVersion: 1,
      latest: true,
      stale: true,
    })
    expect(facts.plans[0]?.tasks.map((item) => item.taskId)).toEqual(['a', 'b'])
    expect(facts.plans[0]?.tasks[0]).toMatchObject({ taskId: 'a', delivered: true, stale: true })
    expect(facts.plans[0]?.tasks[1]).toMatchObject({ taskId: 'b', delivered: false, pending: true })
    expect(facts.plans[0]?.tasks[1]?.pendingReasons.map((reason) => reason.code)).toContain(
      'task_not_delivered',
    )

    expect(facts.currentApproval).toMatchObject({
      planVersion: 1,
      requirementVersion: 1,
      current: true,
      stale: true,
    })
    expect(facts.currentApprovalPlanVersion).toBe(1)

    expect(facts.deliveries).toHaveLength(1)
    expect(facts.deliveries[0]).toMatchObject({ planVersion: 1, taskId: 'a', stale: true })
    expect(facts.deliveries[0]?.material).toEqual({
      candidateSha256: 'a'.repeat(64),
      testEvidenceSha256: 'b'.repeat(64),
      reviewSha256: 'c'.repeat(64),
      baselineCommit: 'abc1234',
      authorizationSource: `plan-approval:${reqId}:v1:owner`,
      acceptance: 'a 可用',
      recordedAt: T1,
    })

    expect(facts.requests[0]).toMatchObject({
      requestId: 'rq-done',
      requestState: 'done',
      pending: false,
    })
    expect(facts.state).toBe('stale_pending')
    expect(facts.stale).toBe(true)
    expect(facts.pending).toBe(true)
    const tool = await impactTool({ req_id: reqId })
    expect(tool.ok, tool.text).toBe(true)
    expect(tool.data).toEqual(output.data)
    expect(tool.text).toContain('未请求推断')

    // 默认路径完全不调用模型，即使已配置执行器。
    expect(recorder.calls).toEqual([])
  })
})

describe('forgeloop_impact: requirement is still valid', () => {
  it('reports a current, fully delivered requirement without stale or pending items on the tool surface', async () => {
    const reqId = submitRequirement()
    recordAnalysis(reqId, 1, 1)
    recordPlan(reqId, 1, 1, [task('a'), task('b', ['a'])])
    recordApproval(reqId, 1)
    recordDelivery(reqId, 1, 'a')
    recordDelivery(reqId, 1, 'b')
    recordRequest(reqId, 'rq-done', 'done')

    const output = await impact(reqId)
    const facts = output.data.facts

    expect(output.data.explainRequested).toBe(false)
    expect(output.data.notice).toContain('未请求推断')
    expect(facts.state).toBe('current')
    expect(facts.stale).toBe(false)
    expect(facts.pending).toBe(false)
    expect(facts.staleReasons).toEqual([])
    expect(facts.pendingReasons).toEqual([])
    expect(facts.coverage).toEqual({
      analyzed: true,
      planned: true,
      approved: true,
      fullyDelivered: true,
    })
    expect(facts.summary).toMatchObject({
      requirementVersions: 1,
      analyses: 1,
      plans: 1,
      approvals: 1,
      deliveredTasks: 2,
      requests: 1,
      gaps: 0,
    })
    expect(facts.currentApproval).toMatchObject({
      planVersion: 1,
      requirementVersion: 1,
      stale: false,
      pending: false,
    })
    expect(facts.plans[0]?.tasks.every((item) => item.delivered && item.state === 'current')).toBe(
      true,
    )

    const tool = await impactTool({ req_id: reqId })
    expect(tool.ok, tool.text).toBe(true)
    expect(tool.data).toEqual(output.data)
    expect(recorder.calls).toEqual([])
  })
})

describe('forgeloop_impact: requirement was never planned', () => {
  it('returns the deterministic gap facts instead of failing, on the tool surface', async () => {
    const reqId = submitRequirement()

    const output = await impact(reqId)
    const facts = output.data.facts

    expect(output.kind).toBe('success')
    expect(output.data.explainRequested).toBe(false)
    expect(output.data.inference).toBeNull()
    expect(facts.requirementVersions).toHaveLength(1)
    expect(facts.analyses).toEqual([])
    expect(facts.plans).toEqual([])
    expect(facts.approvals).toEqual([])
    expect(facts.deliveries).toEqual([])
    expect(facts.requests).toEqual([])
    expect(facts.currentApproval).toBeNull()
    expect(facts.latestAnalysisVersion).toBeNull()
    expect(facts.latestPlanVersion).toBeNull()
    expect(facts.currentApprovalPlanVersion).toBeNull()
    expect(facts.coverage).toEqual({
      analyzed: false,
      planned: false,
      approved: false,
      fullyDelivered: false,
    })
    expect(facts.state).toBe('pending')
    expect(facts.pendingReasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        'requirement_analysis_missing',
        'requirement_plan_missing',
        'requirement_approval_missing',
      ]),
    )

    const tool = await impactTool({ req_id: reqId })
    expect(tool.ok, tool.text).toBe(true)
    expect(tool.data).toEqual(output.data)
    expect(recorder.calls).toEqual([])
  })
})

describe('forgeloop_impact explain', () => {
  it('calls one tool-less Agent and separates marked inference from deterministic facts', async () => {
    const reqId = submitRequirement()
    recordAnalysis(reqId, 1, 1)
    recordPlan(reqId, 1, 1, [task('a'), task('b', ['a'])])
    recordApproval(reqId, 1)
    recordDelivery(reqId, 1, 'a')
    recordDelivery(reqId, 1, 'b')

    const plain = await impact(reqId)
    const explained = await impact(reqId, true)
    const data = explained.data

    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]).toMatchObject({ role: 'product', tools: 'none' })
    expect(recorder.calls[0]?.prompt).toContain(reqId)
    expect(recorder.calls[0]?.prompt).toContain('确定性事实 JSON')

    expect(data.explainRequested).toBe(true)
    expect(data.facts).toEqual(plain.data.facts)
    expect(data.inference).toMatchObject({
      kind: 'inference',
      provenance: 'model-inference',
      inference: true,
      status: 'completed',
      sessionId: 'session-impact',
    })
    expect(data.inference?.title).toContain('推断')
    expect(data.inference?.label).toContain('推断')
    expect(data.inference?.text).toContain('分析 v1 已过期')
    expect(data.notice).toContain('已请求推断')
    expect(data.sections.map((section) => section.kind)).toEqual(['facts', 'inference'])
    expect(data.sections[1]?.kind).toBe('inference')
    expect(explained.text).toContain('模型推断')
    expect(explained.text).toContain('不是确定事实')

    const tool = await impactTool({ req_id: reqId, explain: true })
    expect(tool.ok, tool.text).toBe(true)
    expect(tool.data?.explainRequested).toBe(true)
    expect(tool.data?.facts).toEqual(plain.data.facts)
    expect(tool.data?.inference?.label).toContain('推断')
    expect(tool.data?.sections.map((section) => section.kind)).toEqual(['facts', 'inference'])
    expect(recorder.calls).toHaveLength(2)
    expect(recorder.calls.every((call) => call.tools === 'none')).toBe(true)
  })
})

describe('forgeloop_impact is read-only', () => {
  it('is registered without approval/advance/accept tools and does not mutate records', async () => {
    const reqId = submitRequirement()
    recordAnalysis(reqId, 1, 1)
    recordPlan(reqId, 1, 1, [task('a'), task('b', ['a'])])
    recordApproval(reqId, 1)
    recordDelivery(reqId, 1, 'a')
    recordDelivery(reqId, 1, 'b')

    const names = buildTools(runtime, runtime.config).map((tool) => tool.name)
    expect(names).toContain('forgeloop_impact')
    expect(names.filter((name) => /approve|advance|accept/i.test(name))).toEqual([])

    const before = {
      requirement: runtime.repo.getRequirement(reqId),
      approval: runtime.repo.latestPlanApproval(reqId),
      requests: runtime.repo.requestsFor(reqId),
      artifacts: runtime.repo.taskArtifacts(reqId, 1),
    }

    const tool = await impactTool({ req_id: reqId })
    expect(tool.ok, tool.text).toBe(true)

    expect(runtime.repo.getRequirement(reqId)).toEqual(before.requirement)
    expect(runtime.repo.latestPlanApproval(reqId)).toEqual(before.approval)
    expect(runtime.repo.requestsFor(reqId)).toEqual(before.requests)
    expect(runtime.repo.taskArtifacts(reqId, 1)).toEqual(before.artifacts)

    const missing = await impactTool({ req_id: 'req-missing' })
    expect(missing.ok).toBe(false)
    expect(missing.text).toContain('未找到需求')
  })
})