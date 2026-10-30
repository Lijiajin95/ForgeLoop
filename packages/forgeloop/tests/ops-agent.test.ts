import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, type ForgeLoopConfig, type RawConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { OpsRuntime } from '../src/runtime/ops.js'
import type { AgentLike } from '../src/runtime/service.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import {
  OPS_ATTEMPT_FAILED,
  OPS_ATTEMPT_INTERRUPTED,
  OPS_AWAITING_DECISION,
  OPS_RECOVERED,
  OPS_RECOVERING,
  OPS_UNRESOLVED,
} from '../src/domain/ops.js'

const PROJECT = 'forgeloop'
let dir = ''
let repository: Repository
let clock = new Date('2026-10-29T10:00:00.000Z')

function result(request: AgentRunRequest, text: string, status: AgentRunResult['status'] = 'completed'): AgentRunResult {
  return {
    status,
    text,
    sessionId: `session-fake-${request.role}`,
    reason: status === 'completed' ? '' : 'fake failure',
    transcriptPath: request.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  }
}

function fakeRunner(text: string | ((prompt: string) => string)): AgentLike & { prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    async run(request) {
      prompts.push(request.prompt)
      return result(request, typeof text === 'function' ? text(request.prompt) : text)
    },
  }
}

function diagnosisText(input: {
  impact?: string
  action?: { actionId: string; params: Record<string, string> } | null
  decisionRequired?: boolean
  fixRequired?: boolean
} = {}): string {
  return JSON.stringify({
    impact: input.impact ?? '用户无法打开天工页面',
    facts: ['健康检查退出码 1', '错误信息包含 ECONNREFUSED'],
    hypotheses: [{ statement: 'Web 进程已经退出', confidence: 'medium' }],
    proposed_action:
      input.action === undefined
        ? { action_id: 'restart-web', params: {} }
        : input.action === null
          ? null
          : { action_id: input.action.actionId, params: input.action.params },
    decision_required: input.decisionRequired ?? false,
    fix_required: input.fixRequired ?? false,
    summary: '先按已登记动作重启 Web，再复核健康检查',
  })
}

function opsRaw(overrides: {
  enabled?: boolean
  intervalSeconds?: number
  checkCommand?: string[]
  actionCommand?: string[]
  actionAuto?: boolean
  actionParams?: Array<{ name: string; values: string[] }>
  extraActions?: RawConfig['ops'] extends { actions?: infer T } ? T : never
} = {}): RawConfig {
  return {
    project: PROJECT,
    ops: {
      enabled: overrides.enabled ?? true,
      intervalSeconds: overrides.intervalSeconds ?? 60,
      resources: [{ id: 'web', kind: 'app', label: '天工页面' }],
      checks: [
        {
          id: 'web-health',
          resourceId: 'web',
          command: overrides.checkCommand ?? [
            'node',
            '-e',
            "process.exit(require('node:fs').existsSync('down') ? 1 : 0)",
          ],
          timeoutSeconds: 10,
          severity: 'major',
        },
      ],
      actions: [
        {
          id: 'restart-web',
          resourceId: 'web',
          command: overrides.actionCommand ?? [
            'node',
            '-e',
            "require('node:fs').rmSync('down', { force: true })",
          ],
          params: overrides.actionParams ?? [],
          timeoutSeconds: 10,
          auto: overrides.actionAuto ?? true,
          verifyCheckId: 'web-health',
        },
        ...(overrides.extraActions ?? []),
      ],
    },
  }
}

function makeOps(raw: RawConfig, runner: AgentLike): { ops: OpsRuntime; config: ForgeLoopConfig } {
  const config = resolveConfig(raw, dir)
  return {
    config,
    ops: new OpsRuntime({
      config,
      repo: repository,
      runner,
      now: () => clock,
    }),
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-ops-runtime-'))
  repository = new Repository(Database.open(join(dir, '.forgeloop', 'records.sqlite')))
  clock = new Date('2026-10-29T10:00:00.000Z')
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ops observation and event merging', () => {
  it('does nothing when ops is disabled', async () => {
    const { ops } = makeOps(opsRaw({ enabled: false }), fakeRunner(diagnosisText()))
    const outcome = await ops.tick()
    expect(outcome.skipped).toBe(true)
    expect(ops.list()).toEqual([])
  })

  it('opens one event for repeated identical failures and keeps both observations', async () => {
    const runner = fakeRunner(diagnosisText())
    const { ops } = makeOps(opsRaw({ intervalSeconds: 60 }), runner)
    writeFileSync(join(dir, 'down'), '1')

    await ops.tick()
    const first = ops.list()
    expect(first).toHaveLength(1)
    expect(first[0]?.state).toBe(OPS_RECOVERED)
    expect(runner.prompts).toHaveLength(1)

    // 让动作后的恢复检查再次失败，模拟故障复发；同一签名仍归并到已恢复事件之外的新事件。
    writeFileSync(join(dir, 'down'), '1')
    clock = new Date(clock.getTime() + 61_000)
    await ops.tick()
    const events = ops.list()
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.eventId)).not.toEqual([first[0]?.eventId, first[0]?.eventId])
  })

  it('merges a repeated failure while the event is still active', async () => {
    const runner = fakeRunner(diagnosisText({ action: null, decisionRequired: true }))
    const { ops } = makeOps(opsRaw({ intervalSeconds: 60 }), runner)
    writeFileSync(join(dir, 'down'), '1')

    await ops.tick()
    const eventId = ops.list()[0]!.eventId
    expect(ops.list()).toHaveLength(1)
    clock = new Date(clock.getTime() + 61_000)
    await ops.tick()

    const detail = ops.detail(eventId)!
    expect(detail.observations.filter((item) => item.kind === 'check')).toHaveLength(2)
    expect(runner.prompts).toHaveLength(1)
  })
})

