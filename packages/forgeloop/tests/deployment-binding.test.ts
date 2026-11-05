import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import type { TaskPlan } from '../src/domain/task-plan.js'

const REQ = 'req-binding-1'
const TASK_CANDIDATE = 'cand-task-1'
const NOW = '2026-11-07T10:00:00.000Z'

let dir = ''
let database: Database
let repo: Repository
let script = ''
let artifactPath = ''
let artifactSha = ''
let config: ForgeLoopConfig

function plan(): TaskPlan {
  return {
    taskPlanId: `plan-${REQ}-1`,
    requirementId: REQ,
    project: 'testproj',
    planVersion: 1,
    requirementVersion: 1,
    tasks: [
      {
        taskId: 't1',
        goal: '写文档',
        files: ['docs/a.md'],
        acceptance: '存在',
        testCommand: ['true'],
        dependsOn: [],
        limits: { limitSeconds: -1, maxFailureRounds: -1 },
        authorizationSource: 'system-admission:test',
      },
    ],
    createdAt: '2026-11-07T09:00:00.000Z',
  }
}

function buildRaw(target: Record<string, unknown> = {}): RawConfig {
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
          capabilities: ['preflight', 'apply', 'status', 'rollback'],
          timeoutSeconds: 10,
        },
      ],
      targets: [{ id: 'owner', toolId: 't', requirementId: REQ, approval: 'owner', ...target }],
    } as never,
  }
}

function toolScript(): string {
  return [
    'import json, os, sys',
    'args = sys.argv',
    'op = args[args.index("--op") + 1]',
    'plan = json.load(open(args[args.index("--plan") + 1]))',
    'if op == "preflight":',
    '    print(json.dumps({"ok": True, "state": "ready", "detail": "preflight ok"}))',
    'elif op == "apply":',
    '    print(json.dumps({"ok": True, "state": "applied", "detail": "apply ok"}))',
    'else:',
    '    print(json.dumps({"ok": True, "state": "running", "version": plan["artifact"]["version"], "artifactSha256": plan["artifact"]["sha256"], "runningArtifactSha256": plan["artifact"]["sha256"], "runningPid": os.getpid(), "runningStartedAt": "2026-11-07T10:00:00Z", "detail": "status ok"}))',
  ].join('\n')
}

function candidate(): string {
  return candidateIdentityOf({
    planVersion: 1,
    requirementVersion: 1,
    baselineCommit: '',
    candidateHashes: [TASK_CANDIDATE],
  })
}

function seed(): void {
  repo.submit({
    reqId: REQ,
    project: 'testproj',
    text: '部署绑定测试',
    submittedBy: 'owner',
    source: 'test',
    now: '2026-11-07T08:00:00.000Z',
  })
  repo.setStatus(REQ, 'committed', '已提交')
  repo.recordTaskPlan(plan())
  repo.recordTaskArtifact({
    requirementId: REQ,
    planVersion: 1,
    taskId: 't1',
    candidateSha256: TASK_CANDIDATE,
    testEvidenceSha256: 'e'.repeat(64),
    reviewSha256: 'r'.repeat(64),
    acceptance: '存在',
    authorizationSource: 'test',
    recordedAt: '2026-11-07T08:30:00.000Z',
  })
  repo.recordVerification({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: candidate(),
    requirementVersion: 1,
    workspaceSha256: 'w'.repeat(64),
    verdict: 'pass',
    reportJson: '{}',
    reportPath: '/tmp/verification.json',
    reportSha256: 'v'.repeat(64),
    evidenceDir: '/tmp/verification',
    sessionId: 'session-1',
    verifiedAt: '2026-11-07T08:40:00.000Z',
  })
  repo.recordBusinessReview({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: candidate(),
    requirementVersion: 1,
    verificationSha256: 'v'.repeat(64),
    verdict: 'pass',
    reportJson: '{}',
    reportPath: '/tmp/review.json',
    reportSha256: 's'.repeat(64),
    sessionId: 'session-1',
    reviewedAt: '2026-11-07T08:45:00.000Z',
  })
  repo.recordCommit({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: candidate(),
    commitSha: 'd'.repeat(40),
    commitMessage: '部署绑定测试',
    checkCommand: [],
    checkLogPath: '/tmp/check.log',
    checkSha256: 'f'.repeat(64),
    files: ['docs/a.md'],
    committedAt: '2026-11-07T08:50:00.000Z',
  })
  repo.recordCandidateBuild({
    reqId: REQ,
    planVersion: 1,
    candidateSha256: candidate(),
    verificationSha256: 'v'.repeat(64),
    packageVersion: '1.0.0',
    artifactSha256: artifactSha,
    tarball: artifactPath,
    files: ['lib/index.js'],
    gitHead: 'head',
    builtAt: '2026-11-07T08:55:00.000Z',
    evidenceDir: '/tmp/build',
  })
}

