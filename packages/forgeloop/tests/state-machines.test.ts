import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { Deployments } from '../src/runtime/deployments.js'
import { OpsRuntime } from '../src/runtime/ops.js'
import {
  canTransition,
  DEPLOYMENT_STATES,
  type DeploymentAttemptState,
} from '../src/domain/deployment.js'
import {
  TASK_RUN_AWAITING_USER,
  TASK_RUN_BLOCKED,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
  TASK_RUN_RUNNING,
  TERMINAL_STATUSES,
} from '../src/domain/status.js'
import {
  isOpsActive,
  OPS_AWAITING_DECISION,
  OPS_CLOSED,
  OPS_DIAGNOSED,
  OPS_OPEN,
  OPS_RECOVERING,
  OPS_RECOVERED,
  OPS_UNRESOLVED,
} from '../src/domain/ops.js'
import { resolveConfig, workspaceDir, type ForgeLoopConfig } from '../src/config.js'
import { grantFailureRounds } from '../src/runtime/grants.js'
import { loadReliabilityContract } from './contract-support.js'

interface Machine {
  readonly id: string
  readonly states: readonly string[]
  readonly initial: string
  readonly terminal: readonly string[]
  readonly frozen?: readonly string[]
  readonly frozen_exceptions?: readonly string[]
  readonly transition_rule?: 'explicit' | 'complete'
  readonly transitions: ReadonlyArray<{
    readonly from: string
    readonly to: string
    readonly via: string
    readonly tested?: boolean
  }>
  readonly unreachable?: ReadonlyArray<{ readonly state: string; readonly reason: string }>
}

const CONTRACT = loadReliabilityContract<{ state_machines: Machine[] }>()

function machineOf(id: string): Machine {
  const machine = CONTRACT.state_machines.find((item) => item.id === id)
  if (!machine) throw new Error(`契约缺少状态机 ${id}`)
  return machine
}

function edgeSet(machine: Machine): Set<string> {
  return new Set(machine.transitions.map((edge) => `${edge.from}->${edge.to}`))
}

const AGENT_MUST_NOT_RUN: AgentLike = {
  async run() {
    throw new Error('状态机守卫用例不应调用模型')
  },
}

let dir = ''
let clock = new Date('2026-11-03T10:00:00.000Z')

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

function submitRequirement(runtime: ForgeLoopRuntime): string {
  const result = runtime.submit({
    text: '状态机测试需求',
    by: 'owner',
    source: 'test',
    analyze: false,
  })
  expect(result.ok, result.message).toBe(true)
  return (result.data as { reqId: string }).reqId
}

function deploymentConfig(): ForgeLoopConfig {
  const toolDir = join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', 'tools')
  mkdirSync(toolDir, { recursive: true })
  const script = join(toolDir, 'tool.sh')
  writeFileSync(script, '#!/bin/sh\nexit 0\n')
  return resolveConfig(
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
            capabilities: ['preflight', 'apply', 'status', 'rollback', 'data-rollback'],
            timeoutSeconds: 10,
          },
        ],
        targets: [
          { id: 'owner', toolId: 't', requirementId: 'req-1', approval: 'owner' },
          { id: 'auto', toolId: 't', requirementId: 'req-1', approval: 'auto' },
        ],
      },
    },
    dir,
  )
}

const ARTIFACT = { sha256: 'a'.repeat(64), path: '/tmp/a.tgz', version: '1.0.0' }

function fakeDeploymentTool(options: { failApply?: boolean } = {}) {
  return async (_tool: unknown, op: string) => {
    const payload =
      op === 'status'
        ? { ok: true, state: 'running', version: ARTIFACT.version, detail: 'status ok' }
        : options.failApply && op === 'apply'
          ? { ok: false, state: 'failed', detail: 'apply failed' }
          : { ok: true, state: 'ok', detail: `${op} ok`, restorePoint: 'snap-1' }
    return {
      exitCode: 0,
      stdout: JSON.stringify(payload),
      stderr: '',
      timedOut: false,
      truncated: false,
      sha256: 'f'.repeat(64),
      durationMs: 1,
    }
  }
}

