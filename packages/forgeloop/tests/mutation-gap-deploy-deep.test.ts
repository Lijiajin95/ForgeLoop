import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { resolveConfig, type ForgeLoopConfig, type RawConfig } from '../src/config.js'
import { Deployments, type DeploymentsDeps } from '../src/runtime/deployments.js'
import type { DeploymentGate } from '../src/runtime/deployment-gate.js'
import {
  inspectRequirementModules,
  inspectRuntimeIdentity,
  processAlive,
  readInstalledVersion,
  verifyInstalledFiles,
} from '../src/runtime/deployment-inspect.js'
import { sha256OfBytes } from '../src/domain/delivery.js'
import type { DeploymentArtifact, DeploymentAttemptState } from '../src/domain/deployment.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

const NOW = '2026-11-03T10:00:00.000Z'

let dir = ''
let database: Database
let repo: Repository
let script = ''
let config: ForgeLoopConfig
let alerts: Array<{ url: string; body: Record<string, unknown> }> = []
let seq = 0
let artifacts = 0

type RunTool = NonNullable<DeploymentsDeps['runTool']>
type AlertFn = NonNullable<DeploymentsDeps['alert']>

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function artifact(version = '1.0.0', content = version): DeploymentArtifact {
  artifacts += 1
  const path = join(dir, `candidate-${artifacts}.tgz`)
  writeFileSync(path, content)
  return { sha256: digest(content), path, version }
}

function toolScript(): string {
  return [
    'import json, os, sys',
    'args = sys.argv',
    'op = args[args.index("--op") + 1]',
    'plan = json.load(open(args[args.index("--plan") + 1]))',
    'version = plan["artifact"]["version"]',
    'sha = plan["artifact"]["sha256"]',
    'tag = plan["params"].get("tag", "")',
    'here = os.path.dirname(os.path.abspath(__file__))',
    'state_path = os.path.join(here, "state.json")',
    'state = json.load(open(state_path)) if os.path.exists(state_path) else {}',
    'def save(value):',
    '    json.dump(value, open(state_path, "w"))',
    'if op == "preflight":',
    '    restore = "" if tag == "NO_RESTORE" else "rp-default"',
    '    print(json.dumps({"ok": True, "state": "ready", "restorePoint": restore, "detail": "preflight ok"}))',
    'elif op == "apply":',
    '    save({"version": version, "sha": sha})',
    '    if tag == "FAIL_APPLY":',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": "apply broken"}))',
    '    else:',
    '        print(json.dumps({"ok": True, "state": "applied", "detail": "apply ok"}))',
    'elif op == "data-rollback":',
    '    if tag == "FAIL_DATA":',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": "data rollback " + plan["previous"]["restorePoint"]}))',
    '    else:',
    '        print(json.dumps({"ok": True, "state": "rolled_back", "detail": "data rollback " + plan["previous"]["restorePoint"]}))',
    'elif op == "rollback":',
    '    if tag == "FAIL_ROLLBACK":',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": "rollback failed"}))',
    '    else:',
    '        if tag not in ("STUCK_ROLLBACK", "WRONG_VERSION"):',
    '            save({"version": plan["previous"]["version"], "sha": plan["previous"]["sha256"]})',
    '        print(json.dumps({"ok": True, "state": "rolled_back", "detail": "rollback ok"}))',
    'elif op == "status":',
    '    if tag == "STATUS_DOWN":',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": "status unavailable"}))',
    '        sys.exit(0)',
    '    current = state if state else {"version": version, "sha": sha}',
    '    if tag == "FAIL_STATUS":',
    '        current = {"version": "9.9.9", "sha": current["sha"]}',
    '    installed = "0" * 64 if tag == "WRONG_INSTALLED" else current["sha"]',
    '    running = "0" * 64 if tag == "WRONG_RUNNING" else current["sha"]',
    '    started = {"STALE_PROCESS": "2020-01-01T00:00:00Z", "NO_STARTED_AT": "", "BAD_STARTED_AT": "not-a-time"}.get(tag, "2026-11-03T10:00:00Z")',
    '    fields = {"artifactSha256": installed, "runningArtifactSha256": running, "runningPid": 0 if tag == "ZERO_PID" else os.getpid(), "runningStartedAt": started}',
    '    if tag == "NO_INSTALLED":',
    '        fields["artifactSha256"] = ""',
    '    if tag == "NO_RUNNING":',
    '        fields["runningArtifactSha256"] = ""',
    '    if tag == "NO_IDENTITY":',
    '        fields = {}',
    '    print(json.dumps({"ok": True, "state": "running", "version": current["version"], "detail": "status ok", **fields}))',
  ].join('\n')
}

const BASE_TARGETS = [
  { id: 'owner', toolId: 't', requirementId: 'req-1', approval: 'owner' },
  { id: 'auto', toolId: 't', requirementId: 'req-1', approval: 'auto' },
  { id: 'auto-unbound', toolId: 't', approval: 'auto' },
  {
    id: 'data',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    data: { volumes: ['web-data'] },
  },
  {
    id: 'migrations',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    data: { migrations: ['add-log-table'] },
  },
  {
    id: 'no-restore',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    data: { volumes: ['web-data'] },
    params: { tag: 'NO_RESTORE' },
  },
  {
    id: 'fail-apply',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'FAIL_APPLY' },
  },
  {
    id: 'fail-status',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'FAIL_STATUS' },
  },
  {
    id: 'no-installed',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'NO_INSTALLED' },
  },
  {
    id: 'no-running',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'NO_RUNNING' },
  },
  {
    id: 'zero-pid',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'ZERO_PID' },
  },
  {
    id: 'no-started',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'NO_STARTED_AT' },
  },
  {
    id: 'bad-started',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'BAD_STARTED_AT' },
  },
  {
    id: 'stale-process',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'STALE_PROCESS' },
  },
  {
    id: 'rollback-fail',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'FAIL_ROLLBACK' },
  },
  {
    id: 'rollback-status-down',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'STATUS_DOWN' },
  },
  {
    id: 'rollback-stuck',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'STUCK_ROLLBACK' },
  },
  {
    id: 'rollback-wrong-installed',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'WRONG_INSTALLED' },
  },
  {
    id: 'rollback-wrong-running',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'WRONG_RUNNING' },
  },
  {
    id: 'rollback-zero-pid',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    params: { tag: 'ZERO_PID' },
  },
  {
    id: 'fail-data',
    toolId: 't',
    requirementId: 'req-1',
    approval: 'owner',
    data: { volumes: ['web-data'] },
    params: { tag: 'FAIL_DATA' },
  },
]

function rawDeployments(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    targets: BASE_TARGETS,
    ...extra,
  }
}

function raw(extra: Record<string, unknown> = {}): RawConfig {
  return {
    project: 'testproj',
    projectPath: dir,
    recordsRoot: join(dir, '.forgeloop'),
    deployments: rawDeployments(extra) as never,
  }
}

