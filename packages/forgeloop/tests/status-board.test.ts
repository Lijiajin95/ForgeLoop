import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { MAX_ROUNDS_PER_GRANT } from '../src/domain/counting.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import {
  BOARD_TASK_DELIVERED,
  BOARD_TASK_PENDING,
  buildStatusBoard,
  requirementTitle,
} from '../src/runtime/board.js'

const PROJECT = 'forgeloop'
const NOW = '2026-10-23T10:00:00.000Z'

let dir = ''
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-board-'))
  repository = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function submit(reqId: string, text = '状态看板', createdAt = '2026-10-23T00:00:00.000Z'): string {
  repository.submit({
    reqId,
    project: PROJECT,
    text,
    submittedBy: 'owner',
    source: 'test',
    now: createdAt,
  })
  return reqId
}

function plan(reqId: string, planVersion = 1, requirementVersion = 1): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}-${planVersion}`,
    requirementId: reqId,
    project: PROJECT,
    planVersion,
    requirementVersion,
    createdAt: '2026-10-23T00:00:01.000Z',
    tasks: [
      {
        taskId: 't1',
        goal: '写文档',
        files: ['docs/a.md'],
        acceptance: 'a 存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
      {
        taskId: 't2',
        goal: '补测试',
        files: ['docs/b.md'],
        acceptance: 'b 存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: ['t1'],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
    ],
  }
}

function deliver(reqId: string, taskId: string, planVersion = 1): void {
  repository.recordTaskArtifact({
    requirementId: reqId,
    planVersion,
    taskId,
    candidateSha256: `candidate-${taskId}`,
    testEvidenceSha256: `test-${taskId}`,
    reviewSha256: `review-${taskId}`,
    acceptance: '达成',
    authorizationSource: `plan-approval:${reqId}:v${planVersion}:owner`,
    recordedAt: NOW,
    baselineCommit: 'abc123',
  })
}

function analyze(reqId: string, clarifications: string[], analysisVersion = 1): void {
  repository.recordAnalysis({
    reqId,
    analysisVersion,
    requirementVersion: 1,
    goal: '目标',
    scenarios: ['场景'],
    acceptanceCriteria: ['标准'],
    clarifications,
    createdAt: '2026-10-23T00:00:02.000Z',
  })
}

function board(limit?: number) {
  return buildStatusBoard({ repository, project: PROJECT, now: NOW, limit })
}

describe('status board', () => {
  it('reports an empty project without inventing entries', () => {
    const view = board()
    expect(view.project).toBe(PROJECT)
    expect(view.generatedAt).toBe(NOW)
    expect(view.summary).toEqual({ requirements: 0, active: 0, tasks: 0, delivered: 0, issues: 0, blocking: 0 })
    expect(view.requirements).toEqual([])
    expect(view.tasks).toEqual([])
    expect(view.issues).toEqual([])
  })

  it('lists a requirement before planning with explicit gaps instead of guessed state', () => {
    submit('req-1', '给会话区加一个需求页')
    const view = board()
    expect(view.requirements).toHaveLength(1)
    const requirement = view.requirements[0]!
    expect(requirement.status).toBe('draft')
    expect(requirement.planVersion).toBeNull()
    expect(requirement.approval).toBe('none')
    expect(requirement.progress.total).toBe(0)
    expect(requirement.title).toBe('给会话区加一个需求页')
    expect(view.tasks).toEqual([])
  })

  it('derives task state from artifacts and task runs, not from requirement status alone', () => {
    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId))
    repository.setStatus(reqId, 'executing')
    deliver(reqId, 't1')

    const view = board()
    expect(view.tasks.map((task) => [task.taskId, task.state])).toEqual([
      ['t1', BOARD_TASK_DELIVERED],
      ['t2', BOARD_TASK_PENDING],
    ])
    expect(view.requirements[0]!.progress).toMatchObject({ total: 2, delivered: 1, pending: 1 })
    expect(view.summary.delivered).toBe(1)
  })

  it('surfaces a failed task run as a failed task and a failure-round issue', () => {
    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId))
    repository.setStatus(reqId, 'executing')
    repository.recordTaskRun({
      requirementId: reqId,
      planVersion: 1,
      taskId: 't1',
      state: 'failed',
      reason: '正式测试退出码 1',
      executedSeconds: 12,
      updatedAt: NOW,
    })
    repository.recordFailureRound(reqId, {
      roundId: 'round-1',
      stage: 'formal_test',
      summary: '正式测试退出码 1',
      occurredAt: NOW,
    })

    const view = board()
    expect(view.tasks[0]!.state).toBe('failed')
    expect(view.requirements[0]!.progress.failed).toBe(1)
    const issue = view.issues.find((candidate) => candidate.kind === 'failure_round')
    expect(issue).toMatchObject({ reqId, severity: 'attention', title: '正式测试退出码 1' })
    expect(issue?.detail).toContain(String(MAX_ROUNDS_PER_GRANT - 1))
  })

  it('blocks once the automatic failure-round budget is exhausted', () => {
    const reqId = submit('req-1')
    for (let index = 0; index < MAX_ROUNDS_PER_GRANT; index += 1) {
      repository.recordFailureRound(reqId, {
        roundId: `round-${index}`,
        stage: 'formal_test',
        summary: `第 ${index + 1} 轮失败`,
        occurredAt: `2026-10-23T0${index}:00:00.000Z`,
      })
    }
    const view = board()
    const requirement = view.requirements[0]!
    expect(requirement.remainingRounds).toBe(0)
    const issue = view.issues.find((candidate) => candidate.kind === 'failure_round')
    expect(issue?.severity).toBe('blocking')
    expect(issue?.title).toBe(`第 ${MAX_ROUNDS_PER_GRANT} 轮失败`)
    expect(view.summary.blocking).toBe(1)
  })

  it('turns analysis clarifications into blocking issues and waits for an answer', () => {
    const reqId = submit('req-1')
    analyze(reqId, ['看板展示哪些项目？', '是否需要手动刷新？'])
    repository.setStatus(reqId, 'awaiting_clarification')

    const view = board()
    const clarifications = view.issues.filter((issue) => issue.kind === 'clarification')
    expect(clarifications).toHaveLength(2)
    expect(new Set(clarifications.map((issue) => issue.issueId)).size).toBe(2)
    expect(clarifications.every((issue) => issue.severity === 'blocking')).toBe(true)
    expect(view.requirements[0]!.clarifications).toBe(2)
  })

  it('shows a proposed plan waiting for approval without treating it as approved', () => {
    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId))
    repository.setStatus(reqId, 'plan_proposed')

    const view = board()
    expect(view.requirements[0]!.approval).toBe('missing')
    const issue = view.issues.find((candidate) => candidate.kind === 'approval')
    expect(issue).toMatchObject({ reqId, severity: 'attention', title: '任务包 v1 待批准' })
  })

  it('marks an approval for an older plan version as stale', () => {
    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId, 1))
    repository.setStatus(reqId, 'executing')
    repository.recordTaskPlan(plan(reqId, 2))
    repository.setStatus(reqId, 'plan_proposed')
    repository.recordPlanApproval({
      requirementId: reqId,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-23T00:00:03.000Z',
      source: 'test',
    })

    const view = board()
    expect(view.requirements[0]!.planVersion).toBe(2)
    expect(view.requirements[0]!.approval).toBe('stale')
    const issue = view.issues.find((candidate) => candidate.kind === 'approval')
    expect(issue?.detail).toContain('旧版本批准不能驱动新任务包')
  })

  it('reports blocked requirements with the recorded reason', () => {
    const reqId = submit('req-1')
    repository.setStatus(reqId, 'blocked', '正式测试连续失败，等待人工核对')

    const view = board()
    const issue = view.issues.find((candidate) => candidate.kind === 'blocked')
    expect(issue).toMatchObject({
      reqId,
      severity: 'blocking',
      title: '正式测试连续失败，等待人工核对',
    })
  })

  it('distinguishes an unknown request from a failed one', () => {
    const reqId = submit('req-1')
    repository.recordRequest({
      requestId: 'request-1',
      reqId,
      project: PROJECT,
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    repository.resolveRequest('request-1', 'unknown', '宿主中断', NOW)

    const unknownView = board()
    const unknownIssue = unknownView.issues.find((issue) => issue.kind === 'request')
    expect(unknownIssue).toMatchObject({ severity: 'blocking', title: '推进请求结果未知' })
    expect(unknownIssue?.detail).toContain('不盲目重放')

    repository.recordRequest({
      requestId: 'request-2',
      reqId,
      project: PROJECT,
      planVersion: 1,
      action: 'analyze',
      requestedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    repository.resolveRequest('request-2', 'failed', '执行器异常', NOW)
    const failedView = board()
    const failedIssue = failedView.issues.find((issue) => issue.title.includes('分析'))
    expect(failedIssue).toMatchObject({ severity: 'attention', title: '分析请求失败' })
  })

  it('keeps accepted requirements visible while dropping their resolved issues', () => {
    const reqId = submit('req-1')
    repository.recordTaskPlan(plan(reqId))
    deliver(reqId, 't1')
    deliver(reqId, 't2')
    repository.setStatus(reqId, 'accepted')
    repository.recordFailureRound(reqId, {
      roundId: 'round-old',
      stage: 'formal_test',
      summary: '历史失败',
      occurredAt: NOW,
    })

    const view = board()
    expect(view.requirements[0]!.status).toBe('accepted')
    expect(view.requirements[0]!.progress.delivered).toBe(2)
    expect(view.issues).toEqual([])
  })

  it('limits listed requirements while summary counts the whole project', () => {
    submit('req-a', '第一条', '2026-10-23T00:00:00.000Z')
    submit('req-b', '第二条', '2026-10-23T00:01:00.000Z')
    submit('req-c', '第三条', '2026-10-23T00:02:00.000Z')

    const view = board(2)
    expect(view.requirements.map((requirement) => requirement.reqId)).toEqual(['req-c', 'req-b'])
    expect(view.summary.requirements).toBe(3)
  })

  it('orders blocking issues before attention ones regardless of time', () => {
    const reqId = submit('req-1')
    analyze(reqId, ['需要澄清'], 1)
    repository.setStatus(reqId, 'blocked', '阻塞原因')
    repository.recordFailureRound(reqId, {
      roundId: 'round-1',
      stage: 'formal_test',
      summary: '较新的失败轮次',
      occurredAt: '2026-10-23T09:00:00.000Z',
    })
    const view = board()
    expect(view.issues.map((issue) => issue.severity)).toEqual(['blocking', 'blocking', 'attention'])
    expect(view.issues[2]!.kind).toBe('failure_round')
  })

  it('truncates long titles without rewriting the stored requirement text', () => {
    const long = `第一行 ${'很长的需求描述'.repeat(20)}\n第二行不参与标题`
    submit('req-1', long)
    const view = board()
    expect(view.requirements[0]!.title.length).toBe(81)
    expect(view.requirements[0]!.title.endsWith('…')).toBe(true)
    const requirement = repository.getRequirement('req-1')!
    expect(requirementTitle({ ...requirement, versions: requirement.versions })).toContain('第一行')
    expect(requirement.versions[0]!.text).toBe(long.trim())
  })
})