function opsConfig(): ForgeLoopConfig {
  return resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      ops: {
        enabled: true,
        intervalSeconds: 60,
        resources: [{ id: 'web', kind: 'app', label: 'Web' }],
        checks: [
          {
            id: 'web-health',
            resourceId: 'web',
            command: ['node', '-e', 'process.exit(0)'],
            timeoutSeconds: 5,
            severity: 'major',
          },
        ],
        actions: [
          {
            id: 'restart-web',
            resourceId: 'web',
            command: ['node', '-e', 'process.exit(0)'],
            timeoutSeconds: 5,
            auto: true,
            verifyCheckId: 'web-health',
          },
        ],
      },
    },
    dir,
  )
}

const DIAGNOSIS = JSON.stringify({
  impact: '页面不可用',
  facts: ['健康检查退出码 1'],
  hypotheses: [{ statement: '进程退出', confidence: 'medium' }],
  proposed_action: { action_id: 'restart-web', params: {} },
  decision_required: false,
  fix_required: false,
  summary: '重启 Web 后复核',
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-state-machines-'))
  clock = new Date('2026-11-03T10:00:00.000Z')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('deployment state machine', () => {
  it('deployment: explicit table matches canTransition for every state pair', () => {
    const machine = machineOf('deployment-attempt')
    expect(new Set(machine.states)).toEqual(new Set(DEPLOYMENT_STATES))
    expect(machine.initial).toBe('draft')
    const legal = edgeSet(machine)
    const terminals = new Set(machine.terminal)
    let legalChecked = 0
    let illegalChecked = 0
    let terminalChecked = 0
    for (const from of DEPLOYMENT_STATES) {
      for (const to of DEPLOYMENT_STATES) {
        const expected = legal.has(`${from}->${to}`)
        expect(
          canTransition(from as DeploymentAttemptState, to as DeploymentAttemptState),
          `${from} -> ${to}`,
        ).toBe(expected)
        if (expected) legalChecked += 1
        else illegalChecked += 1
        if (terminals.has(from)) terminalChecked += 1
      }
    }
    // 合法边 100%、非法边 100%、终态出边 100%。
    expect(legalChecked).toBe(machine.transitions.length)
    expect(legalChecked + illegalChecked).toBe(DEPLOYMENT_STATES.length ** 2)
    expect(terminalChecked).toBe(terminals.size * DEPLOYMENT_STATES.length)
    for (const terminal of terminals) {
      expect(machine.transitions.some((edge) => edge.from === terminal)).toBe(false)
    }
  })

  it('deployment: runtime transitions persist and rejected transitions leave state unchanged', async () => {
    const repo = new Repository(Database.open(join(dir, 'deploy.sqlite')))
    const config = deploymentConfig()
    let failApply = false
    const deployments = new Deployments({
      config,
      store: repo.deploymentStore,
      gate: () => ({ ok: true, reason: '' }),
      now: () => clock.toISOString(),
      runTool: fakeDeploymentTool({
        get failApply() {
          return failApply
        },
      }),
      alert: async () => ({ ok: true, error: '' }),
    })
    const intentState = (intentId: string): string => {
      const state = repo.deploymentStore.deploymentIntent(intentId)?.state ?? ''
      expect(DEPLOYMENT_STATES).toContain(state)
      return state
    }

    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'owner',
    })
    expect(requested.ok, requested.message).toBe(true)
    const intentId = (requested.data as { intentId: string }).intentId
    expect(intentState(intentId)).toBe('awaiting_approval')

    const approved = await deployments.approve(intentId)
    expect(approved.ok, approved.message).toBe(true)
    expect(intentState(intentId)).toBe('applied_pending_verify')

    const verified = await deployments.verify(intentId)
    expect(verified.ok, verified.message).toBe(true)
    expect(intentState(intentId)).toBe('verified')

    // 终态/非法迁移：rejected 不是从 verified 可达，状态必须保持。
    const rejected = deployments.reject(intentId, '不需要')
    expect(rejected.ok).toBe(false)
    expect(rejected.code).toBe('invalid_state')
    expect(intentState(intentId)).toBe('verified')
    const reapprove = await deployments.approve(intentId)
    expect(reapprove.ok).toBe(false)
    expect(intentState(intentId)).toBe('verified')

    // 预检门禁失败：draft -> preflight_failed，之后不能批准。
    const denied = new Deployments({
      config,
      store: repo.deploymentStore,
      gate: () => ({ ok: false, reason: '门禁未通过' }),
      now: () => clock.toISOString(),
      runTool: fakeDeploymentTool({ failApply }),
      alert: async () => ({ ok: true, error: '' }),
    })
    const blocked = await denied.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'owner',
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.code).toBe('preflight_failed')
    const blockedIntent = repo.deploymentStore
      .deploymentIntents(20)
      .find((intent) => intent.state === 'preflight_failed')
    expect(blockedIntent).toBeDefined()
    if (blockedIntent) {
      expect((await denied.approve(blockedIntent.intentId)).ok).toBe(false)
      expect(intentState(blockedIntent.intentId)).toBe('preflight_failed')
    }

    // 工具失败：ready -> applying -> failed，持久化失败事实。
    failApply = true
    const auto = await deployments.request({
      targetId: 'auto',
      artifact: ARTIFACT,
      source: 'auto',
    })
    expect(auto.ok).toBe(false)
    const autoId = (auto.data as { intentId?: string } | undefined)?.intentId
    expect(auto.code).toBe('tool_failed')
    if (autoId) {
      expect(intentState(autoId)).toBe('failed')
      expect(
        repo.deploymentStore.deploymentAttempts(autoId).some((attempt) => attempt.op === 'apply'),
      ).toBe(true)
    }
    for (const intent of repo.deploymentStore.deploymentIntents(50)) {
      expect(DEPLOYMENT_STATES).toContain(intent.state)
    }
    repo.close()
  })
})

