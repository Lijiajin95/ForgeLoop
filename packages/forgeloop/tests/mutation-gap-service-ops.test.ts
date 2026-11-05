import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime } from '../src/runtime/service.js'

let dir = ''
let runtime: ForgeLoopRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-service-ops-gap-'))
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      agent: { provider: 'demo', model: 'demo' },
    },
    dir,
  )
  runtime = new ForgeLoopRuntime({ ctx: {}, config })
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

function stable(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TIME')
      .replace(/req-\d{14}-[0-9a-f]{6}/g, 'req-fixed')
      .replace(/\/tmp\/forgeloop-service-ops-gap-[^/]+/g, '/tmp/ws')
  }
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stable(item)]))
  }
  return value
}

describe('service operations on missing requirements', () => {
  it('returns stable not-found/validation failures', () => {
    const results = [
      runtime.revise({ reqId: 'missing', text: 'x', by: 'owner', source: 'test' }),
      runtime.cancel({ reqId: 'missing', by: 'owner', reason: 'x' }),
      runtime.stop({ reqId: 'missing', by: 'owner', reason: 'x' }),
      runtime.requeue({ reqId: 'missing', by: 'owner', source: 'test' }),
      runtime.grant({ reqId: 'missing', by: 'owner' }),
      runtime.retryTask({
        reqId: 'missing',
        planVersion: 1,
        taskId: 't1',
        by: 'owner',
        source: 'test',
      }),
      runtime.approvePlan({ reqId: 'missing', planVersion: 1, by: 'owner', source: 'test' }),
      runtime.requestOperation({
        reqId: 'missing',
        action: 'advance',
        by: 'owner',
        source: 'test',
      }),
      runtime.opsDecide({ eventId: 'missing', decision: 'approve', by: 'owner', source: 'test' }),
      runtime.opsClose({ eventId: 'missing', by: 'owner', reason: 'x' }),
      runtime.opsRequestFix({ eventId: 'missing', by: 'owner', source: 'test' }),
      runtime.taskDetail('missing', 't1'),
      runtime.taskExecution({ reqId: 'missing', taskId: 't1' }),
      runtime.sessionSummary('missing'),
      runtime.pendingClarifications('missing'),
      runtime.showPlan('missing'),
      runtime.evidence('missing'),
      runtime.requirementDetail('missing'),
      runtime.listRequests('missing'),
    ]
    expect(stable(results)).toMatchSnapshot()
  })

  it('rejects empty submissions', () => {
    expect(stable(runtime.submit({ text: '   ', by: 'owner', source: 'test' }))).toMatchSnapshot()
  })
})

describe('service operation sequences', () => {
  it('revises, cancels and refuses terminal mutation', () => {
    const submitted = runtime.submit({
      text: '实现登录',
      by: 'owner',
      source: 'test',
      analyze: false,
    })
    const reqId = /req-\d{14}-[0-9a-f]{6}/.exec(submitted.message)?.[0] ?? ''
    expect(() => runtime.revise({ reqId, text: '   ', by: 'owner', source: 'test' })).toThrow(
      '需求修订原文不能为空',
    )
    const results = [
      runtime.revise({ reqId, text: '实现登录 v2', by: 'owner', source: 'test' }),
      runtime.grant({ reqId, by: 'owner' }),
      runtime.cancel({ reqId, by: 'owner', reason: '不再需要' }),
      runtime.revise({ reqId, text: 'after cancel', by: 'owner', source: 'test' }),
      runtime.cancel({ reqId, by: 'owner', reason: '重复取消' }),
    ]
    expect(stable(results)).toMatchSnapshot()
  })

  it('stops, requeues and retries with stable failures', () => {
    const submitted = runtime.submit({
      text: '实现退出',
      by: 'owner',
      source: 'test',
      analyze: false,
    })
    const reqId = /req-\d{14}-[0-9a-f]{6}/.exec(submitted.message)?.[0] ?? ''
    const results = [
      runtime.stop({ reqId, by: 'owner', reason: '暂停' }),
      runtime.requeue({ reqId, by: 'owner', source: 'test' }),
      runtime.retryTask({ reqId, planVersion: 1, taskId: 't1', by: 'owner', source: 'test' }),
      runtime.requestOperation({ reqId, action: 'verify', by: 'owner', source: 'test' }),
    ]
    expect(stable(results)).toMatchSnapshot()
  })
})