describe('ops diagnosis and authorized recovery', () => {
  it('executes a catalog-authorized action, verifies recovery and records evidence', async () => {
    const runner = fakeRunner(diagnosisText())
    const { ops } = makeOps(opsRaw(), runner)
    writeFileSync(join(dir, 'down'), '1')

    const outcome = await ops.tick()
    expect(outcome.executed).toBe(1)
    expect(outcome.recovered).toBe(1)

    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_RECOVERED)
    expect(event.impact).toBe('用户无法打开天工页面')
    expect(event.recoveredAt).not.toBe('')
    expect(existsSync(join(dir, 'down'))).toBe(false)

    const detail = ops.detail(event.eventId)!
    expect(detail.attempts).toHaveLength(1)
    expect(detail.attempts[0]?.state).toBe('succeeded')
    expect(detail.attempts[0]?.authorizationSource).toBe('ops-action:auto:restart-web')
    expect(detail.attempts[0]?.evidencePath).toContain('ops/')
    expect(detail.observations.some((item) => item.kind === 'recovery')).toBe(true)
    expect(ops.stats().recovered).toBe(1)
    expect(ops.stats().humanInvolved).toBe(0)
  })

  it('waits for an owner decision on a non-auto action, then executes it after approval', async () => {
    const runner = fakeRunner(diagnosisText())
    const { ops } = makeOps(opsRaw({ actionAuto: false }), runner)
    writeFileSync(join(dir, 'down'), '1')

    await ops.tick()
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(ops.detail(event.eventId)?.attempts).toHaveLength(0)

    const approved = ops.decide({
      eventId: event.eventId,
      decision: 'approve',
      by: 'owner',
      source: 'test:owner',
    })
    expect(approved.ok).toBe(true)
    clock = new Date(clock.getTime() + 5_000)
    const outcome = await ops.tick()
    expect(outcome.executed).toBe(1)

    const recovered = ops.list()[0]!
    expect(recovered.state).toBe(OPS_RECOVERED)
    expect(recovered.humanInvolved).toBe(true)
    expect(ops.stats().humanInvolved).toBe(1)
    expect(ops.detail(event.eventId)?.attempts[0]?.authorizationSource).toBe('owner:owner:test:owner')
  })

  it('does not execute a proposed action that is not in the registered catalog', async () => {
    const runner = fakeRunner(
      diagnosisText({ action: { actionId: 'shell-anything', params: {} } }),
    )
    const { ops } = makeOps(opsRaw(), runner)
    writeFileSync(join(dir, 'down'), '1')

    await ops.tick()
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(ops.detail(event.eventId)?.attempts).toHaveLength(0)
    expect(ops.detail(event.eventId)?.event.impact).toContain('用户无法打开')
  })
})

