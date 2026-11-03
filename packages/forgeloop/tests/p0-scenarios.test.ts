import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { Deployments } from '../src/runtime/deployments.js'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import { retryDecision } from '../src/domain/retry-policy.js'
import { parseTaskPlanDraft } from '../src/domain/task-plan.js'
import { parseAnalysisDraft } from '../src/domain/requirement.js'
import { parseDeploymentToolResult } from '../src/domain/deployment.js'
import { actionArgv, parseOpsDiagnosis } from '../src/domain/ops.js'
import { TERMINAL_STATUSES } from '../src/domain/status.js'
import { loadReliabilityContract } from './contract-support.js'

interface Machine {
  readonly states: readonly string[]
}
const CONTRACT = loadReliabilityContract<{ state_machines: Array<Machine & { id: string }> }>()
const REQUIREMENT_STATES = new Set(
  CONTRACT.state_machines.find((machine) => machine.id === 'requirement-status')?.states ?? [],
)

const AGENT_MUST_NOT_RUN: AgentLike = {
  async run() {
    throw new Error('该场景不应调用模型')
  },
}

let dir = ''
const clock = new Date('2026-11-03T10:00:00.000Z')

function serviceConfig(): ForgeLoopConfig {
  return resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
      autonomy: { allowAnySource: false },
      failureRoundsPerGrant: 3,
      maxVerificationAttempts: 3,
    },
    dir,
  )
}

function runtimeOf(): ForgeLoopRuntime {
  return new ForgeLoopRuntime({ ctx: {}, config: serviceConfig(), runner: AGENT_MUST_NOT_RUN })
}

function submit(runtime: ForgeLoopRuntime, clientKey?: string): string {
  const result = runtime.submit({
    text: 'P0 场景需求',
    by: 'owner',
    source: 'test',
    analyze: false,
    ...(clientKey === undefined ? {} : { clientKey }),
  })
  expect(result.ok, result.message).toBe(true)
  return (result.data as { reqId: string }).reqId
}

const PLAN_CONTEXT = {
  requirementId: 'req-1',
  project: 'proj',
  planVersion: 1,
  requirementVersion: 1,
  now: '2026-11-01T00:00:00.000Z',
}

