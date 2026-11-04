import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime } from '../src/runtime/service.js'

let dir = ''
let runtime: ForgeLoopRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-service-gap-'))
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
      .replace(/\/tmp\/forgeloop-service-gap-[^/]+/g, '/tmp/ws')
  }
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stable(item)]))
  }
  return value
}

describe('runtime empty-state payloads', () => {
  it('keeps status, reliability, ops, requests and directory payloads stable', () => {
    expect(stable(runtime.status())).toMatchSnapshot('status-empty')
    expect(stable(runtime.status('missing'))).toMatchSnapshot('status-missing')
    expect(stable(runtime.reliability('all'))).toMatchSnapshot('reliability-empty')
    expect(stable(runtime.opsStatus())).toMatchSnapshot('ops-empty')
    expect(stable(runtime.listRequests())).toMatchSnapshot('requests-empty')
    expect(stable(runtime.directorySummary())).toMatchSnapshot('directory-empty')
    expect(stable(runtime.requirementDetail('missing'))).toMatchSnapshot(
      'requirement-detail-missing',
    )
    expect(stable(runtime.showPlan('missing'))).toMatchSnapshot('plan-missing')
    expect(stable(runtime.evidence('missing'))).toMatchSnapshot('evidence-missing')
    expect(stable(runtime.taskDetail('missing', 't1'))).toMatchSnapshot('task-missing')
  })

  it('keeps a submitted requirement view stable', () => {
    const submitted = runtime.submit({
      text: '实现登录',
      by: 'owner',
      source: 'test',
      clientKey: 'key-1',
      analyze: false,
    })
    const reqId = /req-\d{14}-[0-9a-f]{6}/.exec(submitted.message)?.[0] ?? ''
    expect(stable(submitted)).toMatchSnapshot('submit')
    expect(stable(runtime.status(reqId))).toMatchSnapshot('status-one')
    expect(stable(runtime.requirementDetail(reqId))).toMatchSnapshot('requirement-detail')
    expect(stable(runtime.showPlan(reqId))).toMatchSnapshot('plan-one')
    expect(stable(runtime.listRequests(reqId))).toMatchSnapshot('requests-one')
  })
})
