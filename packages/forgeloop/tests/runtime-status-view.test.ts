import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import type { FailureRound } from '../src/domain/counting.js'

interface GrantQuotaView {
  readonly grants: number
  readonly used: number
  readonly remaining: number
}

interface StatusView {
  readonly failureRoundDetails: readonly FailureRound[]
  readonly grantQuota: GrantQuotaView
}

let dir = ''
let runtime: ForgeLoopRuntime

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

function statusView(reqId: string): StatusView {
  const result = runtime.status(reqId)
  expect(result.ok, result.message).toBe(true)
  return result.data as StatusView
}

function failureRound(roundId: string, occurredAt: string): FailureRound {
  return {
    roundId,
    stage: 'formal_test',
    summary: `正式测试退出码 1（${roundId}）`,
    occurredAt,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-status-view-'))
  runtime = makeRuntime()
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('requirement status view failure visibility', () => {
  it('reports an empty failure detail list and the initial grant quota when no round is recorded', () => {
    const reqId = submitRequirement()

    const view = statusView(reqId)

    expect(view.failureRoundDetails).toEqual([])
    expect(view.grantQuota).toEqual({ grants: 1, used: 0, remaining: 3 })
    expect(runtime.repo.failureRounds(reqId)).toEqual([])
    expect(runtime.repo.grantCount(reqId)).toBe(1)
  })

  it('reports every recorded failure round with the authoritative fields and the used quota', () => {
    const reqId = submitRequirement()
    const first = failureRound('task-a-a1', '2026-10-22T10:00:00.000Z')
    const second = failureRound('task-b-a1', '2026-10-22T10:05:00.000Z')
    expect(runtime.repo.recordFailureRound(reqId, first)).toBe(true)
    expect(runtime.repo.recordFailureRound(reqId, second)).toBe(true)

    const view = statusView(reqId)

    expect(view.failureRoundDetails).toEqual([first, second])
    for (const detail of view.failureRoundDetails) {
      expect(detail).toEqual({
        roundId: expect.any(String),
        stage: expect.stringMatching(/^(formal_test|user_acceptance)$/),
        summary: expect.any(String),
        occurredAt: expect.any(String),
      })
    }
    expect(view.failureRoundDetails).toEqual(runtime.repo.failureRounds(reqId))
    expect(view.grantQuota).toEqual({ grants: 1, used: 2, remaining: 1 })
    expect(runtime.repo.failureRounds(reqId)).toHaveLength(2)
    expect(runtime.repo.grantCount(reqId)).toBe(1)
  })

  it('reports remaining 0 and the full details after the granted quota is exhausted', () => {
    const reqId = submitRequirement()
    const granted = runtime.grant({ reqId, by: 'owner' })
    expect(granted.ok, granted.message).toBe(true)
    const rounds = Array.from({ length: 6 }, (_, index) =>
      failureRound(`task-a-a${index + 1}`, `2026-10-22T11:0${index}:00.000Z`),
    )
    for (const round of rounds) expect(runtime.repo.recordFailureRound(reqId, round)).toBe(true)

    const view = statusView(reqId)

    expect(view.failureRoundDetails).toEqual(rounds)
    expect(view.grantQuota).toEqual({ grants: 2, used: 6, remaining: 0 })
    expect(view.failureRoundDetails).toEqual(runtime.repo.failureRounds(reqId))
    expect(runtime.repo.failureRounds(reqId)).toHaveLength(6)
    expect(runtime.repo.grantCount(reqId)).toBe(2)
  })
})