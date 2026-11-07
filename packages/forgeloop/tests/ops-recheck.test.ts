import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { resolveConfig } from '../src/config.js'
import { OpsRuntime } from '../src/runtime/ops.js'
import { OPS_CLOSED, OPS_UNRESOLVED } from '../src/domain/ops.js'
import type { AgentLike } from '../src/runtime/service.js'

let dir = ''
let repo: Repository
let ops: OpsRuntime

function config() {
  return resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      ops: {
        enabled: true,
        intervalSeconds: 60,
        resources: [{ id: 'web', kind: 'app', label: 'web' }],
        checks: [
          {
            id: 'web-health',
            resourceId: 'web',
            command: ['node', '-e', "process.exit(require('node:fs').existsSync('down') ? 1 : 0)"],
            timeoutSeconds: 10,
            severity: 'major',
          },
        ],
        actions: [],
      },
    },
    dir,
  )
}

const runner: AgentLike = {
  async run() {
    throw new Error('不需模型')
  },
}

function seedEvent(fixRequirementId: string, checkId = 'web-health'): string {
  const event = repo.createOpsEvent({
    eventId: 'ops-fix-1',
    project: 'testproj',
    resourceId: 'web',
    checkId,
    signature: 'sig',
    severity: 'major',
    state: 'recovered',
    title: 'web down',
    openedAt: '2026-11-05T09:00:00.000Z',
    updatedAt: '2026-11-05T09:00:00.000Z',
  })
  repo.updateOpsEvent(event.eventId, {
    fixRequirementId,
    updatedAt: '2026-11-05T09:10:00.000Z',
  })
  return event.eventId
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-ops-recheck-'))
  repo = new Repository(Database.open(join(dir, 'records.sqlite')))
  ops = new OpsRuntime({
    config: config(),
    repo,
    runner,
    now: () => new Date('2026-11-05T10:00:00.000Z'),
  })
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ops fix recheck', () => {
  it('closes the original event when the check passes after the fix deployment', async () => {
    const eventId = seedEvent('req-fix-1')
    await ops.recheckFix(eventId, 'dep-1')
    expect(repo.opsEvent(eventId)?.state).toBe(OPS_CLOSED)
    const observations = repo.opsObservations(eventId).filter((item) => item.kind === 'fix_check')
    expect(observations).toHaveLength(1)
    expect(observations[0]?.summary).toContain('原检查通过')
  })

  it('writes closed_at together with the closed state', async () => {
    const eventId = seedEvent('req-fix-1')
    await ops.recheckFix(eventId, 'dep-1')
    const event = repo.opsEvent(eventId)
    expect(event?.state).toBe(OPS_CLOSED)
    // closed 与 closed_at 必须同一次写入：只改状态会让关单时间缺失。
    expect(event?.closedAt).toBe('2026-11-05T10:00:00.000Z')
    expect(event?.updatedAt).toBe('2026-11-05T10:00:00.000Z')
  })

  it('keeps the first closed_at when the same intent is polled again', async () => {
    const eventId = seedEvent('req-fix-1')
    await ops.recheckFix(eventId, 'dep-1')
    const closedAt = repo.opsEvent(eventId)?.closedAt
    await ops.recheckFix(eventId, 'dep-1')
    expect(repo.opsEvent(eventId)?.closedAt).toBe(closedAt)
    expect(repo.opsObservations(eventId).filter((item) => item.kind === 'fix_check')).toHaveLength(
      1,
    )
  })

  it('keeps the event open when the original check is no longer registered', async () => {
    const eventId = seedEvent('req-fix-1', 'web-missing')
    await ops.recheckFix(eventId, 'dep-1')
    expect(repo.opsEvent(eventId)?.state).toBe(OPS_UNRESOLVED)
    expect(repo.opsEvent(eventId)?.closedAt ?? '').toBe('')
  })

  it('marks the event unresolved when the check still fails', async () => {
    const eventId = seedEvent('req-fix-1')
    writeFileSync(join(dir, 'down'), '')
    await ops.recheckFix(eventId, 'dep-1')
    expect(repo.opsEvent(eventId)?.state).toBe(OPS_UNRESOLVED)
    expect(
      repo.opsObservations(eventId).find((item) => item.kind === 'fix_check')?.summary,
    ).toContain('原检查失败')
  })

  it('does not record the same intent twice', async () => {
    const eventId = seedEvent('req-fix-1')
    await ops.recheckFix(eventId, 'dep-1')
    await ops.recheckFix(eventId, 'dep-1')
    expect(repo.opsObservations(eventId).filter((item) => item.kind === 'fix_check')).toHaveLength(
      1,
    )
  })
})
