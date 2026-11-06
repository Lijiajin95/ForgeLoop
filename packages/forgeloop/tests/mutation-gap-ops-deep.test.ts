import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { OpsRuntime, runOpsCommand } from '../src/runtime/ops.js'
import { OPS_ARTIFACT_TOOL_NAMES } from '../src/runtime/ops-artifacts.js'
import {
  resolveConfig,
  type ForgeLoopConfig,
  type RawConfig,
  type RawOpsAction,
  type RawOpsActionParam,
  type RawOpsCheck,
  type RawOpsResource,
} from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import {
  OPS_AWAITING_DECISION,
  OPS_CLOSED,
  OPS_DIAGNOSED,
  OPS_OPEN,
  OPS_RECOVERED,
  OPS_RECOVERING,
  OPS_UNRESOLVED,
} from '../src/domain/ops.js'
import type { AgentLike } from '../src/runtime/service.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'

const PROJECT = 'forgeloop'
const PASSING_CHECK = ['node', '-e', 'process.exit(0)']
const FAILING_CHECK = ['node', '-e', 'process.exit(1)']
const CLOCK_ISO = '2026-11-03T10:00:00.000Z'

let dir = ''
let repository: Repository
let clock = new Date(CLOCK_ISO)
let seeded = 0
let server: Server | null = null

interface FixtureOptions {
  checkCommand?: string[]
  actionCommand?: string[]
  actionTimeoutSeconds?: number
  params?: RawOpsActionParam[]
  auto?: boolean
  withDatabaseResource?: boolean
  webhook?: string
  enabled?: boolean
}

function rawConfig(options: FixtureOptions = {}): RawConfig {
  const resources: RawOpsResource[] = [{ id: 'web', kind: 'app', label: '页面' }]
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
      command: options.actionCommand ?? PASSING_CHECK,
      params: options.params ?? [],
      timeoutSeconds: options.actionTimeoutSeconds ?? 10,
      auto: options.auto ?? true,
      verifyCheckId: 'web-health',
    },
    {
      id: 'manual-web',
      resourceId: 'web',
      command: PASSING_CHECK,
      timeoutSeconds: 10,
      auto: false,
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
      auto: true,
      verifyCheckId: 'db-health',
    })
  }
  return {
    project: PROJECT,
    ops: {
      enabled: options.enabled ?? true,
      intervalSeconds: 60,
      monitor: { enabled: false, intervalSeconds: 30 },
      resources,
      checks,
      actions,
      ...(options.webhook === undefined
        ? {}
        : { alerts: { webhook: options.webhook, timeoutSeconds: 2 } }),
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
    decisionRequired?: boolean
    deploymentTargetId?: string
    impact?: string
    summary?: string
  } = {},
): string {
  const actionId = input.actionId === undefined ? 'restart-web' : input.actionId
  return JSON.stringify({
    impact: input.impact ?? '页面不可用',
    facts: ['健康检查退出码 1'],
    hypotheses: [{ statement: '进程退出', confidence: 'medium' }],
    proposed_action: actionId === null ? null : { action_id: actionId, params: input.params ?? {} },
    proposed_deployment: input.deploymentTargetId ? { target_id: input.deploymentTargetId } : null,
    decision_required: input.decisionRequired ?? false,
    fix_required: input.fixRequired ?? false,
    summary: input.summary ?? '按登记动作处置后复核',
  })
}

function seedEvent(
  input: {
    state?: string
    severity?: string
    resourceId?: string
    checkId?: string
    diagnosisJson?: string
    diagnosisPath?: string
    decision?: string
    decisionBy?: string
    decisionSource?: string
    impact?: string
    fixRequirementId?: string
    humanInvolved?: boolean
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
    signature: `signature-${eventId}`,
    severity: input.severity ?? 'major',
    state: input.state ?? OPS_OPEN,
    title: '测试构造的运维事件',
    impact: input.impact ?? '',
    openedAt: at,
    updatedAt: at,
  })
  const patch: {
    diagnosisJson?: string
    diagnosisPath?: string
    decision?: string
    decisionBy?: string
    decisionSource?: string
    fixRequirementId?: string
    humanInvolved?: boolean
    recoveredAt?: string
    closedAt?: string
  } = {}
  if (input.diagnosisJson !== undefined) patch.diagnosisJson = input.diagnosisJson
  if (input.diagnosisPath !== undefined) patch.diagnosisPath = input.diagnosisPath
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

interface Webhook {
  readonly url: string
  readonly origin: string
  readonly bodies: string[]
}

async function startWebhook(status: number): Promise<Webhook> {
  const bodies: string[] = []
  const next = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      bodies.push(body)
      response.writeHead(status)
      response.end(status === 204 ? undefined : 'body')
    })
  })
  server = next
  await new Promise<void>((resolve) => next.listen(0, '127.0.0.1', resolve))
  const address = next.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
  const url = `http://127.0.0.1:${address.port}/hook`
  return { url, origin: `http://127.0.0.1:${address.port}`, bodies }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-ops-deep-'))
  repository = new Repository(Database.open(join(dir, '.forgeloop', 'records.sqlite')))
  clock = new Date(CLOCK_ISO)
  seeded = 0
})

