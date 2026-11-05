import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { resolveConfig, type ForgeLoopConfig, type RawConfig } from '../src/config.js'
import { Deployments } from '../src/runtime/deployments.js'
import { candidateDeploymentGate } from '../src/runtime/deployment-gate.js'
import { expectedAcceptanceFingerprints } from '../src/runtime/acceptance-binding.js'
import { candidateIdentityOf } from '../src/domain/delivery.js'
import type { DeploymentGate } from '../src/runtime/deployment-gate.js'
import type { DeploymentArtifact } from '../src/domain/deployment.js'

let dir = ''
let database: Database
let repo: Repository
let script = ''
let config: ForgeLoopConfig
let alerts: Array<{ url: string; body: Record<string, unknown> }> = []

let ARTIFACT: DeploymentArtifact

function writeArtifact(content: string): DeploymentArtifact {
  const path = join(dir, 'candidate.tgz')
  writeFileSync(path, content)
  return {
    sha256: createHash('sha256').update(content).digest('hex'),
    path,
    version: '1.0.0',
  }
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
        { id: 'unbound', toolId: 't', approval: 'owner' },
        {
          id: 'interrupted',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          params: { tag: 'INTERRUPTED' },
        },
        {
          id: 'interrupted-broken',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          params: { tag: 'BROKEN_STATUS' },
        },
        {
          id: 'old-running',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          params: { tag: 'OLD_RUNNING' },
        },
        {
          id: 'wrong-install',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          params: { tag: 'WRONG_INSTALLED' },
        },
        {
          id: 'no-identity',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          params: { tag: 'NO_IDENTITY' },
        },
        {
          id: 'stale-process',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          params: { tag: 'STALE_PROCESS' },
        },
        {
          id: 'no-started-at',
          toolId: 't',
          requirementId: 'req-1',
          approval: 'owner',
          params: { tag: 'NO_STARTED_AT' },
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
    'import json, os, sys',
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
    '    if tag == "BROKEN_STATUS":',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": "status unavailable"}))',
    '        sys.exit(0)',
    '    value = "9.9.9" if tag == "FAIL_STATUS" else version',
    '    running = "0" * 64 if tag == "OLD_RUNNING" else plan["artifact"]["sha256"]',
    '    installed = "0" * 64 if tag == "WRONG_INSTALLED" else plan["artifact"]["sha256"]',
    '    started = {"STALE_PROCESS": "2020-01-01T00:00:00Z", "NO_STARTED_AT": ""}.get(tag, "2026-11-03T10:00:00Z")',
    '    extra = {} if tag == "NO_IDENTITY" else {"artifactSha256": installed, "runningArtifactSha256": running, "runningPid": os.getpid(), "runningStartedAt": started}',
    '    print(json.dumps({"ok": True, "state": "running", "version": value, "detail": "status ok", **extra}))',
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
  ARTIFACT = writeArtifact('candidate-content')
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
      'unbound',
      'interrupted',
      'interrupted-broken',
      'old-running',
      'wrong-install',
      'no-identity',
      'stale-process',
      'no-started-at',
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

  it('records the intent requirement for an unbound target', async () => {
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'unbound',
      requirementId: 'req-9',
      artifact: ARTIFACT,
      source: 'unbound-source',
    })
    expect(requested.ok).toBe(true)
    const intentId = (requested.data as { intentId: string }).intentId
    expect(deployments.detail(intentId)?.intent.requirementId).toBe('req-9')
    expect(deployments.detail(intentId)?.intent.state).toBe('awaiting_approval')
  })

  it('requires a requirement when the target has no default', async () => {
    const deployments = build()
    expect(
      await deployments.request({ targetId: 'unbound', artifact: ARTIFACT, source: 'none' }),
    ).toMatchObject({ ok: false, code: 'requirement_required' })
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

  it('rejects a running process that started before the install or exposes no start time', async () => {
    for (const [targetId, expected] of [
      ['stale-process', '启动时间早于本次安装'],
      ['no-started-at', '未提供运行进程启动时间'],
    ] as const) {
      const deployments = build()
      const requested = await deployments.request({
        targetId,
        artifact: ARTIFACT,
        source: `freshness-${targetId}`,
      })
      const intentId = (requested.data as { intentId: string }).intentId
      await deployments.approve(intentId)
      const verified = await deployments.verify(intentId)
      expect(verified.ok).toBe(false)
      expect(verified.message).toContain(expected)
      expect(deployments.detail(intentId)?.intent.state).toBe('verify_failed')
    }
  })

  it('fails verification when installed or running identity does not match', async () => {
    for (const [targetId, expected] of [
      ['wrong-install', '已安装制品摘要'],
      ['old-running', '运行中制品摘要'],
      ['no-identity', '未提供'],
    ] as const) {
      const deployments = build()
      const requested = await deployments.request({
        targetId,
        artifact: ARTIFACT,
        source: `identity-${targetId}`,
      })
      const intentId = (requested.data as { intentId: string }).intentId
      await deployments.approve(intentId)
      const verified = await deployments.verify(intentId)
      expect(verified.ok).toBe(false)
      expect(verified.message).toContain(expected)
      expect(deployments.detail(intentId)?.intent.state).toBe('verify_failed')
      expect(
        deployments.detail(intentId)?.attempts.some((attempt) => attempt.op === 'status'),
      ).toBe(true)
    }
  })
})

