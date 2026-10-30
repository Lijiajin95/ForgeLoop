import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveConfig,
  type ForgeLoopConfig,
  type RawConfig,
  type RawOpsAction,
  type RawOpsCheck,
} from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { OpsRuntime, runOpsCommand } from '../src/runtime/ops.js'
import type { AgentLike } from '../src/runtime/service.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import {
  OPS_AWAITING_DECISION,
  OPS_CLOSED,
  OPS_OPEN,
  OPS_RECOVERING,
  OPS_RECOVERED,
  OPS_UNRESOLVED,
} from '../src/domain/ops.js'

const PROJECT = 'forgeloop'
let dir = ''
let repository: Repository
let clock = new Date('2026-10-29T10:00:00.000Z')
let seeded = 0

function result(
  request: AgentRunRequest,
  text: string,
  status: AgentRunResult['status'] = 'completed',
): AgentRunResult {
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

function runnerOf(
  handler: (request: AgentRunRequest) => string | AgentRunResult,
): AgentLike & { prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    async run(request) {
      prompts.push(request.prompt)
      const produced = handler(request)
      return typeof produced === 'string'
        ? result(request, produced)
        : { ...produced, transcriptPath: request.transcriptPath }
    },
  }
}

function diagnosisText(input: {
  actionId?: string | null
  params?: Record<string, string>
  fixRequired?: boolean
} = {}): string {
  return JSON.stringify({
    impact: '用户无法打开天工页面',
    facts: ['健康检查退出码 1'],
    hypotheses: [{ statement: 'Web 进程已经退出', confidence: 'medium' }],
    proposed_action:
      input.actionId === null
        ? null
        : { action_id: input.actionId ?? 'restart-web', params: input.params ?? {} },
    decision_required: false,
    fix_required: input.fixRequired ?? false,
    summary: '先按已登记动作重启 Web，再复核健康检查',
  })
}

function raw(options: {
  checks?: RawOpsCheck[]
  actions?: RawOpsAction[]
  checkCommand?: string[]
  actionCommand?: string[]
  params?: Array<{ name: string; values: string[] }>
  auto?: boolean
} = {}): RawConfig {
  const params = options.params
  const defaultAction: RawOpsAction = {
    id: 'restart-web',
    resourceId: 'web',
    command:
      options.actionCommand ??
      (params
        ? ['node', '-e', 'process.exit(0)', '{mode}']
        : ['node', '-e', "require('node:fs').rmSync('down', { force: true })"]),
    params,
    timeoutSeconds: 10,
    auto: options.auto ?? true,
    verifyCheckId: 'web-health',
  }
  return {
    project: PROJECT,
    ops: {
      enabled: true,
      intervalSeconds: 60,
      resources: [
        { id: 'web', kind: 'app', label: '天工页面' },
        { id: 'db', kind: 'database', label: '业务库' },
      ],
      checks:
        options.checks ??
        [
          {
            id: 'web-health',
            resourceId: 'web',
            command: options.checkCommand ?? [
              'node',
              '-e',
              "process.exit(require('node:fs').existsSync('down') ? 1 : 0)",
            ],
            timeoutSeconds: 10,
            severity: 'major',
          },
          {
            id: 'db-health',
            resourceId: 'db',
            command: ['node', '-e', 'process.exit(0)'],
            timeoutSeconds: 10,
            severity: 'minor',
          },
        ],
      actions:
        options.actions ??
        [
          defaultAction,
          {
            id: 'restart-db',
            resourceId: 'db',
            command: ['node', '-e', 'process.exit(0)'],
            timeoutSeconds: 10,
            auto: true,
            verifyCheckId: 'db-health',
          },
        ],
    },
  }
}

function makeOps(rawConfig: RawConfig, runner: AgentLike): { ops: OpsRuntime; config: ForgeLoopConfig } {
  const config = resolveConfig(rawConfig, dir)
  return {
    config,
    ops: new OpsRuntime({ config, repo: repository, runner, now: () => clock }),
  }
}

