import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { ExecutionDev } from '../src/runtime/execution-dev.js'
import type { AgentSession, AgentTurnResult } from '../src/runtime/agent-runner.js'
import type { Requirement } from '../src/domain/requirement.js'
import type { PlannedTask, TaskPlan } from '../src/domain/task-plan.js'
import { classifyFailure } from '../src/domain/failure-classification.js'

const NOW = '2026-11-24T10:00:00.000Z'
const REQ_ID = 'req-autonomy'

let dir = ''
let repo: Repository
let requirement: Requirement
let task: PlannedTask
let plan: TaskPlan

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-autonomy-'))
  repo = new Repository(Database.open(join(dir, 'records.sqlite')))
  requirement = {
    reqId: REQ_ID,
    project: 'demo',
    status: 'developing',
    blockedReason: '',
    versions: [
      { version: 1, text: '实现导出', createdAt: NOW, revisedBy: 'owner', source: 'test' },
    ],
    submittedBy: 'owner',
    source: 'test',
  }
  task = {
    taskId: 't1',
    goal: '实现导出',
    files: ['src/export.ts'],
    acceptance: '导出文件包含列表',
    testCommand: ['node', '-e', 'process.exit(0)'],
    dependsOn: [],
    limits: { limitSeconds: -1, maxFailureRounds: -1 },
    authorizationSource: 'system-admission:test',
  }
  plan = {
    taskPlanId: 'plan-1',
    requirementId: REQ_ID,
    project: 'demo',
    planVersion: 1,
    requirementVersion: 1,
    tasks: [task],
    createdAt: NOW,
  }
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

function configWith(overrides: Record<string, unknown> = {}): ForgeLoopConfig {
  return resolveConfig(
    {
      project: 'demo',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      agent: { timeoutSeconds: 10 },
      ...overrides,
    },
    dir,
  )
}

function sessionReturning(
  results: readonly AgentTurnResult[],
): AgentSession & { prompts: string[] } {
  const queue = [...results]
  const prompts: string[] = []
  return {
    sessionId: 'session-autonomy',
    prompts,
    async send(turn) {
      prompts.push(turn.prompt)
      return (
        queue.shift() ?? {
          status: 'completed',
          text: '{}',
          sessionId: 'session-autonomy',
          reason: '',
          transcriptPath: turn.transcriptPath,
          durationMs: 1,
          toolCalls: [],
        }
      )
    },
    async close() {},
  }
}

function completed(text: string): AgentTurnResult {
  return {
    status: 'completed',
    text,
    sessionId: 'session-autonomy',
    reason: '',
    transcriptPath: 'transcript.jsonl',
    durationMs: 1,
    toolCalls: [],
  }
}

function failed(reason: string): AgentTurnResult {
  return {
    status: 'error',
    text: '',
    sessionId: 'session-autonomy',
    reason,
    transcriptPath: 'transcript.jsonl',
    durationMs: 1,
    toolCalls: [],
  }
}

function devWith(
  config: ForgeLoopConfig,
  options: { formalTest?: unknown; sleep?: (ms: number) => Promise<void> } = {},
): ExecutionDev {
  return new ExecutionDev({
    config,
    repo,
    now: () => NOW,
    recordRun: () => undefined,
    previousTaskFailure: () => '',
    formalTest: (options.formalTest ??
      (() => {
        throw new Error('formal test must not run')
      })) as never,
    existingPackages: () => [],
    ctx: {},
    authorizedPlan: (value) => value,
    applyDiffFile: () => ({ ok: true, detail: '' }),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  } as never)
}

describe('dev clarification counting', () => {
  it('records every product clarification with its requirement version', () => {
    repo.recordDevClarification({
      reqId: REQ_ID,
      requirementVersion: 2,
      question: '导出范围包含筛选结果吗',
      context: '已查文档与代码，无法确认业务预期',
      now: NOW,
    })
    repo.recordDevClarification({
      reqId: REQ_ID,
      requirementVersion: 3,
      question: '空列表时导出空文件还是报错',
      context: '',
      now: NOW,
    })

    expect(repo.devClarifications(REQ_ID)).toEqual([
      expect.objectContaining({
        seq: 1,
        requirementVersion: 2,
        question: '导出范围包含筛选结果吗',
      }),
      expect.objectContaining({
        seq: 2,
        requirementVersion: 3,
        question: '空列表时导出空文件还是报错',
      }),
    ])
    expect(repo.devClarificationCount(REQ_ID)).toBe(2)
    expect(repo.devClarificationCount('req-other')).toBe(0)
  })
})

describe('self-verification precheck', () => {
  it('blocks an insufficient self report before running the formal test or committing', async () => {
    const formalTest = vi.fn()
    const session = sessionReturning([
      completed(
        JSON.stringify({
          mode: 'self',
          risk: 'low',
          white_box: [],
          black_box: [],
          red_green: { required: false },
          reason: '直接自验',
        }),
      ),
    ])

    const outcome = await devWith(configWith(), { formalTest }).developTaskInSession({
      reqId: REQ_ID,
      requirement,
      plan,
      task,
      workspace: dir,
      session,
      authorizationSource: 'system-admission:test',
      inputKind: 'requirement',
      signal: new AbortController().signal,
    })

    expect(outcome).toMatchObject({ state: 'blocked' })
    expect(outcome.reason).toContain('研发自验证不足')
    expect(formalTest).not.toHaveBeenCalled()
    expect(repo.taskArtifact(REQ_ID, 1, 't1')).toBeNull()
  })
})

describe('transient failure classification', () => {
  it('separates retryable transport failures from configuration or quota failures', () => {
    for (const reason of [
      '请求超时：ETIMEDOUT',
      'fetch failed',
      'socket hang up',
      '429 Too Many Requests',
      '503 Service Unavailable',
      'read ECONNRESET',
    ]) {
      expect(classifyFailure(reason), reason).toBe('transient')
    }
    for (const reason of [
      'spawn npm ENOENT',
      'You have insufficient credits to make this request',
      '需求已处于终态 cancelled',
      '研发自验证不足：缺少白盒或黑盒检查证据',
    ]) {
      expect(classifyFailure(reason), reason).toBe('fatal')
    }
  })

  it('retries a transient model turn without spending a task attempt', async () => {
    const sleep = vi.fn(async () => undefined)
    const report = JSON.stringify({
      mode: 'self',
      risk: 'low',
      white_box: [],
      black_box: [],
      red_green: { required: false },
      reason: '直接自验',
    })
    const session = sessionReturning([
      failed('请求超时：ETIMEDOUT'),
      failed('socket hang up'),
      completed(report),
    ])

    const outcome = await devWith(configWith(), { sleep }).developTaskInSession({
      reqId: REQ_ID,
      requirement,
      plan,
      task,
      workspace: dir,
      session,
      authorizationSource: 'system-admission:test',
      inputKind: 'requirement',
      signal: new AbortController().signal,
    })

    expect(sleep).toHaveBeenCalledTimes(2)
    expect(session.prompts).toHaveLength(3)
    expect(outcome).toMatchObject({ state: 'blocked' })
    expect(outcome.reason).toContain('研发自验证不足')
  })
})