describe('ops failure handling', () => {
  it('marks an unresolved event and files one linked fix requirement', async () => {
    const runner = fakeRunner(diagnosisText({ fixRequired: true }))
    const { ops } = makeOps(
      opsRaw({ actionCommand: ['node', '-e', 'process.exit(2)'] }),
      runner,
    )
    writeFileSync(join(dir, 'down'), '1')

    await ops.tick()
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_UNRESOLVED)
    expect(event.fixRequirementId).not.toBe('')

    const requirement = repository.getRequirement(event.fixRequirementId)!
    expect(requirement.source).toBe(`ops:${event.eventId}`)
    expect(requirement.versions[0]?.text).toContain(event.eventId)
    const requests = repository.requestsFor(requirement.reqId)
    expect(requests.map((request) => request.action)).toEqual(['analyze'])

    // 再跑一轮不会重复生成需求。
    clock = new Date(clock.getTime() + 61_000)
    await ops.tick()
    expect(ops.list().filter((item) => item.fixRequirementId === event.fixRequirementId)).toHaveLength(1)
  })

  it('records a timed-out action as failed and closes the event as unresolved without replay', async () => {
    const runner = fakeRunner(diagnosisText())
    // 把动作超时缩到 1 秒，避免测试等待。
    const raw = opsRaw({ actionCommand: ['node', '-e', 'setTimeout(() => {}, 60000)'] })
    const config = resolveConfig(raw, dir)
    const fast = new OpsRuntime({
      config: { ...config, ops: { ...config.ops, actions: config.ops.actions.map((action) => ({ ...action, timeoutSeconds: 1 })) } },
      repo: repository,
      runner,
      now: () => clock,
    })
    writeFileSync(join(dir, 'down'), '1')

    await fast.tick()
    const event = fast.list()[0]!
    expect(event.state).toBe(OPS_UNRESOLVED)
    const detail = fast.detail(event.eventId)!
    expect(detail.attempts[0]?.state).toBe(OPS_ATTEMPT_FAILED)
    expect(detail.attempts[0]?.exitCode).toBeNull()
    expect(detail.attempts[0]?.detail).toContain('没有退出码')
    // 超时后仍只用登记的恢复检查判定服务状态；检查失败即未解决，不猜成功。
    expect(detail.observations.some((item) => item.kind === 'recovery')).toBe(true)

    const before = detail.attempts.length
    clock = new Date(clock.getTime() + 61_000)
    await fast.tick()
    expect(fast.detail(event.eventId)?.attempts.length).toBe(before)
    expect(fast.list()[0]?.state).toBe(OPS_UNRESOLVED)
  })

  it('closes an interrupted unresolved event without a reconciliation confirmation', () => {
    const { ops } = makeOps(opsRaw(), fakeRunner(diagnosisText()))
    repository.createOpsEvent({
      eventId: 'ops-interrupted',
      project: PROJECT,
      resourceId: 'web',
      checkId: 'web-health',
      signature: 'web/web-health/1/manual',
      severity: 'major',
      state: OPS_UNRESOLVED,
      title: '人工构造的中断事件',
      openedAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    })
    repository.recordOpsActionAttempt({
      actionId: 'opa-interrupted',
      eventId: 'ops-interrupted',
      actionDefId: 'restart-web',
      state: OPS_ATTEMPT_INTERRUPTED,
      authorizationSource: 'owner:test',
      startedAt: clock.toISOString(),
    })

    const closed = ops.close({ eventId: 'ops-interrupted', by: 'owner', reason: '已核对外部状态' })
    expect(closed.ok).toBe(true)
    const event = ops.list().find((item) => item.eventId === 'ops-interrupted')!
    expect(event.state).toBe('closed')
    expect(event.humanInvolved).toBe(true)
  })

  it('asks the ops agent to report the root cause of an interrupted action exactly once', async () => {
    const prompts: string[] = []
    const runner: AgentLike = {
      async run(request) {
        prompts.push(request.prompt)
        if (request.prompt.includes('被中断的处置动作')) {
          return result(
            request,
            JSON.stringify({
              summary: '动作被宿主中断，结果没有记录',
              root_cause: '动作已开始但没有退出码，无法判断是否生效；不重放',
              evidence: ['动作 restart-web 已登记为 running', '没有退出码与恢复复核结果'],
              next_step: '人工检查 Web 进程和健康检查后决定是否重试',
            }),
          )
        }
        return result(request, diagnosisText())
      },
    }
    const { ops } = makeOps(opsRaw(), runner)
    repository.createOpsEvent({
      eventId: 'ops-interrupted',
      project: PROJECT,
      resourceId: 'web',
      checkId: 'web-health',
      signature: 'web/web-health/1/interrupted',
      severity: 'major',
      state: OPS_RECOVERING,
      title: '中断的动作',
      openedAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    })
    repository.recordOpsActionAttempt({
      actionId: 'opa-interrupted',
      eventId: 'ops-interrupted',
      actionDefId: 'restart-web',
      state: 'running',
      authorizationSource: 'owner:test',
      startedAt: clock.toISOString(),
    })
    repository.markRunningOpsActionsInterrupted(clock.toISOString())

    await ops.tick()
    const detail = ops.detail('ops-interrupted')!
    expect(ops.list().find((item) => item.eventId === 'ops-interrupted')?.state).toBe(OPS_UNRESOLVED)
    expect(detail.attempts[0]?.state).toBe(OPS_ATTEMPT_INTERRUPTED)
    const kinds = detail.observations.map((item) => item.kind)
    expect(kinds).toContain('interruption')
    expect(kinds).toContain('interruption_report')
    const report = detail.observations.find((item) => item.kind === 'interruption_report')!
    expect(report.summary).toContain('中断')
    expect(report.evidencePath).toContain('interruption-')
    expect(detail.attempts).toHaveLength(1)

    const calls = prompts.length
    clock = new Date(clock.getTime() + 61_000)
    await ops.tick()
    expect(prompts.length).toBe(calls)
  })
})