function seedEvent(input: {
  state?: string
  checkId?: string
  diagnosisJson?: string
  eventId?: string
} = {}): string {
  seeded += 1
  const eventId = input.eventId ?? `ops-seed-${seeded}`
  const at = clock.toISOString()
  repository.createOpsEvent({
    eventId,
    project: PROJECT,
    resourceId: 'web',
    checkId: input.checkId ?? 'web-health',
    signature: `signature-${eventId}`,
    severity: 'major',
    state: input.state ?? OPS_OPEN,
    title: '人工构造的运维事件',
    openedAt: at,
    updatedAt: at,
  })
  if (input.diagnosisJson) {
    repository.updateOpsEvent(eventId, { diagnosisJson: input.diagnosisJson })
  }
  return eventId
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-ops-controls-'))
  repository = new Repository(Database.open(join(dir, '.forgeloop', 'records.sqlite')))
  clock = new Date('2026-10-29T10:00:00.000Z')
  seeded = 0
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ops owner decisions', () => {
  it('declines a pending action, keeps the event unresolved and files the requested fix', async () => {
    const runner = runnerOf(() => diagnosisText({ fixRequired: true }))
    const { ops } = makeOps(raw({ auto: false }), runner)
    writeFileSync(join(dir, 'down'), '1')

    await ops.tick()
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_AWAITING_DECISION)

    const declined = ops.decide({
      eventId: event.eventId,
      decision: 'decline',
      by: 'owner',
      source: 'test:owner',
    })
    expect(declined.ok).toBe(true)

    const after = ops.list()[0]!
    expect(after.state).toBe(OPS_UNRESOLVED)
    expect(after.humanInvolved).toBe(true)
    expect(after.fixRequirementId).not.toBe('')
    const requirement = repository.getRequirement(after.fixRequirementId)!
    expect(requirement.versions[0]?.text).toContain('未执行处置动作')
    expect(ops.stats().unresolved).toBe(1)
    expect(ops.stats().humanRate).toBe(1)
  })

  it('rejects decisions that do not match the state, diagnosis or registered catalog', () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(raw(), runner)

    expect(ops.decide({ eventId: 'ops-missing', decision: 'approve', by: 'owner', source: 'test' }).code).toBe(
      'not_found',
    )

    const recovered = seedEvent({ state: OPS_RECOVERED })
    expect(
      ops.decide({ eventId: recovered, decision: 'approve', by: 'owner', source: 'test' }).code,
    ).toBe('not_awaiting_decision')

    const actionless = seedEvent({ state: OPS_AWAITING_DECISION })
    expect(
      ops.decide({ eventId: actionless, decision: 'approve', by: 'owner', source: 'test' }).code,
    ).toBe('no_action')

    const withoutActions = makeOps(raw({ actions: [] }), runner).ops
    const missingAction = seedEvent({
      state: OPS_AWAITING_DECISION,
      diagnosisJson: diagnosisText(),
    })
    expect(
      withoutActions.decide({ eventId: missingAction, decision: 'approve', by: 'owner', source: 'test' }).code,
    ).toBe('action_missing')
  })

  it('rejects a decision whose stored parameters are outside the catalog values', () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(raw({ params: [{ name: 'mode', values: ['graceful'] }] }), runner)
    const eventId = seedEvent({
      state: OPS_AWAITING_DECISION,
      diagnosisJson: diagnosisText({ params: { mode: 'force' } }),
    })

    const decided = ops.decide({ eventId, decision: 'approve', by: 'owner', source: 'test' })
    expect(decided.ok).toBe(false)
    expect(decided.code).toBe('invalid_params')
    expect(ops.list()[0]?.state).toBe(OPS_AWAITING_DECISION)
  })

  it('closes an unresolved event without any reconciliation confirmation', () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(raw(), runner)
    const unresolved = seedEvent({ state: OPS_UNRESOLVED })
    const closed = ops.close({ eventId: unresolved, by: 'owner', reason: '人工核对外部状态后关闭' })
    expect(closed.ok).toBe(true)
    const event = ops.list().find((item) => item.eventId === unresolved)!
    expect(event.state).toBe(OPS_CLOSED)
    expect(event.humanInvolved).toBe(true)
  })

  it('closes resolved events, refuses a second close and protects running actions', () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(raw(), runner)

    const resolved = seedEvent({ state: OPS_RECOVERED })
    const closed = ops.close({ eventId: resolved, by: 'owner', reason: '' })
    expect(closed.ok).toBe(true)
    expect(ops.list().find((event) => event.eventId === resolved)?.state).toBe(OPS_CLOSED)
    expect(ops.stats().closed).toBe(1)
    expect(ops.close({ eventId: resolved, by: 'owner', reason: '再次关闭' }).code).toBe('already_closed')

    const running = seedEvent({ state: OPS_RECOVERING })
    repository.recordOpsActionAttempt({
      actionId: 'opa-running',
      eventId: running,
      actionDefId: 'restart-web',
      state: 'running',
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: clock.toISOString(),
    })
    expect(ops.close({ eventId: running, by: 'owner', reason: '关闭' }).code).toBe('action_running')
  })

  it('files a fix requirement on demand once and only with a diagnosis in a compatible state', async () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(raw(), runner)
    writeFileSync(join(dir, 'down'), '1')

    await ops.tick()
    const event = ops.list().find((item) => item.state === OPS_RECOVERED)!

    expect(ops.requestFix({ eventId: 'ops-missing', by: 'owner', source: 'test' }).code).toBe('not_found')
    const unreadable = seedEvent({ state: OPS_CLOSED })
    expect(ops.requestFix({ eventId: unreadable, by: 'owner', source: 'test' }).code).toBe('no_diagnosis')
    const diagnosed = seedEvent({ state: OPS_CLOSED, diagnosisJson: diagnosisText() })
    expect(ops.requestFix({ eventId: diagnosed, by: 'owner', source: 'test' }).code).toBe('state_conflict')

    const first = ops.requestFix({ eventId: event.eventId, by: 'owner', source: 'test:owner' })
    expect(first.ok).toBe(true)
    const reqId = (first.data as { reqId: string }).reqId
    const requirement = repository.getRequirement(reqId)!
    expect(requirement.versions[0]?.text).toContain('天工页面')
    expect(requirement.versions[0]?.text).toContain('restart-web（succeeded，退出码 0）')
    expect(ops.list().find((item) => item.eventId === event.eventId)?.humanInvolved).toBe(true)

    const second = ops.requestFix({ eventId: event.eventId, by: 'owner', source: 'test:owner' })
    expect((second.data as { reqId: string }).reqId).toBe(reqId)
    expect(ops.stats().fixRequirements).toBe(1)
  })
})