afterEach(async () => {
  repository.close()
  if (server) {
    const closing = server
    server = null
    closing.closeAllConnections()
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('runOpsCommand process boundaries', () => {
  it('runs registered argv with a non-interactive Git environment', async () => {
    const result = await runOpsCommand(
      ['node', '-e', 'process.stdout.write(String(process.env.GIT_TERMINAL_PROMPT))'],
      dir,
      5_000,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('0')
    expect(result.stderr).toBe('')
  })

  it('reports a signal-terminated child as a non-zero exit instead of success', async () => {
    const result = await runOpsCommand(
      ['node', '-e', "process.kill(process.pid, 'SIGTERM')"],
      dir,
      5_000,
    )
    expect(result.code).toBe(1)
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })
})

describe('OpsRuntime tick boundaries', () => {
  it('skips a disabled runtime and refuses a concurrent tick', async () => {
    const disabled = makeOps(unusedRunner(), { enabled: false }).ops
    expect(await disabled.tick()).toEqual({
      skipped: true,
      checked: 0,
      failed: 0,
      monitored: false,
      issues: 0,
      opened: 0,
      merged: 0,
      alerted: 0,
      diagnosed: 0,
      executed: 0,
      recovered: 0,
      unresolved: 0,
      errors: [],
    })

    const { ops } = makeOps(unusedRunner(), {
      checkCommand: ['node', '-e', 'setTimeout(() => {}, 300)'],
    })
    const first = ops.tick()
    const second = await ops.tick()
    expect(second.skipped).toBe(true)
    expect(second.errors).toEqual(['上一轮巡检尚未结束，本次跳过'])
    const completed = await first
    expect(completed.skipped).toBe(false)
    expect(completed.checked).toBe(1)
  })

  it('honours the check interval boundary and a malformed last-run timestamp', async () => {
    const { ops } = makeOps(unusedRunner())
    repository.setMeta('ops_check_at:web-health', 'not-a-time')
    const first = await ops.tick()
    expect(first.skipped).toBe(false)
    expect(first.checked).toBe(1)

    clock = new Date(clock.getTime() + 59_000)
    const tooSoon = await ops.tick()
    expect(tooSoon.checked).toBe(0)

    clock = new Date(clock.getTime() + 1_000)
    const exactlyDue = await ops.tick()
    expect(exactlyDue.checked).toBe(1)
  })
})

describe('OpsRuntime alerts', () => {
  it('alerts once per new failure and merges a repeated failure without alerting again', async () => {
    const hook = await startWebhook(204)
    const runner = runnerOf(() => diagnosisText({ actionId: null }))
    const { ops } = makeOps(runner, { checkCommand: FAILING_CHECK, webhook: hook.url })

    const first = await ops.tick()
    expect(first.checked).toBe(1)
    expect(first.failed).toBe(1)
    expect(first.alerted).toBe(1)
    expect(first.errors).toEqual([])
    expect(hook.bodies).toHaveLength(1)

    const [event] = ops.list()
    expect(event?.eventId).toMatch(/^ops-20261103100000-[0-9a-f]{6}$/)
    expect(event?.state).toBe(OPS_AWAITING_DECISION)
    const detail = ops.detail(event!.eventId)!
    expect(detail.observations.map((item) => item.kind)).toEqual([
      'check',
      'alert',
      'diagnosis',
      'decision_required',
    ])

    interface AlertBody {
      project: string
      eventId: string
      severity: string
      title: string
      impact: string
      source: string
      at: string
      summary: string
    }
    const alertBody = JSON.parse(hook.bodies[0]!) as AlertBody
    expect(alertBody).toEqual({
      project: PROJECT,
      eventId: event!.eventId,
      severity: 'major',
      title: '页面：web-health 检查失败',
      impact: '',
      source: 'check:web-health',
      at: CLOCK_ISO,
      summary: '检查 web-health 失败：退出码 1',
    })

    const check = detail.observations.find((item) => item.kind === 'check')!
    expect(basename(check.evidencePath)).toBe('check-1.log')
    expect(readFileSync(check.evidencePath, 'utf8')).toBe(
      [
        'command: ["node","-e","process.exit(1)"]',
        'exit_code: 1',
        'timed_out: false',
        'aborted: false',
        '',
        '（无输出）',
      ].join('\n'),
    )
    expect(JSON.parse(check.detailJson)).toEqual({
      checkId: 'web-health',
      exitCode: 1,
      timedOut: false,
      aborted: false,
      output: '（无输出）',
    })
    const alert = detail.observations.find((item) => item.kind === 'alert')!
    expect(alert.summary).toBe(`告警已发送到 ${hook.origin}（HTTP 204）`)
    expect(JSON.parse(alert.detailJson)).toEqual({
      origin: hook.origin,
      status: 204,
      source: 'check:web-health',
    })
    expect(JSON.parse(repository.getMeta('ops_check_last:web-health')!)).toEqual({
      at: CLOCK_ISO,
      code: 1,
      timedOut: false,
      aborted: false,
      output: '（无输出）',
    })

    clock = new Date(clock.getTime() + 60_000)
    const second = await ops.tick()
    expect(second.failed).toBe(1)
    expect(second.alerted).toBe(0)
    expect(second.errors).toEqual([])
    expect(hook.bodies).toHaveLength(1)
    expect(ops.list()).toHaveLength(1)
    const after = ops.detail(event!.eventId)!
    const checks = after.observations.filter((item) => item.kind === 'check')
    expect(checks).toHaveLength(2)
    expect(basename(checks[1]!.evidencePath)).toBe('check-2.log')
  })

  it('records a rejected webhook as a tick error without closing the event', async () => {
    const hook = await startWebhook(500)
    const runner = runnerOf(() => diagnosisText({ actionId: null }))
    const { ops } = makeOps(runner, { checkCommand: FAILING_CHECK, webhook: hook.url })

    const outcome = await ops.tick()
    expect(outcome.alerted).toBe(0)
    expect(outcome.errors).toEqual([`告警发送失败（${hook.origin}）：HTTP 500`])
    const event = ops.list()[0]!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    const alertError = ops
      .detail(event.eventId)!
      .observations.find((item) => item.kind === 'alert_error')!
    expect(alertError.summary).toBe(`告警发送失败（${hook.origin}）：HTTP 500`)
    expect(alertError.detailJson).not.toContain('/hook')
  })
})

describe('OpsRuntime diagnosis inputs and escalation', () => {
  it('gives the model the latest check output, five observations and only resource actions', async () => {
    const runner = runnerOf(() => diagnosisText({ actionId: null }))
    const { ops } = makeOps(runner, {
      params: [{ name: 'mode', values: ['graceful', 'force'] }],
      actionCommand: ['node', '-e', 'process.exit(0)', '{mode}'],
      withDatabaseResource: true,
    })
    const withOutput = seedEvent()
    for (let index = 1; index <= 6; index += 1) {
      repository.appendOpsObservation({
        eventId: withOutput,
        at: `2026-11-03T09:0${index}:00.000Z`,
        kind: 'check',
        summary: `第${index}次检查摘要`,
        detailJson: JSON.stringify({ output: `第${index}次检查输出` }),
      })
    }
    const malformed = seedEvent()
    repository.appendOpsObservation({
      eventId: malformed,
      at: CLOCK_ISO,
      kind: 'check',
      summary: '损坏记录回退为摘要',
      detailJson: '{not json',
    })

    const outcome = await ops.tick()
    expect(outcome.diagnosed).toBe(2)
    expect(runner.calls).toHaveLength(2)
    const outputPrompt = runner.calls.find((call) => call.prompt.includes(withOutput))!.prompt
    expect(outputPrompt).toContain('第6次检查输出')
    expect(outputPrompt).not.toContain('第1次检查输出')
    expect(outputPrompt).toContain('第2次检查摘要')
    expect(outputPrompt).toContain('第6次检查摘要')
    expect(outputPrompt).not.toContain('第1次检查摘要')
    expect(outputPrompt).toContain(
      '- restart-web（mode ∈ [graceful, force]；目录已预授权，可自动执行）',
    )
    expect(outputPrompt).toContain('- manual-web（无参数）')
    expect(outputPrompt).not.toContain('restart-db')
    expect(outputPrompt).toContain('当前没有可提议的目标')

    const fallbackPrompt = runner.calls.find((call) => call.prompt.includes(malformed))!.prompt
    expect(fallbackPrompt).toContain('损坏记录回退为摘要')
  })

  it('writes diagnosis evidence, a parsed observation and a manual decision reason', async () => {
    const runner = runnerOf(() => diagnosisText({ actionId: 'manual-web' }))
    const { ops, config } = makeOps(runner)
    const eventId = seedEvent()

    const outcome = await ops.tick()
    expect(outcome.diagnosed).toBe(1)
    expect(runner.calls).toHaveLength(1)
    const request = runner.calls[0]!
    expect(request.role).toBe('ops')
    expect(request.permission).toBe('workspace-write')
    expect(request.timeoutMs).toBe(config.agent.timeoutSeconds * 1000)
    expect(request.allowTools).toEqual(OPS_ARTIFACT_TOOL_NAMES)
    expect(request.transcriptPath.endsWith(join('ops', eventId, 'diagnosis-1.jsonl'))).toBe(true)

    const event = repository.opsEvent(eventId)!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(event.decision).toBe('')
    expect(basename(event.diagnosisPath)).toBe('diagnosis-1.json')
    expect(existsSync(event.diagnosisPath)).toBe(true)
    interface DiagnosisEvidence {
      diagnosis: {
        impact: string
        proposedAction: { actionId: string; params: Record<string, string> } | null
        fixRequired: boolean
      }
      session: string
      modelStatus: string
      invalid: string | null
    }
    const evidence = JSON.parse(readFileSync(event.diagnosisPath, 'utf8')) as DiagnosisEvidence
    expect(evidence.diagnosis.impact).toBe('页面不可用')
    expect(evidence.diagnosis.proposedAction?.actionId).toBe('manual-web')
    expect(evidence.diagnosis.fixRequired).toBe(false)
    expect(evidence.session).toBe('session-fake-ops')
    expect(evidence.modelStatus).toBe('completed')
    expect(evidence.invalid).toBeNull()

    const detail = ops.detail(eventId)!
    const diagnosis = detail.observations.find((item) => item.kind === 'diagnosis')!
    expect(diagnosis.summary).toBe('按登记动作处置后复核')
    expect(diagnosis.evidencePath).toBe(event.diagnosisPath)
    expect(JSON.parse(diagnosis.detailJson)).toEqual({
      facts: ['健康检查退出码 1'],
      hypotheses: [{ statement: '进程退出', confidence: 'medium' }],
      proposedAction: { actionId: 'manual-web', params: {} },
      fixRequired: false,
    })
    expect(detail.observations.at(-1)?.summary).toBe(
      '动作 manual-web 未获目录自动授权；等待所有者决定',
    )
    expect(detail.attempts).toEqual([])
  })

  it('escalates events whose check or resource left the catalog without calling the model', async () => {
    const runner = unusedRunner()
    const { ops } = makeOps(runner)
    const missingCheck = seedEvent({ checkId: 'gone-check' })
    const missingResource = seedEvent({ resourceId: 'gone-resource' })

    const outcome = await ops.tick()
    expect(runner.calls).toHaveLength(0)
    expect(outcome.diagnosed).toBe(2)
    for (const eventId of [missingCheck, missingResource]) {
      const event = repository.opsEvent(eventId)!
      expect(event.state).toBe(OPS_AWAITING_DECISION)
      expect(event.impact).toBe('登记目录已变化，无法继续自动诊断')
      expect(repository.opsObservations(eventId).at(-1)).toMatchObject({
        kind: 'decision_required',
        summary: '事件的检查或资源已不在登记目录中，等待人工处理',
      })
    }
  })

  it('keeps an existing impact and escalates only after three diagnosis attempts', async () => {
    const runner = runnerOf((request) => agentResult(request, '', 'failed'))
    const { ops } = makeOps(runner)
    const eventId = seedEvent({ impact: '历史影响保留' })
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      repository.appendOpsObservation({
        eventId,
        at: CLOCK_ISO,
        kind: 'diagnosis_error',
        summary: `第 ${attempt} 次诊断失败`,
      })
    }

    const first = await ops.tick()
    expect(runner.calls).toHaveLength(1)
    expect(first.diagnosed).toBe(1)
    expect(repository.opsEvent(eventId)?.state).toBe(OPS_OPEN)
    expect(repository.opsObservations(eventId).at(-1)?.kind).toBe('diagnosis_error')

    const second = await ops.tick()
    expect(runner.calls).toHaveLength(1)
    expect(second.diagnosed).toBe(1)
    const event = repository.opsEvent(eventId)!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(event.impact).toBe('历史影响保留')
    expect(repository.opsObservations(eventId).at(-1)).toMatchObject({
      kind: 'decision_required',
      summary: '自动诊断连续 3 次未完成，等待人工判断',
    })
  })

  it('rejects a foreign-resource action and out-of-catalog parameters before execution', async () => {
    const runner = runnerOf((request) => {
      if (request.prompt.includes('ops-gap-1')) return diagnosisText({ actionId: 'restart-db' })
      return diagnosisText({ actionId: 'restart-web', params: { mode: 'force' } })
    })
    const { ops } = makeOps(runner, {
      params: [{ name: 'mode', values: ['graceful'] }],
      actionCommand: ['node', '-e', 'process.exit(0)', '{mode}'],
      withDatabaseResource: true,
    })
    const foreign = seedEvent()
    const invalidParams = seedEvent()

    const outcome = await ops.tick()
    expect(outcome.executed).toBe(0)
    expect(outcome.diagnosed).toBe(2)
    const foreignDetail = ops.detail(foreign)!
    expect(foreignDetail.event.state).toBe(OPS_AWAITING_DECISION)
    expect(foreignDetail.event.decision).toBe('')
    expect(foreignDetail.attempts).toEqual([])
    expect(foreignDetail.observations.at(-1)?.summary).toBe('动作 restart-db 不属于事件资源 web')
    const paramDetail = ops.detail(invalidParams)!
    expect(paramDetail.event.state).toBe(OPS_AWAITING_DECISION)
    expect(paramDetail.event.decision).toBe('')
    expect(paramDetail.attempts).toEqual([])
    expect(paramDetail.observations.at(-1)?.summary).toBe(
      '动作 restart-web 的参数 mode 取值 "force" 不在允许值内',
    )
  })

  it('returns an auto event to the owner when catalog authorization no longer holds', async () => {
    const { ops } = makeOps(unusedRunner())
    const eventId = seedEvent({
      state: OPS_DIAGNOSED,
      decision: 'auto',
      diagnosisJson: diagnosisText({ actionId: 'manual-web' }),
    })

    const outcome = await ops.tick()
    expect(outcome.executed).toBe(0)
    const event = repository.opsEvent(eventId)!
    expect(event.state).toBe(OPS_AWAITING_DECISION)
    expect(event.decision).toBe('')
    expect(repository.opsActionAttempts(eventId)).toEqual([])
    expect(repository.opsObservations(eventId).at(-1)).toMatchObject({
      kind: 'decision_required',
      summary: '自动授权已不成立：动作 manual-web 未获目录自动授权',
    })
  })
})

describe('OpsRuntime execution and recovery', () => {
  it('does not accept a successful action as recovery when the verification check fails', async () => {
    const marker = join(dir, 'verify-marker')
    const verifyScript = [
      "const fs = require('node:fs')",
      `const marker = ${JSON.stringify(marker)}`,
      "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'x'); process.exit(0) }",
      'process.exit(1)',
    ].join('\n')
    const { ops } = makeOps(unusedRunner(), { checkCommand: ['node', '-e', verifyScript] })
    const eventId = seedApproved()

    const outcome = await ops.tick()
    expect(outcome.executed).toBe(1)
    expect(outcome.recovered).toBe(0)
    expect(outcome.unresolved).toBe(1)
    const event = repository.opsEvent(eventId)!
    expect(event.state).toBe(OPS_UNRESOLVED)
    expect(event.recoveredAt).toBe('')
    const attempt = repository.opsActionAttempts(eventId)[0]!
    expect(attempt.state).toBe('succeeded')
    expect(attempt.exitCode).toBe(0)
    const recovery = repository.opsObservations(eventId).find((item) => item.kind === 'recovery')!
    expect(recovery.summary).toBe('恢复复核未通过：web-health 退出码 1')
    expect(JSON.parse(recovery.detailJson)).toEqual({
      checkId: 'web-health',
      exitCode: 1,
      timedOut: false,
    })
    expect(basename(recovery.evidencePath)).toBe('recovery-1.log')
    const log = readFileSync(recovery.evidencePath, 'utf8')
    expect(log).toContain('exit_code: 1')
    expect(log).toContain('（无输出）')
  })

  it('marks an event unresolved when the recovery check left the catalog', async () => {
    const base = makeOps(unusedRunner())
    const drifted: ForgeLoopConfig = {
      ...base.config,
      ops: { ...base.config.ops, checks: [] },
    }
    const ops = new OpsRuntime({
      config: drifted,
      repo: repository,
      runner: unusedRunner(),
      now: () => clock,
    })
    const eventId = seedApproved()

    const outcome = await ops.tick()
    expect(outcome.executed).toBe(1)
    expect(outcome.unresolved).toBe(1)
    expect(repository.opsEvent(eventId)?.state).toBe(OPS_UNRESOLVED)
    expect(repository.opsActionAttempts(eventId)[0]?.state).toBe('succeeded')
    expect(repository.opsObservations(eventId).at(-1)).toMatchObject({
      kind: 'recovery',
      summary: '恢复检查 web-health 已不在登记目录中，不能确认恢复',
    })
  })

  it('closes an aborted action as unresolved without replaying it on the next tick', async () => {
    const { ops } = makeOps(unusedRunner(), {
      actionCommand: ['node', '-e', 'setTimeout(() => {}, 60000)'],
    })
    const eventId = seedApproved()
    const controller = new AbortController()
    const ticking = ops.tick(controller.signal)
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (repository.opsActionAttempts(eventId).length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    controller.abort()
    const outcome = await ticking

    expect(outcome.executed).toBe(1)
    expect(outcome.unresolved).toBe(1)
    const event = repository.opsEvent(eventId)!
    expect(event.state).toBe(OPS_UNRESOLVED)
    const attempt = repository.opsActionAttempts(eventId)[0]!
    expect(attempt.state).toBe('failed')
    expect(attempt.exitCode).toBeNull()
    expect(attempt.detail).toContain('宿主停止')
    expect(repository.opsObservations(eventId).at(-1)?.summary).toBe(
      '动作 restart-web 未完成（宿主停止）；没有退出码，按未解决收口',
    )
    expect(readFileSync(attempt.evidencePath, 'utf8')).toContain('aborted: true')

    const next = await ops.tick()
    expect(next.executed).toBe(0)
    expect(repository.opsActionAttempts(eventId)).toHaveLength(1)
    expect(repository.opsEvent(eventId)?.state).toBe(OPS_UNRESOLVED)
  })
})

describe('OpsRuntime interruption reports', () => {
  it('records interruption facts and a parsed root-cause report only once', async () => {
    const runner = runnerOf(() =>
      JSON.stringify({
        summary: '中断结论',
        root_cause: '进程在动作执行中被宿主终止',
        evidence: ['没有退出码记录'],
        next_step: '人工核对服务状态',
      }),
    )
    const { ops } = makeOps(runner, {
      params: [
        { name: 'mode', values: ['graceful'] },
        { name: 'force', values: ['true', 'false'] },
      ],
      actionCommand: ['node', '-e', 'process.exit(0)', '{mode}', '{force}'],
    })
    const eventId = seedEvent({ state: OPS_RECOVERING })
    const evidence = join(dir, 'attempt.log')
    writeFileSync(evidence, 'first line\ntail-marker-line\n', 'utf8')
    repository.recordOpsActionAttempt({
      actionId: 'opa-int',
      eventId,
      actionDefId: 'restart-web',
      paramsJson: JSON.stringify({ mode: 'graceful', force: true }),
      state: 'interrupted',
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: CLOCK_ISO,
      evidencePath: evidence,
    })

    await ops.tick()
    const detail = ops.detail(eventId)!
    const fact = detail.observations.find((item) => item.kind === 'interruption')!
    expect(JSON.parse(fact.detailJson)).toEqual({
      actionId: 'restart-web',
      params: { mode: 'graceful', force: 'true' },
      argv: ['node', '-e', 'process.exit(0)', 'graceful', 'true'],
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: CLOCK_ISO,
      detail: '',
      evidencePath: evidence,
    })
    const report = detail.observations.find((item) => item.kind === 'interruption_report')!
    expect(report.summary).toBe('中断结论')
    expect(JSON.parse(report.detailJson)).toEqual({
      summary: '中断结论',
      rootCause: '进程在动作执行中被宿主终止',
      evidence: ['没有退出码记录'],
      nextStep: '人工核对服务状态',
    })
    expect(basename(report.evidencePath)).toBe('interruption-opa-int.json')
    expect(JSON.parse(readFileSync(report.evidencePath, 'utf8'))).toEqual({
      report: {
        summary: '中断结论',
        rootCause: '进程在动作执行中被宿主终止',
        evidence: ['没有退出码记录'],
        nextStep: '人工核对服务状态',
      },
      session: 'session-fake-ops',
      modelStatus: 'completed',
    })

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.transcriptPath.endsWith('interruption-report.jsonl')).toBe(true)
    expect(runner.calls[0]!.allowTools).toEqual(OPS_ARTIFACT_TOOL_NAMES)
    expect(runner.calls[0]!.prompt).toContain('mode=graceful；force=true')
    expect(runner.calls[0]!.prompt).toContain('tail-marker-line')
    expect(detail.event.state).toBe(OPS_UNRESOLVED)

    const before = detail.observations.length
    const next = await ops.tick()
    expect(next.errors).toEqual([])
    expect(repository.opsObservations(eventId)).toHaveLength(before)
    expect(
      repository.opsObservations(eventId).filter((item) => item.kind === 'interruption_report'),
    ).toHaveLength(1)
  })

  it('records an unusable interruption report once, with empty argv for a missing action', async () => {
    const runner = runnerOf(() => 'not-a-json-report')
    const { ops } = makeOps(runner)
    const eventId = seedEvent({ state: OPS_RECOVERING })
    repository.recordOpsActionAttempt({
      actionId: 'opa-ghost',
      eventId,
      actionDefId: 'ghost-action',
      paramsJson: '{not json',
      state: 'interrupted',
      authorizationSource: 'ops-action:auto:ghost-action',
      startedAt: CLOCK_ISO,
    })

    await ops.tick()
    const observations = repository.opsObservations(eventId)
    const fact = observations.find((item) => item.kind === 'interruption')!
    expect(JSON.parse(fact.detailJson)).toEqual({
      actionId: 'ghost-action',
      params: {},
      argv: [],
      authorizationSource: 'ops-action:auto:ghost-action',
      startedAt: CLOCK_ISO,
      detail: '',
      evidencePath: '',
    })
    const error = observations.find((item) => item.kind === 'interruption_error')!
    expect(error.summary.startsWith('中断根因报告不可用：')).toBe(true)
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.prompt).toContain('- 参数：无')
    expect(runner.calls[0]!.prompt).toContain('（没有日志）')
    expect(repository.opsEvent(eventId)?.state).toBe(OPS_UNRESOLVED)

    await ops.tick()
    expect(runner.calls).toHaveLength(1)
    expect(
      repository.opsObservations(eventId).filter((item) => item.kind === 'interruption_error'),
    ).toHaveLength(1)
  })
})

describe('OpsRuntime fix requirements and owner decisions', () => {
  it('files one linked fix requirement whose text records the failed attempt', async () => {
    const { ops } = makeOps(unusedRunner())
    const eventId = seedEvent({
      state: OPS_UNRESOLVED,
      diagnosisJson: diagnosisText({ fixRequired: true }),
      diagnosisPath: join(dir, 'diagnosis-1.json'),
    })
    repository.recordOpsActionAttempt({
      actionId: 'opa-failed',
      eventId,
      actionDefId: 'restart-web',
      state: 'failed',
      exitCode: 2,
      detail: '动作退出码 2',
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: CLOCK_ISO,
    })

    await ops.tick()
    const event = repository.opsEvent(eventId)!
    expect(event.fixRequirementId).toMatch(/^req-20261103100000-[0-9a-f]{6}$/)
    const requirement = repository.getRequirement(event.fixRequirementId)!
    expect(requirement.submittedBy).toBe('ops-agent')
    expect(requirement.source).toBe(`ops:${eventId}`)
    expect(requirement.versions[0]!.text).toBe(
      [
        `运维事件 ${eventId} 的永久修复（由运维 Agent 创建）`,
        '',
        '资源：页面（web）',
        '检查：web-health',
        '严重度：major',
        `首次发现：${CLOCK_ISO}`,
        '当前状态：unresolved',
        '业务影响：页面不可用',
        '诊断摘要：按登记动作处置后复核',
        '已执行处置：restart-web（failed，退出码 2）',
        `事件证据：${join(dir, 'diagnosis-1.json')}`,
        '',
        '要求：定位并修复根因，给出可验证的验收方式；恢复服务与永久修复分别收口。',
        '本需求只记录修复工作，不表示事件已经恢复，也不构成验收或发布授权。',
      ].join('\n'),
    )
    const requests = repository.requestsFor(requirement.reqId)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      action: 'analyze',
      planVersion: 0,
      requestedBy: 'ops-agent',
      source: `ops:${eventId}`,
      state: 'pending',
    })

    await ops.tick()
    expect(repository.opsEvent(eventId)?.fixRequirementId).toBe(event.fixRequirementId)
    expect(repository.requestsFor(requirement.reqId)).toHaveLength(1)
    const again = ops.requestFix({ eventId, by: 'owner', source: 'cli' })
    expect(again).toEqual({
      ok: true,
      code: 'ok',
      message: `事件 ${eventId} 已关联修复需求 ${event.fixRequirementId}`,
      data: { reqId: event.fixRequirementId },
    })
  })

  it('validates manual fix requests and records the human request', () => {
    const { ops } = makeOps(unusedRunner())
    const missing = ops.requestFix({ eventId: 'ops-absent', by: 'owner', source: 'cli' })
    expect(missing).toMatchObject({ ok: false, code: 'not_found' })
    expect(missing.message).toBe('未找到运维事件 ops-absent')

    const undiagnosed = seedEvent({ state: OPS_AWAITING_DECISION })
    const noDiagnosis = ops.requestFix({ eventId: undiagnosed, by: 'owner', source: 'cli' })
    expect(noDiagnosis).toMatchObject({ ok: false, code: 'no_diagnosis' })
    expect(noDiagnosis.message).toBe('事件尚无诊断结论，不能生成修复需求')

    const open = seedEvent({ state: OPS_OPEN, diagnosisJson: diagnosisText() })
    const conflicted = ops.requestFix({ eventId: open, by: 'owner', source: 'cli' })
    expect(conflicted).toMatchObject({ ok: false, code: 'state_conflict' })
    expect(conflicted.message).toBe('事件当前状态 open，不能生成修复需求')

    const awaiting = seedEvent({
      state: OPS_AWAITING_DECISION,
      diagnosisJson: diagnosisText(),
    })
    const created = ops.requestFix({ eventId: awaiting, by: 'owner', source: 'cli' })
    expect(created.ok).toBe(true)
    expect(created.data).toEqual({ reqId: repository.opsEvent(awaiting)?.fixRequirementId })
    const event = repository.opsEvent(awaiting)!
    expect(event.humanInvolved).toBe(true)
    expect(event.humanReason).toBe('owner 要求生成修复需求（cli）')
    expect(event.fixRequirementId).toMatch(/^req-/)
    expect(repository.requestsFor(event.fixRequirementId)).toHaveLength(1)
  })

  it('records approval and refusal with human reasons and observations', () => {
    const { ops } = makeOps(unusedRunner())
    const approved = seedEvent({
      state: OPS_AWAITING_DECISION,
      diagnosisJson: diagnosisText({ actionId: 'restart-web' }),
    })
    const approval = ops.decide({
      eventId: approved,
      decision: 'approve',
      by: 'alice',
      source: 'cli',
      reason: '  已核对影响  ',
    })
    expect(approval).toEqual({
      ok: true,
      code: 'ok',
      message: `已批准事件 ${approved} 的处置 restart-web；协调器会在下一次巡检执行`,
      data: { eventId: approved, actionId: 'restart-web' },
    })
    const approvedEvent = repository.opsEvent(approved)!
    expect(approvedEvent.state).toBe(OPS_AWAITING_DECISION)
    expect(approvedEvent.decision).toBe('approved')
    expect(approvedEvent.decisionBy).toBe('alice')
    expect(approvedEvent.decisionSource).toBe('cli')
    expect(approvedEvent.decisionAt).toBe(CLOCK_ISO)
    expect(approvedEvent.humanInvolved).toBe(true)
    expect(approvedEvent.humanReason).toBe('alice 批准处置 restart-web（cli）：已核对影响')
    expect(repository.opsObservations(approved).at(-1)).toMatchObject({
      kind: 'decision',
      summary: 'alice 批准处置 restart-web；等待协调器执行',
    })

    const declined = seedEvent({
      state: OPS_AWAITING_DECISION,
      diagnosisJson: diagnosisText({ actionId: 'restart-web', fixRequired: true }),
    })
    const refusal = ops.decide({
      eventId: declined,
      decision: 'decline',
      by: 'bob',
      source: 'ui',
    })
    expect(refusal).toEqual({
      ok: true,
      code: 'ok',
      message: `已拒绝事件 ${declined} 的处置 restart-web，事件保留为未解决`,
    })
    const declinedEvent = repository.opsEvent(declined)!
    expect(declinedEvent.state).toBe(OPS_UNRESOLVED)
    expect(declinedEvent.decision).toBe('declined')
    expect(declinedEvent.humanInvolved).toBe(true)
    expect(declinedEvent.humanReason).toBe('bob 拒绝处置 restart-web（ui）')
    expect(declinedEvent.fixRequirementId).toMatch(/^req-/)
    expect(repository.opsObservations(declined).at(-1)).toMatchObject({
      kind: 'decision',
      summary: 'bob 拒绝处置 restart-web',
    })
  })

  it('refuses to close a running or closed event and explains the default close reason', () => {
    const { ops } = makeOps(unusedRunner())
    const running = seedEvent({ state: OPS_RECOVERING })
    repository.recordOpsActionAttempt({
      actionId: 'opa-running',
      eventId: running,
      actionDefId: 'restart-web',
      state: 'running',
      authorizationSource: 'ops-action:auto:restart-web',
      startedAt: CLOCK_ISO,
    })
    const blocked = ops.close({ eventId: running, by: 'owner', reason: '维护窗口' })
    expect(blocked).toEqual({
      ok: false,
      code: 'action_running',
      message: '事件仍有动作在执行，不能关闭',
    })

    const closed = seedEvent({ state: OPS_CLOSED, closedAt: CLOCK_ISO })
    const already = ops.close({ eventId: closed, by: 'owner', reason: '' })
    expect(already).toMatchObject({ ok: false, code: 'already_closed' })
    expect(already.message).toBe(`事件 ${closed} 已经关闭`)

    const unresolved = seedEvent({ state: OPS_UNRESOLVED })
    const result = ops.close({ eventId: unresolved, by: 'owner', reason: '' })
    expect(result).toEqual({
      ok: true,
      code: 'ok',
      message: `已关闭事件 ${unresolved}；历史与证据保留`,
    })
    const event = repository.opsEvent(unresolved)!
    expect(event.state).toBe(OPS_CLOSED)
    expect(event.closedAt).toBe(CLOCK_ISO)
    expect(event.humanInvolved).toBe(true)
    expect(event.humanReason).toBe('owner 关闭：未说明')
    expect(repository.opsObservations(unresolved).at(-1)).toMatchObject({
      kind: 'closed',
      summary: 'owner 关闭事件：未说明',
    })
  })
})

