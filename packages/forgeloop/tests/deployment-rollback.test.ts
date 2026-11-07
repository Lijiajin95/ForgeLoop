import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function artifact(version: string, content: string): DeploymentArtifact {
  const path = join(dir, `candidate-${version}.tgz`)
  writeFileSync(path, content)
  return { sha256: createHash('sha256').update(content).digest('hex'), path, version }
}

function toolScript(): string {
  return [
    'import json, os, sys',
    'args = sys.argv',
    'op = args[args.index("--op") + 1]',
    'plan = json.load(open(args[args.index("--plan") + 1]))',
    'tag = plan["params"].get("tag", "")',
    'here = os.path.dirname(os.path.abspath(__file__))',
    'state_path = os.path.join(here, "state.json")',
    'state = json.load(open(state_path)) if os.path.exists(state_path) else {}',
    'def save(value):',
    '    json.dump(value, open(state_path, "w"))',
    'if op == "preflight":',
    '    restore = "" if tag == "NO_RESTORE" else "rp-2026-11-04"',
    '    print(json.dumps({"ok": True, "state": "ready", "restorePoint": restore, "detail": "preflight ok"}))',
    'elif op == "apply":',
    '    save({"version": plan["artifact"]["version"], "sha": plan["artifact"]["sha256"]})',
    '    print(json.dumps({"ok": True, "state": "applied", "detail": "apply ok"}))',
    'elif op == "data-rollback":',
    '    failed = tag == "FAIL_DATA_ROLLBACK"',
    '    print(json.dumps({"ok": not failed, "state": "failed" if failed else "rolled_back", "detail": "data rollback " + plan["previous"]["restorePoint"]}))',
    'elif op == "rollback":',
    '    if tag == "FAIL_ROLLBACK":',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": "rollback"}))',
    '    elif tag == "STUCK_ROLLBACK":',
    '        print(json.dumps({"ok": True, "state": "rolled_back", "detail": "pretend rollback"}))',
    '    else:',
    '        save({"version": plan["previous"]["version"], "sha": plan["previous"]["sha256"]})',
    '        print(json.dumps({"ok": True, "state": "rolled_back", "detail": "rollback"}))',
    'elif op == "status":',
    '    current = state or {"version": plan["artifact"]["version"], "sha": plan["artifact"]["sha256"]}',
    '    print(json.dumps({"ok": True, "state": "running", "version": current["version"], "artifactSha256": current["sha"], "runningArtifactSha256": current["sha"], "runningPid": os.getpid(), "runningStartedAt": "2026-11-04T00:00:00Z", "detail": "status"}))',
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
          params: { tag: 'FAIL_ROLLBACK' },
        },
        {
          id: 'stuck-rollback',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          params: { tag: 'STUCK_ROLLBACK' },
        },
        {
          id: 'fail-data',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          data: { volumes: ['web-data'], migrations: [] },
          params: { tag: 'FAIL_DATA_ROLLBACK' },
        },
      ],
    } as never,
  }
}

function build(options: { failStatus?: boolean } = {}): Deployments {
  return new Deployments({
    config,
    store: repo.deploymentStore,
    gate: () => ({ ok: true, reason: '' }),
    now: () => '2026-11-04T00:00:00.000Z',
    alert: async (_url, body) => {
      alerts.push({ body })
      return { ok: true, error: '' }
    },
    ...(options.failStatus
      ? {
          runTool: async () => {
            throw new Error('status down')
          },
        }
      : {}),
  })
}

async function deploy(
  deployments: Deployments,
  targetId: string,
  value: DeploymentArtifact,
): Promise<string> {
  const requested = await deployments.request({
    targetId,
    artifact: value,
    source: `owner-${targetId}-${value.version}`,
  })
  expect(requested.ok, requested.message).toBe(true)
  const intentId = (requested.data as { intentId: string }).intentId
  const approved = await deployments.approve(intentId)
  expect(approved.ok, approved.message).toBe(true)
  const verified = await deployments.verify(intentId)
  expect(verified.ok, verified.message).toBe(true)
  return intentId
}

