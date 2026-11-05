import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { buildStatusBoard, buildProjectFacts } from '../src/runtime/board.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

const PROJECT = 'demo'
const NOW = '2026-11-06T00:00:00.000Z'
let dir = ''
let database: Database
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-board-deep-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repository = new Repository(database)
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function submit(reqId: string, text: string): void {
  repository.submit({
    reqId,
    project: PROJECT,
    text,
    submittedBy: 'owner',
    source: 'test',
    now: NOW,
  })
}

function plan(reqId: string): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}`,
    requirementId: reqId,
    project: PROJECT,
    planVersion: 1,
    requirementVersion: 1,
    technicalSolution: { summary: '方案摘要', approach: ['步骤一'], risks: ['风险一'] },
    tasks: [
      {
        taskId: 't1',
        goal: '文档任务',
        files: ['docs/a.md'],
        acceptance: '文档存在',
        testCommand: ['true'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 1 },
        authorizationSource: '',
      },
      {
        taskId: 't2',
        goal: '代码任务',
        files: ['packages/forgeloop/src/x.ts'],
        acceptance: '代码通过',
        testCommand: ['false'],
        dependsOn: ['t1'],
        limits: { limitSeconds: 60, maxFailureRounds: 1 },
        authorizationSource: '',
      },
    ],
    createdAt: NOW,
  }
}

describe('board query matching', () => {
  it('matches requirement text, analysis, plan, task, run, round and request fields', () => {
    submit('req-1', '实现搜索命中')
    repository.recordAnalysis({
      reqId: 'req-1',
      analysisVersion: 1,
      requirementVersion: 1,
      goal: '目标-阿尔法',
      scenarios: ['场景-贝塔'],
      businessRules: ['规则-伽马'],
      exceptions: ['异常-德尔塔'],
      nonGoals: ['非目标-艾普西龙'],
      acceptanceCriteria: ['标准-泽塔'],
      clarifications: [],
      createdAt: NOW,
    })
    repository.recordTaskPlan(plan('req-1'))
    repository.recordFailureRound('req-1', {
      roundId: 't1-1',
      stage: 'formal_test',
      summary: '轮次-伊塔',
      occurredAt: NOW,
    })
    for (const query of ['目标-阿尔法', '场景-贝塔', '规则-伽马', '异常-德尔塔', '标准-泽塔']) {
      expect(
        buildStatusBoard({ repository, project: PROJECT, now: NOW, query }).requirements,
      ).toHaveLength(1)
    }
    for (const query of [
      '非目标-艾普西龙',
      '方案摘要',
      '步骤一',
      '风险一',
      '文档任务',
      'docs/a.md',
      '代码通过',
    ]) {
      expect(
        buildStatusBoard({ repository, project: PROJECT, now: NOW, query }).requirements,
      ).toHaveLength(1)
    }
    expect(
      buildStatusBoard({ repository, project: PROJECT, now: NOW, query: '轮次-伊塔' }).requirements,
    ).toHaveLength(1)
    expect(
      buildStatusBoard({ repository, project: PROJECT, now: NOW, query: '不存在-欧米伽' })
        .requirements,
    ).toHaveLength(0)
  })

  it('counts only non-terminal, non-draft requirements as active', () => {
    submit('req-draft', '草稿需求')
    submit('req-blocked', '阻塞需求')
    repository.setStatus('req-blocked', 'blocked', '等批准')
    submit('req-done', '完成需求')
    repository.setStatus('req-done', 'accepted')
    const board = buildStatusBoard({ repository, project: PROJECT, now: NOW, limit: 10 })
    expect(board.summary.requirements).toBe(3)
    expect(board.summary.active).toBe(1)
    expect(board.requirements.map((item) => item.reqId).sort()).toEqual([
      'req-blocked',
      'req-done',
      'req-draft',
    ])
    const filtered = buildStatusBoard({ repository, project: PROJECT, now: NOW, query: '阻塞' })
    expect(filtered.summary.requirements).toBe(1)
    expect(filtered.summary.active).toBe(1)
  })

  it('clamps limit and marks truncation', () => {
    for (let index = 0; index < 3; index += 1) submit(`req-${index}`, `需求 ${index}`)
    const limited = buildStatusBoard({ repository, project: PROJECT, now: NOW, limit: 2 })
    expect(limited.limit).toBe(2)
    expect(limited.truncated).toBe(true)
    expect(limited.requirements).toHaveLength(2)
    expect(limited.tasks.every((task) => task.reqId !== undefined)).toBe(true)
    const clamped = buildStatusBoard({ repository, project: PROJECT, now: NOW, limit: 0 })
    expect(clamped.limit).toBe(1)
    const huge = buildStatusBoard({ repository, project: PROJECT, now: NOW, limit: 10_000 })
    expect(huge.limit).toBe(100)
    expect(huge.truncated).toBe(false)
  })
})

describe('project facts history', () => {
  it('summarises limit, tasks and terminal counts', () => {
    submit('req-a', '需求 A')
    repository.recordTaskPlan(plan('req-a'))
    submit('req-b', '需求 B')
    submit('req-c', '需求 C')
    repository.setStatus('req-c', 'cancelled')
    const facts = buildProjectFacts({ repository, project: PROJECT, now: NOW, limit: 1 })
    expect(facts.total).toBe(2)
    expect(facts.terminal).toBe(1)
    expect(facts.listed).toBe(1)
    expect(facts.notListed).toBe(1)
    expect(facts.requirements[0]?.planVersion).toBe(1)
    expect(facts.requirements[0]?.taskCount).toBe(2)
    expect(facts.requirements[0]?.tasks.length).toBeLessThanOrEqual(8)
    const withCurrent = buildProjectFacts({
      repository,
      project: PROJECT,
      now: NOW,
      limit: 1,
      currentReqId: 'req-b',
    })
    expect(withCurrent.requirements[0]?.reqId).toBe('req-b')
    expect(withCurrent.requirements[0]?.current).toBe(true)
  })
})
