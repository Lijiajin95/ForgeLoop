import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OpsRuntime, runOpsCommand } from '../src/runtime/ops.js'
import {
  resolveConfig,
  type ForgeLoopConfig,
  type RawConfig,
  type RawOpsAction,
  type RawOpsCheck,
} from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import {
  OPS_AWAITING_DECISION,
  OPS_CLOSED,
  OPS_DIAGNOSED,
  OPS_OPEN,
  OPS_RECOVERED,
  OPS_UNRESOLVED,
} from '../src/domain/ops.js'
import type { AgentLike } from '../src/runtime/service.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'

const PROJECT = 'forgeloop'
const PASSING_CHECK = ['node', '-e', 'process.exit(0)']
const FAILING_CHECK = ['node', '-e', 'process.exit(1)']
const TRUNCATED_MARK = '…（输出已截断）'

let dir = ''
let repository: Repository
let clock = new Date('2026-11-03T10:00:00.000Z')
let seeded = 0

interface FixtureOptions {
  checkCommand?: string[]
  actionCommand?: string[]
  params?: Array<{ name: string; values: string[] }>
  actionTimeoutSeconds?: number
  withDatabaseResource?: boolean
}

function rawConfig(options: FixtureOptions = {}): RawConfig {
  const resources = [{ id: 'web', kind: 'app', label: '页面' }]
  const checks: RawOpsCheck[] = [
    {
      id: 'web-health',
      resourceId: 'web',
      command: options.checkCommand ?? PASSING_CHECK,
      timeoutSeconds: 10,
      severity: 'major',
    },
  ]
  const actions: RawOpsAction[] = [
    {
      id: 'restart-web',
      resourceId: 'web',
      command: options.actionCommand ?? ['node', '-e', 'process.exit(0)'],
      params: options.params ?? [],
      timeoutSeconds: options.actionTimeoutSeconds ?? 10,
      auto: true,
      verifyCheckId: 'web-health',
    },
  ]
  if (options.withDatabaseResource) {
    resources.push({ id: 'db', kind: 'database', label: '业务库' })
    checks.push({
      id: 'db-health',
      resourceId: 'db',
      command: PASSING_CHECK,
      timeoutSeconds: 10,
      severity: 'minor',
    })
    actions.push({
      id: 'restart-db',
      resourceId: 'db',
      command: PASSING_CHECK,
      timeoutSeconds: 10,
      auto: false,
      verifyCheckId: 'db-health',
    })
  }
  return {
    project: PROJECT,
    ops: {
      enabled: true,
      intervalSeconds: 60,
      monitor: { enabled: false, intervalSeconds: 30 },
      resources,
      checks,
      actions,
    },
  }
}

function makeOps(
  runner: AgentLike,
  options: FixtureOptions = {},
): { ops: OpsRuntime; config: ForgeLoopConfig } {
  const config = resolveConfig(rawConfig(options), dir)
  return {
    config,
    ops: new OpsRuntime({ config, repo: repository, runner, now: () => clock }),
  }
}

function agentResult(
  request: AgentRunRequest,
  text: string,
  status: AgentRunResult['status'] = 'completed',
): AgentRunResult {
  return {
    status,
    text,
    sessionId: 'session-fake-ops',
    reason: status === 'completed' ? '' : 'fake failure',
    transcriptPath: request.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  }
}

function runnerOf(
  handler: (request: AgentRunRequest) => string | AgentRunResult,
): AgentLike & { calls: AgentRunRequest[] } {
  const calls: AgentRunRequest[] = []
  return {
    calls,
    async run(request) {
      calls.push(request)
      const produced = handler(request)
      return typeof produced === 'string' ? agentResult(request, produced) : produced
    },
  }
}

function unusedRunner(): AgentLike & { calls: AgentRunRequest[] } {
  return runnerOf(() => {
    throw new Error('runner must not be called')
  })
}