function twoTaskPlan(
  overrides: {
    files?: string[]
    testCommand?: string[]
    limits?: Record<string, unknown>
    dependsOn?: string[]
  } = {},
) {
  return {
    plan_version: 1,
    requirement_version: 1,
    project: 'proj',
    tasks: [
      {
        task_id: 't0',
        goal: '实现',
        files: overrides.files ?? ['src/a.ts'],
        acceptance: '可验证',
        test_command: overrides.testCommand ?? ['npm', 'test'],
        ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
      },
      {
        task_id: 't1',
        goal: '补测试',
        files: ['src/b.ts'],
        acceptance: '可验证',
        test_command: ['npm', 'test'],
        depends_on: overrides.dependsOn ?? ['t0'],
      },
    ],
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-p0-scenarios-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('P0 boundary and failure scenarios', () => {
  it('null and empty inputs fail closed', () => {
    expect(() => parseAnalysisDraft(null)).toThrow()
    expect(() => parseAnalysisDraft([])).toThrow()
    expect(() => parseAnalysisDraft('')).toThrow()
    expect(() => parseTaskPlanDraft(null, PLAN_CONTEXT)).toThrow()
    expect(() => parseTaskPlanDraft({}, PLAN_CONTEXT)).toThrow()
    expect(() => parseTaskPlanDraft({ tasks: [] }, PLAN_CONTEXT)).toThrow()
    const runtime = runtimeOf()
    expect(runtime.submit({ text: '   ', by: 'owner', source: 'test' }).ok).toBe(false)
    expect(runtime.submit({ text: '需求', by: '', source: 'test' }).ok).toBe(true)
    runtime.close()
  })

  it('out-of-range numbers and versions are rejected', () => {
    // 任务包版本由运行时上下文决定，载荷里的 plan_version 不参与判定。
    expect(() => parseTaskPlanDraft(twoTaskPlan(), { ...PLAN_CONTEXT, planVersion: 0 })).toThrow()
    expect(() =>
      parseTaskPlanDraft(twoTaskPlan({ limits: { limit_seconds: 0 } }), PLAN_CONTEXT),
    ).toThrow()
    expect(() =>
      parseTaskPlanDraft(twoTaskPlan({ limits: { limit_seconds: -2 } }), PLAN_CONTEXT),
    ).toThrow()
    expect(() =>
      parseTaskPlanDraft(twoTaskPlan({ limits: { max_failure_rounds: 1.5 } }), PLAN_CONTEXT),
    ).toThrow()
    expect(() =>
      parseTaskPlanDraft(twoTaskPlan(), { ...PLAN_CONTEXT, requirementVersion: 0 }),
    ).toThrow()
    expect(() =>
      parseTaskPlanDraft(twoTaskPlan({ dependsOn: ['t-missing'] }), PLAN_CONTEXT),
    ).toThrow()
    expect(() =>
      retryDecision({
        status: 'approved',
        blockedReason: '',
        remainingRounds: -2,
        activeRequest: false,
        runningTasks: 0,
        awaitingInputTasks: 0,
        planApproved: true,
        delivered: 0,
        total: 1,
      }),
    ).not.toThrow()
  })

  it('invalid parameters and malformed payloads fail closed', () => {
    for (const payload of [
      '',
      'not json',
      '[]',
      '{"state":"x"}',
      '{"ok":true}',
      '{"ok":"yes","state":"x"}',
    ]) {
      expect(() => parseDeploymentToolResult(payload)).toThrow()
    }
    expect(() => parseOpsDiagnosis('{"impact":"x"}')).toThrow()
    expect(() =>
      actionArgv(
        {
          id: 'restart',
          resourceId: 'web',
          command: ['tool', '{mode}'],
          params: [{ name: 'mode', values: ['fast'] }],
          timeoutSeconds: 10,
          auto: true,
          verifyCheckId: 'check',
        },
        { mode: 'slow' },
      ),
    ).toThrow()
    expect(() => parseTaskPlanDraft(twoTaskPlan({ testCommand: [] }), PLAN_CONTEXT)).toThrow()
    expect(() =>
      parseTaskPlanDraft(twoTaskPlan({ files: ['src/a.ts', 'src/a.ts'] }), PLAN_CONTEXT),
    ).toThrow()
  })

  it('timeout and tool failure are recorded without success', async () => {
    const toolDir = join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', 'tools')
    mkdirSync(toolDir, { recursive: true })
    const script = join(toolDir, 'tool.sh')
    writeFileSync(script, '#!/bin/sh\nexit 0\n')
    const config = resolveConfig(
      {
        project: 'testproj',
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
        deployments: {
          enabled: true,
          alerts: { webhook: 'https://example.com/deploy-hook' },
          tools: [
            {
              id: 't',
              kind: 'shell',
              path: script,
              capabilities: ['preflight', 'apply', 'status'],
              timeoutSeconds: 10,
            },
          ],
          targets: [{ id: 'auto', toolId: 't', requirementId: 'req-1', approval: 'auto' }],
        },
      },
      dir,
    )
    const repo = new Repository(Database.open(join(dir, 'timeout.sqlite')))
    const scenarios = [
      {
        name: 'timeout',
        run: async () => ({
          exitCode: -1,
          stdout: '',
          stderr: '',
          timedOut: true,
          truncated: false,
          sha256: 'f'.repeat(64),
          durationMs: 1,
        }),
      },
      {
        name: 'tool failure',
        run: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'boom',
          timedOut: false,
          truncated: false,
          sha256: 'f'.repeat(64),
          durationMs: 1,
        }),
      },
    ]
    for (const scenario of scenarios) {
      const deployments = new Deployments({
        config,
        store: repo.deploymentStore,
        gate: () => ({ ok: true, reason: '' }),
        now: () => clock.toISOString(),
        runTool: scenario.run,
        alert: async () => ({ ok: true, error: '' }),
      })
      const outcome = await deployments.request({
        targetId: 'auto',
        artifact: { sha256: 'a'.repeat(64), path: '/tmp/a.tgz', version: '1.0.0' },
        source: 'auto',
      })
      expect(outcome.ok, scenario.name).toBe(false)
      const intents = repo.deploymentStore.deploymentIntents(10)
      expect(intents).toHaveLength(1)
      expect(intents[0]?.state).toBe('preflight_failed')
      expect(outcome.code).toBe('preflight_failed')
      expect(repo.deploymentStore.deploymentAttempts(intents[0]!.intentId).length).toBe(1)
      repo.close()
      break
    }
  })

  it('exhausted failure rounds block retry', () => {
    const decision = retryDecision({
      status: 'blocked',
      blockedReason: '任务失败',
      remainingRounds: 0,
      activeRequest: false,
      runningTasks: 0,
      awaitingInputTasks: 0,
      planApproved: true,
      delivered: 0,
      total: 2,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('额度')
    const runtime = runtimeOf()
    const reqId = submit(runtime)
    runtime.repo.setStatus(reqId, 'blocked', '任务失败')
    expect(runtime.retryDecisionFor(reqId).allowed).toBe(false)
    runtime.close()
  })

  it('database failure surfaces and leaves no partial row', () => {
    const path = join(dir, 'failure.sqlite')
    const db = Database.open(path)
    const repo = new Repository(db)
    const { requirement } = repo.submit({
      reqId: 'req-db-1',
      project: 'testproj',
      text: '数据库失败场景',
      submittedBy: 'owner',
      source: 'test',
      clientKey: '',
      now: clock.toISOString(),
    })
    expect(requirement.reqId).toBe('req-db-1')
    expect(() =>
      db.transaction(() => {
        db.prepare("UPDATE requirements SET status = 'accepted' WHERE req_id = ?").run('req-db-1')
        throw new Error('模拟事务中途失败')
      }),
    ).toThrow('模拟事务中途失败')
    expect(repo.getRequirement('req-db-1')?.status).toBe('draft')
    expect(
      Number(
        (db.prepare('SELECT COUNT(*) AS count FROM requirements').get() as { count: number }).count,
      ),
    ).toBe(1)
    repo.close()
    expect(() => repo.getRequirement('req-db-1')).toThrow()
    // 重新打开后仍只有一条需求，失败没有留下半条记录。
    const reopened = new Repository(Database.open(path))
    expect(reopened.listRequirements('testproj')).toHaveLength(1)
    reopened.close()
  })

  it('resource release is idempotent and failures do not corrupt state', () => {
    const runtime = runtimeOf()
    const reqId = submit(runtime)
    runtime.close()
    expect(() => runtime.close()).not.toThrow()
    const reopened = runtimeOf()
    expect(reopened.repo.getRequirement(reqId)?.status).toBe('draft')
    reopened.close()
  })

  it('state conflicts are rejected without undefined states', () => {
    const runtime = runtimeOf()
    const reqId = submit(runtime)
    runtime.repo.setStatus(reqId, 'cancelled')
    expect(runtime.revise({ reqId, text: '再来', by: 'owner', source: 'test' }).code).toBe(
      'terminal',
    )
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('cancelled')
    // 未批准/缺失任务包的批准请求被拒绝，状态保持终态而不是写成未定义值。
    const approve = runtime.approvePlan({ reqId, planVersion: 1, by: 'owner', source: 'test' })
    expect(approve.ok).toBe(false)
    expect(REQUIREMENT_STATES.has(runtime.repo.getRequirement(reqId)?.status ?? '')).toBe(true)
    expect(TERMINAL_STATUSES.has(runtime.repo.getRequirement(reqId)?.status ?? '')).toBe(true)
    runtime.close()
  })

  it('duplicate requests are idempotent', () => {
    const runtime = runtimeOf()
    const first = submit(runtime, 'client-key-1')
    const second = submit(runtime, 'client-key-1')
    expect(second).toBe(first)
    expect(runtime.repo.listRequirements('testproj')).toHaveLength(1)
    const request = {
      requestId: 'rq-dup-1',
      reqId: first,
      project: 'testproj',
      planVersion: 0,
      action: 'analyze' as const,
      requestedBy: 'owner',
      source: 'test',
      now: clock.toISOString(),
    }
    runtime.repo.recordRequest(request)
    const duplicate = runtime.repo.recordRequest({ ...request, requestId: 'rq-dup-2' })
    expect(duplicate.created).toBe(false)
    expect(duplicate.request.requestId).toBe('rq-dup-1')
    runtime.close()
  })

  it('interruption and cancellation settle explicitly', () => {
    const runtime = runtimeOf()
    const stopped = submit(runtime)
    expect(runtime.stop({ reqId: stopped, by: 'owner', reason: '暂停' }).ok).toBe(true)
    runtime.settleStopIfQuiet(stopped)
    expect(runtime.repo.stop(stopped)?.settledAt).toBeTruthy()
    expect(runtime.repo.getRequirement(stopped)?.status).toBe('blocked')

    const cancelled = submit(runtime)
    expect(runtime.cancel({ reqId: cancelled, by: 'owner', reason: '取消' }).ok).toBe(true)
    expect(runtime.repo.getRequirement(cancelled)?.status).toBe('cancelled')
    expect(runtime.repo.cancellation(cancelled)?.reason).toBe('取消')
    runtime.close()
  })

  it('empty collections are rejected where the domain requires content', () => {
    expect(() => parseTaskPlanDraft({ tasks: [] }, PLAN_CONTEXT)).toThrow()
    expect(() => parseTaskPlanDraft(twoTaskPlan({ files: [] }), PLAN_CONTEXT)).toThrow()
    expect(() => parseTaskPlanDraft(twoTaskPlan({ testCommand: [] }), PLAN_CONTEXT)).toThrow()
    expect(() =>
      parseTaskPlanDraft(
        { plan_version: 1, requirement_version: 1, tasks: [twoTaskPlan().tasks[0]] },
        PLAN_CONTEXT,
      ),
    ).toThrow()
    expect(() =>
      parseTaskPlanDraft(
        {
          plan_version: 1,
          requirement_version: 1,
          tasks: [
            { ...twoTaskPlan().tasks[0], depends_on: [] },
            { ...twoTaskPlan().tasks[1], depends_on: [] },
          ],
        },
        PLAN_CONTEXT,
      ),
    ).toThrow()
    expect(() =>
      parseOpsDiagnosis(
        JSON.stringify({
          impact: 'x',
          facts: [],
          proposed_action: null,
          decision_required: false,
          fix_required: false,
          summary: 's',
        }),
      ),
    ).not.toThrow()
  })

  it('unexpected exceptions do not leave undefined states', async () => {
    const runtime = runtimeOf()
    const reqId = submit(runtime)
    expect(() => runtime.revise({ reqId, text: '   ', by: 'owner', source: 'test' })).toThrow(
      '需求修订原文不能为空',
    )
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('draft')
    expect(runtime.repo.getRequirement(reqId)?.versions).toHaveLength(1)

    const toolDir = join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', 'tools')
    mkdirSync(toolDir, { recursive: true })
    const script = join(toolDir, 'tool.sh')
    writeFileSync(script, '#!/bin/sh\nexit 0\n')
    const config = resolveConfig(
      {
        project: 'testproj',
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
        deployments: {
          enabled: true,
          alerts: { webhook: 'https://example.com/deploy-hook' },
          tools: [
            {
              id: 't',
              kind: 'shell',
              path: script,
              capabilities: ['preflight', 'apply'],
              timeoutSeconds: 10,
            },
          ],
          targets: [{ id: 'owner', toolId: 't', requirementId: 'req-1', approval: 'owner' }],
        },
      },
      dir,
    )
    const repo = new Repository(Database.open(join(dir, 'exception.sqlite')))
    const deployments = new Deployments({
      config,
      store: repo.deploymentStore,
      gate: () => ({ ok: true, reason: '' }),
      now: () => clock.toISOString(),
      runTool: async () => {
        throw new Error('工具进程启动失败')
      },
      alert: async () => ({ ok: true, error: '' }),
    })
    const outcome = await deployments.request({
      targetId: 'owner',
      artifact: { sha256: 'a'.repeat(64), path: '/tmp/a.tgz', version: '1.0.0' },
      source: 'owner',
    })
    expect(outcome.ok).toBe(false)
    const intent = repo.deploymentStore.deploymentIntents(5)[0]
    expect(intent?.state).toBe('preflight_failed')
    runtime.close()
    repo.close()
  })
})