function configWith(patch: Record<string, unknown>): ForgeLoopConfig {
  return {
    ...config,
    deployments: { ...config.deployments, ...patch },
  } as ForgeLoopConfig
}

function build(
  options: {
    config?: ForgeLoopConfig
    gate?: DeploymentGate
    now?: () => string
    alert?: AlertFn
    runTool?: RunTool
  } = {},
): Deployments {
  const alert: AlertFn =
    options.alert ??
    (async (url, body) => {
      alerts.push({ url, body })
      return { ok: true, error: '' }
    })
  return new Deployments({
    config: options.config ?? config,
    store: repo.deploymentStore,
    gate: options.gate ?? (() => ({ ok: true, reason: '' })),
    now: options.now ?? (() => NOW),
    alert,
    ...(options.runTool ? { runTool: options.runTool } : {}),
  })
}

function evidenceDir(intentId: string): string {
  return join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', intentId)
}

function lastPlan(intentId: string, op: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(evidenceDir(intentId), `${op}.json`), 'utf8')) as Record<
    string,
    unknown
  >
}

function seedIntent(input: {
  targetId: string
  state: DeploymentAttemptState
  artifact: DeploymentArtifact
  requirementId?: string
  createdAt?: string
  updatedAt?: string
}): string {
  seq += 1
  const intentId = `dep-seed-${seq}`
  const createdAt = input.createdAt ?? NOW
  const updatedAt = input.updatedAt ?? createdAt
  repo.deploymentStore.recordDeploymentIntent({
    intentId,
    project: 'testproj',
    targetId: input.targetId,
    requirementId: input.requirementId ?? 'req-1',
    artifactSha256: input.artifact.sha256,
    artifactPath: input.artifact.path,
    artifactVersion: input.artifact.version,
    source: 'seed',
    approval: 'owner',
    state: 'draft',
    createdAt,
    updatedAt,
  })
  if (input.state !== 'draft') {
    repo.deploymentStore.updateDeploymentIntentState(intentId, input.state, updatedAt)
  }
  return intentId
}

