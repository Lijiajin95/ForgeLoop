import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { ExecutionDev } from '../src/runtime/execution-dev.js'
import type { AgentSession } from '../src/runtime/agent-runner.js'
import type { Requirement } from '../src/domain/requirement.js'
import type { PlannedTask, TaskPlan } from '../src/domain/task-plan.js'

const NOW = '2026-11-03T10:00:00.000Z'
const REQ_ID = 'req-exec-1'

let dir = ''
let config: ForgeLoopConfig
let repo: Repository
let dev: ExecutionDev
let task: PlannedTask
let plan: TaskPlan
let requirement: Requirement

function recordRun(
  reqId: string,
  value: TaskPlan,
  item: PlannedTask,
  outcome: {
    state: 'running' | 'delivered' | 'awaiting_user' | 'failed' | 'blocked'
    reason: string
  },
): void {
  repo.recordTaskRun({
    requirementId: reqId,
    planVersion: value.planVersion,
    taskId: item.taskId,
    state: outcome.state,
    reason: outcome.reason,
    executedSeconds: 0,
    updatedAt: NOW,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-execution-dev-'))
  config = resolveConfig(
    { project: 'demo', projectPath: dir, recordsRoot: join(dir, '.forgeloop') },
    dir,
  )
  repo = new Repository(Database.open(join(dir, 'records.sqlite')))
  requirement = {
    reqId: REQ_ID,
    project: 'demo',
    status: 'developing',
    blockedReason: '',
    versions: [
      { version: 1, text: '实现一个改动', createdAt: NOW, revisedBy: 'owner', source: 'test' },
    ],
    submittedBy: 'owner',
    source: 'test',
  }
  task = {
    taskId: 't1',
    goal: '写文档',
    files: ['docs/a.md'],
    acceptance: '文档存在',
    testCommand: ['node', '-e', 'process.exit(0)'],
    dependsOn: [],
    limits: { limitSeconds: 60, maxFailureRounds: 1 },
    authorizationSource: '',
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
  dev = new ExecutionDev({
    config,
    repo,
    now: () => NOW,
    recordRun,
    previousTaskFailure: () => '',
    formalTest: (() => {
      throw new Error('formal test must not run for an aborted turn')
    }) as never,
    existingPackages: () => [],
    ctx: {},
    authorizedPlan: (value) => value,
    applyDiffFile: () => ({ ok: true, detail: '' }),
  })
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ExecutionDev turn activity', () => {
  it('heartbeats the running task when the session reports activity', async () => {
    const heartbeat = vi.spyOn(repo, 'heartbeatTaskRun')
    const workspace = join(dir, 'workspace')
    const session: AgentSession = {
      sessionId: 'session-dev',
      async send(turn) {
        turn.onActivity?.([{ type: 'tool/call', data: { name: 'bash' } }])
        return {
          status: 'aborted',
          text: '',
          sessionId: 'session-dev',
          reason: '宿主停止',
          transcriptPath: turn.transcriptPath,
          durationMs: 1,
          toolCalls: [],
        }
      },
      async close() {},
    }

    const outcome = await dev.developTaskInSession({
      reqId: REQ_ID,
      requirement,
      plan,
      task,
      workspace,
      session,
      authorizationSource: 'test',
      signal: new AbortController().signal,
    })

    expect(outcome).toMatchObject({ state: 'blocked' })
    expect(heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementId: REQ_ID,
        planVersion: 1,
        taskId: 't1',
        reason: '正在调用工具 bash',
        updatedAt: NOW,
      }),
    )
    expect(repo.taskRuns(REQ_ID, 1)[0]).toMatchObject({ state: 'blocked' })
  })

  it('skips tasks without delivered artifacts when restoring a workspace', () => {
    const restored = dev.restoreDeliveredArtifacts(REQ_ID, plan, join(dir, 'workspace'), 'baseline')
    expect(restored).toEqual({ ok: true })
  })
})
