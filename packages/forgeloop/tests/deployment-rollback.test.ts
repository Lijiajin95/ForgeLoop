import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { resolveConfig, type ForgeLoopConfig, type RawConfig } from '../src/config.js'
import { Deployments } from '../src/runtime/deployments.js'
import type { DeploymentArtifact } from '../src/domain/deployment.js'

let dir = ''
let database: Database
let repo: Repository
let script = ''
let config: ForgeLoopConfig
let alerts: Array<{ body: Record<string, unknown> }> = []

const ARTIFACT: DeploymentArtifact = {
  sha256: 'a'.repeat(64),
  path: '/tmp/a.tgz',
  version: '1.0.0',
}

function toolScript(): string {
  return [
    'import json, sys',
    'args = sys.argv',
    'op = args[args.index("--op") + 1]',
    'plan = json.load(open(args[args.index("--plan") + 1]))',
    'version = plan["artifact"]["version"]',
    'tag = plan["params"].get("tag", "")',
    'restore = "" if tag == "NO_RESTORE" else "rp-2026-11-04"',
    'if op == "preflight":',
    '    print(json.dumps({"ok": True, "state": "ready", "restorePoint": restore, "detail": "preflight ok"}))',
    'elif op == "apply":',
    '    print(json.dumps({"ok": True, "state": "applied", "detail": "apply ok"}))',
    'elif op == "status":',
    '    print(json.dumps({"ok": True, "state": "running", "version": version, "detail": "status ok"}))',
    'elif op == "rollback":',
    '    failed = tag == "FAIL_ROLLBACK"',
    '    print(json.dumps({"ok": not failed, "state": "rolled_back" if not failed else "failed", "detail": "rollback"}))',
    'elif op == "data-rollback":',
    '    print(json.dumps({"ok": True, "state": "rolled_back", "detail": "data rollback ok"}))',
  ].join('\n')
}

function raw(): RawConfig {
  return {
    project: 'testproj',
    projectPath: dir,
    recordsRoot: join(dir, '.forgeloop'),
    deployments: {
      enabled: true,
      alerts: { webhook: 'https://example.com/deploy-hook' },
      tools: [
        {
          id: 't',
          kind: 'python',
          path: script,
          capabilities: ['preflight', 'apply', 'status', 'rollback', 'data-rollback'],
          timeoutSeconds: 10,
        },
      ],
      targets: [
        { id: 'plain', toolId: 't', requirementId: 'req-1', approval: 'owner' },
        {
          id: 'data',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          data: { volumes: ['web-data'], migrations: [] },
        },
        {
          id: 'no-restore',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          data: { volumes: ['web-data'], migrations: [] },
          params: { tag: 'NO_RESTORE' },
        },
        {
          id: 'fail-rollback',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          data: { volumes: ['web-data'], migrations: [] },
          params: { tag: 'FAIL_ROLLBACK' },
        },
      ],
    } as never,
  }
}

function build(): Deployments {
  return new Deployments({
    config,
    store: repo.deploymentStore,
    gate: () => ({ ok: true, reason: '' }),
    now: () => '2026-11-04T00:00:00.000Z',
    alert: async (_url, body) => {
      alerts.push({ body })
      return { ok: true, error: '' }
    },
  })
}

async function deployed(targetId: string): Promise<{ deployments: Deployments; intentId: string }> {
  const deployments = build()
  const requested = await deployments.request({ targetId, artifact: ARTIFACT, source: 'owner' })
  const intentId = (requested.data as { intentId: string }).intentId
  await deployments.approve(intentId)
  await deployments.verify(intentId)
  return { deployments, intentId }
}

beforeEach(() => {
  alerts = []
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-deploy-rollback-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repo = new Repository(database)
  const toolDir = join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', 'tools')
  mkdirSync(toolDir, { recursive: true })
  script = join(toolDir, 'tool.py')
  writeFileSync(script, toolScript())
  config = resolveConfig(raw(), dir)
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('deployment rollback', () => {
  it('refuses a data target whose preflight has no restore point', async () => {
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'no-restore',
      artifact: ARTIFACT,
      source: 'owner',
    })
    expect(requested).toMatchObject({ ok: false, code: 'preflight_failed' })
    const intentId = deployments.list()[0]!.intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('preflight_failed')
    expect(deployments.detail(intentId)?.attempts.at(-1)?.detail).toContain('restorePoint')
  })

  it('runs data-rollback, rollback and a status re-check for a data target', async () => {
    const { deployments, intentId } = await deployed('data')
    expect(deployments.detail(intentId)?.intent.state).toBe('verified')

    const rolled = await deployments.rollback(intentId, '验证失败回退')
    expect(rolled.ok).toBe(true)
    const detail = deployments.detail(intentId)
    expect(detail?.intent.state).toBe('rolled_back')
    expect(detail?.attempts.map((attempt) => attempt.op)).toEqual([
      'preflight',
      'apply',
      'status',
      'data-rollback',
      'rollback',
      'status',
    ])
    expect(alerts).toHaveLength(0)
  })

  it('rolls back a non-data target without data-rollback', async () => {
    const { deployments, intentId } = await deployed('plain')
    const rolled = await deployments.rollback(intentId, '手动回退')
    expect(rolled.ok).toBe(true)
    expect(deployments.detail(intentId)?.attempts.map((attempt) => attempt.op)).toEqual([
      'preflight',
      'apply',
      'status',
      'rollback',
      'status',
    ])
  })

  it('alerts and marks failed when the rollback tool reports an error', async () => {
    const { deployments, intentId } = await deployed('fail-rollback')
    const rolled = await deployments.rollback(intentId, '回退')
    expect(rolled).toMatchObject({ ok: false, code: 'rollback_failed' })
    expect(deployments.detail(intentId)?.intent.state).toBe('failed')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.body.message).toContain('rollback')
  })

  it('rejects rollback before the target is applied and for unknown intents', async () => {
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'plain',
      artifact: ARTIFACT,
      source: 'owner',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('awaiting_approval')
    await expect(deployments.rollback(intentId, 'x')).resolves.toMatchObject({
      code: 'invalid_state',
    })
    await expect(deployments.rollback('missing', 'x')).resolves.toMatchObject({
      code: 'not_found',
    })
  })
})