describe('ops diagnosis boundaries', () => {
  it('counts failed diagnoses and hands the event to a human after three attempts', async () => {
    const runner = runnerOf((request) => result(request, '', 'failed'))
    const { ops } = makeOps(raw(), runner)
    writeFileSync(join(dir, 'down'), '1')

    await ops.tick()
    const eventId = ops.list()[0]!.eventId
    expect(ops.list()[0]?.state).toBe(OPS_OPEN)
    expect(ops.detail(eventId)?.observations.some((item) => item.kind === 'diagnosis_error')).toBe(true)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      clock = new Date(clock.getTime() + 61_000)
      await ops.tick()
    }
    const final = ops.list().find((item) => item.eventId === eventId)!
    expect(final.state).toBe(OPS_AWAITING_DECISION)
    expect(final.impact).toContain('自动诊断多次未完成')
    expect(runner.prompts).toHaveLength(3)
  })

  it('records a malformed diagnosis without changing the event state', async () => {
    const runner = runnerOf(() => 'not json at all')
    const { ops } = makeOps(raw(), runner)
    writeFileSync(join(dir, 'down'), '1')

    await ops.tick()
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_OPEN)
    expect(event.diagnosis).toBeNull()
    expect(ops.detail(event.eventId)?.observations.some((item) => item.kind === 'diagnosis_error')).toBe(true)
  })

  it('keeps an action proposed for another resource with the owner', async () => {
    const runner = runnerOf(() => diagnosisText({ actionId: 'restart-db' }))
    const { ops } = makeOps(raw(), runner)
    writeFileSync(join(dir, 'down'), '1')

    await ops.tick()
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(ops.detail(event.eventId)?.attempts).toHaveLength(0)
    expect(ops.detail(event.eventId)?.observations.at(-1)?.summary).toContain('不属于事件资源')
  })

  it('stops automatic diagnosis when the registered check is gone', async () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(raw(), runner)
    const eventId = seedEvent({ checkId: 'gone-check' })

    await ops.tick()
    const event = ops.list().find((item) => item.eventId === eventId)!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(ops.detail(eventId)?.observations.at(-1)?.summary).toContain('已不在登记目录中')
    expect(runner.prompts).toHaveLength(0)
  })

  it('falls back to the observation summary when stored output is not readable', async () => {
    const runner = runnerOf(() => diagnosisText({ actionId: null }))
    const { ops } = makeOps(raw(), runner)
    const eventId = seedEvent()
    repository.appendOpsObservation({
      eventId,
      at: clock.toISOString(),
      kind: 'check',
      summary: '检查摘要保留',
      detailJson: 'not-json',
    })

    await ops.tick()
    expect(runner.prompts[0]).toContain('检查摘要保留')
  })
})

