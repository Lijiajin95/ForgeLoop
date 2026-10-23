import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CommandSurface } from '../src/commands.js'
import { resolveConfig } from '../src/config.js'
import { Coordinator } from '../src/runtime/coordinator.js'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import type { FailureRound } from '../src/domain/counting.js'

interface GrantQuota {
  readonly grants: number
  readonly used: number
  readonly remaining: number
}

interface StatusCommandView {
  readonly reqId: string
  readonly status: string
  readonly failureRounds: number
  readonly grants: number
  readonly failureRoundDetails: readonly FailureRound[]
  readonly grantQuota: GrantQuota
}

interface RequirementListView {
  readonly requirements: readonly { readonly reqId: string; readonly status: string }[]
}

let dir = ''
let runtime: ForgeLoopRuntime
let surface: CommandSurface

function makeRuntime(): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config })
}

function submitRequirement(): string {
  const submitted = runtime.submit({ text: '失败轮次可见性', by: 'owner', source: 'test' })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

function failureRound(roundId: string, occurredAt: string): FailureRound {
  return {
    roundId,
    stage: 'formal_test',
    summary: `正式测试退出码 1（${roundId}）`,
    occurredAt,
  }
}

function parseBody(text: string): Record<string, unknown> {
  const newline = text.indexOf('\n')
  expect(newline).toBeGreaterThan(-1)
  return JSON.parse(text.slice(newline + 1)) as Record<string, unknown>
}

async function statusCommand(rawInput: string): Promise<{ kind: 'success' | 'error'; text: string }> {
  return surface.handle({ rawInput })
}

async function statusView(reqId: string): Promise<StatusCommandView> {
  const output = await statusCommand(`status ${reqId}`)
  expect(output.kind, output.text).toBe('success')
  return parseBody(output.text) as unknown as StatusCommandView
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-status-command-'))
  runtime = makeRuntime()
  surface = new CommandSurface(
    runtime,
    new Coordinator({ runtime, pollSeconds: 60, autoAdvance: false }),
    runtime.config,
  )
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('/fl status failure visibility output', () => {
  it('shows an empty failure detail list and the initial quota when no round is recorded', async () => {
    const reqId = submitRequirement()

    const view = await statusView(reqId)
    const output = await statusCommand(`status ${reqId}`)

    expect(view.failureRoundDetails).toEqual([])
    expect(view.grantQuota).toEqual({ grants: 1, used: 0, remaining: 3 })
    // 0 轮只输出空数组，不伪造记录，也不改变既有字段。
    expect(runtime.repo.failureRounds(reqId)).toEqual([])
    expect(view.failureRounds).toBe(0)
    expect(view.grants).toBe(1)
    expect(view.status).toBe('draft')
    expect(output.text).toContain('"failureRoundDetails": []')
    expect(output.text).toContain('"grantQuota"')
  })

  it('shows every recorded round with roundId/stage/summary/occurredAt and the used quota', async () => {
    const reqId = submitRequirement()
    const first = failureRound('task-a-a1', '2026-10-22T10:00:00.000Z')
    const second = failureRound('task-b-a1', '2026-10-22T10:05:00.000Z')
    expect(runtime.repo.recordFailureRound(reqId, first)).toBe(true)
    expect(runtime.repo.recordFailureRound(reqId, second)).toBe(true)

    const view = await statusView(reqId)

    expect(view.failureRoundDetails).toEqual([first, second])
    expect(view.failureRoundDetails).toEqual(runtime.repo.failureRounds(reqId))
    for (const detail of view.failureRoundDetails) {
      expect(detail).toEqual({
        roundId: expect.any(String),
        stage: expect.stringMatching(/^(formal_test|user_acceptance)$/),
        summary: expect.any(String),
        occurredAt: expect.any(String),
      })
    }
    expect(view.grantQuota).toEqual({ grants: 1, used: 2, remaining: 1 })
    expect(view.failureRounds).toBe(2)
    expect(view.grants).toBe(1)
  })

  it('shows remaining 0 with the full details when the granted quota is exhausted', async () => {
    const reqId = submitRequirement()
    const granted = runtime.grant({ reqId, by: 'owner' })
    expect(granted.ok, granted.message).toBe(true)
    const rounds = Array.from({ length: 6 }, (_, index) =>
      failureRound(`task-a-a${index + 1}`, `2026-10-22T11:0${index}:00.000Z`),
    )
    for (const round of rounds) expect(runtime.repo.recordFailureRound(reqId, round)).toBe(true)

    const view = await statusView(reqId)

    expect(view.failureRoundDetails).toEqual(rounds)
    expect(view.grantQuota).toEqual({ grants: 2, used: 6, remaining: 0 })
    expect(view.failureRoundDetails).toEqual(runtime.repo.failureRounds(reqId))
    expect(view.failureRounds).toBe(6)
    expect(view.grants).toBe(2)
  })

  it('keeps the existing requirement-list output and not-found rejection', async () => {
    const reqId = submitRequirement()

    const list = await statusCommand('status')
    expect(list.kind).toBe('success')
    const listView = parseBody(list.text) as unknown as RequirementListView
    expect(listView.requirements.map((requirement) => requirement.reqId)).toEqual([reqId])
    expect(list.text).not.toContain('failureRoundDetails')

    const missing = await statusCommand('status req-not-found')
    expect(missing.kind).toBe('error')
    expect(missing.text).toContain('拒绝(not_found)')
  })
})