/**
 * G1：预检通过后依据变化（停止/版本/候选）必须阻止真正产生副作用。
 * 这里使用真实 candidateDeploymentGate 与完整交付记录，覆盖 approve 前的重新核对。
 */
describe('deployment approval revalidation', () => {
  const REQ = 'req-1'
  const CANDIDATE = candidateIdentityOf({
    planVersion: 1,
    requirementVersion: 1,
    baselineCommit: '',
    candidateHashes: ['task-a-candidate'],
  })

  function seedDeliverable(): void {
    repo.submit({
      reqId: REQ,
      project: 'testproj',
      text: '交付门禁测试',
      submittedBy: 'owner',
      source: 'test',
      now: '2026-11-05T09:00:00.000Z',
    })
    repo.recordAdmission({
      requirementId: REQ,
      requirementVersion: 1,
      decision: {
        admit: true,
        code: 'admitted',
        reason: 'ok',
        basis: {
          policyVersion: 'test',
          source: 'test',
          submittedBy: 'owner',
          owner: 'owner',
          project: 'testproj',
          projectPath: dir,
          requirementVersion: 1,
          analysisVersion: 1,
          trustedSource: true,
          allowAnySource: false,
          requireOwner: false,
          codeCommitAllowed: true,
        },
      },
      decidedBy: 'system:admission',
      createdAt: '2026-11-05T09:01:00.000Z',
    })
    repo.recordTaskPlan({
      taskPlanId: `plan-${REQ}-1`,
      requirementId: REQ,
      project: 'testproj',
      planVersion: 1,
      requirementVersion: 1,
      createdAt: '2026-11-05T09:02:00.000Z',
      tasks: [
        {
          taskId: 'a',
          goal: '写文档',
          files: ['docs/a.md'],
          acceptance: '存在',
          testCommand: ['true'],
          dependsOn: [],
          limits: { limitSeconds: -1, maxFailureRounds: -1 },
          authorizationSource: 'system-admission:test',
        },
      ],
    })
    repo.recordTaskArtifact({
      requirementId: REQ,
      planVersion: 1,
      taskId: 'a',
      candidateSha256: 'task-a-candidate',
      testEvidenceSha256: 'e'.repeat(64),
      reviewSha256: 'r'.repeat(64),
      acceptance: '存在',
      authorizationSource: 'test',
      recordedAt: '2026-11-05T09:02:30.000Z',
    })
    repo.recordCandidateBuild({
      reqId: REQ,
      planVersion: 1,
      candidateSha256: CANDIDATE,
      verificationSha256: 'v'.repeat(64),
      packageVersion: '1.0.0',
      artifactSha256: ARTIFACT.sha256,
      tarball: ARTIFACT.path,
      files: ['lib/index.js'],
      gitHead: 'head',
      builtAt: '2026-11-05T09:03:00.000Z',
      evidenceDir: '/tmp/build',
    })
    repo.recordVerification({
      requirementId: REQ,
      planVersion: 1,
      candidateSha256: CANDIDATE,
      requirementVersion: 1,
      workspaceSha256: 'w'.repeat(64),
      verdict: 'pass',
      reportJson: '{}',
      reportPath: '/tmp/v.json',
      reportSha256: 'r'.repeat(64),
      evidenceDir: '/tmp/v',
      sessionId: 's',
      verifiedAt: '2026-11-05T09:04:00.000Z',
    })
    repo.recordBusinessReview({
      requirementId: REQ,
      planVersion: 1,
      candidateSha256: CANDIDATE,
      requirementVersion: 1,
      verificationSha256: 'r'.repeat(64),
      verdict: 'pass',
      reportJson: '{}',
      reportPath: '/tmp/r.json',
      reportSha256: 's'.repeat(64),
      sessionId: 's',
      reviewedAt: '2026-11-05T09:05:00.000Z',
    })
    repo.recordCommit({
      requirementId: REQ,
      planVersion: 1,
      candidateSha256: CANDIDATE,
      commitSha: 'd'.repeat(40),
      commitMessage: 'test',
      checkCommand: [],
      checkLogPath: '/tmp/c.log',
      checkSha256: 'e'.repeat(64),
      files: ['docs/a.md'],
      committedAt: '2026-11-05T09:06:00.000Z',
    })
    repo.setStatus(REQ, 'committed')
    repo.recordAcceptance({
      reqId: REQ,
      acceptedBy: 'owner',
      source: 'test',
      fingerprint: expectedAcceptanceFingerprints(repo, REQ, ARTIFACT.sha256)[0] ?? '',
      now: '2026-11-05T09:07:00.000Z',
    })
  }

  function realGate(): Deployments {
    return build({ gate: candidateDeploymentGate(repo) })
  }

  it('refuses to apply when the requirement was stopped after preflight', async () => {
    seedDeliverable()
    const deployments = realGate()
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'owner-g1',
    })
    expect(requested.ok).toBe(true)
    const intentId = (requested.data as { intentId: string }).intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('awaiting_approval')

    repo.recordStop({
      requirementId: REQ,
      requestedBy: 'owner',
      reason: '暂停交付',
      requestedAt: '2026-11-05T09:10:00.000Z',
    })
    const approved = await deployments.approve(intentId)
    expect(approved.ok).toBe(false)
    expect(approved.message).toContain('停止')
    expect(deployments.detail(intentId)?.intent.state).toBe('awaiting_approval')
    // 预检之后没有任何 apply 副作用。
    expect(deployments.detail(intentId)?.attempts.map((attempt) => attempt.op)).toEqual([
      'preflight',
    ])
    expect(repo.activeStop(REQ)).not.toBeNull()
  })

  it('continues after an explicit resume that satisfies the gate again', async () => {
    seedDeliverable()
    const deployments = realGate()
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'owner-resume',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    repo.recordStop({
      requirementId: REQ,
      requestedBy: 'owner',
      reason: '暂停交付',
      requestedAt: '2026-11-05T09:10:00.000Z',
    })
    expect((await deployments.approve(intentId)).ok).toBe(false)

    repo.resumeStop({
      requirementId: REQ,
      resumedBy: 'owner',
      reason: '显式恢复',
      resumedAt: '2026-11-05T09:11:00.000Z',
    })
    const approved = await deployments.approve(intentId)
    expect(approved.ok, approved.message).toBe(true)
    expect(deployments.detail(intentId)?.intent.state).toBe('applied_pending_verify')
  })

  it('refuses to apply when the candidate or requirement version changed', async () => {
    seedDeliverable()
    const deployments = realGate()
    const first = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'owner-drift',
    })
    const intentId = (first.data as { intentId: string }).intentId

    // 需求版本变化：准入/任务包绑定的版本过期，部署必须拒绝。
    repo.appendVersion({
      reqId: REQ,
      text: '交付门禁测试 v2',
      revisedBy: 'owner',
      source: 'test',
      now: '2026-11-05T09:20:00.000Z',
    })
    const afterRevise = await deployments.approve(intentId)
    expect(afterRevise.ok).toBe(false)
    // 修订使需求回到 draft：无论按“版本过期”还是“未受控提交”拒绝，都不能放行安装。
    expect(afterRevise.message).toMatch(/版本|未受控提交|draft/)
    expect(deployments.detail(intentId)?.attempts.map((attempt) => attempt.op)).toEqual([
      'preflight',
    ])
  })

  it('refuses to apply when a newer artifact with the same version appears', async () => {
    seedDeliverable()
    const deployments = realGate()
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: ARTIFACT,
      source: 'owner-drift-build',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    repo.recordTaskArtifact({
      requirementId: REQ,
      planVersion: 1,
      taskId: 'a',
      candidateSha256: 'task-a-candidate',
      testEvidenceSha256: 'e'.repeat(64),
      reviewSha256: 'r'.repeat(64),
      acceptance: '存在',
      authorizationSource: 'test',
      recordedAt: '2026-11-05T09:02:30.000Z',
    })
    repo.recordCandidateBuild({
      reqId: REQ,
      planVersion: 1,
      candidateSha256: CANDIDATE,
      verificationSha256: 'v'.repeat(64),
      packageVersion: '1.0.0',
      artifactSha256: 'b'.repeat(64),
      tarball: '/tmp/b.tgz',
      files: ['lib/index.js'],
      gitHead: 'head',
      builtAt: '2026-11-05T09:20:00.000Z',
      evidenceDir: '/tmp/build2',
    })
    const afterBuild = await deployments.approve(intentId)
    expect(afterBuild.ok).toBe(false)
    expect(afterBuild.message).toMatch(/制品摘要|路径|候选构建/)
    expect(deployments.detail(intentId)?.attempts.map((attempt) => attempt.op)).toEqual([
      'preflight',
    ])
  })
})