function artifact(): DeploymentArtifact {
  return { sha256: artifactSha, path: artifactPath, version: '1.0.0' }
}

function acceptWith(fingerprint: string): void {
  repo.recordAcceptance({
    reqId: REQ,
    acceptedBy: 'owner',
    source: 'test',
    fingerprint,
    now: '2026-11-07T09:30:00.000Z',
  })
}

interface Harness {
  deployments: Deployments
  ops: string[]
  decisions: (intentId: string) => Array<{ decision: string; by: string; detail: string }>
}

function harness(
  options: {
    gate?: DeploymentGate
    slowPreflight?: { wait: Promise<void> }
    raw?: RawConfig
  } = {},
): Harness {
  const ops: string[] = []
  const deployments = new Deployments({
    config: options.raw ? resolveConfig(options.raw, dir) : config,
    store: repo.deploymentStore,
    gate: options.gate ?? (() => ({ ok: true, reason: '' })),
    now: () => NOW,
    alert: async () => ({ ok: true, error: '' }),
    runTool: async (_tool, op) => {
      ops.push(op)
      if (op === 'preflight' && options.slowPreflight) await options.slowPreflight.wait
      const payload =
        op === 'status'
          ? {
              ok: true,
              state: 'running',
              version: '1.0.0',
              artifactSha256: artifactSha,
              runningArtifactSha256: artifactSha,
              runningPid: process.pid,
              runningStartedAt: NOW,
              detail: 'status ok',
            }
          : op === 'preflight'
            ? { ok: true, state: 'ready', detail: 'preflight ok' }
            : { ok: true, state: 'applied', detail: 'apply ok' }
      return {
        exitCode: 0,
        stdout: JSON.stringify(payload),
        stderr: '',
        timedOut: false,
        truncated: false,
        sha256: 'x',
        durationMs: 1,
      }
    },
  })
  return {
    deployments,
    ops,
    decisions: (intentId) => repo.deploymentStore.deploymentDecisions(intentId),
  }
}

function deferred(): { wait: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const wait = new Promise<void>((done) => {
    resolve = done
  })
  return { wait, resolve }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-deploy-binding-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repo = new Repository(database)
  const toolDir = join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', 'tools')
  mkdirSync(toolDir, { recursive: true })
  script = join(toolDir, 'tool.py')
  writeFileSync(script, toolScript())
  artifactPath = join(dir, 'candidate-1.0.0.tgz')
  writeFileSync(artifactPath, 'package-content-v1')
  artifactSha = createHash('sha256').update('package-content-v1').digest('hex')
  config = resolveConfig(buildRaw(), dir)
  seed()
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('deployment gate acceptance binding', () => {
  it('rejects an owner deployment whose acceptance binds a different candidate', async () => {
    acceptWith('f'.repeat(64))
    const { deployments, ops } = harness({ gate: candidateDeploymentGate(repo) })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'owner',
    })
    expect(requested).toMatchObject({ ok: false, code: 'preflight_failed' })
    expect(requested.message).toContain('验收所绑定的候选材料')
    // 门禁拒绝时不得调用任何部署工具操作。
    expect(ops).toEqual([])
    expect(deployments.list()[0]?.state).toBe('preflight_failed')
  })

  it('accepts an owner deployment bound to the current candidate', async () => {
    const fingerprints = expectedAcceptanceFingerprints(repo, REQ, artifactSha)
    expect(fingerprints).toHaveLength(2)
    acceptWith(fingerprints[1]!)
    const { deployments } = harness({ gate: candidateDeploymentGate(repo) })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'owner',
    })
    expect(requested.ok).toBe(true)
    const intentId = (requested.data as { intentId: string }).intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('awaiting_approval')
    expect((await deployments.approve(intentId)).ok).toBe(true)
    expect((await deployments.verify(intentId)).ok).toBe(true)
  })
})

