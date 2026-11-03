import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { resolveConfig, type ForgeLoopConfig, type RawConfig } from '../src/config.js'
import { Deployments } from '../src/runtime/deployments.js'
import type { DeploymentGate } from '../src/runtime/deployment-gate.js'
import type { DeploymentArtifact } from '../src/domain/deployment.js'

let dir = ''
let database: Database
let repo: Repository
let script = ''
let config: ForgeLoopConfig
let alerts: Array<{ url: string; body: Record<string, unknown> }> = []

const ARTIFACT: DeploymentArtifact = {
  sha256: 'a'.repeat(64),
  path: '/tmp/a.tgz',
  version: '1.0.0',
}

function deploymentRaw(extra: Record<string, unknown> = {}): RawConfig {
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
        { id: 'owner', toolId: 't', requirementId: 'req-1', approval: 'owner' },
        {
          id: 'auto',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'auto',
          rollback: { keep: 1 },
        },
        {
          id: 'broken',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          params: { tag: 'FAIL_STATUS' },
        },
        {
          id: 'data',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          data: { volumes: ['web-data'] },
        },
      ],
      ...extra,
    } as never,
  }
}

function build(overrides: { gate?: DeploymentGate; now?: () => string } = {}): Deployments {
  return new Deployments({
    config,
    store: repo.deploymentStore,
    gate: overrides.gate ?? (() => ({ ok: true, reason: '' })),
    now: overrides.now ?? (() => '2026-11-03T10:00:00.000Z'),
    alert: async (url, body) => {
      alerts.push({ url, body })
      return { ok: true, error: '' }
    },
  })
}

function toolScript(): string {
  return [
    'import json, sys',
    'args = sys.argv',
    'op = args[args.index("--op") + 1]',
    'plan = json.load(open(args[args.index("--plan") + 1]))',
    'version = plan["artifact"]["version"]',
    'tag = plan["params"].get("tag", "")',
    'if op == "preflight":',
    '    print(json.dumps({"ok": True, "state": "ready", "detail": "preflight ok"}))',
    'elif op == "apply":',
    '    print(json.dumps({"ok": True, "state": "applied", "detail": "apply ok"}))',
    'elif op == "status":',
    '    value = "9.9.9" if tag == "FAIL_STATUS" else version',
    '    print(json.dumps({"ok": True, "state": "running", "version": value, "detail": "status ok"}))',
    'elif op == "rollback":',
    '    print(json.dumps({"ok": True, "state": "rolled_back", "detail": "rollback ok"}))',
  ].join('\n')
}