describe('OpsRuntime query and deployment surfaces', () => {
  it('reports list fallbacks, detail catalog filtering and statistics', () => {
    const { ops } = makeOps(unusedRunner())
    const ghost = seedEvent({
      resourceId: 'ghost',
      checkId: 'ghost-check',
      state: OPS_CLOSED,
      humanInvolved: true,
      closedAt: '2026-11-03T10:00:30.000Z',
    })
    const recovered = seedEvent({
      state: OPS_RECOVERED,
      diagnosisJson: diagnosisText(),
      openedAt: '2026-11-03T10:00:00.000Z',
      recoveredAt: '2026-11-03T10:00:30.000Z',
    })

    const list = ops.list()
    const ghostView = list.find((item) => item.eventId === ghost)!
    expect(ghostView.resourceLabel).toBe('ghost')
    expect(ghostView.resourceKind).toBe('other')
    expect(ghostView.diagnosis).toBeNull()
    expect(ghostView.lastObservation).toBe('')
    const recoveredView = list.find((item) => item.eventId === recovered)!
    expect(recoveredView.resourceLabel).toBe('页面')
    expect(recoveredView.resourceKind).toBe('app')
    expect(recoveredView.diagnosis?.proposedAction?.actionId).toBe('restart-web')

    const ghostDetail = ops.detail(ghost)!
    expect(ghostDetail.resource).toBeNull()
    expect(ghostDetail.check).toBeNull()
    expect(ghostDetail.actions).toEqual([])
    const recoveredDetail = ops.detail(recovered)!
    expect(recoveredDetail.resource?.id).toBe('web')
    expect(recoveredDetail.check?.id).toBe('web-health')
    expect(recoveredDetail.actions.map((action) => action.id)).toEqual([
      'restart-web',
      'manual-web',
    ])

    expect(ops.stats()).toEqual({
      total: 2,
      humanInvolved: 1,
      humanRate: 0.5,
      recovered: 1,
      unresolved: 0,
      awaitingDecision: 0,
      active: 0,
      closed: 1,
      fixRequirements: 0,
      averageRecoverySeconds: 30,
    })
  })

  it('rejects a proposed deployment when deployments are disabled', async () => {
    const runner = runnerOf(() => diagnosisText({ actionId: null, deploymentTargetId: 'prod' }))
    const { ops } = makeOps(runner)
    const eventId = seedEvent()

    await ops.tick()
    const rejection = repository
      .opsObservations(eventId)
      .find((item) => item.kind === 'deployment_rejected')!
    expect(rejection.summary).toBe('部署未启用，忽略诊断中的 proposed_deployment')
    expect(JSON.parse(rejection.detailJson)).toEqual({
      targetId: 'prod',
      source: `ops:${eventId}`,
    })
    expect(repository.opsEvent(eventId)?.state).toBe(OPS_AWAITING_DECISION)
  })
})