describe('deployment apply revalidation', () => {
  it('re-gates before apply when the requirement is revised during preflight', async () => {
    const slow = deferred()
    const raw = buildRaw({ approval: 'auto', rollback: { keep: 1 } })
    const { deployments, ops, decisions } = harness({
      gate: candidateDeploymentGate(repo),
      slowPreflight: slow,
      raw,
    })
    const pending = deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'auto',
    })
    // preflight 进行中需求被修订：任务包与准入对当前版本过期。
    repo.appendVersion({
      reqId: REQ,
      text: '部署绑定测试（修订）',
      revisedBy: 'owner',
      source: 'test',
      now: '2026-11-07T10:00:01.000Z',
    })
    slow.resolve()
    const requested = await pending
    expect(requested).toMatchObject({ ok: false, code: 'preflight_failed' })
    expect(ops).toEqual(['preflight'])
    const intentId = deployments.list()[0]!.intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('preflight_failed')
    expect(
      decisions(intentId).some((entry) =>
        ['gate_failed', 'revalidate_failed'].includes(entry.decision),
      ),
    ).toBe(true)
  })

  it('refuses to apply a stopped requirement', async () => {
    const slow = deferred()
    const raw = buildRaw({ approval: 'auto', rollback: { keep: 1 } })
    const { deployments, ops } = harness({
      gate: candidateDeploymentGate(repo),
      slowPreflight: slow,
      raw,
    })
    const pending = deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'auto-stop',
    })
    repo.recordStop({
      requirementId: REQ,
      requestedBy: 'owner',
      reason: '停止测试',
      requestedAt: '2026-11-07T10:00:01.000Z',
    })
    slow.resolve()
    const requested = await pending
    expect(requested).toMatchObject({ ok: false, code: 'preflight_failed' })
    expect(requested.message).toContain('已停止')
    expect(ops).toEqual(['preflight'])
  })

  it('rejects a different artifact with the same version before apply', async () => {
    const fingerprints = expectedAcceptanceFingerprints(repo, REQ, artifactSha)
    acceptWith(fingerprints[0]!)
    const { deployments, ops } = harness({ gate: candidateDeploymentGate(repo) })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'owner',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    expect(deployments.detail(intentId)?.intent.state).toBe('awaiting_approval')
    // 等待批准期间同版本换包：磁盘内容变了，记录摘要没变。
    writeFileSync(artifactPath, 'package-content-v2')
    const approved = await deployments.approve(intentId)
    expect(approved).toMatchObject({ ok: false, code: 'preflight_failed' })
    expect(approved.message).toContain('制品文件摘要')
    expect(ops).toEqual(['preflight'])
    expect(deployments.detail(intentId)?.intent.state).toBe('preflight_failed')
  })

  it('rejects an unreadable artifact file before apply', async () => {
    const fingerprints = expectedAcceptanceFingerprints(repo, REQ, artifactSha)
    acceptWith(fingerprints[0]!)
    const { deployments, ops } = harness({ gate: candidateDeploymentGate(repo) })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'owner',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    rmSync(artifactPath)
    const approved = await deployments.approve(intentId)
    expect(approved).toMatchObject({ ok: false, code: 'preflight_failed' })
    expect(approved.message).toContain('制品文件不可读')
    expect(ops).toEqual(['preflight'])
  })
})

describe('deployment target mutual exclusion', () => {
  it('allows only one active intent per target', async () => {
    const slow = deferred()
    const raw = buildRaw({ approval: 'auto', rollback: { keep: 1 } })
    const { deployments } = harness({ slowPreflight: slow, raw })
    const first = deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'first',
    })
    const second = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'second',
    })
    expect(second).toMatchObject({ ok: false, code: 'target_busy' })
    slow.resolve()
    expect((await first).ok).toBe(true)
    expect(deployments.list().filter((intent) => intent.state !== 'rejected')).toHaveLength(1)
  })

  it('applies once when approve is called concurrently', async () => {
    const fingerprints = expectedAcceptanceFingerprints(repo, REQ, artifactSha)
    acceptWith(fingerprints[0]!)
    const { deployments, ops } = harness({ gate: candidateDeploymentGate(repo) })
    const requested = await deployments.request({
      targetId: 'owner',
      artifact: artifact(),
      source: 'owner',
    })
    const intentId = (requested.data as { intentId: string }).intentId
    const [first, second] = await Promise.all([
      deployments.approve(intentId),
      deployments.approve(intentId),
    ])
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
    expect([first.code, second.code]).toContain('invalid_state')
    expect(ops.filter((op) => op === 'apply')).toHaveLength(1)
  })
})
