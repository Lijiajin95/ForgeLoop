import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OpsRuntime } from '../src/runtime/ops.js'
import { resolveConfig, type ForgeLoopConfig, type RawConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { parseOpsDiagnosis, type OpsAction, type OpsDiagnosis } from '../src/domain/ops.js'
import {
  OPS_AWAITING_DECISION,
  OPS_CLOSED,
  OPS_OPEN,
  OPS_RECOVERING,
  OPS_UNRESOLVED,
} from '../src/domain/ops.js'
import type { AgentLike } from '../src/runtime/service.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'

const PROJECT = 'forgeloop'

let dir = ''
let repository: Repository
let clock = new Date('2026-11-03T10:00:00.000Z')
let seeded = 0
let runnerBehavior: 'completed' | 'failed' | 'throw' = 'completed'

function diagnosisText(actionId = 'restart-web'): string {
  return JSON.stringify({
    impact: '页面不可用',
    facts: ['检查退出码 1'],
    hypotheses: [{ statement: '进程退出', confidence: 'medium' }],
    proposed_action: { action_id: actionId, params: {} },
    decision_required: false,
    fix_required: false,
    summary: '重启后复核',
  })
}

function rawConfig(monitorEnabled = false): RawConfig {
  return {
    project: PROJECT,
    ops: {
      enabled: true,
      intervalSeconds: 60,
      monitor: { enabled: monitorEnabled, intervalSeconds: 30 },
      resources: [{ id: 'web', kind: 'app', label: '页面' }],
      checks: [
        {
          id: 'web-health',
          resourceId: 'web',
          command: ['node', '-e', 'process.exit(0)'],
          timeoutSeconds: 10,
          severity: 'major',
        },
      ],
      actions: [
        {
          id: 'restart-web',
          resourceId: 'web',
          command: ['node', '-e', 'process.exit(0)'],
          timeoutSeconds: 10,
          auto: true,
          verifyCheckId: 'web-health',
        },
        {
          id: 'manual-web',
          resourceId: 'web',
          command: ['node', '-e', 'process.exit(0)'],
          timeoutSeconds: 10,
          auto: false,
          verifyCheckId: 'web-health',
        },
      ],
    },
  }
}

function runnerResult(request: AgentRunRequest, status: AgentRunResult['status']): AgentRunResult {
  return {
    status,
    text: '{}',
    sessionId: 'session-fake-ops',
    reason: 'not completed',
    transcriptPath: request.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  }
}

function makeOps(monitorEnabled = false): { ops: OpsRuntime; config: ForgeLoopConfig } {
  const config = resolveConfig(rawConfig(monitorEnabled), dir)
  const runner: AgentLike = {
    run(request) {
      if (runnerBehavior === 'throw') return Promise.reject(new Error('runner exploded'))
      if (runnerBehavior === 'failed') return Promise.resolve(runnerResult(request, 'failed'))
      return Promise.resolve({
        ...runnerResult(request, 'completed'),
        text: JSON.stringify({
          root_cause: '进程退出',
          facts: ['动作中断'],
          recommendation: '检查进程守护',
          fix_required: false,
        }),
      })
    },
  }
  return { ops: new OpsRuntime({ config, repo: repository, runner, now: () => clock }), config }
}

function seedEvent(
  input: {
    state?: string
    severity?: string
    diagnosisJson?: string
    decision?: string
    decisionBy?: string
    decisionSource?: string
    resourceId?: string
  } = {},
): string {
  seeded += 1
  const eventId = `ops-branch-${seeded}`
  const at = clock.toISOString()
  repository.createOpsEvent({
    eventId,
    project: PROJECT,
    resourceId: input.resourceId ?? 'web',
    checkId: 'web-health',
    signature: `signature-${eventId}`,
    severity: input.severity ?? 'major',
    state: input.state ?? OPS_OPEN,
    title: '人工事件',
    openedAt: at,
    updatedAt: at,
  })
  const update: Record<string, string> = {}
  if (input.diagnosisJson) update.diagnosisJson = input.diagnosisJson
  if (input.decision) update.decision = input.decision
  if (input.decisionBy) update.decisionBy = input.decisionBy
  if (input.decisionSource) update.decisionSource = input.decisionSource
  if (Object.keys(update).length > 0) repository.updateOpsEvent(eventId, update)
  return eventId
}

function diagnosis(actionId = 'restart-web'): OpsDiagnosis {
  return parseOpsDiagnosis(diagnosisText(actionId))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-ops-branches-'))
  repository = new Repository(Database.open(join(dir, '.forgeloop', 'records.sqlite')))
  clock = new Date('2026-11-03T10:00:00.000Z')
  seeded = 0
  runnerBehavior = 'completed'
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ops branch boundaries', () => {
  it('ignores missing and malformed diagnoses', () => {
    const { ops } = makeOps()
    const missing = seedEvent()
    expect(ops['readDiagnosis'](repository.opsEvent(missing))).toBeNull()
    const malformed = seedEvent({ diagnosisJson: '{not json' })
    expect(ops['readDiagnosis'](repository.opsEvent(malformed))).toBeNull()
    const valid = seedEvent({ diagnosisJson: diagnosisText() })
    expect(ops['readDiagnosis'](repository.opsEvent(valid))?.proposedAction?.actionId).toBe(
      'restart-web',
    )
  })

  it('orders active events by severity and skips closed ones', () => {
    const { ops } = makeOps()
    const minor = seedEvent({ severity: 'minor' })
    const major = seedEvent({ severity: 'major' })
    const critical = seedEvent({ severity: 'critical' })
    const closed = seedEvent({ state: OPS_CLOSED })
    expect(ops['activeEvents']().map((event: { eventId: string }) => event.eventId)).toEqual([
      critical,
      major,
      minor,
    ])
    expect(ops['activeEvents']().map((event: { eventId: string }) => event.eventId)).not.toContain(
      closed,
    )
  })

  it('derives authorization only from the catalog and the recorded human decision', () => {
    const { ops } = makeOps()
    const action = ops['action']('restart-web') as OpsAction
    const manual = ops['action']('manual-web') as OpsAction

    expect(
      ops['authorizationFor'](
        repository.opsEvent(seedEvent({ decision: '' })),
        action,
        diagnosis(),
      ),
    ).toBeNull()

    expect(
      ops['authorizationFor'](
        repository.opsEvent(
          seedEvent({ decision: 'approved', decisionBy: 'alice', decisionSource: 'owner-ui' }),
        ),
        action,
        diagnosis(),
      ),
    ).toBe('owner:alice:owner-ui')

    expect(
      ops['authorizationFor'](
        repository.opsEvent(seedEvent({ decision: 'approved', decisionBy: '' })),
        action,
        diagnosis(),
      ),
    ).toBeNull()

    const autoEvent = seedEvent({ decision: 'auto' })
    expect(ops['authorizationFor'](repository.opsEvent(autoEvent), action, diagnosis())).toContain(
      'ops-action',
    )

    const manualEvent = seedEvent({ decision: 'auto' })
    expect(
      ops['authorizationFor'](repository.opsEvent(manualEvent), manual, diagnosis()),
    ).toBeNull()
    expect(repository.opsObservations(manualEvent).at(-1)?.summary).toContain('自动授权已不成立')
  })

  it('runs the monitor only when enabled and due', () => {
    const disabled = makeOps(false).ops
    expect(disabled['monitorDue']()).toBe(false)

    const { ops } = makeOps(true)
    expect(ops['monitorDue']()).toBe(true)
    repository.setMeta('ops_monitor_at', 'not-a-time')
    expect(ops['monitorDue']()).toBe(true)
    repository.setMeta('ops_monitor_at', clock.toISOString())
    expect(ops['monitorDue']()).toBe(false)
    clock = new Date(clock.getTime() + 31_000)
    expect(ops['monitorDue']()).toBe(true)
  })

  it('reports an unresolved event when the recovery check is gone', async () => {
    const { ops } = makeOps()
    const eventId = seedEvent({ state: OPS_RECOVERING })
    const action = {
      ...(ops['action']('restart-web') as OpsAction),
      verifyCheckId: 'missing-check',
    }
    const outcome = await ops['verifyAfterAction'](eventId, action, diagnosis(), 1)
    expect(outcome).toBe('unresolved')
    expect(repository.opsEvent(eventId)?.state).toBe(OPS_UNRESOLVED)
    expect(repository.opsObservations(eventId).at(-1)?.summary).toContain('已不在登记目录中')
  })

  it('reports an interruption analysis exception without losing the facts', async () => {
    const { ops } = makeOps()
    const eventId = seedEvent({ state: OPS_RECOVERING })
    repository.recordOpsActionAttempt({
      actionId: 'opa-1',
      eventId,
      actionDefId: 'restart-web',
      paramsJson: '{not json',
      state: 'interrupted',
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: clock.toISOString(),
      evidencePath: join(dir, 'missing.log'),
    })
    runnerBehavior = 'throw'
    await ops['reportInterruption'](repository.opsEvent(eventId))
    expect(
      repository.opsObservations(eventId).some((item) => item.kind === 'interruption_error'),
    ).toBe(true)
    expect(repository.opsObservations(eventId).at(-1)?.summary).toContain('异常')
  })

  it('reports an interruption analysis that did not complete', async () => {
    const { ops } = makeOps()
    const eventId = seedEvent({ state: OPS_RECOVERING })
    repository.recordOpsActionAttempt({
      actionId: 'opa-2',
      eventId,
      actionDefId: 'restart-web',
      paramsJson: JSON.stringify({ bogus: 1 }),
      state: 'interrupted',
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: clock.toISOString(),
      evidencePath: join(dir, 'missing.log'),
    })
    runnerBehavior = 'failed'
    await ops['reportInterruption'](repository.opsEvent(eventId))
    expect(repository.opsObservations(eventId).at(-1)?.summary).toContain('未完成')
  })

  it('treats a succeeded action without diagnosis or catalog entry as unresolved', async () => {
    const { ops } = makeOps()
    const noDiagnosis = seedEvent({ state: OPS_RECOVERING })
    repository.recordOpsActionAttempt({
      actionId: 'opa-3',
      eventId: noDiagnosis,
      actionDefId: 'restart-web',
      state: 'succeeded',
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: clock.toISOString(),
    })
    expect(await ops['verifyEvent'](repository.opsEvent(noDiagnosis))).toBe('unresolved')
    expect(repository.opsEvent(noDiagnosis)?.state).toBe(OPS_UNRESOLVED)

    const noAction = seedEvent({ state: OPS_RECOVERING, diagnosisJson: diagnosisText() })
    repository.recordOpsActionAttempt({
      actionId: 'opa-4',
      eventId: noAction,
      actionDefId: 'missing-action',
      state: 'succeeded',
      authorizationSource: 'ops-action:auto:missing-action',
      startedAt: clock.toISOString(),
    })
    expect(await ops['verifyEvent'](repository.opsEvent(noAction))).toBe('unresolved')
  })

  it('closes an aborted action as unresolved without replaying it', async () => {
    const { ops } = makeOps()
    const eventId = seedEvent({
      state: OPS_AWAITING_DECISION,
      decision: 'approved',
      decisionBy: 'alice',
      diagnosisJson: diagnosisText(),
    })
    const outcome = await ops['executeEvent'](repository.opsEvent(eventId), AbortSignal.abort())
    expect(outcome).toBe('unresolved')
    expect(repository.opsEvent(eventId)?.state).toBe(OPS_UNRESOLVED)
    expect(repository.opsActionAttempts(eventId)[0]?.detail).toContain('宿主停止')
    expect(repository.opsObservations(eventId).at(-1)?.summary).toContain('未完成')
  })
})

it('keeps ops list, detail, stats and summary payloads stable', () => {
  const { ops } = makeOps()
  seedEvent({ severity: 'minor' })
  const critical = seedEvent({
    severity: 'critical',
    state: OPS_AWAITING_DECISION,
    diagnosisJson: diagnosisText(),
    decision: 'approved',
    decisionBy: 'owner',
    decisionSource: 'cli',
  })
  expect(ops.list()).toMatchSnapshot()
  expect(ops.detail(critical)).toMatchSnapshot()
  expect(ops.detail('missing-event')).toBeNull()
  expect(ops.stats()).toMatchSnapshot()
  expect(ops.summary()).toMatchSnapshot()
})