function recordPreflightRestorePoint(
  intentId: string,
  restorePoint: string,
  startedAt: string,
): void {
  repo.deploymentStore.recordDeploymentAttempt({
    intentId,
    op: 'preflight',
    state: 'ready',
    exitCode: 0,
    resultJson: JSON.stringify({
      stdout: JSON.stringify({ ok: true, state: 'ready', restorePoint }),
    }),
    detail: '',
    toolSha256: 'seed',
    evidencePath: evidenceDir(intentId),
    startedAt,
    finishedAt: startedAt,
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

function resetToolState(): void {
  rmSync(join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', 'tools', 'state.json'), {
    force: true,
  })
}

function flushAlerts(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  alerts = []
  seq = 0
  artifacts = 0
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-deploy-deep-'))
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

describe('deployment request validation and approval paths', () => {
  it('rejects a disabled coordinator, unknown target, missing tool and missing requirement', async () => {
    const disabled = build({ config: resolveConfig(raw({ enabled: false }), dir) })
    expect(
      await disabled.request({ targetId: 'owner', artifact: artifact(), source: 'x' }),
    ).toEqual({ ok: false, code: 'deployments_disabled', message: '部署未启用' })

    const enabled = build()
    expect(await enabled.request({ targetId: 'nope', artifact: artifact(), source: 'x' })).toEqual({
      ok: false,
      code: 'not_found',
      message: '未登记部署目标：nope',
    })

    const noTools = build({ config: configWith({ tools: [] }) })
    expect(await noTools.request({ targetId: 'owner', artifact: artifact(), source: 'x' })).toEqual(
      { ok: false, code: 'not_found', message: '部署目标引用了未登记工具：t' },
    )

    expect(
      await enabled.request({ targetId: 'auto-unbound', artifact: artifact(), source: 'x' }),
    ).toEqual({
      ok: false,
      code: 'requirement_required',
      message: '部署必须指定所属需求；目标未配置默认需求',
    })
  })

  it('trims an explicit requirement, falls back to the target default and applies auto targets immediately', async () => {
    const deployments = build()
    const blank = await deployments.request({
      targetId: 'auto',
      requirementId: '   ',
      artifact: artifact('1.0.0', 'auto-default'),
      source: 'auto',
    })
    expect(blank.ok).toBe(true)
    const blankId = (blank.data as { intentId: string }).intentId
    const blankDetail = deployments.detail(blankId)
    expect(blankDetail?.intent.requirementId).toBe('req-1')
    expect(blankDetail?.intent.approval).toBe('auto')
    expect(blankDetail?.intent.state).toBe('applied_pending_verify')
    expect(blankDetail?.attempts.map((attempt) => attempt.op)).toEqual(['preflight', 'apply'])
    expect(repo.deploymentStore.deploymentDecisions(blankId)).toEqual([])

    const explicit = await deployments.request({
      targetId: 'auto-unbound',
      requirementId: ' req-9 ',
      artifact: artifact('1.0.0', 'auto-explicit'),
      source: 'auto',
    })
    expect(explicit.ok).toBe(true)
    const explicitId = (explicit.data as { intentId: string }).intentId
    expect(deployments.detail(explicitId)?.intent.requirementId).toBe('req-9')
    expect(deployments.detail(explicitId)?.intent.state).toBe('applied_pending_verify')
  })

  it('records a preflight attempt with no tool call and an evidence path when the gate rejects', async () => {
    const deployments = build({ gate: () => ({ ok: false, reason: '独立测试未通过' }) })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'gate',
    })
    expect(requested).toEqual({
      ok: false,
      code: 'preflight_failed',
      message: '部署门禁未通过：独立测试未通过',
    })
    const intentId = deployments.list()[0]!.intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('preflight_failed')
    const attempt = deployments.detail(intentId)?.attempts[0]
    expect(attempt).toMatchObject({
      op: 'preflight',
      state: 'preflight_failed',
      exitCode: -1,
      resultJson: '',
      detail: '独立测试未通过',
      toolSha256: '',
    })
    expect(attempt?.evidencePath).toBe(evidenceDir(intentId))
  })

  it('refuses a data target whose preflight did not return a restore point', async () => {
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'no-restore',
      artifact: artifact(),
      source: 'data',
    })
    expect(requested).toEqual({
      ok: false,
      code: 'preflight_failed',
      message: '目标声明了卷或数据库迁移，但 preflight 没有给出 restorePoint，拒绝部署',
    })
    const intentId = deployments.list()[0]!.intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('preflight_failed')
    const attempts = deployments.detail(intentId)?.attempts ?? []
    expect(attempts.map((attempt) => attempt.op)).toEqual(['preflight', 'preflight'])
    expect(attempts.at(-1)).toMatchObject({
      state: 'preflight_failed',
      exitCode: 0,
      resultJson: '',
      toolSha256: '',
      detail: '目标声明了卷或数据库迁移，但 preflight 没有给出 restorePoint，拒绝部署',
    })
  })

  it('revalidates after preflight and records a system decision when the gate closes', async () => {
    let calls = 0
    const deployments = build({
      gate: () => (++calls === 1 ? { ok: true, reason: '' } : { ok: false, reason: '需求已停止' }),
    })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'revalidate',
    })
    expect(requested).toEqual({
      ok: false,
      code: 'preflight_failed',
      message: '部署门禁未通过：需求已停止',
    })
    const intentId = deployments.list()[0]!.intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('preflight_failed')
    expect(deployments.detail(intentId)?.attempts.at(-1)).toMatchObject({
      op: 'preflight',
      state: 'preflight_failed',
      exitCode: 0,
      resultJson: '',
      toolSha256: '',
      detail: '需求已停止',
    })
    expect(repo.deploymentStore.deploymentDecisions(intentId)).toContainEqual({
      intentId,
      decision: 'revalidate_failed',
      by: 'system:coordinator',
      at: NOW,
      detail: '需求已停止',
    })
  })

  it('applies and verifies an owner-approved deployment and records decisions, plans and evidence', async () => {
    const deployments = build()
    const value = artifact('1.0.0', 'owner-content')
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: value,
      source: 'owner',
    })
    expect(requested.ok).toBe(true)
    expect(requested.message).toBe(
      `部署 ${(requested.data as { intentId: string }).intentId} 已通过预检，等待所有者批准`,
    )
    const intentId = (requested.data as { intentId: string }).intentId
    expect(requested.data).toMatchObject({
      intentId,
      state: 'awaiting_approval',
      restorePoint: 'rp-default',
    })

    const preflightPlan = lastPlan(intentId, 'preflight')
    expect(preflightPlan).toMatchObject({
      intentId,
      op: 'preflight',
      artifact: value,
      previous: null,
      device: { id: 'local', transport: 'local' },
      data: { volumes: [], migrations: [] },
      timeoutSeconds: 10,
    })
    expect(readFileSync(join(evidenceDir(intentId), 'preflight.json'), 'utf8').endsWith('\n')).toBe(
      true,
    )

    const approved = await deployments.approve(intentId)
    expect(approved.ok).toBe(true)
    expect(approved.message).toBe(`部署 ${intentId} 已执行，等待核对`)
    expect(deployments.detail(intentId)?.intent.state).toBe('applied_pending_verify')
    const decisions = repo.deploymentStore.deploymentDecisions(intentId)
    expect(decisions).toContainEqual({
      intentId,
      decision: 'approve',
      by: 'owner',
      at: NOW,
      detail: 'owner 批准部署',
    })
    const applyAttempt = deployments.detail(intentId)?.attempts.find((item) => item.op === 'apply')
    expect(applyAttempt).toMatchObject({ state: 'ready', exitCode: 0 })
    expect(applyAttempt?.toolSha256).toBe(digest(toolScript()))
    expect(applyAttempt?.evidencePath).toBe(evidenceDir(intentId))

    const verified = await deployments.verify(intentId)
    expect(verified.ok).toBe(true)
    expect(verified.message).toBe(`部署 ${intentId} 已核对：版本 1.0.0`)
    expect(deployments.detail(intentId)?.intent.state).toBe('verified')
    expect(
      repo.deploymentStore
        .deploymentDecisions(intentId)
        .some(
          (decision) =>
            decision.decision === 'verify' && /^版本 1\.0\.0，运行 pid \d+$/.test(decision.detail),
        ),
    ).toBe(true)
    expect(deployments.detail(intentId)?.attempts.map((attempt) => attempt.op)).toEqual([
      'preflight',
      'apply',
      'status',
    ])
    expect(deployments.list(1)).toHaveLength(1)
  })

  it('keeps the intent awaiting approval and records a decision when approval revalidation fails', async () => {
    let calls = 0
    const deployments = build({
      gate: () => (++calls <= 2 ? { ok: true, reason: '' } : { ok: false, reason: '验收已失效' }),
    })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'approval-revalidate',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    const approved = await deployments.approve(intentId, 'ops')
    expect(approved).toEqual({
      ok: false,
      code: 'gate_failed',
      message: '部署核对未通过：验收已失效',
    })
    expect(deployments.detail(intentId)?.intent.state).toBe('awaiting_approval')
    expect(deployments.detail(intentId)?.attempts.map((attempt) => attempt.op)).toEqual([
      'preflight',
    ])
    expect(repo.deploymentStore.deploymentDecisions(intentId)).toContainEqual({
      intentId,
      decision: 'revalidate_failed',
      by: 'ops',
      at: NOW,
      detail: '验收已失效',
    })
  })

  it('reports approve, verify and rollback when the target or tool left the configuration', async () => {
    const empty = resolveConfig(raw({ tools: [], targets: [] }), dir)
    const deployments = build({ config: empty })
    const awaiting = seedIntent({
      targetId: 'owner',
      state: 'awaiting_approval',
      artifact: artifact(),
    })
    const applied = seedIntent({
      targetId: 'owner',
      state: 'applied_pending_verify',
      artifact: artifact(),
    })
    const verified = seedIntent({ targetId: 'owner', state: 'verified', artifact: artifact() })

    for (const result of [
      await deployments.approve(awaiting),
      await deployments.verify(applied),
      await deployments.rollback(verified, 'x'),
    ]) {
      expect(result).toEqual({
        ok: false,
        code: 'not_found',
        message: '部署目标或工具已不在配置中',
      })
    }
    expect(deployments.detail('missing')).toBeNull()
  })

  it('validates rejection state and defaults an empty reason without losing the owner decision', async () => {
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'reject',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    expect(deployments.reject(intentId, '', 'ops')).toEqual({
      ok: true,
      code: 'ok',
      message: `部署 ${intentId} 已拒绝：未说明原因`,
    })
    expect(deployments.detail(intentId)?.intent.state).toBe('rejected')
    expect(repo.deploymentStore.deploymentDecisions(intentId)).toContainEqual({
      intentId,
      decision: 'reject',
      by: 'ops',
      at: NOW,
      detail: '未说明原因',
    })
    expect(deployments.reject(intentId, '再拒绝')).toEqual({
      ok: false,
      code: 'invalid_state',
      message: `部署 ${intentId} 当前状态 rejected 不能拒绝`,
    })
    expect(await deployments.approve(intentId)).toEqual({
      ok: false,
      code: 'invalid_state',
      message: `部署 ${intentId} 当前状态 rejected 不能批准`,
    })
    expect(deployments.reject('missing', 'x')).toEqual({
      ok: false,
      code: 'not_found',
      message: '未找到部署 missing',
    })
  })

  it('rejects verification in the wrong state and records a failed tool observation', async () => {
    const deployments = build()
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'verify-state',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    expect(await deployments.verify(intentId)).toEqual({
      ok: false,
      code: 'invalid_state',
      message: `部署 ${intentId} 当前状态 awaiting_approval 不能核对`,
    })
    expect(await deployments.verify('missing')).toEqual({
      ok: false,
      code: 'not_found',
      message: '未找到部署 missing',
    })

    const value = artifact()
    const failed = await deployments.request({
      targetId: 'rollback-status-down',
      artifact: value,
      source: 'verify-tool-fail',
    })
    const failedId = (failed.data as { intentId: string }).intentId
    await deployments.approve(failedId)
    expect(await deployments.verify(failedId, 'ops')).toEqual({
      ok: false,
      code: 'verify_failed',
      message: '工具 t 报告 status 失败：status unavailable',
    })
    expect(deployments.detail(failedId)?.intent.state).toBe('verify_failed')
    expect(repo.deploymentStore.deploymentDecisions(failedId)).toContainEqual({
      intentId: failedId,
      decision: 'verify_failed',
      by: 'ops',
      at: NOW,
      detail: '工具 t 报告 status 失败：status unavailable',
    })
    expect(alerts.at(-1)?.body.message).toBe('工具 t 报告 status 失败：status unavailable')
  })

  it('reports each verification identity mismatch with its exact reason', async () => {
    const deployments = build()
    const cases: Array<[string, string]> = [
      ['fail-status', '实际运行版本 9.9.9 与制品 1.0.0 不一致'],
      ['no-installed', '工具未提供已安装制品摘要，无法核对实际安装内容'],
      ['no-running', '工具未提供运行中制品摘要，无法确认进程已加载本次制品'],
      ['zero-pid', '工具未提供有效运行进程 pid'],
      ['no-started', '工具未提供运行进程启动时间，无法确认进程已加载本次制品'],
      ['bad-started', '工具提供的运行进程启动时间不可解析'],
      ['stale-process', '运行进程启动时间早于本次安装，进程可能仍运行旧内容'],
    ]
    for (const [targetId, expected] of cases) {
      const requested = await deployments.request({
        targetId,
        artifact: artifact('1.0.0', `verify-${targetId}`),
        source: `verify-${targetId}`,
      })
      expect(requested.ok, requested.message).toBe(true)
      const intentId = (requested.data as { intentId: string }).intentId
      expect((await deployments.approve(intentId)).ok).toBe(true)
      expect(await deployments.verify(intentId)).toEqual({
        ok: false,
        code: 'verify_failed',
        message: expected,
      })
      expect(deployments.detail(intentId)?.intent.state).toBe('verify_failed')
      expect(
        repo.deploymentStore
          .deploymentDecisions(intentId)
          .some(
            (decision) => decision.decision === 'verify_failed' && decision.detail === expected,
          ),
      ).toBe(true)
    }
  })
})

