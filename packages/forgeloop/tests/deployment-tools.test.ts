import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import type { DeploymentToolConfig } from '../src/config.js'
import type { DeploymentToolPlan } from '../src/runtime/deployment-tools.js'
import {
  deploymentToolArgv,
  deploymentToolEnv,
  runDeploymentTool,
  syncDeploymentToolScript,
} from '../src/runtime/deployment-tools.js'

let dir = ''
let repo: Repository
let database: Database
let planPath = ''

function tool(overrides: Partial<DeploymentToolConfig> = {}): DeploymentToolConfig {
  return {
    id: 'fake',
    kind: 'python',
    path: join(dir, 'tool.py'),
    capabilities: ['preflight', 'apply'],
    timeoutSeconds: 5,
    env: [],
    ...overrides,
  }
}

function writeScript(body: string): string {
  const path = join(dir, 'tool.py')
  writeFileSync(path, body)
  return path
}

const PLAN: DeploymentToolPlan = {
  intentId: 'intent-1',
  op: 'apply',
  artifact: { sha256: 'a'.repeat(64), path: '/tmp/artifact.tgz', version: '1.0.0' },
  previous: null,
  params: { profile: 'web' },
  device: { id: 'local', transport: 'local' },
  data: { volumes: [], migrations: [] },
  timeoutSeconds: 5,
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-deploy-tools-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repo = new Repository(database)
  planPath = join(dir, 'plan.json')
  writeFileSync(planPath, JSON.stringify(PLAN))
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('deployment tool invocation', () => {
  it('builds a fixed argv and a restricted environment', () => {
    expect(deploymentToolArgv(tool(), 'apply', planPath)).toEqual({
      command: 'python3',
      args: [join(dir, 'tool.py'), '--op', 'apply', '--plan', planPath],
    })
    expect(deploymentToolArgv(tool({ kind: 'shell' }), 'rollback', planPath).command).toBe(
      '/bin/sh',
    )
    process.env.FORGELOOP_DEPLOY_TEST = 'yes'
    try {
      expect(deploymentToolEnv(tool({ env: ['FORGELOOP_DEPLOY_TEST'] }))).toMatchObject({
        FORGELOOP_DEPLOY_TEST: 'yes',
      })
      expect(deploymentToolEnv(tool())).not.toHaveProperty('FORGELOOP_DEPLOY_TEST')
    } finally {
      delete process.env.FORGELOOP_DEPLOY_TEST
    }
  })

  it('runs the registered script and returns its real output', async () => {
    writeScript(
      [
        'import json, sys',
        'args = sys.argv',
        'op = args[args.index("--op") + 1]',
        'plan = json.load(open(args[args.index("--plan") + 1]))',
        'print(json.dumps({"ok": True, "state": "applied", "version": plan["artifact"]["version"], "detail": op}))',
      ].join('\n'),
    )
    const result = await runDeploymentTool(tool(), 'apply', planPath)
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.sha256).toHaveLength(64)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      state: 'applied',
      version: '1.0.0',
    })
  })

  it('reports non-zero exits, timeouts and oversized output without throwing', async () => {
    writeScript('import sys\nsys.exit(2)\n')
    const failed = await runDeploymentTool(tool(), 'apply', planPath)
    expect(failed.exitCode).toBe(2)
    expect(failed.timedOut).toBe(false)

    writeScript('import time\ntime.sleep(5)\n')
    const timedOut = await runDeploymentTool(tool({ timeoutSeconds: 1 }), 'apply', planPath)
    expect(timedOut.timedOut).toBe(true)
    expect(timedOut.exitCode).toBe(-1)

    writeScript('print("x" * 100000)\n')
    const big = await runDeploymentTool(tool(), 'apply', planPath)
    expect(big.truncated).toBe(true)
    expect(big.stdout.length).toBeLessThanOrEqual(64 * 1024)
  })
})