describe('requirement state machine', () => {
  const NON_TERMINAL = [
    'draft',
    'analysis_failed',
    'awaiting_clarification',
    'blocked',
    'specified',
    'plan_proposed',
    'approved',
    'developing',
    'executing',
    'verifying',
    'awaiting_dev_session',
  ]

  it('requirement: terminal and frozen states reject every guarded workflow operation', async () => {
    const machine = machineOf('requirement-status')
    const runtime = runtimeOf()
    const observed = new Set<string>()
    const states = [...TERMINAL_STATUSES]
    const guarded = [
      (reqId: string) => runtime.revise({ reqId, text: '再改一次', by: 'owner', source: 'test' }),
      (reqId: string) => runtime.cancel({ reqId, by: 'owner', reason: '不做了' }),
      (reqId: string) => runtime.stop({ reqId, by: 'owner', reason: '停下' }),
      (reqId: string) =>
        runtime.requestOperation({ reqId, action: 'plan', by: 'owner', source: 'test' }),
      (reqId: string) =>
        runtime.requestOperation({ reqId, action: 'advance', by: 'owner', source: 'test' }),
      (reqId: string) => grantFailureRounds(runtime.repo, { reqId, by: 'owner', source: 'test' }),
    ]
    for (const state of states) {
      for (const operation of guarded) {
        const reqId = submitRequirement(runtime)
        runtime.repo.setStatus(reqId, state)
        const result = operation(reqId)
        expect(result.ok, `${state} 上被拒绝的操作返回成功`).toBe(false)
        expect(result.code).toBe('terminal')
        expect(runtime.repo.getRequirement(reqId)?.status).toBe(state)
        observed.add(state)
      }
      const reqId = submitRequirement(runtime)
      runtime.repo.setStatus(reqId, state)
      const analysis = await runtime.analyzeRequirement(reqId)
      expect(analysis.ok).toBe(false)
      expect(analysis.code).toBe('terminal')
      expect(runtime.repo.getRequirement(reqId)?.status).toBe(state)
      // 冻结态唯一例外：最终验收入口仍可进入（材料缺失时失败，但不是 terminal）。
      const accepted = runtime.accept({ reqId, by: 'owner', source: 'test' })
      expect(accepted.ok).toBe(false)
      expect(accepted.code).not.toBe('terminal')
      expect(runtime.repo.getRequirement(reqId)?.status).toBe(state)
    }
    expect([...observed].sort()).toEqual([...states].sort())
    expect(new Set(machine.terminal)).toEqual(new Set(['accepted', 'rejected', 'cancelled']))
    expect(machine.frozen).toEqual(['committed'])
    expect(new Set([...machine.terminal, ...(machine.frozen ?? [])])).toEqual(
      new Set(TERMINAL_STATUSES),
    )
    runtime.close()
  })

  it('requirement: declared legal edges are produced by the guarded entry points', () => {
    const machine = machineOf('requirement-status')
    const legal = edgeSet(machine)
    const runtime = runtimeOf()
    const exercised: string[] = []
    const check = (from: string, to: string, result: { ok: boolean; message: string }) => {
      expect(result.ok, result.message).toBe(true)
      const status = runtime.repo.getRequirement(reqId)?.status
      expect(status).toBe(to)
      const edge = `${from}->${to}`
      expect(legal.has(edge), `契约未声明迁移边 ${edge}`).toBe(true)
      exercised.push(edge)
    }
    let reqId = ''
    for (const from of NON_TERMINAL) {
      reqId = submitRequirement(runtime)
      runtime.repo.setStatus(reqId, from)
      check(from, 'draft', runtime.revise({ reqId, text: '修订一次', by: 'owner', source: 'test' }))

      reqId = submitRequirement(runtime)
      runtime.repo.setStatus(reqId, from)
      check(from, 'cancelled', runtime.cancel({ reqId, by: 'owner', reason: '不做了' }))

      reqId = submitRequirement(runtime)
      runtime.repo.setStatus(reqId, from)
      check(from, 'blocked', runtime.stop({ reqId, by: 'owner', reason: '停下' }))
    }
    // 重复停止：blocked -> blocked 是声明的幂等自环。
    const repeated = submitRequirement(runtime)
    runtime.repo.setStatus(repeated, 'blocked')
    reqId = repeated
    check('blocked', 'blocked', runtime.stop({ reqId, by: 'owner', reason: '再次停下' }))

    // 追加授权：blocked -> approved。
    reqId = submitRequirement(runtime)
    runtime.repo.setStatus(reqId, 'blocked')
    check(
      'blocked',
      'approved',
      grantFailureRounds(runtime.repo, { reqId, by: 'owner', source: 'test' }),
    )

    // 重复取消：终态后再次取消必须被拒绝且状态不变。
    reqId = submitRequirement(runtime)
    runtime.repo.setStatus(reqId, 'draft')
    expect(runtime.cancel({ reqId, by: 'owner', reason: '取消' }).ok).toBe(true)
    const again = runtime.cancel({ reqId, by: 'owner', reason: '再取消' })
    expect(again.ok).toBe(false)
    expect(again.code).toBe('terminal')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('cancelled')

    expect(new Set(exercised).size).toBe(34)
    for (const edge of exercised) expect(legal.has(edge)).toBe(true)
    const untested = machine.transitions.filter(
      (edge) => !exercised.includes(`${edge.from}->${edge.to}`),
    )
    for (const edge of untested) {
      expect(edge.tested, `未驱动也未标记 tested=false 的边：${edge.from}->${edge.to}`).toBe(false)
    }
    runtime.close()
  })

  it('requirement: interruption recovery settles to blocked and discards the workspace', () => {
    const machine = machineOf('requirement-status')
    const runtime = runtimeOf()
    const reqId = submitRequirement(runtime)
    runtime.repo.setStatus(reqId, 'approved')
    runtime.repo.recordTaskPlan(seedPlan(reqId))
    runtime.repo.recordRequest({
      requestId: 'rq-interrupted-1',
      reqId,
      project: 'testproj',
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: clock.toISOString(),
    })
    const claimed = runtime.repo.claimNextRequest('owner', clock.toISOString())
    expect(claimed?.requestId).toBe('rq-interrupted-1')
    const workspace = workspaceDir(runtime.config, reqId, 1, 't1')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'partial.txt'), 'partial')
    const recovered = runtime.recoverInterrupted(clock.toISOString())
    expect(recovered.interruptedRequests).toContain('rq-interrupted-1')
    expect(recovered.discardedWorkspaces).toContain(workspace)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
    expect(runtime.repo.getRequirement(reqId)?.blockedReason).toContain('中断')
    expect(
      machine.transitions.some((edge) => edge.from === 'approved' && edge.to === 'blocked'),
    ).toBe(true)
    runtime.close()
  })
})

