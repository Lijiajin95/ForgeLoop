import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, type ForgeLoopConfig, type RawConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { sendOpsAlert } from '../src/runtime/ops-alerts.js'

const PROJECT = 'forgeloop'
let dir = ''
let repository: Repository
let server: Server | null = null
let received = 0
const now = new Date('2026-11-02T10:00:00.000Z')

function alertConfig(webhook: string, timeoutSeconds = 2): ForgeLoopConfig {
  const raw: RawConfig = {
    project: PROJECT,
    ops: { alerts: { webhook, timeoutSeconds } },
  }
  return resolveConfig(raw, dir)
}

function alertInput(config: ForgeLoopConfig, eventId: string): Parameters<typeof sendOpsAlert>[0] {
  return {
    config,
    repo: repository,
    now,
    eventId,
    severity: 'major',
    title: '天工页面响应变慢',
    impact: '用户打开页面需要等待',
    source: 'monitor',
    summary: '监控发现问题',
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-ops-alerts-'))
  repository = new Repository(Database.open(join(dir, '.forgeloop', 'records.sqlite')))
  received = 0
  repository.createOpsEvent({
    eventId: 'ops-alert-test',
    project: PROJECT,
    resourceId: 'web',
    checkId: 'monitor',
    signature: 'monitor/web/test',
    severity: 'major',
    state: 'diagnosed',
    title: '告警测试',
    openedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })
})

afterEach(async () => {
  repository.close()
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

async function start(status: number): Promise<string> {
  const next = createServer((request, response) => {
    received += 1
    request.resume()
    response.writeHead(status)
    response.end(status === 204 ? undefined : 'body')
  })
  server = next
  await new Promise<void>((resolve) => next.listen(0, '127.0.0.1', resolve))
  const address = next.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
  return `http://127.0.0.1:${address.port}/hook`
}

describe('ops external alerts', () => {
  it('does nothing when no webhook is configured', async () => {
    const config = alertConfig('')
    const outcome = await sendOpsAlert(alertInput(config, 'ops-alert-test'))
    expect(outcome).toEqual({ sent: false, error: '' })
    expect(repository.opsObservations('ops-alert-test')).toEqual([])
    expect(received).toBe(0)
  })

  it('records a failed alert for a non-2xx response', async () => {
    const url = await start(500)
    const config = alertConfig(url)
    const outcome = await sendOpsAlert(alertInput(config, 'ops-alert-test'))
    expect(outcome.sent).toBe(false)
    expect(outcome.error).toContain('HTTP 500')
    const observations = repository.opsObservations('ops-alert-test')
    expect(observations).toHaveLength(1)
    expect(observations[0]?.kind).toBe('alert_error')
    expect(observations[0]?.summary).toContain('http://127.0.0.1')
    expect(observations[0]?.detailJson).not.toContain('/hook')
  })

  it('records a failed alert when the webhook is unreachable', async () => {
    const config = alertConfig('http://127.0.0.1:1/hook', 1)
    const outcome = await sendOpsAlert(alertInput(config, 'ops-alert-test'))
    expect(outcome.sent).toBe(false)
    expect(outcome.error).toContain('告警发送失败')
    expect(repository.opsObservations('ops-alert-test')[0]?.kind).toBe('alert_error')
  })

  it('records a failed alert for an invalid webhook origin', async () => {
    const base = alertConfig('')
    const config: ForgeLoopConfig = {
      ...base,
      ops: { ...base.ops, alerts: { webhook: 'not-a-url', timeoutSeconds: 1 } },
    }
    const outcome = await sendOpsAlert(alertInput(config, 'ops-alert-test'))
    expect(outcome.sent).toBe(false)
    expect(outcome.error).toContain('invalid-url')
  })
})