function diagnosisText(
  input: {
    actionId?: string | null
    params?: Record<string, string>
    fixRequired?: boolean
  } = {},
): string {
  return JSON.stringify({
    impact: '页面不可用',
    facts: ['健康检查退出码 1'],
    hypotheses: [{ statement: '进程退出', confidence: 'medium' }],
    proposed_action:
      input.actionId === null
        ? null
        : { action_id: input.actionId ?? 'restart-web', params: input.params ?? {} },
    decision_required: false,
    fix_required: input.fixRequired ?? false,
    summary: '按登记动作处置后复核',
  })
}

function seedEvent(
  input: {
    state?: string
    severity?: string
    resourceId?: string
    checkId?: string
    diagnosisJson?: string
    decision?: string
    decisionBy?: string
    decisionSource?: string
    impact?: string
    fixRequirementId?: string
    humanInvolved?: boolean
    signature?: string
    openedAt?: string
    recoveredAt?: string
    closedAt?: string
  } = {},
): string {
  seeded += 1
  const eventId = `ops-gap-${seeded}`
  const at = input.openedAt ?? clock.toISOString()
  repository.createOpsEvent({
    eventId,
    project: PROJECT,
    resourceId: input.resourceId ?? 'web',
    checkId: input.checkId ?? 'web-health',
    signature: input.signature ?? `signature-${eventId}`,
    severity: input.severity ?? 'major',
    state: input.state ?? OPS_OPEN,
    title: '测试构造的运维事件',
    impact: input.impact ?? '',
    openedAt: at,
    updatedAt: at,
  })
  const patch: {
    diagnosisJson?: string
    decision?: string
    decisionBy?: string
    decisionSource?: string
    fixRequirementId?: string
    humanInvolved?: boolean
    recoveredAt?: string
    closedAt?: string
  } = {}
  if (input.diagnosisJson !== undefined) patch.diagnosisJson = input.diagnosisJson
  if (input.decision !== undefined) patch.decision = input.decision
  if (input.decisionBy !== undefined) patch.decisionBy = input.decisionBy
  if (input.decisionSource !== undefined) patch.decisionSource = input.decisionSource
  if (input.fixRequirementId !== undefined) patch.fixRequirementId = input.fixRequirementId
  if (input.humanInvolved !== undefined) patch.humanInvolved = input.humanInvolved
  if (input.recoveredAt !== undefined) patch.recoveredAt = input.recoveredAt
  if (input.closedAt !== undefined) patch.closedAt = input.closedAt
  if (Object.keys(patch).length > 0) repository.updateOpsEvent(eventId, patch)
  return eventId
}