describe('ops command and recovery boundaries', () => {
  it('treats a successful action without a passing recovery check as unresolved', async () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(raw({ actionCommand: ['node', '-e', 'process.exit(0)'] }), runner)
    writeFileSync(join(dir, 'down'), '1')

    const outcome = await ops.tick()
    expect(outcome.recovered).toBe(0)
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_UNRESOLVED)
    expect(event.recoveredAt).toBe('')
    expect(ops.detail(event.eventId)?.attempts[0]?.state).toBe('succeeded')
    expect(ops.detail(event.eventId)?.observations.at(-1)?.summary).toContain('恢复复核未通过')
  })

  it('keeps stdout and stderr in the check evidence', async () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(
      raw({
        checkCommand: [
          'node',
          '-e',
          "process.stdout.write('out-line');process.stderr.write('err-line');process.exit(1)",
        ],
      }),
      runner,
    )

    await ops.tick()
    const event = ops.list()[0]!
    const observation = ops.detail(event.eventId)!.observations.find((item) => item.kind === 'check')!
    expect(observation.detailJson).toContain('out-line')
    expect(observation.detailJson).toContain('[stderr]')
    expect(observation.detailJson).toContain('err-line')
  })

  it('reports empty, missing and aborted commands without throwing', async () => {
    const empty = await runOpsCommand([], dir, 100)
    expect(empty.code).toBe(127)
    expect(empty.stderr).toContain('空命令')

    const missing = await runOpsCommand(['forgeloop-no-such-binary'], dir, 1_000)
    expect(missing.code).toBe(127)
    expect(missing.stderr).not.toBe('')

    const cancelled = await runOpsCommand(
      ['node', '-e', 'process.exit(0)'],
      dir,
      1_000,
      AbortSignal.abort(),
    )
    expect(cancelled.aborted).toBe(true)
    expect(cancelled.code).toBe(130)

    const controller = new AbortController()
    const running = runOpsCommand(['node', '-e', 'setTimeout(() => {}, 60000)'], dir, 5_000, controller.signal)
    controller.abort()
    expect((await running).aborted).toBe(true)
  })

  it('skips a second tick while the first is still running', async () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(
      raw({ checkCommand: ['node', '-e', 'setTimeout(() => {}, 700)'] }),
      runner,
    )

    const first = ops.tick()
    const second = await ops.tick()
    expect(second.skipped).toBe(true)
    expect(second.errors[0]).toContain('上一轮巡检尚未结束')
    expect((await first).checked).toBe(2)
  })

  it('stops before running checks and diagnosis when the host already aborted', async () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(raw(), runner)
    const eventId = seedEvent({ state: OPS_AWAITING_DECISION, diagnosisJson: diagnosisText() })

    const outcome = await ops.tick(AbortSignal.abort())
    expect(outcome.checked).toBe(0)
    expect(outcome.executed).toBe(0)
    expect(ops.list().find((item) => item.eventId === eventId)?.state).toBe(OPS_AWAITING_DECISION)
  })

  it('runs a check again when the stored timestamp is malformed', async () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(raw(), runner)
    repository.setMeta('ops_check_at:web-health', 'not-a-timestamp')

    const outcome = await ops.tick()
    expect(outcome.checked).toBe(2)
    expect(ops.list()).toEqual([])
  })

  it('reconciles a recovering event from its stored action record, never from hope', async () => {
    const runner = runnerOf(() => diagnosisText())
    const { ops } = makeOps(raw(), runner)
    const interrupted = seedEvent({ state: OPS_RECOVERING })
    repository.recordOpsActionAttempt({
      actionId: 'opa-interrupted',
      eventId: interrupted,
      actionDefId: 'restart-web',
      state: 'interrupted',
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: clock.toISOString(),
    })
    const failed = seedEvent({ state: OPS_RECOVERING })
    repository.recordOpsActionAttempt({
      actionId: 'opa-failed',
      eventId: failed,
      actionDefId: 'restart-web',
      state: 'failed',
      exitCode: 2,
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: clock.toISOString(),
    })
    const orphan = seedEvent({ state: OPS_RECOVERING })
    const stillRunning = seedEvent({ state: OPS_RECOVERING })
    repository.recordOpsActionAttempt({
      actionId: 'opa-still-running',
      eventId: stillRunning,
      actionDefId: 'restart-web',
      state: 'running',
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: clock.toISOString(),
    })

    await ops.tick()
    const byId = new Map(ops.list().map((event) => [event.eventId, event]))
    expect(byId.get(interrupted)?.state).toBe(OPS_UNRESOLVED)
    expect(byId.get(failed)?.state).toBe(OPS_UNRESOLVED)
    expect(byId.get(orphan)?.state).toBe(OPS_AWAITING_DECISION)
    expect(byId.get(stillRunning)?.state).toBe(OPS_RECOVERING)
    // 中断的动作只上报事实，不产生第二条动作记录，也不自动重放。
    expect(repository.opsActionAttempts(interrupted)).toHaveLength(1)
    expect(
      repository.opsObservations(interrupted).some((item) => item.kind === 'interruption'),
    ).toBe(true)
  })

  it('truncates oversized command output instead of keeping it all', async () => {
    const huge = await runOpsCommand(
      ['node', '-e', "process.stdout.write('x'.repeat(300 * 1024))"],
      dir,
      5_000,
    )
    expect(huge.code).toBe(0)
    expect(huge.stdout.endsWith('…（输出已截断）')).toBe(true)
    expect(huge.stdout.length).toBeLessThan(300 * 1024)
    expect(huge.stdout.startsWith('xxxx')).toBe(true)
  })
})
