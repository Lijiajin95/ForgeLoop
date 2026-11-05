import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import type { Requirement, RequirementAnalysis } from '../src/domain/requirement.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import {
  boardTaskState,
  buildStatusBoard,
  requirementTitle,
  taskIdOfFailureRound,
} from '../src/runtime/board.js'

const PROJECT = 'demo'
const NOW = '2026-11-04T00:00:00.000Z'
let dir = ''
let database: Database
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-board-gap-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repository = new Repository(database)
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function submit(reqId: string, text = '需求标题'): void {
  repository.submit({
    reqId,
    project: PROJECT,
    text,
    submittedBy: 'owner',
    source: 'test',
    now: NOW,
  })
}

function analysis(_reqId: string): RequirementAnalysis {
  return {
    analysisVersion: 1,
    requirementVersion: 1,
    goal: '目标',
    scenarios: ['场景'],
    acceptanceCriteria: ['标准'],
    clarifications: [],
    createdAt: NOW,
  }
}

function plan(reqId: string): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}`,
    requirementId: reqId,
    project: PROJECT,
    planVersion: 1,
    requirementVersion: 1,
    tasks: [
      {
        taskId: 't1',
        goal: '一',
        files: ['docs/a.md'],
        acceptance: 'a',
        testCommand: ['true'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 1 },
        authorizationSource: '',
      },
      {
        taskId: 't10',
        goal: '十',
        files: ['docs/b.md'],
        acceptance: 'b',
        testCommand: ['true'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 1 },
        authorizationSource: '',
      },
    ],
    createdAt: NOW,
  }
}

function requirement(reqId: string, text: string): Requirement {
  return {
    reqId,
    project: PROJECT,
    status: 'draft',
    blockedReason: '',
    submittedBy: 'owner',
    source: 'test',
    versions: [{ version: 1, text, createdAt: NOW, revisedBy: 'owner', source: 'test' }],
  }
}

describe('title and task state helpers', () => {
  it('uses the latest version, first line and truncates long titles', () => {
    const short = requirement('r1', '第一行\n第二行')
    expect(requirementTitle(short)).toBe('第一行')
    const long = requirement('r2', 'x'.repeat(120))
    const title = requirementTitle(long)
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(81)
    const empty = requirement('r3', '   ')
    expect(requirementTitle(empty)).toBe('r3')
  })

  it('maps task run states and ask-user reasons', () => {
    expect(boardTaskState({ run: null, task: null } as never)).toBe('pending')
    expect(boardTaskState({ run: { state: 'running', reason: '' }, task: null } as never)).toBe(
      'running',
    )
    expect(
      boardTaskState({
        run: { state: 'running', reason: 'ask_user_question' },
        task: null,
      } as never),
    ).toBe('awaiting_input')
    expect(
      boardTaskState({
        run: { state: 'blocked', reason: 'ask_user_question' },
        task: null,
      } as never),
    ).toBe('blocked')
    expect(
      boardTaskState({ run: { state: 'blocked', reason: '缺少批准' }, task: null } as never),
    ).toBe('blocked')
    expect(
      boardTaskState({ delivered: true, run: { state: 'delivered', reason: '' } } as never),
    ).toBe('delivered')
    expect(
      boardTaskState({ delivered: false, run: { state: 'delivered', reason: '' } } as never),
    ).toBe('pending')
  })

  it('maps failure round ids to the longest matching task prefix', () => {
    const p = plan('r1')
    expect(taskIdOfFailureRound(p, 't1-123')).toBe('t1')
    expect(taskIdOfFailureRound(p, 't10-123')).toBe('t10')
    expect(taskIdOfFailureRound(p, 'unknown-1')).toBeUndefined()
    expect(taskIdOfFailureRound(null, 't1-1')).toBeUndefined()
  })
})

describe('board query and limit', () => {
  it('filters by query, respects limit and hides terminal requirements', () => {
    submit('req-login', '实现登录')
    submit('req-logout', '实现退出')
    repository.recordAnalysis({ ...analysis('req-login'), reqId: 'req-login' })
    repository.recordTaskPlan(plan('req-login'))
    repository.setStatus('req-logout', 'cancelled')
    const all = buildStatusBoard({ repository, project: PROJECT, now: NOW })
    expect(all.requirements.map((item) => item.reqId).sort()).toEqual(['req-login', 'req-logout'])
    const filtered = buildStatusBoard({ repository, project: PROJECT, now: NOW, query: 'login' })
    expect(filtered.requirements.map((item) => item.reqId)).toEqual(['req-login'])
    const none = buildStatusBoard({ repository, project: PROJECT, now: NOW, query: '不存在' })
    expect(none.requirements).toEqual([])
    const limited = buildStatusBoard({ repository, project: PROJECT, now: NOW, limit: 1 })
    expect(limited.requirements).toHaveLength(1)
  })
})