function seedApproved(
  input: { fixRequired?: boolean; params?: Record<string, string> } = {},
): string {
  return seedEvent({
    state: OPS_AWAITING_DECISION,
    decision: 'approved',
    decisionBy: 'alice',
    decisionSource: 'test:owner',
    diagnosisJson: diagnosisText(input),
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-ops-runtime-gap-'))
  repository = new Repository(Database.open(join(dir, '.forgeloop', 'records.sqlite')))
  clock = new Date('2026-11-03T10:00:00.000Z')
  seeded = 0
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('runOpsCommand', () => {
  it('rejects an empty argv without spawning anything', async () => {
    const result = await runOpsCommand([], dir, 1_000)
    expect(result).toEqual({
      code: 127,
      timedOut: false,
      aborted: false,
      stdout: '',
      stderr: '空命令',
    })
  })

  it('reports a missing executable as exit code 127 with the spawn error', async () => {
    const result = await runOpsCommand(['forgeloop-no-such-binary-xyz'], dir, 1_000)
    expect(result.code).toBe(127)
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('ENOENT')
    expect(result.stderr).toContain('forgeloop-no-such-binary-xyz')
  })

  it('keeps the real exit code and both output streams', async () => {
    const result = await runOpsCommand(
      [
        'node',
        '-e',
        "process.stdout.write('stdout-line');process.stderr.write('stderr-line');process.exit(3)",
      ],
      dir,
      5_000,
    )
    expect(result.code).toBe(3)
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.stdout).toBe('stdout-line')
    expect(result.stderr).toBe('stderr-line')
  })

  it('aborts before spawning and kills a command that is already running', async () => {
    const marker = join(dir, 'aborted-marker')
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`
    const early = await runOpsCommand(['node', '-e', script], dir, 1_000, AbortSignal.abort())
    expect(early).toEqual({
      code: 130,
      timedOut: false,
      aborted: true,
      stdout: '',
      stderr: '已取消',
    })
    expect(existsSync(marker)).toBe(false)

    const controller = new AbortController()
    const running = runOpsCommand(
      ['node', '-e', 'setTimeout(() => {}, 60000)'],
      dir,
      5_000,
      controller.signal,
    )
    controller.abort()
    const result = await running
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.code).not.toBe(0)
  })

  it('kills a command on timeout and marks it timed out rather than successful', async () => {
    const startedAt = Date.now()
    const result = await runOpsCommand(['node', '-e', 'setTimeout(() => {}, 60000)'], dir, 200)
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.code).not.toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('truncates oversized output and leaves exactly one truncation mark', async () => {
    const result = await runOpsCommand(
      [
        'node',
        '-e',
        "process.stdout.write('x'.repeat(300 * 1024));setTimeout(() => { process.stdout.write('tail') }, 100)",
      ],
      dir,
      10_000,
    )
    expect(result.code).toBe(0)
    expect(result.stdout.startsWith('xxxx')).toBe(true)
    expect(result.stdout.endsWith(TRUNCATED_MARK)).toBe(true)
    expect(result.stdout.split(TRUNCATED_MARK)).toHaveLength(2)
    expect(result.stdout.length).toBeGreaterThanOrEqual(256 * 1024)
    expect(result.stdout.length).toBeLessThan(300 * 1024)
    expect(result.stdout.endsWith('tail')).toBe(false)
  })
})

describe('OpsRuntime decisions', () => {
  it('rejects decisions for unknown events and for events not awaiting a decision', () => {
    const { ops } = makeOps(unusedRunner())

    const missing = ops.decide({
      eventId: 'ops-absent',
      decision: 'approve',
      by: 'owner',
      source: 'test',
    })
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe('not_found')
    expect(missing.message).toContain('ops-absent')

    const recovered = seedEvent({ state: OPS_RECOVERED })
    const wrongState = ops.decide({
      eventId: recovered,
      decision: 'approve',
      by: 'owner',
      source: 'test',
    })
    expect(wrongState.ok).toBe(false)
    expect(wrongState.code).toBe('not_awaiting_decision')
    expect(wrongState.message).toContain('recovered')
    expect(repository.opsObservations(recovered)).toEqual([])
  })

  it('refuses to approve an event whose diagnosis proposed no action', () => {
    const { ops } = makeOps(unusedRunner())
    const eventId = seedEvent({
      state: OPS_AWAITING_DECISION,
      diagnosisJson: diagnosisText({ actionId: null }),
    })

    const decided = ops.decide({
      eventId,
      decision: 'approve',
      by: 'owner',
      source: 'test',
    })
    expect(decided.ok).toBe(false)
    expect(decided.code).toBe('no_action')
    expect(decided.message).toBe('该事件没有可批准的处置建议')
    expect(repository.opsEvent(eventId)?.state).toBe(OPS_AWAITING_DECISION)
    expect(repository.opsEvent(eventId)?.humanInvolved).toBe(false)
  })

  it('refuses to approve an action that is no longer in the catalog', () => {
    const { ops } = makeOps(unusedRunner())
    const eventId = seedEvent({
      state: OPS_AWAITING_DECISION,
      diagnosisJson: diagnosisText({ actionId: 'ghost-action' }),
    })

    const decided = ops.decide({
      eventId,
      decision: 'approve',
      by: 'owner',
      source: 'test',
    })
    expect(decided.ok).toBe(false)
    expect(decided.code).toBe('action_missing')
    expect(decided.message).toContain('ghost-action')
    expect(repository.opsEvent(eventId)?.decision).toBe('')
  })

  it('refuses stored parameters outside the registered values without recording a decision', () => {
    const { ops } = makeOps(unusedRunner(), {
      params: [{ name: 'mode', values: ['graceful'] }],
      actionCommand: ['node', '-e', 'process.exit(0)', '{mode}'],
    })
    const eventId = seedEvent({
      state: OPS_AWAITING_DECISION,
      diagnosisJson: diagnosisText({ params: { mode: 'force' } }),
    })

    const decided = ops.decide({
      eventId,
      decision: 'approve',
      by: 'owner',
      source: 'test',
    })
    expect(decided.ok).toBe(false)
    expect(decided.code).toBe('invalid_params')
    expect(decided.message).toContain('mode')
    expect(decided.message).toContain('不在允许值内')
    const event = repository.opsEvent(eventId)
    expect(event?.state).toBe(OPS_AWAITING_DECISION)
    expect(event?.decision).toBe('')
    expect(event?.humanInvolved).toBe(false)
    expect(repository.opsObservations(eventId)).toEqual([])
  })
})

describe('OpsRuntime close and fix requests', () => {
  it('reports missing events for close and requestFix', () => {
    const { ops } = makeOps(unusedRunner())

    const closed = ops.close({ eventId: 'ops-ghost-close', by: 'owner', reason: '核对外部状态' })
    expect(closed.ok).toBe(false)
    expect(closed.code).toBe('not_found')
    expect(closed.message).toContain('ops-ghost-close')

    const fixed = ops.requestFix({ eventId: 'ops-ghost-fix', by: 'owner', source: 'test' })
    expect(fixed.ok).toBe(false)
    expect(fixed.code).toBe('not_found')
    expect(fixed.message).toContain('ops-ghost-fix')
    expect(repository.listOpsEvents(PROJECT)).toEqual([])
  })
})

describe('OpsRuntime views and stats', () => {
  it('lists unregistered resources with fallbacks and the latest observation summary', () => {
    const { ops } = makeOps(unusedRunner())
    const eventId = seedEvent({
      resourceId: 'legacy-host',
      checkId: 'legacy-check',
      diagnosisJson: '{not json',
    })
    repository.appendOpsObservation({
      eventId,
      at: clock.toISOString(),
      kind: 'check',
      summary: '第一次检查摘要',
    })
    repository.appendOpsObservation({
      eventId,
      at: clock.toISOString(),
      kind: 'check',
      summary: '最后一次检查摘要',
    })

    const [view] = ops.list()
    expect(view?.eventId).toBe(eventId)
    expect(view?.resourceId).toBe('legacy-host')
    expect(view?.resourceLabel).toBe('legacy-host')
    expect(view?.resourceKind).toBe('other')
    expect(view?.lastObservation).toBe('最后一次检查摘要')
    expect(view?.diagnosis).toBeNull()
    expect(view?.decision).toBe('')
    expect(view?.humanInvolved).toBe(false)
  })

  it('returns catalog lookups, observations and attempts in detail, and null for a missing event', () => {
    const { ops } = makeOps(unusedRunner(), { withDatabaseResource: true })
    const eventId = seedEvent({ diagnosisJson: diagnosisText() })
    repository.appendOpsObservation({
      eventId,
      at: clock.toISOString(),
      kind: 'check',
      summary: '详情检查摘要',
    })
    repository.recordOpsActionAttempt({
      actionId: 'opa-detail',
      eventId,
      actionDefId: 'restart-web',
      state: 'succeeded',
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: clock.toISOString(),
    })

    const detail = ops.detail(eventId)
    expect(detail?.event.eventId).toBe(eventId)
    expect(detail?.resource?.id).toBe('web')
    expect(detail?.check?.id).toBe('web-health')
    expect(detail?.actions.map((action) => action.id)).toEqual(['restart-web'])
    expect(detail?.observations).toHaveLength(1)
    expect(detail?.observations[0]?.summary).toBe('详情检查摘要')
    expect(detail?.attempts).toHaveLength(1)
    expect(detail?.attempts[0]?.state).toBe('succeeded')
    expect(detail?.diagnosis?.proposedAction?.actionId).toBe('restart-web')
    expect(ops.detail('ops-missing')).toBeNull()
  })

  it('reports empty statistics without inventing a recovery duration', () => {
    const { ops } = makeOps(unusedRunner())
    expect(ops.stats()).toEqual({
      total: 0,
      humanInvolved: 0,
      humanRate: 0,
      recovered: 0,
      unresolved: 0,
      awaitingDecision: 0,
      active: 0,
      closed: 0,
      fixRequirements: 0,
      averageRecoverySeconds: null,
    })
  })

  it('aggregates states, human involvement and only sane recovery durations', () => {
    const { ops } = makeOps(unusedRunner())
    const base = clock.getTime()
    const iso = (offsetSeconds: number): string =>
      new Date(base + offsetSeconds * 1_000).toISOString()

    seedEvent({
      state: OPS_RECOVERED,
      openedAt: iso(0),
      recoveredAt: iso(120),
    })
    seedEvent({
      state: OPS_RECOVERED,
      openedAt: iso(300),
      recoveredAt: iso(100),
    })
    seedEvent({
      state: OPS_UNRESOLVED,
      humanInvolved: true,
      fixRequirementId: 'req-existing',
    })
    seedEvent({ state: OPS_AWAITING_DECISION })
    seedEvent({ state: OPS_CLOSED, closedAt: iso(10) })
    seedEvent({ state: OPS_OPEN })

    const stats = ops.stats()
    expect(stats.total).toBe(6)
    expect(stats.recovered).toBe(2)
    expect(stats.unresolved).toBe(1)
    expect(stats.awaitingDecision).toBe(1)
    expect(stats.closed).toBe(1)
    expect(stats.active).toBe(3)
    expect(stats.humanInvolved).toBe(1)
    expect(stats.fixRequirements).toBe(1)
    expect(stats.humanRate).toBeCloseTo(1 / 6, 10)
    expect(stats.averageRecoverySeconds).toBe(120)
  })
})

describe('OpsRuntime diagnosis failures', () => {
  it('records an incomplete diagnosis and leaves the event open', async () => {
    const runner = runnerOf((request) => agentResult(request, '', 'failed'))
    const { ops } = makeOps(runner, { checkCommand: FAILING_CHECK })

    const outcome = await ops.tick()
    expect(outcome.checked).toBe(1)
    expect(outcome.diagnosed).toBe(1)
    expect(runner.calls).toHaveLength(1)
    const [event] = ops.list()
    expect(event?.state).toBe(OPS_OPEN)
    expect(event?.diagnosis).toBeNull()
    const lastObservation = ops.detail(event!.eventId)!.observations.at(-1)
    expect(lastObservation?.kind).toBe('diagnosis_error')
    expect(lastObservation?.summary).toBe('诊断未完成：fake failure')
  })

  it('records a malformed diagnosis without treating it as a conclusion', async () => {
    const runner = runnerOf(() => 'this is not a diagnosis')
    const { ops } = makeOps(runner, { checkCommand: FAILING_CHECK })

    const outcome = await ops.tick()
    expect(outcome.diagnosed).toBe(1)
    expect(outcome.errors).toEqual([])
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_OPEN)
    expect(event.diagnosis).toBeNull()
    const lastObservation = ops.detail(event.eventId)!.observations.at(-1)
    expect(lastObservation?.kind).toBe('diagnosis_error')
    expect(lastObservation?.summary.startsWith('诊断结果畸形：')).toBe(true)
  })

  it('surfaces a thrown runner error per event without changing its state', async () => {
    const runner = runnerOf(() => {
      throw new Error('runner exploded')
    })
    const { ops } = makeOps(runner, { checkCommand: FAILING_CHECK })

    const outcome = await ops.tick()
    expect(runner.calls).toHaveLength(1)
    expect(outcome.errors).toHaveLength(1)
    expect(outcome.errors[0]).toContain('runner exploded')
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_OPEN)
    expect(
      ops.detail(event.eventId)!.observations.some((item) => item.kind === 'diagnosis_error'),
    ).toBe(false)
  })

  it('hands an action missing from the catalog to the owner without executing it', async () => {
    const runner = runnerOf(() => diagnosisText({ actionId: 'ghost-action' }))
    const { ops } = makeOps(runner, { checkCommand: FAILING_CHECK })

    const outcome = await ops.tick()
    expect(outcome.executed).toBe(0)
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(event.diagnosis?.proposedAction?.actionId).toBe('ghost-action')
    const detail = ops.detail(event.eventId)!
    expect(detail.attempts).toHaveLength(0)
    expect(detail.observations.at(-1)?.kind).toBe('decision_required')
    expect(detail.observations.at(-1)?.summary).toBe('诊断没有给出可执行动作，等待所有者决定')
  })

  it('stops automatic diagnosis after three failed attempts and asks for a human', async () => {
    const runner = unusedRunner()
    const { ops } = makeOps(runner)
    const eventId = seedEvent({ state: OPS_OPEN })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      repository.appendOpsObservation({
        eventId,
        at: clock.toISOString(),
        kind: 'diagnosis_error',
        summary: `第 ${attempt} 次诊断失败`,
      })
    }

    const outcome = await ops.tick()
    expect(runner.calls).toHaveLength(0)
    expect(outcome.diagnosed).toBe(1)
    const event = ops.list().find((item) => item.eventId === eventId)!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(event.impact).toBe('自动诊断多次未完成，需要人工判断')
    expect(ops.detail(eventId)!.observations.at(-1)?.summary).toBe(
      '自动诊断连续 3 次未完成，等待人工判断',
    )
  })
})

describe('OpsRuntime execution failures', () => {
  it('leaves a pending approved event without a diagnosis under owner decision', async () => {
    const { ops } = makeOps(unusedRunner())
    const eventId = seedEvent({
      state: OPS_AWAITING_DECISION,
      decision: 'approved',
      decisionBy: 'alice',
      decisionSource: 'test:owner',
    })

    const outcome = await ops.tick()
    expect(outcome.executed).toBe(0)
    const event = ops.list().find((item) => item.eventId === eventId)!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    const detail = ops.detail(eventId)!
    expect(detail.attempts).toHaveLength(0)
    expect(detail.observations.at(-1)?.summary).toBe('诊断提出的动作已不在登记目录中，等待人工处理')
  })

  it('never replays an event that already has an action attempt', async () => {
    const { ops } = makeOps(unusedRunner())
    const eventId = seedEvent({ state: OPS_DIAGNOSED, diagnosisJson: diagnosisText() })
    repository.recordOpsActionAttempt({
      actionId: 'opa-existing',
      eventId,
      actionDefId: 'restart-web',
      state: 'failed',
      exitCode: 1,
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: clock.toISOString(),
    })
    const observationsBefore = ops.detail(eventId)!.observations.length

    const outcome = await ops.tick()
    expect(outcome.executed).toBe(0)
    expect(outcome.unresolved).toBe(0)
    expect(ops.list().find((item) => item.eventId === eventId)?.state).toBe(OPS_DIAGNOSED)
    const detail = ops.detail(eventId)!
    expect(detail.attempts).toHaveLength(1)
    expect(detail.observations).toHaveLength(observationsBefore)
  })

  it('returns an event to the owner when the approved parameters violate the catalog', async () => {
    const { ops } = makeOps(unusedRunner(), {
      params: [{ name: 'mode', values: ['graceful'] }],
      actionCommand: ['node', '-e', 'process.exit(0)', '{mode}'],
    })
    const eventId = seedApproved({ params: { mode: 'force' } })

    const outcome = await ops.tick()
    expect(outcome.executed).toBe(0)
    const detail = ops.detail(eventId)!
    expect(detail.event.state).toBe(OPS_AWAITING_DECISION)
    expect(detail.attempts).toHaveLength(0)
    expect(detail.observations.at(-1)?.summary).toBe(
      '动作 restart-web 的参数 mode 取值 "force" 不在允许值内',
    )
  })

  it('records a failing action as unresolved and files the required fix', async () => {
    const { ops } = makeOps(unusedRunner(), {
      actionCommand: ['node', '-e', 'process.exit(2)'],
    })
    const eventId = seedApproved({ fixRequired: true })

    const outcome = await ops.tick()
    expect(outcome.executed).toBe(1)
    expect(outcome.unresolved).toBe(1)
    expect(outcome.recovered).toBe(0)
    const event = ops.list().find((item) => item.eventId === eventId)!
    expect(event.state).toBe(OPS_UNRESOLVED)
    expect(event.fixRequirementId).toMatch(/^req-/)
    const detail = ops.detail(eventId)!
    const attempt = detail.attempts[0]!
    expect(attempt.state).toBe('failed')
    expect(attempt.exitCode).toBe(2)
    expect(attempt.detail).toBe('动作退出码 2')
    expect(detail.observations.find((item) => item.kind === 'action')?.summary).toBe(
      '动作 restart-web 失败：退出码 2',
    )
    const requirement = repository.getRequirement(event.fixRequirementId)!
    expect(requirement.versions[0]?.text).toContain('restart-web（failed，退出码 2）')
  })

  it('reuses the fix requirement of an earlier event with the same signature', async () => {
    const signature = 'svc/svc-health/repeat'
    seedEvent({
      state: OPS_RECOVERED,
      signature,
      openedAt: '2026-11-03T09:00:00.000Z',
      fixRequirementId: 'req-existing-fix',
      diagnosisJson: diagnosisText({ fixRequired: true }),
    })
    const { ops } = makeOps(unusedRunner(), {
      actionCommand: ['node', '-e', 'process.exit(0)'],
    })
    const repeated = seedEvent({
      state: OPS_AWAITING_DECISION,
      // 签名带输出摘要，重复崩溃的签名可能不同；按资源+检查复用。
      signature: 'svc/svc-health/1/other-digest',
      decision: 'approved',
      decisionBy: 'alice',
      decisionSource: 'test:owner',
      diagnosisJson: diagnosisText({ fixRequired: true }),
    })

    await ops.tick()
    const event = ops.list().find((item) => item.eventId === repeated)!
    // 不为重复事件新建需求，直接复用同一签名的在办修复需求。
    expect(event.fixRequirementId).toBe('req-existing-fix')
    expect(repository.listRequirements?.().length ?? 0).toBe(0)
  })

  it('records a timed-out action as failed but still accepts a passing recovery check', async () => {
    const { ops } = makeOps(unusedRunner(), {
      actionCommand: ['node', '-e', 'setTimeout(() => {}, 60000)'],
      actionTimeoutSeconds: 0.3,
    })
    const eventId = seedApproved()

    const outcome = await ops.tick()
    expect(outcome.executed).toBe(1)
    expect(outcome.recovered).toBe(1)
    expect(outcome.unresolved).toBe(0)
    const event = ops.list().find((item) => item.eventId === eventId)!
    expect(event.state).toBe(OPS_RECOVERED)
    expect(event.recoveredAt).not.toBe('')
    const detail = ops.detail(eventId)!
    const attempt = detail.attempts[0]!
    expect(attempt.state).toBe('failed')
    expect(attempt.exitCode).toBeNull()
    expect(attempt.detail).toContain('动作超时')
    expect(detail.attempts).toHaveLength(1)
    const summaries = detail.observations.map((item) => item.summary)
    expect(summaries.some((summary) => summary.includes('未完成（超时）'))).toBe(true)
    expect(summaries).toContain('恢复复核通过：web-health 退出码 0')
  })
})