describe('deployment tool script records', () => {
  it('records the first digest, ignores an unchanged script and logs a change', () => {
    writeScript('print("v1")\n')
    const first = syncDeploymentToolScript(repo.deploymentStore, tool(), '2026-11-03T10:00:00.000Z')
    expect(first.changed).toBe(false)
    expect(repo.deploymentStore.deploymentToolScript('fake')?.sha256).toBe(first.sha256)
    expect(repo.deploymentStore.deploymentToolChanges('fake')).toEqual([])

    const same = syncDeploymentToolScript(repo.deploymentStore, tool(), '2026-11-03T10:01:00.000Z')
    expect(same.changed).toBe(false)

    writeScript('print("v2")\n')
    const changed = syncDeploymentToolScript(
      repo.deploymentStore,
      tool(),
      '2026-11-03T10:02:00.000Z',
    )
    expect(changed.changed).toBe(true)
    expect(changed.sha256).not.toBe(first.sha256)
    const changes = repo.deploymentStore.deploymentToolChanges('fake')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      toolId: 'fake',
      previousSha256: first.sha256,
      sha256: changed.sha256,
      changedAt: '2026-11-03T10:02:00.000Z',
    })
    expect(repo.deploymentStore.deploymentToolScript('fake')?.size).toBeGreaterThan(0)
  })
})

describe('deployment records', () => {
  it('stores intents, their state changes and tool attempts', () => {
    repo.deploymentStore.recordDeploymentIntent({
      intentId: 'intent-1',
      project: 'testproj',
      targetId: 'web',
      requirementId: 'req-1',
      artifactSha256: 'a'.repeat(64),
      artifactPath: '/tmp/a.tgz',
      artifactVersion: '1.0.0',
      source: 'owner',
      approval: 'auto',
      state: 'ready',
      createdAt: '2026-11-03T10:00:00.000Z',
      updatedAt: '2026-11-03T10:00:00.000Z',
    })
    repo.deploymentStore.updateDeploymentIntentState(
      'intent-1',
      'applying',
      '2026-11-03T10:00:05.000Z',
    )
    expect(repo.deploymentStore.deploymentIntent('intent-1')).toMatchObject({
      state: 'applying',
      approval: 'auto',
      updatedAt: '2026-11-03T10:00:05.000Z',
    })
    repo.deploymentStore.recordDeploymentAttempt({
      intentId: 'intent-1',
      op: 'apply',
      state: 'applied_pending_verify',
      exitCode: 0,
      resultJson: '{"ok":true}',
      detail: 'installed',
      toolSha256: 'b'.repeat(64),
      evidencePath: '/tmp/evidence',
      startedAt: '2026-11-03T10:00:05.000Z',
      finishedAt: '2026-11-03T10:00:06.000Z',
    })
    expect(repo.deploymentStore.deploymentAttempts('intent-1')).toHaveLength(1)
    expect(repo.deploymentStore.deploymentIntents()).toHaveLength(1)
    expect(repo.deploymentStore.deploymentIntent('missing')).toBeNull()

    repo.deploymentStore.recordDeploymentIntent({
      intentId: 'intent-2',
      project: 'testproj',
      targetId: 'web',
      requirementId: 'req-1',
      artifactSha256: 'c'.repeat(64),
      artifactPath: '/tmp/b.tgz',
      artifactVersion: '1.0.1',
      source: 'owner',
      approval: 'owner',
      state: 'awaiting_approval',
      createdAt: '2026-11-03T10:01:00.000Z',
      updatedAt: '2026-11-03T10:01:00.000Z',
    })
    expect(repo.deploymentStore.deploymentIntent('intent-2')).toMatchObject({
      approval: 'owner',
      state: 'awaiting_approval',
    })

    // 旧行或手工写入的未知值按最保守的初值回读，不让未知状态冒充成功。
    database.handle
      .prepare(
        `INSERT INTO deployment_intents
          (intent_id, project, target_id, requirement_id, artifact_sha256, artifact_path,
           artifact_version, source, approval, state, created_at, updated_at)
         VALUES ('intent-3', 'testproj', 'web', 'req-1', 'd', '/tmp/c.tgz', '1', 'x', 'owner',
                 'bogus', 'now', 'now')`,
      )
      .run()
    expect(repo.deploymentStore.deploymentIntent('intent-3')?.state).toBe('draft')
    database.handle
      .prepare(
        `INSERT INTO deployment_attempts
          (intent_id, op, state, exit_code, result_json, detail, tool_sha256, evidence_path,
           started_at, finished_at)
         VALUES ('intent-3', 'bogus', 'bogus', -1, '', '', '', '', 'now', '')`,
      )
      .run()
    const unknown = repo.deploymentStore.deploymentAttempts('intent-3')[0]
    expect(unknown?.op).toBe('preflight')
    expect(unknown?.state).toBe('draft')
  })
})