describe('task run state machine', () => {
  const STATES = [
    TASK_RUN_RUNNING,
    TASK_RUN_DELIVERED,
    TASK_RUN_AWAITING_USER,
    TASK_RUN_FAILED,
    TASK_RUN_BLOCKED,
  ] as const

  it('task run: every declared outcome pair round-trips through the repository', () => {
    const machine = machineOf('task-run')
    expect(new Set(machine.states)).toEqual(new Set(STATES))
    expect(machine.transition_rule).toBe('complete')
    const repo = new Repository(Database.open(join(dir, 'task-runs.sqlite')))
    const base = {
      requirementId: 'req-runs',
      planVersion: 1,
      taskId: 't1',
      reason: '',
      executedSeconds: 0,
      updatedAt: clock.toISOString(),
    }
    let pairs = 0
    for (const first of STATES) {
      repo.recordTaskRun({ ...base, state: first })
      expect(repo.taskRuns('req-runs', 1)[0]?.state).toBe(first)
      for (const next of STATES) {
        repo.recordTaskRun({ ...base, state: next })
        expect(repo.taskRuns('req-runs', 1)[0]?.state).toBe(next)
        pairs += 1
      }
    }
    expect(pairs).toBe(STATES.length ** 2)

    // 心跳只刷新已有行；不存在的任务不隐式插入。
    repo.heartbeatTaskRun({
      requirementId: 'req-runs',
      planVersion: 1,
      taskId: 't1',
      reason: 'heartbeat',
      updatedAt: clock.toISOString(),
    })
    expect(repo.taskRuns('req-runs', 1)[0]?.state).toBe(TASK_RUN_RUNNING)
    repo.heartbeatTaskRun({
      requirementId: 'req-runs',
      planVersion: 1,
      taskId: 't-missing',
      reason: 'heartbeat',
      updatedAt: clock.toISOString(),
    })
    expect(repo.taskRuns('req-runs', 1).some((run) => run.taskId === 't-missing')).toBe(false)

    // 执行秒数累计，重试不清零。
    repo.recordTaskRun({ ...base, state: TASK_RUN_FAILED, executedSeconds: 2 })
    repo.recordTaskRun({ ...base, state: TASK_RUN_FAILED, executedSeconds: 3 })
    expect(repo.taskRuns('req-runs', 1)[0]?.executedSeconds).toBe(5)

    // 数据库里的未知状态必须 fail-closed，不能静默映射成别的状态。
    repo.db
      .prepare(
        `INSERT INTO requirement_task_runs
           (req_id, plan_version, task_id, state, reason, executed_seconds, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('req-unknown', 1, 'tx', 'unknown', '', 0, clock.toISOString())
    expect(() => repo.taskRuns('req-unknown', 1)).toThrow()
    repo.close()
  })
})

describe('ops event state machine', () => {
  const OPS_STATES = [
    OPS_OPEN,
    OPS_DIAGNOSED,
    OPS_AWAITING_DECISION,
    OPS_RECOVERING,
    OPS_RECOVERED,
    OPS_UNRESOLVED,
    OPS_CLOSED,
  ] as const
  const FIX_ALLOWED = new Set([OPS_RECOVERED, OPS_UNRESOLVED, OPS_AWAITING_DECISION])

  function opsFixture(): { repo: Repository; ops: OpsRuntime } {
    const repo = new Repository(Database.open(join(dir, 'ops.sqlite')))
    const config = opsConfig()
    const ops = new OpsRuntime({
      config,
      repo,
      runner: AGENT_MUST_NOT_RUN,
      now: () => clock,
    })
    return { repo, ops }
  }

  function seedEvent(repo: Repository, eventId: string, state: string): void {
    repo.createOpsEvent({
      eventId,
      project: 'testproj',
      resourceId: 'web',
      checkId: 'web-health',
      signature: `signature-${eventId}`,
      severity: 'major',
      state,
      title: '测试事件',
      openedAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    })
    repo.updateOpsEvent(eventId, { diagnosisJson: DIAGNOSIS })
  }

  it('ops: decision, close and fix entry points allow exactly the declared states', () => {
    const machine = machineOf('ops-event')
    expect(new Set(machine.states)).toEqual(new Set(OPS_STATES))
    const legal = edgeSet(machine)
    const { repo, ops } = opsFixture()
    let checks = 0
    for (const state of OPS_STATES) {
      const decideId = `decide-${state}`
      seedEvent(repo, decideId, state)
      const decided = ops.decide({
        eventId: decideId,
        decision: 'approve',
        by: 'owner',
        source: 'test',
      })
      expect(decided.ok, `decide 在 ${state} 上判定错误`).toBe(state === OPS_AWAITING_DECISION)
      expect(repo.opsEvent(decideId)?.state).toBe(state)
      checks += 1

      const closeId = `close-${state}`
      seedEvent(repo, closeId, state)
      const closed = ops.close({ eventId: closeId, by: 'owner', reason: '收口' })
      expect(closed.ok, `close 在 ${state} 上判定错误`).toBe(state !== OPS_CLOSED)
      expect(repo.opsEvent(closeId)?.state).toBe(OPS_CLOSED)
      if (state !== OPS_CLOSED) {
        expect(legal.has(`${state}->${OPS_CLOSED}`), `未声明迁移 ${state}->closed`).toBe(true)
      }
      checks += 1

      const fixId = `fix-${state}`
      seedEvent(repo, fixId, state)
      const fixed = ops.requestFix({ eventId: fixId, by: 'owner', source: 'test' })
      expect(fixed.ok, `requestFix 在 ${state} 上判定错误`).toBe(FIX_ALLOWED.has(state))
      checks += 1
    }
    expect(checks).toBe(OPS_STATES.length * 3)

    // 拒绝决定：awaiting_decision -> unresolved 是声明的合法边。
    const declineId = 'decline-1'
    seedEvent(repo, declineId, OPS_AWAITING_DECISION)
    expect(
      ops.decide({ eventId: declineId, decision: 'decline', by: 'owner', source: 'test' }).ok,
    ).toBe(true)
    expect(repo.opsEvent(declineId)?.state).toBe(OPS_UNRESOLVED)
    expect(legal.has('awaiting_decision->unresolved')).toBe(true)

    // 重复关闭：已关闭事件必须拒绝且状态不变。
    expect(ops.close({ eventId: declineId, by: 'owner', reason: '再次关闭' }).ok).toBe(true)
    const repeat = ops.close({ eventId: declineId, by: 'owner', reason: '第三次关闭' })
    expect(repeat.ok).toBe(false)
    expect(repeat.code).toBe('already_closed')
    expect(repo.opsEvent(declineId)?.state).toBe(OPS_CLOSED)

    // 活跃状态分类：终态不吸收新告警。
    for (const state of OPS_STATES) {
      expect(isOpsActive(state)).toBe(![OPS_RECOVERED, OPS_CLOSED].includes(state as never))
    }
    repo.close()
  })

  it('ops: interrupted action attempts are recovered as interrupted without replay', () => {
    const machine = machineOf('ops-event')
    const { repo } = opsFixture()
    const eventId = 'ops-interrupted'
    seedEvent(repo, eventId, OPS_OPEN)
    repo.recordOpsActionAttempt({
      actionId: 'act-1',
      eventId,
      actionDefId: 'restart-web',
      state: 'running',
      authorizationSource: 'ops-catalog:auto',
      startedAt: clock.toISOString(),
    })
    const marked = repo.markRunningOpsActionsInterrupted(clock.toISOString())
    expect(marked).toEqual([{ actionId: 'act-1', eventId }])
    const attempt = repo.latestOpsActionAttempt(eventId)
    expect(attempt?.state).toBe('interrupted')
    expect(attempt?.exitCode).toBeNull()
    expect(attempt?.detail).toContain('不自动重放')
    expect(repo.opsEvent(eventId)?.state).toBe(OPS_UNRESOLVED)
    expect(
      machine.transitions.some((edge) => edge.from === OPS_OPEN && edge.to === OPS_UNRESOLVED),
    ).toBe(true)
    // 第二次启动不应再次收口，也不产生新的动作尝试。
    expect(repo.markRunningOpsActionsInterrupted(clock.toISOString())).toEqual([])
    expect(repo.opsActionAttempts(eventId)).toHaveLength(1)
    repo.close()
  })
})

function seedPlan(reqId: string) {
  return {
    taskPlanId: `plan-${reqId}-1`,
    requirementId: reqId,
    project: 'testproj',
    planVersion: 1,
    requirementVersion: 1,
    createdAt: clock.toISOString(),
    tasks: [
      {
        taskId: 't1',
        goal: '改文档',
        files: ['docs/a.md'],
        acceptance: '文档存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
    ],
  }
}