/**
 * G2：安装/核对中途中断后，持久记录停在 applying/verifying；
 * 恢复必须先观测实际结果，再决定完成、失败或保留未知，不能盲目重装。
 */
describe('deployment interruption recovery', () => {
  const REQ = 'req-1'

  function seedIntent(state: 'applying' | 'verifying', targetId: string): string {
    const intentId = `dep-interrupted-${state}-${targetId}`
    repo.deploymentStore.recordDeploymentIntent({
      intentId,
      project: 'testproj',
      targetId,
      requirementId: REQ,
      artifactSha256: ARTIFACT.sha256,
      artifactPath: ARTIFACT.path,
      artifactVersion: ARTIFACT.version,
      source: 'interrupted',
      approval: 'owner',
      state: 'draft',
      createdAt: '2026-11-05T09:00:00.000Z',
      updatedAt: '2026-11-05T09:00:00.000Z',
    })
    repo.deploymentStore.updateDeploymentIntentState(intentId, state, '2026-11-05T09:00:00.000Z')
    return intentId
  }

  it('observes the installed result instead of reinstalling', async () => {
    const deployments = build()
    const applying = seedIntent('applying', 'interrupted')
    const verified = seedIntent('verifying', 'interrupted')
    const recovered = await deployments.recoverInterrupted('2026-11-05T10:00:00.000Z')
    expect(recovered).toBe(2)
    expect(deployments.detail(applying)?.intent.state).toBe('applied_pending_verify')
    expect(deployments.detail(verified)?.intent.state).toBe('verified')
    // 只观测，不产生新的 apply。
    for (const intentId of [applying, verified]) {
      expect(
        deployments.detail(intentId)?.attempts.filter((attempt) => attempt.op === 'apply'),
      ).toHaveLength(0)
    }
  })

  it('marks a mismatched installation failed and keeps unknown results open', async () => {
    const deployments = build()
    const mismatched = seedIntent('applying', 'broken')
    const unknown = seedIntent('applying', 'interrupted-broken')
    const recovered = await deployments.recoverInterrupted('2026-11-05T10:00:00.000Z')
    expect(recovered).toBe(1)
    expect(deployments.detail(mismatched)?.intent.state).toBe('failed')
    // 结果无法确认：保留 applying，等待人工决定，不当作成功也不反复重装。
    expect(deployments.detail(unknown)?.intent.state).toBe('applying')
    expect(
      repo.deploymentStore
        .deploymentDecisions(unknown)
        .some((decision) => decision.decision === 'recovery_unknown'),
    ).toBe(true)

    await deployments.recoverInterrupted('2026-11-05T10:10:00.000Z')
    expect(
      deployments.detail(unknown)?.attempts.filter((attempt) => attempt.op === 'status'),
    ).toHaveLength(1)
  })

  it('leaves fresh intents alone', async () => {
    const deployments = build()
    const fresh = seedIntent('applying', 'interrupted')
    const recovered = await deployments.recoverInterrupted('2026-11-05T09:00:01.000Z')
    expect(recovered).toBe(0)
    expect(deployments.detail(fresh)?.intent.state).toBe('applying')
  })
})