describe('deployment alerts, expiry and recovery', () => {
  it('records alert delivery failure, exception, unknown reason and missing webhook', async () => {
    const failedAlerts = build({
      alert: async (url, body) => {
        alerts.push({ url, body })
        return { ok: false, error: 'webhook down' }
      },
    })
    const first = await failedAlerts.request({
      targetId: 'fail-status',
      artifact: artifact(),
      source: 'alert-fail',
    })
    const firstId = (first.data as { intentId: string }).intentId
    await failedAlerts.approve(firstId)
    await failedAlerts.verify(firstId)
    await flushAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.url).toBe('https://example.com/deploy-hook')
    expect(alerts[0]?.body).toMatchObject({
      kind: 'deployment',
      intentId: firstId,
      targetId: 'fail-status',
      artifactVersion: '1.0.0',
      state: 'verify_failed',
      at: NOW,
    })
    expect(String(alerts[0]?.body.message)).toContain('9.9.9')
    expect(
      repo.deploymentStore
        .deploymentDecisions(firstId)
        .some(
          (decision) =>
            decision.decision === 'alert' && decision.detail === '告警发送失败：webhook down',
        ),
    ).toBe(true)

    const throwing = build({
      alert: async () => {
        throw new Error('boom')
      },
    })
    const second = await throwing.request({
      targetId: 'fail-status',
      artifact: artifact(),
      source: 'alert-throw',
    })
    const secondId = (second.data as { intentId: string }).intentId
    await throwing.approve(secondId)
    await throwing.verify(secondId)
    await flushAlerts()
    expect(
      repo.deploymentStore
        .deploymentDecisions(secondId)
        .some(
          (decision) => decision.decision === 'alert' && decision.detail === '告警发送异常：boom',
        ),
    ).toBe(true)

    const unknown = build({ alert: async () => ({ ok: false, error: '' }) })
    const third = await unknown.request({
      targetId: 'fail-status',
      artifact: artifact(),
      source: 'alert-unknown',
    })
    const thirdId = (third.data as { intentId: string }).intentId
    await unknown.approve(thirdId)
    await unknown.verify(thirdId)
    await flushAlerts()
    expect(
      repo.deploymentStore
        .deploymentDecisions(thirdId)
        .some(
          (decision) =>
            decision.decision === 'alert' && decision.detail === '告警发送失败：未知原因',
        ),
    ).toBe(true)

    const noWebhook = resolveConfig(
      raw({
        alerts: undefined,
        targets: BASE_TARGETS.filter((target) => target.id === 'fail-status'),
      }),
      dir,
    )
    let sent = 0
    const quiet = build({
      config: noWebhook,
      alert: async () => {
        sent += 1
        return { ok: true, error: '' }
      },
    })
    const fourth = await quiet.request({
      targetId: 'fail-status',
      artifact: artifact(),
      source: 'alert-none',
    })
    const fourthId = (fourth.data as { intentId: string }).intentId
    await quiet.approve(fourthId)
    await quiet.verify(fourthId)
    await flushAlerts()
    expect(sent).toBe(0)
    expect(
      repo.deploymentStore
        .deploymentDecisions(fourthId)
        .some(
          (decision) =>
            decision.decision === 'alert' && decision.detail === '未配置告警地址，未发送',
        ),
    ).toBe(true)
  })

  it('expires only applied deployments past the window and ignores unparseable timestamps', async () => {
    const deployments = build()
    const value = artifact()
    const fresh = seedIntent({
      targetId: 'owner',
      state: 'applied_pending_verify',
      artifact: value,
      updatedAt: NOW,
    })
    const stale = seedIntent({
      targetId: 'owner',
      state: 'applied_pending_verify',
      artifact: value,
      updatedAt: '2026-11-03T09:49:59.999Z',
    })
    const unparseable = seedIntent({
      targetId: 'owner',
      state: 'applied_pending_verify',
      artifact: value,
      updatedAt: 'not-a-date',
    })
    const verified = seedIntent({
      targetId: 'owner',
      state: 'verified',
      artifact: value,
      updatedAt: '2026-11-03T09:00:00.000Z',
    })
    const applying = seedIntent({
      targetId: 'owner',
      state: 'applying',
      artifact: value,
      updatedAt: '2026-11-03T09:00:00.000Z',
    })

    expect(deployments.expireStale(NOW)).toBe(1)
    expect(deployments.detail(stale)?.intent.state).toBe('verify_failed')
    expect(deployments.detail(fresh)?.intent.state).toBe('applied_pending_verify')
    expect(deployments.detail(unparseable)?.intent.state).toBe('applied_pending_verify')
    expect(deployments.detail(verified)?.intent.state).toBe('verified')
    expect(deployments.detail(applying)?.intent.state).toBe('applying')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.body.message).toBe(`部署 ${stale} 超过 600 秒未完成核对`)
    expect(deployments.expireStale(NOW)).toBe(0)

    const disabled = build({ config: resolveConfig(raw({ enabled: false }), dir) })
    expect(disabled.expireStale(NOW)).toBe(0)
  })

  it('recovers interrupted deployments at the boundary, leaves fresh ones and preserves unknown results', async () => {
    const deployments = build()
    const value = artifact()
    const missingTarget = seedIntent({
      targetId: 'not-configured',
      state: 'applying',
      artifact: value,
      updatedAt: '2026-11-03T09:00:00.000Z',
    })
    const boundary = seedIntent({
      targetId: 'owner',
      state: 'applying',
      artifact: value,
      updatedAt: '2026-11-03T09:50:00.000Z',
    })
    const fresh = seedIntent({
      targetId: 'migrations',
      state: 'applying',
      artifact: value,
      updatedAt: '2026-11-03T09:50:00.001Z',
    })
    const verifying = seedIntent({
      targetId: 'owner',
      state: 'verifying',
      artifact: value,
      updatedAt: '2026-11-03T09:00:00.000Z',
    })
    const unknown = seedIntent({
      targetId: 'rollback-status-down',
      state: 'applying',
      artifact: value,
      updatedAt: '2026-11-03T09:00:00.000Z',
    })

    expect(await deployments.recoverInterrupted(NOW)).toBe(3)
    expect(deployments.detail(missingTarget)?.intent.state).toBe('failed')
    expect(
      repo.deploymentStore
        .deploymentDecisions(missingTarget)
        .some(
          (decision) =>
            decision.decision === 'recovery_failed' &&
            decision.detail === '部署目标或工具已不在配置中',
        ),
    ).toBe(true)
    expect(deployments.detail(boundary)?.intent.state).toBe('applied_pending_verify')
    expect(
      repo.deploymentStore
        .deploymentDecisions(boundary)
        .some(
          (decision) =>
            decision.decision === 'recovery_applied' &&
            decision.detail === '中断后观测到制品已安装，等待核对',
        ),
    ).toBe(true)
    expect(deployments.detail(fresh)?.intent.state).toBe('applying')
    expect(deployments.detail(verifying)?.intent.state).toBe('verified')
    expect(
      repo.deploymentStore
        .deploymentDecisions(verifying)
        .some(
          (decision) =>
            decision.decision === 'verify' && decision.detail === '中断后观测到安装与运行摘要一致',
        ),
    ).toBe(true)
    expect(deployments.detail(unknown)?.intent.state).toBe('applying')
    expect(
      repo.deploymentStore
        .deploymentDecisions(unknown)
        .some(
          (decision) =>
            decision.decision === 'recovery_unknown' &&
            decision.detail.includes('工具 t 报告 status 失败：status unavailable'),
        ),
    ).toBe(true)
    expect(alerts.at(-1)?.body.message).toContain('中断后无法确认结果')
    expect(
      deployments.detail(unknown)?.attempts.filter((attempt) => attempt.op === 'status'),
    ).toHaveLength(1)

    expect(await deployments.recoverInterrupted(NOW)).toBe(0)
    expect(
      deployments.detail(unknown)?.attempts.filter((attempt) => attempt.op === 'status'),
    ).toHaveLength(1)

    const withoutTools = build({ config: configWith({ tools: [] }) })
    const orphan = seedIntent({
      targetId: 'owner',
      state: 'applying',
      artifact: value,
      updatedAt: '2026-11-03T09:00:00.000Z',
    })
    expect(await withoutTools.recoverInterrupted(NOW)).toBe(1)
    expect(withoutTools.detail(orphan)?.intent.state).toBe('failed')

    const disabled = build({ config: resolveConfig(raw({ enabled: false }), dir) })
    expect(await disabled.recoverInterrupted(NOW)).toBe(0)
  })

  it('blocks a second deployment on a busy target and releases it after rejection', async () => {
    const deployments = build()
    const first = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'busy-first',
    })
    const intentId = (first.data as { intentId: string }).intentId
    expect(
      await deployments.request({
        targetId: 'owner',
        artifact: artifact(),
        source: 'busy-second',
      }),
    ).toEqual({
      ok: false,
      code: 'target_busy',
      message: `部署目标 owner 有进行中的部署 ${intentId}（awaiting_approval），先完成或收口后再发起`,
    })
    expect(deployments.reject(intentId, '取消').ok).toBe(true)
    expect(
      await deployments.request({
        targetId: 'owner',
        artifact: artifact(),
        source: 'busy-third',
      }),
    ).toMatchObject({ ok: true })
  })
})