function lastPlan(intentId: string, op: string): Record<string, unknown> {
  const path = join(
    dir,
    '.forgeloop',
    'projects',
    'testproj',
    'deployments',
    intentId,
    `${op}.json`,
  )
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
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
      artifact: artifact('1.0.0', 'v1'),
      source: 'owner',
    })
    expect(requested).toMatchObject({ ok: false, code: 'preflight_failed' })
    const intentId = deployments.list()[0]!.intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('preflight_failed')
    expect(deployments.detail(intentId)?.attempts.at(-1)?.detail).toContain('restorePoint')
  })

  it('rolls back to the previous verified artifact, not the current one', async () => {
    const deployments = build()
    const v1 = artifact('1.0.0', 'v1')
    const v2 = artifact('2.0.0', 'v2')
    await deploy(deployments, 'plain', v1)
    const intentId = await deploy(deployments, 'plain', v2)

    const rolled = await deployments.rollback(intentId, '测试失败回退')
    expect(rolled.ok, rolled.message).toBe(true)
    const detail = deployments.detail(intentId)
    expect(detail?.intent.state).toBe('rolled_back')
    // 工具收到的 previous 是上一已验证制品，不是本次制品。
    const plan = lastPlan(intentId, 'rollback')
    expect((plan.previous as { sha256: string }).sha256).toBe(v1.sha256)
    expect(plan.artifact).toMatchObject({ sha256: v2.sha256 })
    expect((rolled.data as { artifactSha256: string }).artifactSha256).toBe(v1.sha256)
    expect(alerts).toHaveLength(0)
  })

  it('runs data-rollback with the previous artifact before rollback', async () => {
    const deployments = build()
    const v1 = artifact('1.0.0', 'data-v1')
    const v2 = artifact('2.0.0', 'data-v2')
    await deploy(deployments, 'data', v1)
    const intentId = await deploy(deployments, 'data', v2)

    const rolled = await deployments.rollback(intentId, '数据回退')
    expect(rolled.ok, rolled.message).toBe(true)
    const detail = deployments.detail(intentId)
    expect(detail?.attempts.map((attempt) => attempt.op)).toEqual([
      'preflight',
      'apply',
      'status',
      'data-rollback',
      'rollback',
      'status',
    ])
    const plan = lastPlan(intentId, 'data-rollback')
    expect((plan.previous as { sha256: string; restorePoint: string }).sha256).toBe(v1.sha256)
    expect((plan.previous as { restorePoint: string }).restorePoint).toBe('rp-2026-11-04')
  })

  it('refuses rollback when there is no previous verified artifact', async () => {
    const deployments = build()
    const intentId = await deploy(deployments, 'plain', artifact('1.0.0', 'only'))

    const rolled = await deployments.rollback(intentId, '没有上一版本')
    expect(rolled).toMatchObject({ ok: false, code: 'no_previous_artifact' })
    expect(deployments.detail(intentId)?.intent.state).toBe('verified')
    expect(deployments.detail(intentId)?.attempts.map((attempt) => attempt.op)).toEqual([
      'preflight',
      'apply',
      'status',
    ])
  })

  it('refuses rollback when the previous artifact is no longer retained', async () => {
    const deployments = build()
    const v1 = artifact('1.0.0', 'retained')
    const v2 = artifact('2.0.0', 'current')
    await deploy(deployments, 'plain', v1)
    const intentId = await deploy(deployments, 'plain', v2)
    rmSync(v1.path)

    const rolled = await deployments.rollback(intentId, '制品丢失')
    expect(rolled).toMatchObject({ ok: false, code: 'previous_artifact_missing' })
    expect(deployments.detail(intentId)?.intent.state).toBe('verified')
  })

  it('refuses rollback when the retained artifact content changed', async () => {
    const deployments = build()
    const v1 = artifact('1.0.0', 'retained')
    const v2 = artifact('2.0.0', 'current')
    await deploy(deployments, 'plain', v1)
    const intentId = await deploy(deployments, 'plain', v2)
    writeFileSync(v1.path, 'tampered')

    const rolled = await deployments.rollback(intentId, '制品被改')
    expect(rolled).toMatchObject({ ok: false, code: 'previous_artifact_changed' })
    expect(deployments.detail(intentId)?.intent.state).toBe('verified')
  })

  it('stops before rollback when data recovery fails', async () => {
    const deployments = build()
    await deploy(deployments, 'fail-data', artifact('1.0.0', 'data-fail-v1'))
    const intentId = await deploy(deployments, 'fail-data', artifact('2.0.0', 'data-fail-v2'))

    const rolled = await deployments.rollback(intentId, '数据恢复失败')
    expect(rolled).toMatchObject({ ok: false, code: 'data_rollback_failed' })
    expect(deployments.detail(intentId)?.intent.state).toBe('failed')
    // 数据恢复失败后不再执行代码回退。
    expect(deployments.detail(intentId)?.attempts.map((attempt) => attempt.op)).toEqual([
      'preflight',
      'apply',
      'status',
      'data-rollback',
    ])
    expect(alerts).toHaveLength(1)
  })

  it('fails when the tool reports success but the target still runs the new artifact', async () => {
    const deployments = build()
    await deploy(deployments, 'stuck-rollback', artifact('1.0.0', 'stuck-v1'))
    const intentId = await deploy(deployments, 'stuck-rollback', artifact('2.0.0', 'stuck-v2'))

    const rolled = await deployments.rollback(intentId, '假回退')
    expect(rolled).toMatchObject({ ok: false, code: 'rollback_verify_failed' })
    expect(rolled.message).toContain('期望上一已验证版本 1.0.0')
    expect(deployments.detail(intentId)?.intent.state).toBe('failed')
    expect(alerts).toHaveLength(1)
  })

  it('alerts and marks failed when the rollback tool reports an error', async () => {
    const deployments = build()
    await deploy(deployments, 'fail-rollback', artifact('1.0.0', 'fail-v1'))
    const intentId = await deploy(deployments, 'fail-rollback', artifact('2.0.0', 'fail-v2'))
    const rolled = await deployments.rollback(intentId, '回退')
    expect(rolled).toMatchObject({ ok: false, code: 'rollback_failed' })
    expect(deployments.detail(intentId)?.intent.state).toBe('failed')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.body.message).toContain('rollback')
  })

  it('completes as rolled back when the interrupted target already runs the previous artifact', async () => {
    const deployments = build()
    const v1 = artifact('1.0.0', 'recovered-v1')
    const v2 = artifact('2.0.0', 'recovered-v2')
    await deploy(deployments, 'plain', v1)
    const intentId = await deploy(deployments, 'plain', v2)
    // 模拟宿主在回退过程中崩溃，而外部工具已经完成回退。
    writeFileSync(
      join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', 'tools', 'state.json'),
      JSON.stringify({ version: '1.0.0', sha: v1.sha256 }),
    )
    repo.deploymentStore.updateDeploymentIntentState(
      intentId,
      'rolling_back',
      '2026-11-01T00:00:00.000Z',
    )

    expect(await deployments.recoverInterrupted('2026-11-04T00:00:00.000Z')).toBe(1)
    expect(deployments.detail(intentId)?.intent.state).toBe('rolled_back')
    expect(
      repo.deploymentStore
        .deploymentDecisions(intentId)
        .some((entry) => entry.decision === 'recovery_rolled_back'),
    ).toBe(true)
  })

  it('fails an interrupted rollback that still runs the new artifact', async () => {
    const deployments = build()
    const v1 = artifact('1.0.0', 'stuck-v1')
    const v2 = artifact('2.0.0', 'stuck-v2')
    await deploy(deployments, 'plain', v1)
    const intentId = await deploy(deployments, 'plain', v2)
    repo.deploymentStore.updateDeploymentIntentState(
      intentId,
      'rolling_back',
      '2026-11-01T00:00:00.000Z',
    )

    expect(await deployments.recoverInterrupted('2026-11-04T00:00:00.000Z')).toBe(1)
    expect(deployments.detail(intentId)?.intent.state).toBe('failed')
    expect(
      repo.deploymentStore
        .deploymentDecisions(intentId)
        .some((entry) => entry.decision === 'recovery_failed'),
    ).toBe(true)
  })

  it('releases a target whose interrupted rollback cannot be observed', async () => {
    const deployedBy = build()
    const v1 = artifact('1.0.0', 'unknown-v1')
    const v2 = artifact('2.0.0', 'unknown-v2')
    await deploy(deployedBy, 'plain', v1)
    const intentId = await deploy(deployedBy, 'plain', v2)
    repo.deploymentStore.updateDeploymentIntentState(
      intentId,
      'rolling_back',
      '2026-11-01T00:00:00.000Z',
    )

    const blind = build({ failStatus: true })
    expect(await blind.recoverInterrupted('2026-11-04T00:00:00.000Z')).toBe(1)
    expect(blind.detail(intentId)?.intent.state).toBe('failed')
    expect(
      repo.deploymentStore
        .deploymentDecisions(intentId)
        .some((entry) => entry.decision === 'recovery_unknown'),
    ).toBe(true)
    // 目标已释放，不再被 rolling_back 永久占用。
    const next = await build().request({
      targetId: 'plain',
      artifact: v2,
      source: 'after-recovery',
    })
    expect(next.ok, next.message).toBe(true)
  })

  it('releases a target whose interrupted rollback has no previous artifact', async () => {
    const deployments = build()
    const intentId = await deploy(deployments, 'plain', artifact('1.0.0', 'first-only'))
    repo.deploymentStore.updateDeploymentIntentState(
      intentId,
      'rolling_back',
      '2026-11-01T00:00:00.000Z',
    )

    expect(await deployments.recoverInterrupted('2026-11-04T00:00:00.000Z')).toBe(1)
    expect(deployments.detail(intentId)?.intent.state).toBe('failed')
    expect(
      repo.deploymentStore
        .deploymentDecisions(intentId)
        .some((entry) => entry.decision === 'recovery_unknown'),
    ).toBe(true)
  })

  it('rejects rollback before the target is applied and for unknown intents', async () => {
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'plain',
      artifact: artifact('1.0.0', 'pending'),
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