beforeEach(() => {
  alerts = []
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-deploy-run-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repo = new Repository(database)
  const toolDir = join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', 'tools')
  mkdirSync(toolDir, { recursive: true })
  script = join(toolDir, 'tool.py')
  writeFileSync(script, toolScript())
  config = resolveConfig(deploymentRaw(), dir)
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('deployment coordinator', () => {
  it('runs preflight, waits for owner approval, applies and verifies', async () => {
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'owner',
    })
    expect(requested.ok).toBe(true)
    const intentId = (requested.data as { intentId: string }).intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('awaiting_approval')

    const approved = await deployments.approve(intentId)
    expect(approved.ok).toBe(true)
    expect(deployments.detail(intentId)?.intent.state).toBe('applied_pending_verify')

    const verified = await deployments.verify(intentId)
    expect(verified.ok).toBe(true)
    const detail = deployments.detail(intentId)
    expect(detail?.intent.state).toBe('verified')
    expect(detail?.attempts.map((attempt) => attempt.op)).toEqual(['preflight', 'apply', 'status'])
    expect(deployments.list()).toHaveLength(1)
  })

  it('applies automatically when the target is auto', async () => {
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'auto',
      artifact: ARTIFACT,
      source: 'auto',
    })
    expect(requested.ok).toBe(true)
    const intentId = (requested.data as { intentId: string }).intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('applied_pending_verify')
  })

  it('stops before the tool when the gate rejects', async () => {
    const deployments = build({ gate: () => ({ ok: false, reason: '独立验证未通过' }) })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'ops',
    })
    expect(requested).toMatchObject({ ok: false, code: 'preflight_failed' })
    const intentId = deployments.list()[0]!.intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('preflight_failed')
    expect(deployments.detail(intentId)?.attempts[0]?.detail).toContain('独立验证未通过')
  })

  it('marks a version mismatch as verify_failed and alerts once', async () => {
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'broken',
      artifact: ARTIFACT,
      source: 'owner',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    await deployments.approve(intentId)
    const verified = await deployments.verify(intentId)
    expect(verified).toMatchObject({ ok: false, code: 'verify_failed' })
    expect(deployments.detail(intentId)?.intent.state).toBe('verify_failed')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.body.message).toContain('9.9.9')
  })

  it('rejects, forbids invalid transitions and requires a restore point for data rollback', async () => {
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'owner',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    expect(deployments.reject(intentId, '不需要').ok).toBe(true)
    expect(await deployments.approve(intentId)).toMatchObject({ code: 'invalid_state' })
    expect(deployments.reject('missing', 'x')).toMatchObject({ code: 'not_found' })
  })

  it('reports preflight timeouts, non-zero exits, malformed output and tool exceptions', async () => {
    const gate = () => ({ ok: true, reason: '' })
    const run =
      (overrides: { exitCode?: number; stdout?: string; timedOut?: boolean }) => async () => ({
        exitCode: overrides.exitCode ?? 0,
        stdout: overrides.stdout ?? '{"ok":true,"state":"ready","detail":"ok"}',
        stderr: '',
        timedOut: overrides.timedOut ?? false,
        truncated: false,
        sha256: 'x',
        durationMs: 1,
      })
    const cases = [
      run({ exitCode: -1, timedOut: true, stdout: '' }),
      run({ exitCode: 2, stdout: '' }),
      run({ stdout: 'not json' }),
    ]
    for (const runTool of cases) {
      const deployments = new Deployments({
        config,
        store: repo.deploymentStore,
        gate,
        alert: async () => ({ ok: true, error: '' }),
        runTool,
      })
      expect(
        await deployments.request({ targetId: 'owner', artifact: ARTIFACT, source: 'x' }),
      ).toMatchObject({ code: 'preflight_failed' })
    }
    const thrown = new Deployments({
      config,
      store: repo.deploymentStore,
      gate,
      alert: async () => ({ ok: true, error: '' }),
      runTool: async () => {
        throw new Error('spawn failed')
      },
    })
    expect(
      await thrown.request({ targetId: 'owner', artifact: ARTIFACT, source: 'x' }),
    ).toMatchObject({ code: 'preflight_failed' })
  })

  it('fails the apply step when the tool reports an error', async () => {
    const deployments = new Deployments({
      config,
      store: repo.deploymentStore,
      gate: () => ({ ok: true, reason: '' }),
      alert: async () => ({ ok: true, error: '' }),
      runTool: async (_tool, op) => ({
        exitCode: 0,
        stdout:
          op === 'preflight'
            ? '{"ok":true,"state":"ready","detail":"ok"}'
            : '{"ok":false,"state":"failed","detail":"apply broken"}',
        stderr: '',
        timedOut: false,
        truncated: false,
        sha256: 'x',
        durationMs: 1,
      }),
    })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'x',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    expect(await deployments.approve(intentId)).toMatchObject({ code: 'tool_failed' })
    expect(deployments.detail(intentId)?.intent.state).toBe('failed')
  })

  it('treats tool-reported failures as failures and skips alerts without a webhook', async () => {
    const failTool = async (_tool: unknown, op: string) => ({
      exitCode: 0,
      stdout:
        op === 'status'
          ? '{"ok":false,"state":"failed","detail":"down"}'
          : '{"ok":false,"state":"failed","detail":"broken"}',
      stderr: '',
      timedOut: false,
      truncated: false,
      sha256: 'x',
      durationMs: 1,
    })
    const preflightFail = new Deployments({
      config,
      store: repo.deploymentStore,
      gate: () => ({ ok: true, reason: '' }),
      alert: async () => ({ ok: true, error: '' }),
      runTool: failTool,
    })
    expect(
      await preflightFail.request({ targetId: 'owner', artifact: ARTIFACT, source: 'x' }),
    ).toMatchObject({ code: 'preflight_failed' })

    const normalTool = async (_tool: unknown, op: string) => ({
      exitCode: 0,
      stdout:
        op === 'status'
          ? '{"ok":false,"state":"failed","detail":"down"}'
          : '{"ok":true,"state":"ready","detail":"ok"}',
      stderr: '',
      timedOut: false,
      truncated: false,
      sha256: 'x',
      durationMs: 1,
    })
    const noWebhook = resolveConfig(
      {
        project: 'testproj',
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        deployments: {
          enabled: true,
          tools: [
            {
              id: 't',
              kind: 'python',
              path: script,
              capabilities: ['preflight', 'apply', 'status'],
              timeoutSeconds: 10,
            },
          ],
          targets: [{ id: 'owner', toolId: 't', requirementId: 'req-1', approval: 'owner' }],
        } as never,
      },
      dir,
    )
    let alertsSent = 0
    const deployments = new Deployments({
      config: noWebhook,
      store: repo.deploymentStore,
      gate: () => ({ ok: true, reason: '' }),
      alert: async () => {
        alertsSent += 1
        return { ok: true, error: '' }
      },
      runTool: normalTool,
    })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'x',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    expect(await deployments.verify(intentId)).toMatchObject({ code: 'invalid_state' })
    await deployments.approve(intentId)
    expect(await deployments.verify(intentId)).toMatchObject({ code: 'verify_failed' })
    expect(alertsSent).toBe(0)
  })

  it('reports a target removed from configuration and exposes the target list', async () => {
    const deployments = build()
    expect(deployments.targets().map((target) => target.id)).toEqual([
      'owner',
      'auto',
      'broken',
      'data',
    ])
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'owner',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    const reloaded = resolveConfig(
      {
        project: 'testproj',
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        deployments: { enabled: true } as never,
      },
      dir,
    )
    const afterReload = new Deployments({
      config: reloaded,
      store: repo.deploymentStore,
      gate: () => ({ ok: true, reason: '' }),
      alert: async () => ({ ok: true, error: '' }),
    })
    expect(await afterReload.approve(intentId)).toMatchObject({ code: 'not_found' })
    expect(afterReload.detail('missing')).toBeNull()
  })

  it('refuses when deployments are disabled or the target is unknown', async () => {
    const disabled = resolveConfig(
      { ...deploymentRaw(), deployments: { enabled: false } as never },
      dir,
    )
    const deployments = new Deployments({
      config: disabled,
      store: repo.deploymentStore,
      gate: () => ({ ok: true, reason: '' }),
    })
    expect(
      await deployments.request({ targetId: 'owner', artifact: ARTIFACT, source: 'owner' }),
    ).toMatchObject({ code: 'deployments_disabled' })
    const enabled = build()
    expect(
      await enabled.request({ targetId: 'nope', artifact: ARTIFACT, source: 'owner' }),
    ).toMatchObject({ code: 'not_found' })
  })
})