describe('deployment apply revalidation and tool failures', () => {
  it('refuses apply when the artifact changed, disappeared or another intent owns the target', async () => {
    const changed = build()
    const first = artifact('1.0.0', 'first')
    const firstRequest = await changed.request({
      targetId: 'owner',
      artifact: first,
      source: 'artifact-changed',
    })
    const firstId = (firstRequest.data as { intentId: string }).intentId
    writeFileSync(first.path, 'swapped')
    const changedResult = await changed.approve(firstId)
    expect(changedResult).toMatchObject({ ok: false, code: 'preflight_failed' })
    expect(changedResult.message).toMatch(
      /^制品文件摘要 [0-9a-f]{12}… 与记录 [0-9a-f]{12}… 不一致，拒绝部署换包后的制品$/,
    )
    expect(changed.detail(firstId)?.intent.state).toBe('preflight_failed')
    expect(changed.detail(firstId)?.attempts.map((attempt) => attempt.op)).toEqual(['preflight'])
    expect(repo.deploymentStore.deploymentDecisions(firstId)).toContainEqual({
      intentId: firstId,
      decision: 'gate_failed',
      by: 'system:deployment-gate',
      at: NOW,
      detail: changedResult.message,
    })

    const missing = build()
    const second = artifact('1.0.0', 'second')
    const secondRequest = await missing.request({
      targetId: 'owner',
      artifact: second,
      source: 'artifact-missing',
    })
    const secondId = (secondRequest.data as { intentId: string }).intentId
    rmSync(second.path)
    expect(await missing.approve(secondId)).toEqual({
      ok: false,
      code: 'preflight_failed',
      message: `制品文件不可读：${second.path}`,
    })
    expect(missing.detail(secondId)?.intent.state).toBe('preflight_failed')

    const competing = build()
    const thirdRequest = await competing.request({
      targetId: 'owner',
      artifact: artifact('1.0.0', 'third'),
      source: 'artifact-competition',
    })
    const thirdId = (thirdRequest.data as { intentId: string }).intentId
    const blocker = seedIntent({ targetId: 'owner', state: 'applying', artifact: artifact() })
    expect(await competing.approve(thirdId)).toEqual({
      ok: false,
      code: 'preflight_failed',
      message: `部署目标 owner 有进行中的部署 ${blocker}（applying），本次部署不再执行`,
    })
    expect(competing.detail(thirdId)?.attempts.map((attempt) => attempt.op)).toEqual(['preflight'])
  })

  it('maps apply failures and tool exceptions, timeouts, exit codes and malformed output to evidence', async () => {
    const failingApply = build()
    const applyRequest = await failingApply.request({
      targetId: 'fail-apply',
      artifact: artifact(),
      source: 'apply-fail',
    })
    const applyId = (applyRequest.data as { intentId: string }).intentId
    expect(await failingApply.approve(applyId)).toEqual({
      ok: false,
      code: 'tool_failed',
      message: '工具 t 报告 apply 失败：apply broken',
    })
    expect(failingApply.detail(applyId)?.intent.state).toBe('failed')
    expect(
      failingApply.detail(applyId)?.attempts.find((attempt) => attempt.op === 'apply'),
    ).toMatchObject({ state: 'failed', exitCode: 0, detail: 'apply broken' })

    const run = (overrides: Partial<Awaited<ReturnType<RunTool>>>): RunTool => {
      return async () => ({
        exitCode: 0,
        stdout: '{"ok":true,"state":"ready","detail":"ok"}',
        stderr: '',
        timedOut: false,
        truncated: false,
        sha256: 'sha',
        durationMs: 1,
        ...overrides,
      })
    }
    const cases: Array<{
      runTool: RunTool
      expected: string
      attempt: Record<string, unknown>
    }> = [
      {
        runTool: run({ exitCode: -1, stdout: '', timedOut: true }),
        expected: '工具 t 执行 preflight 超时',
        attempt: {
          exitCode: -1,
          state: 'failed',
          detail: '工具 t 执行 preflight 超时',
          toolSha256: 'sha',
        },
      },
      {
        runTool: run({ exitCode: 2, stdout: '', stderr: 'boom' }),
        expected: '工具 t 执行 preflight 失败：退出码 2',
        attempt: { exitCode: 2, state: 'failed', toolSha256: 'sha' },
      },
      {
        runTool: run({ stdout: 'not json' }),
        expected: '输出不可解析',
        attempt: { exitCode: 0, state: 'failed', toolSha256: 'sha' },
      },
    ]
    for (const item of cases) {
      const deployments = build({ runTool: item.runTool })
      const source = `tool-map-${item.expected}`
      const requested = await deployments.request({
        targetId: 'owner',
        artifact: artifact(),
        source,
      })
      expect(requested.ok).toBe(false)
      expect(requested.code).toBe('preflight_failed')
      expect(requested.message).toContain(item.expected)
      const intentId = repo.deploymentStore
        .deploymentIntents(200)
        .find((intent) => intent.source === source)!.intentId
      expect(deployments.detail(intentId)?.attempts[0]).toMatchObject(item.attempt)
    }

    const thrown = build({
      runTool: async () => {
        throw new Error('spawn failed')
      },
    })
    const requested = await thrown.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'tool-throw',
    })
    expect(requested).toEqual({
      ok: false,
      code: 'preflight_failed',
      message: '工具 t 调用失败：spawn failed',
    })
    const intentId = repo.deploymentStore
      .deploymentIntents(200)
      .find((intent) => intent.source === 'tool-throw')!.intentId
    expect(thrown.detail(intentId)?.attempts[0]).toMatchObject({
      exitCode: -1,
      state: 'failed',
      resultJson: '',
      detail: '工具 t 调用失败：spawn failed',
      toolSha256: digest(toolScript()),
    })
  })
})