/**
 * 真实安装与运行身份：解包可运行制品、启动真实 node 进程，
 * 核对以运行进程自己报告的介质摘要为准，而不是工具或计划里的期望值。
 */
describe('real installer and running identity', () => {
  const SERVER = `import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const sha = createHash('sha256').update(readFileSync(join(here, 'bundle.tgz'))).digest('hex')
const startedAt = new Date().toISOString()
const port = Number(process.env.FORGELOOP_TEST_PORT || 0)
createServer((req, res) => {
  res.writeHead(req.url === '/identity' ? 200 : 404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ version: '1.0.0', artifactSha256: sha, pid: process.pid, startedAt, message: 'ok' }))
}).listen(port, '127.0.0.1')
`
  const INSTALLER = [
    'import hashlib, json, os, shutil, signal, socket, subprocess, sys, tarfile, time, urllib.request',
    'args = sys.argv',
    'op = args[args.index("--op") + 1]',
    'plan = json.load(open(args[args.index("--plan") + 1]))',
    'target = plan["params"]["target"]',
    'current = os.path.join(target, "current")',
    'pidfile = os.path.join(target, "process.pid")',
    'portfile = os.path.join(target, "port")',
    'def sha(path):',
    '    h = hashlib.sha256()',
    '    h.update(open(path, "rb").read())',
    '    return h.hexdigest()',
    'def stop():',
    '    try:',
    '        pid = int(open(pidfile).read().strip())',
    '    except Exception:',
    '        return',
    '    try:',
    '        os.kill(pid, signal.SIGKILL)',
    '        time.sleep(0.2)',
    '    except Exception:',
    '        pass',
    'if op == "preflight":',
    '    print(json.dumps({"ok": True, "state": "ready", "restorePoint": "previous-1" if os.path.isdir(current) else ""}))',
    'elif op == "apply":',
    '    stop()',
    '    shutil.rmtree(current, ignore_errors=True)',
    '    os.makedirs(current)',
    '    with tarfile.open(plan["artifact"]["path"]) as tar:',
    '        tar.extractall(current)',
    '    shutil.copyfile(plan["artifact"]["path"], os.path.join(current, "bundle.tgz"))',
    '    s = socket.socket()',
    '    s.bind(("127.0.0.1", 0))',
    '    port = s.getsockname()[1]',
    '    s.close()',
    '    env = dict(os.environ)',
    '    env["FORGELOOP_TEST_PORT"] = str(port)',
    '    log = open(os.path.join(target, "server.log"), "w")',
    '    proc = subprocess.Popen(["node", os.path.join(current, "server.mjs")], cwd=current, env=env, stdout=log, stderr=log, start_new_session=True)',
    '    open(pidfile, "w").write(str(proc.pid))',
    '    open(portfile, "w").write(str(port))',
    '    for _ in range(100):',
    '        try:',
    '            urllib.request.urlopen("http://127.0.0.1:%d/identity" % port, timeout=1)',
    '            print(json.dumps({"ok": True, "state": "applied", "version": "1.0.0", "detail": "started"}))',
    '            break',
    '        except Exception:',
    '            time.sleep(0.1)',
    '    else:',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": "server did not start"}))',
    'elif op == "status":',
    '    installed = sha(os.path.join(current, "bundle.tgz"))',
    '    port = int(open(portfile).read().strip())',
    '    identity = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/identity" % port, timeout=2).read())',
    '    print(json.dumps({"ok": True, "state": "running", "version": identity["version"], "artifactSha256": installed, "runningArtifactSha256": identity["artifactSha256"], "runningPid": identity["pid"], "runningStartedAt": identity["startedAt"], "detail": "live identity"}))',
  ].join('\n')

  function makeArtifact(path: string, body: string): string {
    const bundle = join(dir, `bundle-${Math.random().toString(36).slice(2)}`)
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'server.mjs'), SERVER)
    writeFileSync(join(bundle, 'app.mjs'), body)
    execFileSync('tar', ['-czf', path, '-C', bundle, '.'])
    return path
  }

  function installer(): string {
    const path = join(
      dir,
      '.forgeloop',
      'projects',
      'testproj',
      'deployments',
      'tools',
      'install.py',
    )
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, INSTALLER)
    return path
  }

  it('verifies against the live process identity and rejects a stale process', async () => {
    const artifactPath = makeArtifact(join(dir, 'app.tgz'), 'export const marker = "v1"\n')
    const artifact = {
      sha256: execFileSync('sha256sum', [artifactPath], { encoding: 'utf8' }).split(' ')[0]!,
      path: artifactPath,
      version: '1.0.0',
    }
    const tool = installer()
    const targetDir = join(dir, 'target')
    mkdirSync(targetDir, { recursive: true })
    config = resolveConfig(
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
              path: tool,
              capabilities: ['preflight', 'apply', 'status', 'rollback'],
              timeoutSeconds: 60,
            },
          ],
          targets: [
            {
              id: 'real',
              toolId: 't',
              requirementId: 'req-1',
              approval: 'owner',
              params: { target: targetDir },
            },
          ],
        },
      },
      dir,
    )
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'real',
      artifact,
      source: 'real-install',
    })
    expect(requested.ok, requested.message).toBe(true)
    const intentId = (requested.data as { intentId: string }).intentId
    const approved = await deployments.approve(intentId)
    expect(approved.ok, approved.message).toBe(true)
    const verified = await deployments.verify(intentId)
    expect(verified.ok, verified.message).toBe(true)
    expect(deployments.detail(intentId)?.intent.state).toBe('verified')

    // 运行进程自己报告的 pid 与介质摘要，不是安装工具的自述。
    const port = Number(readFileSync(join(targetDir, 'port'), 'utf8').trim())
    const identity = (await (await fetch(`http://127.0.0.1:${port}/identity`)).json()) as {
      pid: number
      artifactSha256: string
    }
    const toolPid = Number(readFileSync(join(targetDir, 'process.pid'), 'utf8').trim())
    expect(identity.pid).toBe(toolPid)
    expect(identity.artifactSha256).toBe(artifact.sha256)

    // 已安装介质被替换但进程仍在跑旧内容：核对必须失败，不能写 verified。
    writeFileSync(join(targetDir, 'current', 'bundle.tgz'), 'tampered')
    const staleId = 'dep-stale-verify'
    repo.deploymentStore.recordDeploymentIntent({
      intentId: staleId,
      project: 'testproj',
      targetId: 'real',
      requirementId: 'req-1',
      artifactSha256: artifact.sha256,
      artifactPath: artifact.path,
      artifactVersion: artifact.version,
      source: 'stale-verify',
      approval: 'owner',
      state: 'draft',
      createdAt: '2026-11-05T09:00:00.000Z',
      updatedAt: '2026-11-05T09:00:00.000Z',
    })
    repo.deploymentStore.updateDeploymentIntentState(
      staleId,
      'applied_pending_verify',
      '2026-11-05T09:00:00.000Z',
    )
    const stale = await deployments.verify(staleId)
    expect(stale.ok).toBe(false)
    expect(stale.message).toMatch(/运行中制品摘要|已安装制品摘要/)
    expect(deployments.detail(staleId)?.intent.state).toBe('verify_failed')
  })
})