describe('deployment verify timeout', () => {
  it('expires only applied-pending-verify deployments past the configured window', async () => {
    let now = '2026-11-03T10:00:00.000Z'
    const deployments = build({ now: () => now })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'owner',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    await deployments.approve(intentId)
    expect(deployments.detail(intentId)?.intent.state).toBe('applied_pending_verify')

    expect(deployments.expireStale()).toBe(0)
    expect(deployments.detail(intentId)?.intent.state).toBe('applied_pending_verify')

    now = '2026-11-03T10:10:00.001Z'
    expect(deployments.expireStale()).toBe(1)
    expect(deployments.detail(intentId)?.intent.state).toBe('verify_failed')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.body.message).toContain('未完成核对')
  })

  it('does nothing when deployments are disabled or already verified', async () => {
    let now = '2026-11-03T10:00:00.000Z'
    const deployments = build({ now: () => now })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'owner',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    await deployments.approve(intentId)
    await deployments.verify(intentId)
    now = '2026-11-03T12:00:00.000Z'
    expect(deployments.expireStale()).toBe(0)
    expect(deployments.detail(intentId)?.intent.state).toBe('verified')

    const disabled = new Deployments({
      config: resolveConfig(
        {
          project: 'testproj',
          projectPath: dir,
          recordsRoot: join(dir, '.forgeloop'),
          deployments: { enabled: false } as never,
        },
        dir,
      ),
      store: repo.deploymentStore,
      gate: () => ({ ok: true, reason: '' }),
      alert: async () => ({ ok: true, error: '' }),
    })
    expect(disabled.expireStale()).toBe(0)
  })
})