describe('deployment rollback', () => {
  it('rolls data targets back with the latest usable restore point and reports previous artifact data', async () => {
    const deployments = build()
    const v1 = artifact('1.0.0', 'data-v1')
    const v2 = artifact('2.0.0', 'data-v2')
    await deploy(deployments, 'data', v1)
    const currentId = await deploy(deployments, 'data', v2)

    recordPreflightRestorePoint(currentId, 'rp-injected', '2026-11-03T10:00:01.000Z')
    repo.deploymentStore.recordDeploymentAttempt({
      intentId: currentId,
      op: 'preflight',
      state: 'ready',
      exitCode: 0,
      resultJson: 'not json',
      detail: '',
      toolSha256: 'seed',
      evidencePath: evidenceDir(currentId),
      startedAt: '2026-11-03T10:00:02.000Z',
      finishedAt: '2026-11-03T10:00:02.000Z',
    })

    const rolled = await deployments.rollback(currentId, '')
    expect(rolled.ok).toBe(true)
    expect(rolled.message).toBe(`部署 ${currentId} 已回退：未说明原因`)
    expect(rolled.data).toEqual({
      intentId: currentId,
      state: 'rolled_back',
      restorePoint: 'rp-injected',
      artifactSha256: v1.sha256,
      artifactVersion: '1.0.0',
    })
    expect(deployments.detail(currentId)?.intent.state).toBe('rolled_back')
    const dataPlan = lastPlan(currentId, 'data-rollback')
    expect(dataPlan.previous).toMatchObject({ sha256: v1.sha256, restorePoint: 'rp-injected' })
    expect(lastPlan(currentId, 'rollback').previous).toMatchObject({ sha256: v1.sha256 })
    expect(
      deployments
        .detail(currentId)
        ?.attempts.map((attempt) => attempt.op)
        .filter((op) => op === 'data-rollback' || op === 'rollback'),
    ).toEqual(['data-rollback', 'rollback'])
    expect(alerts).toHaveLength(0)
  })

  it('refuses rollback without the data capability, without a restore point or in the wrong state', async () => {
    const value = artifact('2.0.0', 'capability')
    const basic = configWith({
      tools: config.deployments.tools.map((tool) => ({
        ...tool,
        capabilities: tool.capabilities.filter((capability) => capability !== 'data-rollback'),
      })),
    })
    const withoutCapability = build({ config: basic })
    const capableIntent = seedIntent({ targetId: 'data', state: 'verified', artifact: value })
    expect(await withoutCapability.rollback(capableIntent, 'x')).toEqual({
      ok: false,
      code: 'capability_missing',
      message: '目标声明了数据范围，但工具 t 没有 data-rollback 能力',
    })
    expect(withoutCapability.detail(capableIntent)?.intent.state).toBe('verified')

    const deployments = build()
    const previous = artifact('1.0.0', 'restore-prev')
    const current = artifact('2.0.0', 'restore-current')
    seedIntent({
      targetId: 'data',
      state: 'verified',
      artifact: previous,
      createdAt: '2026-11-03T09:00:00.000Z',
    })
    const currentId = seedIntent({
      targetId: 'data',
      state: 'verified',
      artifact: current,
      createdAt: '2026-11-03T09:01:00.000Z',
    })
    expect(await deployments.rollback(currentId, 'x')).toEqual({
      ok: false,
      code: 'restore_point_missing',
      message: `部署 ${currentId} 没有可用的 restorePoint，拒绝回退`,
    })
    expect(deployments.detail(currentId)?.intent.state).toBe('verified')

    const awaiting = seedIntent({
      targetId: 'owner',
      state: 'awaiting_approval',
      artifact: artifact(),
    })
    expect(await deployments.rollback(awaiting, 'x')).toEqual({
      ok: false,
      code: 'invalid_state',
      message: `部署 ${awaiting} 当前状态 awaiting_approval 不能回退`,
    })
    expect(await deployments.rollback('missing', 'x')).toEqual({
      ok: false,
      code: 'not_found',
      message: '未找到部署 missing',
    })
  })

  it('reports data-rollback, rollback and post-rollback verification failures', async () => {
    const deployments = build()
    const scenarios: Array<{
      targetId: string
      data?: boolean
      restorePoint?: string
      code: string
      message: string
      expectRollbackOp?: boolean
    }> = [
      {
        targetId: 'fail-data',
        data: true,
        restorePoint: 'rp-test',
        code: 'data_rollback_failed',
        message: '工具 t 报告 data-rollback 失败：data rollback rp-test',
        expectRollbackOp: false,
      },
      {
        targetId: 'rollback-fail',
        code: 'rollback_failed',
        message: '工具 t 报告 rollback 失败：rollback failed',
        expectRollbackOp: true,
      },
      {
        targetId: 'rollback-status-down',
        code: 'rollback_verify_failed',
        message: '回退后状态核对失败：工具 t 报告 status 失败：status unavailable',
        expectRollbackOp: true,
      },
      {
        targetId: 'rollback-stuck',
        code: 'rollback_verify_failed',
        message: '回退后实际状态不符：实际运行版本 2.0.0，期望上一已验证版本 1.0.0',
        expectRollbackOp: true,
      },
      {
        targetId: 'rollback-wrong-installed',
        code: 'rollback_verify_failed',
        message: '回退后实际状态不符：已安装制品摘要不是上一已验证制品 ',
        expectRollbackOp: true,
      },
      {
        targetId: 'rollback-wrong-running',
        code: 'rollback_verify_failed',
        message: '回退后实际状态不符：运行中制品摘要不是上一已验证制品 ',
        expectRollbackOp: true,
      },
      {
        targetId: 'rollback-zero-pid',
        code: 'rollback_verify_failed',
        message: '回退后实际状态不符：工具未提供有效运行进程 pid',
        expectRollbackOp: true,
      },
    ]
    for (const scenario of scenarios) {
      resetToolState()
      const previous = artifact('1.0.0', `prev-${scenario.targetId}`)
      const current = artifact('2.0.0', `curr-${scenario.targetId}`)
      seedIntent({
        targetId: scenario.targetId,
        state: 'verified',
        artifact: previous,
        createdAt: '2026-11-03T09:00:00.000Z',
      })
      const currentId = seedIntent({
        targetId: scenario.targetId,
        state: 'verified',
        artifact: current,
        createdAt: '2026-11-03T09:01:00.000Z',
      })
      if (scenario.restorePoint) {
        recordPreflightRestorePoint(currentId, scenario.restorePoint, '2026-11-03T10:00:00.000Z')
      }
      const result = await deployments.rollback(currentId, 'x')
      expect(result.code, `${scenario.targetId}: ${result.message}`).toBe(scenario.code)
      expect(result.message.startsWith(scenario.message)).toBe(true)
      expect(deployments.detail(currentId)?.intent.state).toBe('failed')
      expect(alerts.at(-1)?.body.message).toContain(
        scenario.code === 'data_rollback_failed' || scenario.code === 'rollback_failed'
          ? scenario.message
          : '回退',
      )
      if (scenario.targetId === 'rollback-wrong-installed') {
        expect(result.message).toContain(previous.sha256.slice(0, 12))
      }
      const ops = deployments.detail(currentId)?.attempts.map((attempt) => attempt.op) ?? []
      expect(ops.includes('data-rollback')).toBe(Boolean(scenario.data))
      expect(ops.includes('rollback')).toBe(Boolean(scenario.expectRollbackOp))
      if (!scenario.expectRollbackOp) {
        expect(ops.filter((op) => op === 'data-rollback')).toHaveLength(1)
      }
    }
  })
})

