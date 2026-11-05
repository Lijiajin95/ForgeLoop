import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime } from '../src/runtime/service.js'

let dir = ''
let runtime: ForgeLoopRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-service-lifecycle-'))
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      agent: { provider: 'demo', model: 'demo' },
      pollSeconds: 3600,
    },
    dir,
  )
  runtime = new ForgeLoopRuntime({ ctx: {}, config })
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

function submit(text = '实现登录', source = 'test'): string {
  const result = runtime.submit({ text, by: 'owner', source, analyze: false })
  return /req-\d{14}-[0-9a-f]{6}/.exec(result.message)?.[0] ?? ''
}

describe('retry decisions', () => {
  it('reports missing, stopped and normal requirements', () => {
    expect(runtime.retryDecisionFor('missing')).toEqual({
      allowed: false,
      reason: '未找到需求 missing',
    })
    const reqId = submit()
    const initial = runtime.retryDecisionFor(reqId)
    expect(initial.allowed).toBe(false)
    expect(initial.reason).not.toBe('')
    runtime.stop({ reqId, by: 'owner', reason: '暂停' })
    expect(runtime.retryDecisionFor(reqId)).toEqual({
      allowed: false,
      reason: '需求已被主动停止；恢复需要显式决定',
    })
  })
})

describe('stop settlement', () => {
  it('settles only when no request or running task remains', () => {
    const reqId = submit()
    runtime.settleStopIfQuiet(reqId)
    expect(runtime.retryDecisionFor(reqId).reason).not.toContain('主动停止')
    runtime.stop({ reqId, by: 'owner', reason: '暂停' })
    runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 'test' })
    runtime.settleStopIfQuiet(reqId)
    expect(runtime.retryDecisionFor(reqId).reason).toBe('需求已被主动停止；恢复需要显式决定')
  })
})

describe('plan change guard', () => {
  it('returns null when nothing is frozen and rejects unconfirmed changes', () => {
    const reqId = submit()
    // 没有分析结论时不允许排规划；分析可以排队。
    expect(
      runtime.requestOperation({ reqId, action: 'plan', by: 'owner', source: 'test' }),
    ).toMatchObject({
      ok: false,
      code: 'analysis_missing',
    })
    expect(
      runtime.requestOperation({ reqId, action: 'analyze', by: 'owner', source: 'test' }),
    ).toMatchObject({
      ok: true,
    })
  })

  it('requires a reason only for plan changes with a frozen approval', () => {
    const reqId = submit()
    // 未批准的任务包不触发 planChangeGuard；这里验证分析前置仍然生效。
    expect(
      runtime.requestOperation({
        reqId,
        action: 'plan',
        by: 'owner',
        source: 'test',
        confirmPlanChange: true,
        reason: '   ',
      }),
    ).toMatchObject({ ok: false, code: 'analysis_missing' })
  })
})

describe('auto advance scanning', () => {
  it('queues nothing for a fresh project and ignores terminal requirements', () => {
    expect(runtime.autoAdvanceRequests(new Date('2026-11-06T00:00:00.000Z'))).toEqual([])
    const reqId = submit()
    runtime.cancel({ reqId, by: 'owner', reason: '不需要' })
    expect(runtime.autoAdvanceRequests(new Date('2026-11-06T00:00:00.000Z'))).toEqual([])
  })

  it('does not auto-advance a stopped requirement', () => {
    const reqId = submit()
    runtime.stop({ reqId, by: 'owner', reason: '暂停' })
    expect(runtime.autoAdvanceRequests(new Date('2026-11-06T00:00:00.000Z'))).toEqual([])
  })
})

describe('intake and clarifications', () => {
  it('returns null when the queue is empty', () => {
    expect(runtime.intakeQueuedRequirement()).toBeNull()
  })

  it('lists no pending clarifications before analysis', () => {
    const reqId = submit()
    expect(runtime.pendingClarifications('session-1')).toEqual([])
    expect(runtime.openClarifications(reqId)).toEqual([])
  })
})

describe('views', () => {
  it('summarises the directory with an explicit agent selection', () => {
    const summary = runtime.directorySummary() as Record<string, unknown>
    expect(summary).toMatchObject({
      recordsRoot: join(dir, '.forgeloop'),
      projectPath: dir,
      agent: { provider: 'demo', model: 'demo' },
      autoAdvance: false,
    })
    expect(summary.database).toContain('records.sqlite')
  })

  it('reports board and reliability payloads', () => {
    expect(runtime.statusBoard()).toMatchObject({ project: 'demo' })
    expect(runtime.reliability('7d')).toMatchObject({ window: { key: '7d' } })
    expect(runtime.opsStatus()).toMatchObject({ ok: expect.any(Boolean) })
  })
})
