import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { Coordinator } from '../src/runtime/coordinator.js'
import { resolveConfig } from '../src/config.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { OPS_RECOVERED, OPS_UNKNOWN } from '../src/domain/ops.js'

let dir = ''
let runtime: ForgeLoopRuntime
let coordinator: Coordinator | null = null

function result(request: AgentRunRequest, text: string): AgentRunResult {
  return {
    status: 'completed',
    text,
    sessionId: `session-fake-${request.role}`,
    reason: '',
    transcriptPath: request.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  }
}

const DIAGNOSIS = JSON.stringify({
  impact: '用户无法打开天工页面',
  facts: ['健康检查退出码 1'],
  hypotheses: [{ statement: '进程已退出', confidence: 'medium' }],
  proposed_action: { action_id: 'restart-web', params: {} },
  decision_required: false,
  fix_required: false,
  summary: '重启并复核',
})

function makeRuntime(): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 3600,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      ops: {
        enabled: true,
        intervalSeconds: 60,
        resources: [{ id: 'web', kind: 'app', label: '天工页面' }],
        checks: [
          {
            id: 'web-health',
            resourceId: 'web',
            command: ['node', '-e', "process.exit(require('node:fs').existsSync('down') ? 1 : 0)"],
            timeoutSeconds: 10,
          },
        ],
        actions: [
          {
            id: 'restart-web',
            resourceId: 'web',
            command: ['node', '-e', "require('node:fs').rmSync('down', { force: true })"],
            timeoutSeconds: 10,
            auto: true,
          },
        ],
      },
    },
    dir,
  )
  return new ForgeLoopRuntime({
    ctx: {},
    config,
    runner: { run: async (request) => result(request, DIAGNOSIS) },
  })
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待条件超时')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-ops-coordinator-'))
  runtime = makeRuntime()
})

afterEach(async () => {
  await coordinator?.stop()
  coordinator = null
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('coordinator ops wiring', () => {
  it('runs a failing registered check, diagnosis and authorized recovery', async () => {
    writeFileSync(join(dir, 'down'), '1')
    coordinator = new Coordinator({ runtime, pollSeconds: 3600, autoAdvance: false })
    coordinator.start()
    await waitFor(() => runtime.ops.list().some((event) => event.state === OPS_RECOVERED))

    const event = runtime.ops.list()[0]!
    expect(event.humanInvolved).toBe(false)
    expect(runtime.ops.detail(event.eventId)?.attempts[0]?.state).toBe('succeeded')
  })

  it('marks an action left running by a previous host as unknown and does not replay it', async () => {
    runtime.repo.createOpsEvent({
      eventId: 'ops-interrupted',
      project: 'testproj',
      resourceId: 'web',
      checkId: 'web-health',
      signature: 'web/web-health/1/interrupted',
      severity: 'major',
      state: 'recovering',
      title: '中断的动作',
      openedAt: '2026-10-29T10:00:00.000Z',
      updatedAt: '2026-10-29T10:00:00.000Z',
    })
    runtime.repo.recordOpsActionAttempt({
      actionId: 'opa-interrupted',
      eventId: 'ops-interrupted',
      actionDefId: 'restart-web',
      paramsJson: '{}',
      state: 'running',
      authorizationSource: 'owner:test:test',
      startedAt: '2026-10-29T10:00:00.000Z',
    })

    coordinator = new Coordinator({ runtime, pollSeconds: 3600, autoAdvance: false })
    coordinator.start()
    const event = runtime.repo.opsEvent('ops-interrupted')
    expect(event?.state).toBe(OPS_UNKNOWN)
    expect(event?.resultUnknown).toBe(true)
    expect(runtime.repo.opsActionAttempts('ops-interrupted')[0]?.state).toBe('unknown')

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(runtime.repo.opsActionAttempts('ops-interrupted')).toHaveLength(1)
  })
})