describe('deployment inspect', () => {
  it('reads installed package versions and treats missing or malformed manifests as unknown', () => {
    const root = join(dir, 'installed-version')
    mkdirSync(root, { recursive: true })
    expect(readInstalledVersion(root)).toBe('')
    writeFileSync(join(root, 'package.json'), '{')
    expect(readInstalledVersion(root)).toBe('')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: 42 }))
    expect(readInstalledVersion(root)).toBe('')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }))
    expect(readInstalledVersion(root)).toBe('')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    expect(readInstalledVersion(root)).toBe('1.2.3')
  })

  it('verifies installed files against tar members with and without the package prefix', () => {
    const pack = join(dir, 'pack')
    mkdirSync(join(pack, 'package'), { recursive: true })
    writeFileSync(join(pack, 'package', 'a.js'), 'export const a = 1\n')
    writeFileSync(join(pack, 'b.js'), 'export const b = 2\n')
    writeFileSync(join(pack, 'package', 'c.js'), 'export const c = 3\n')
    const tarball = join(dir, 'build.tgz')
    execFileSync('tar', ['-czf', tarball, '-C', pack, 'package/a.js', 'b.js', 'package/c.js'], {
      stdio: 'ignore',
    })
    const installedRoot = join(dir, 'installed-files')
    mkdirSync(installedRoot, { recursive: true })
    writeFileSync(join(installedRoot, 'a.js'), 'export const a = 1\n')
    writeFileSync(join(installedRoot, 'b.js'), 'export const b = 2\n')
    writeFileSync(join(installedRoot, 'c.js'), 'export const c = 3\n')
    const build = { files: ['a.js', 'b.js'], tarball }

    expect(verifyInstalledFiles(build, installedRoot)).toEqual({
      ok: true,
      detail: '2 个文件与包内容一致',
    })
    expect(verifyInstalledFiles({ files: [], tarball }, installedRoot)).toEqual({
      ok: true,
      detail: '0 个文件与包内容一致',
    })
    expect(verifyInstalledFiles({ files: ['a.js', 'missing.js'], tarball }, installedRoot)).toEqual(
      {
        ok: false,
        detail: '缺少 missing.js',
      },
    )
    writeFileSync(join(installedRoot, 'orphan.js'), 'orphan\n')
    expect(
      verifyInstalledFiles({ files: ['missing.js', 'orphan.js'], tarball }, installedRoot),
    ).toEqual({
      ok: false,
      detail: '缺少 missing.js；无法读取包内 orphan.js',
    })
    writeFileSync(join(installedRoot, 'c.js'), 'tampered\n')
    expect(verifyInstalledFiles({ files: ['c.js'], tarball }, installedRoot)).toEqual({
      ok: false,
      detail: '内容不一致 c.js',
    })
    expect(verifyInstalledFiles({ files: ['orphan.js'], tarball }, installedRoot)).toEqual({
      ok: false,
      detail: '无法读取包内 orphan.js',
    })
  })

  it('reports missing, malformed, matching, stale and version-mismatched runtime identities', () => {
    const root = join(dir, 'identity')
    mkdirSync(join(root, 'lib', 'runtime'), { recursive: true })
    const index = 'export const entry = 1\n'
    const service = 'export const service = 1\n'
    writeFileSync(join(root, 'lib', 'index.js'), index)
    writeFileSync(join(root, 'lib', 'runtime', 'service.js'), service)
    const indexSha = sha256OfBytes(Buffer.from(index))
    const serviceSha = sha256OfBytes(Buffer.from(service))
    const writeIdentity = (value: unknown): void => {
      writeFileSync(join(root, 'runtime-identity.json'), JSON.stringify(value))
    }
    const identityPath = join(root, 'runtime-identity.json')

    expect(inspectRuntimeIdentity(root, { packageVersion: '1.0.0' })).toBeNull()
    writeFileSync(identityPath, '{')
    expect(inspectRuntimeIdentity(root, { packageVersion: '1.0.0' })).toEqual({
      id: 'running_identity',
      ok: false,
      detail: '运行身份文件无法解析',
    })

    const live = {
      kind: 'forgeloop-runtime-identity',
      version: '1.0.0',
      pid: process.pid,
      indexSha256: indexSha,
      serviceSha256: serviceSha,
    }
    writeIdentity(live)
    expect(inspectRuntimeIdentity(root, { packageVersion: '1.0.0' })).toEqual({
      id: 'running_identity',
      ok: true,
      detail: `运行身份 pid=${process.pid}，入口摘要 ${indexSha}，服务摘要 ${serviceSha}`,
    })

    writeIdentity({ ...live, version: '2.0.0' })
    expect(inspectRuntimeIdentity(root, { packageVersion: '1.0.0' })?.ok).toBe(false)
    writeIdentity({ ...live, indexSha256: '0'.repeat(64) })
    expect(inspectRuntimeIdentity(root, { packageVersion: '1.0.0' })?.ok).toBe(false)
    writeIdentity({ ...live, kind: 'other' })
    expect(inspectRuntimeIdentity(root, { packageVersion: '1.0.0' })?.ok).toBe(false)

    const deadPid = Number(
      execFileSync('node', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim(),
    )
    writeIdentity({ ...live, pid: deadPid })
    expect(inspectRuntimeIdentity(root, { packageVersion: '1.0.0' })?.ok).toBe(false)
    writeIdentity({ ...live, pid: 'not-a-pid' })
    const unknownPid = inspectRuntimeIdentity(root, { packageVersion: '1.0.0' })
    expect(unknownPid?.ok).toBe(false)
    expect(unknownPid?.detail.startsWith('运行身份 pid=未知')).toBe(true)
  })

  it('judges process liveness for the current, zero, negative and exited pids', () => {
    const deadPid = Number(
      execFileSync('node', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim(),
    )
    expect(processAlive(process.pid)).toBe(true)
    expect(processAlive(0)).toBe(false)
    expect(processAlive(-1)).toBe(false)
    expect(processAlive(deadPid)).toBe(false)
    expect(processAlive(2_147_483_647)).toBe(false)
  })

  it('checks required modules from admitted candidate diffs or task plans', () => {
    const root = join(dir, 'modules')
    mkdirSync(join(root, 'lib', 'sub'), { recursive: true })
    writeFileSync(join(root, 'lib', 'a.js'), 'a\n')
    writeFileSync(join(root, 'lib', 'sub', 'b.js'), 'b\n')
    writeFileSync(join(root, 'lib', 'c.js'), 'c\n')
    const diff = join(dir, 'candidate.diff')
    writeFileSync(
      diff,
      [
        'diff --git a/packages/forgeloop/src/a.ts b/packages/forgeloop/src/a.ts',
        '+++ b/packages/forgeloop/src/a.ts',
        '+++ b/packages/forgeloop/src/sub/b.ts',
        '+++ b/packages/forgeloop/src/sub/b.ts',
        '+++ b/docs/x.md',
        '+++ b/packages/forgeloop/src/a.tsx',
        '+++ b/packages/forgeloop/src/a.ts',
        '',
      ].join('\n'),
    )
    const plan = (files: string[]): TaskPlan => ({
      taskPlanId: 'plan-1',
      requirementId: 'req-1',
      project: 'testproj',
      planVersion: 1,
      requirementVersion: 1,
      createdAt: NOW,
      tasks: [
        {
          taskId: 'a',
          goal: 'g',
          files,
          acceptance: 'a',
          testCommand: [],
          dependsOn: [],
          limits: { limitSeconds: 60, maxFailureRounds: 1 },
          authorizationSource: 'test',
        },
      ],
    })

    expect(inspectRequirementModules(true, diff, plan([]), root)).toEqual({
      ok: true,
      detail: '本次需求的 2 个源码模块已随安装包加载',
    })
    expect(
      inspectRequirementModules(
        false,
        diff,
        plan([
          'packages/forgeloop/src/c.ts',
          'docs/x.md',
          'scripts/y.ts',
          'packages/forgeloop/src/c.ts',
        ]),
        root,
      ),
    ).toEqual({ ok: true, detail: '本次需求的 1 个源码模块已随安装包加载' })

    rmSync(join(root, 'lib', 'sub', 'b.js'))
    expect(inspectRequirementModules(true, diff, plan([]), root)).toEqual({
      ok: false,
      detail: '安装包缺少本次需求的模块：lib/sub/b.js',
    })
    expect(
      inspectRequirementModules(false, diff, plan(['packages/forgeloop/src/z.ts']), root),
    ).toEqual({
      ok: false,
      detail: '安装包缺少本次需求的模块：lib/z.js',
    })
  })
})
