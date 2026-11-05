import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { resolveConfig, type ForgeLoopConfig, type RawConfig } from '../src/config.js'
import { Deployments } from '../src/runtime/deployments.js'
import { DeploymentService } from '../src/runtime/deployment-service.js'
import { createDeliveryHandoff, DeliveryHandoff } from '../src/runtime/delivery-handoff.js'
import { ok } from '../src/runtime/operation-result.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

const REQ = 'req-handoff-1'
const CANDIDATE = 'c'.repeat(64)
let ARTIFACT = ''
let ARTIFACT_PATH = ''

let dir = ''
let database: Database
let repo: Repository
let script = ''
let config: ForgeLoopConfig

function raw(overrides: Record<string, unknown> = {}): RawConfig {
  return {
    project: 'testproj',
    projectPath: dir,
    recordsRoot: join(dir, '.forgeloop'),
    deployments: {
      enabled: true,
      alerts: { webhook: 'https://example.com/hook' },
      tools: [
        {
          id: 't',
          kind: 'python',
          path: script,
          capabilities: ['preflight', 'apply', 'status', 'rollback'],
          timeoutSeconds: 10,
        },
      ],
      targets: [
        {
          id: 'auto',
          toolId: 't',
          approval: 'auto',
          autoDeliver: true,
          rollback: { keep: 1 },
          ...overrides,
        },
      ],
    } as never,
  }
}

function toolScript(): string {
  return [
    'import json, os, sys',
    'args = sys.argv',
    'op = args[args.index("--op") + 1]',
    'plan = json.load(open(args[args.index("--plan") + 1]))',
    'artifact = plan["artifact"]["sha256"]',
    'tag = plan["params"].get("tag", "")',
    'if op == "preflight":',
    '    failed = tag == "FAIL_PREFLIGHT"',
    '    print(json.dumps({"ok": not failed, "state": "ready" if not failed else "failed", "restorePoint": "rp-1", "detail": "preflight"}))',
    'elif op == "apply":',
    '    print(json.dumps({"ok": True, "state": "applied", "detail": "ok"}))',
    'elif op == "status":',
    '    running = "0" * 64 if tag == "OLD_RUNNING" else artifact',
    '    print(json.dumps({"ok": True, "state": "running", "version": "1.0.0", "artifactSha256": artifact, "runningArtifactSha256": running, "runningPid": os.getpid(), "runningStartedAt": "2026-11-05T10:00:00Z", "detail": "status"}))',
  ].join('\n')
}

function plan(): TaskPlan {
  return {
    taskPlanId: `plan-${REQ}-1`,
    requirementId: REQ,
    project: 'testproj',
    planVersion: 1,
    requirementVersion: 1,
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
    createdAt: '2026-11-05T10:00:00.000Z',
  }
}

function seedRequirement(): void {
  repo.submit({
    reqId: REQ,
    project: 'testproj',
    text: '自动交付测试',
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
  repo.recordTaskPlan(plan())
  repo.recordCodeCandidate({
    requirementId: REQ,
    planVersion: 1,
    candidateVersion: 1,
    candidateSha256: CANDIDATE,
    requirementVersion: 1,
    baselineCommit: 'b'.repeat(40),
    snapshotCommit: 's'.repeat(40),
    diffPath: '/tmp/candidate.diff',
    diffSha256: 'd'.repeat(64),
    createdAt: '2026-11-05T09:02:00.000Z',
  })
  repo.recordVerification({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    requirementVersion: 1,
    workspaceSha256: 'w'.repeat(64),
    verdict: 'pass',
    reportJson: '{}',
    reportPath: '/tmp/verification.json',
    reportSha256: 'r'.repeat(64),
    evidenceDir: '/tmp/verification',
    sessionId: 'session-1',
    verifiedAt: '2026-11-05T09:03:00.000Z',
  })
  repo.recordBusinessReview({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    requirementVersion: 1,
    verificationSha256: 'r'.repeat(64),
    verdict: 'pass',
    reportJson: '{}',
    reportPath: '/tmp/review.json',
    reportSha256: 'v'.repeat(64),
    sessionId: 'session-1',
    reviewedAt: '2026-11-05T09:04:00.000Z',
  })
  repo.recordCommit({
    requirementId: REQ,
    planVersion: 1,
    candidateSha256: CANDIDATE,
    commitSha: 'e'.repeat(40),
    commitMessage: '自动交付测试',
    checkCommand: [],
    checkLogPath: '/tmp/check.log',
    checkSha256: 'f'.repeat(64),
    files: ['docs/a.md'],
    committedAt: '2026-11-05T09:05:00.000Z',
  })
  repo.setStatus(REQ, 'committed', '已提交')
}

function buildStub(): ReturnType<typeof vi.fn> {
  return vi.fn((reqId: string) => {
    repo.recordCandidateBuild({
      reqId,
      planVersion: 1,
      candidateSha256: CANDIDATE,
      verificationSha256: 'r'.repeat(64),
      packageVersion: '1.0.0',
      artifactSha256: ARTIFACT,
      tarball: ARTIFACT_PATH,
      files: ['lib/index.js'],
      gitHead: 'head',
      builtAt: '2026-11-05T09:06:00.000Z',
      evidenceDir: '/tmp/build',
    })
    return ok('built', { artifactSha256: ARTIFACT })
  })
}

function makeHandoff(
  buildCandidate: (reqId: string) => unknown,
  recheckImpl?: () => Promise<void>,
): {
  handoff: DeliveryHandoff
  deployments: Deployments
  recheck: ReturnType<typeof vi.fn>
} {
  const deployments = new Deployments({
    config,
    store: repo.deploymentStore,
    gate: () => ({ ok: true, reason: '' }),
    now: () => '2026-11-05T10:00:00.000Z',
    alert: async () => ({ ok: true, error: '' }),
  })
  const service = new DeploymentService({ config, repo, deployments })
  const recheck = vi.fn(recheckImpl ?? (async () => {}))
  const handoff = new DeliveryHandoff({
    config,
    repo,
    now: () => '2026-11-05T10:00:00.000Z',
    buildCandidate: buildCandidate as never,
    deployments,
    deploymentService: service,
    ops: { recheckFix: recheck },
  })
  return { handoff, deployments, recheck }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-handoff-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repo = new Repository(database)
  const toolDir = join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', 'tools')
  mkdirSync(toolDir, { recursive: true })
  script = join(toolDir, 'tool.py')
  writeFileSync(script, toolScript())
  ARTIFACT_PATH = join(dir, 'handoff-candidate.tgz')
  writeFileSync(ARTIFACT_PATH, 'handoff-candidate')
  ARTIFACT = createHash('sha256').update('handoff-candidate').digest('hex')
  config = resolveConfig(raw(), dir)
  seedRequirement()
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('delivery handoff', () => {
  it('builds and verifies once, then stays idempotent across ticks and restarts', async () => {
    const build = buildStub()
    const first = makeHandoff(build)
    await first.handoff.tick()
    expect(build).toHaveBeenCalledTimes(1)
    expect(first.deployments.list()).toHaveLength(1)
    expect(first.deployments.list()[0]?.state).toBe('verified')

    await first.handoff.tick()
    const restarted = makeHandoff(build)
    await restarted.handoff.tick()
    expect(build).toHaveBeenCalledTimes(1)
    expect(restarted.deployments.list()).toHaveLength(1)
  })

  it('waits for owner approval instead of applying an owner target', async () => {
    config = resolveConfig(raw({ approval: 'owner', autoDeliver: true }), dir)
    const build = buildStub()
    const { handoff, deployments } = makeHandoff(build)
    await handoff.tick()
    expect(deployments.list()).toHaveLength(1)
    expect(deployments.list()[0]?.state).toBe('awaiting_approval')
    await handoff.tick()
    expect(deployments.list()).toHaveLength(1)
  })

  it('does not deliver a stopped requirement', async () => {
    repo.recordStop({
      requirementId: REQ,
      requestedBy: 'owner',
      reason: '停止',
      requestedAt: '2026-11-05T09:10:00.000Z',
    })
    const build = buildStub()
    const { handoff, deployments } = makeHandoff(build)
    await handoff.tick()
    expect(build).not.toHaveBeenCalled()
    expect(deployments.list()).toHaveLength(0)
  })

  it('records a build failure and does not retry the same candidate forever', async () => {
    const build = vi.fn(() => ({ ok: false, code: 'candidate_build_failed', message: 'boom' }))
    const { handoff, deployments } = makeHandoff(build)
    await handoff.tick()
    await handoff.tick()
    expect(build).toHaveBeenCalledTimes(1)
    expect(deployments.list()).toHaveLength(0)
    expect(repo.deliveryStore.handoff(REQ, CANDIDATE, '')?.state).toBe('build_failed')
  })

  it('fails verification when the running artifact is stale', async () => {
    config = resolveConfig(raw({ params: { tag: 'OLD_RUNNING' } }), dir)
    const build = buildStub()
    const { handoff, deployments } = makeHandoff(build)
    await handoff.tick()
    expect(deployments.list()[0]?.state).toBe('verify_failed')
    expect(repo.deliveryStore.handoff(REQ, CANDIDATE, 'auto')?.state).toBe('verify_failed')
  })

  it('rechecks the original ops event after the fix deployment is verified', async () => {
    const event = repo.createOpsEvent({
      eventId: 'ops-test-1',
      project: 'testproj',
      checkId: 'check-1',
      resourceId: 'res-1',
      signature: 'sig-1',
      title: 'down',
      severity: 'major',
      state: 'recovered',
      openedAt: '2026-11-05T09:00:00.000Z',
      updatedAt: '2026-11-05T09:00:00.000Z',
    })
    repo.updateOpsEvent(event.eventId, {
      fixRequirementId: REQ,
      updatedAt: '2026-11-05T09:10:00.000Z',
    })
    const build = buildStub()
    const { handoff, recheck } = makeHandoff(build)
    await handoff.tick()
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(recheck).toHaveBeenCalledWith(event.eventId, expect.any(String))
  })

  it('records a deployment failure and does not retry the same target', async () => {
    const cfg = raw()
    const deploymentsConfig = cfg.deployments as {
      targets: Array<Record<string, unknown>>
    }
    deploymentsConfig.targets.push({
      id: 'fail',
      toolId: 't',
      approval: 'auto',
      autoDeliver: true,
      rollback: { keep: 1 },
      params: { tag: 'FAIL_PREFLIGHT' },
    })
    config = resolveConfig(cfg, dir)
    const build = buildStub()
    const { handoff, deployments } = makeHandoff(build)
    await handoff.tick()
    await handoff.tick()
    expect(build).toHaveBeenCalledTimes(1)
    expect(deployments.list()).toHaveLength(2)
    expect(repo.deliveryStore.handoff(REQ, CANDIDATE, 'fail')?.state).toBe('deploy_failed')
  })

  it('verifies an applied auto-target intent left by a manual request', async () => {
    const deployments = new Deployments({
      config,
      store: repo.deploymentStore,
      gate: () => ({ ok: true, reason: '' }),
      now: () => '2026-11-05T10:00:00.000Z',
      alert: async () => ({ ok: true, error: '' }),
    })
    const service = new DeploymentService({ config, repo, deployments })
    const build = buildStub()
    build(REQ)
    const requested = await service.request({
      targetId: 'auto',
      by: 'owner',
      source: 'manual-applied',
      requirementId: REQ,
    })
    expect(requested.ok).toBe(true)
    expect(deployments.list()[0]?.state).toBe('applied_pending_verify')

    // 需求尚未提交，交接主循环不会处理它；只剩 auto 目标的未核对 intent 路径。
    repo.setStatus(REQ, 'draft', '')
    const handoff = new DeliveryHandoff({
      config,
      repo,
      now: () => '2026-11-05T10:00:00.000Z',
      buildCandidate: build as never,
      deployments,
      deploymentService: service,
      ops: { recheckFix: async () => {} },
    })
    await handoff.tick()
    expect(build).toHaveBeenCalledTimes(1)
    expect(deployments.list()[0]?.state).toBe('verified')
  })

  it('builds through the runtime factory wiring', async () => {
    const deployments = new Deployments({
      config,
      store: repo.deploymentStore,
      gate: () => ({ ok: true, reason: '' }),
      now: () => '2026-11-05T10:00:00.000Z',
      alert: async () => ({ ok: true, error: '' }),
    })
    const service = new DeploymentService({ config, repo, deployments })
    const build = buildStub()
    const handoff = createDeliveryHandoff(
      {
        config,
        repo,
        deployments,
        deploymentService: service,
        ops: { recheckFix: async () => {} },
        buildCandidate: (input) => build(input.reqId),
      },
      () => '2026-11-05T10:00:00.000Z',
    )
    await handoff.tick()
    expect(build).toHaveBeenCalledWith(REQ)
  })

  it('skips requirements without admission, plan or code candidate', async () => {
    const noAdmission = 'req-no-admission'
    repo.submit({
      reqId: noAdmission,
      project: 'testproj',
      text: 'x',
      submittedBy: 'owner',
      source: 'test',
      now: '2026-11-05T09:00:00.000Z',
    })
    repo.setStatus(noAdmission, 'committed')
    const noPlan = 'req-no-plan'
    repo.submit({
      reqId: noPlan,
      project: 'testproj',
      text: 'x',
      submittedBy: 'owner',
      source: 'test',
      now: '2026-11-05T09:00:00.000Z',
    })
    repo.recordAdmission({
      requirementId: noPlan,
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
    repo.setStatus(noPlan, 'committed')
    const build = buildStub()
    const { handoff } = makeHandoff(build)
    await handoff.tick()
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('records a failure when a successful build yields no build record', async () => {
    const build = vi.fn(() => ({ ok: true, code: 'ok', message: 'ok' }))
    const { handoff, deployments } = makeHandoff(build)
    await handoff.tick()
    expect(build).toHaveBeenCalledTimes(1)
    expect(deployments.list()).toHaveLength(0)
  })
})

/**
 * G3：部署核对完成与原事件复核完成必须分开持久化。
 * 复核第一次抛异常不能丢失后续推进，也不能重复部署。
 */
describe('delivery handoff ops recheck recovery', () => {
  function seedEvent(): string {
    const event = repo.createOpsEvent({
      eventId: 'ops-g3',
      project: 'testproj',
      checkId: 'check-1',
      resourceId: 'res-1',
      signature: 'sig-g3',
      title: 'down',
      severity: 'major',
      state: 'recovered',
      openedAt: '2026-11-05T09:00:00.000Z',
      updatedAt: '2026-11-05T09:00:00.000Z',
    })
    repo.updateOpsEvent(event.eventId, {
      fixRequirementId: REQ,
      updatedAt: '2026-11-05T09:10:00.000Z',
    })
    return event.eventId
  }

  it('retries a recheck that threw once without redeploying', async () => {
    seedEvent()
    let calls = 0
    const recheck = async (): Promise<void> => {
      calls += 1
      if (calls === 1) throw new Error('临时异常')
    }
    const build = buildStub()
    const { handoff, deployments } = makeHandoff(build, recheck)
    await handoff.tick()
    // 部署已核对，复核失败不抛出、不重复部署。
    expect(deployments.list()).toHaveLength(1)
    expect(deployments.list()[0]?.state).toBe('verified')
    expect(repo.deliveryStore.pendingRechecks(REQ)).toHaveLength(1)

    await handoff.tick()
    expect(calls).toBe(2)
    expect(repo.deliveryStore.pendingRechecks(REQ)).toHaveLength(0)
    expect(deployments.list()).toHaveLength(1)
  })

  it('does not redeploy and does not re-run a completed recheck', async () => {
    seedEvent()
    const build = buildStub()
    const { handoff, deployments, recheck } = makeHandoff(build)
    await handoff.tick()
    await handoff.tick()
    await handoff.tick()
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledTimes(1)
    expect(deployments.list()).toHaveLength(1)
  })

  it('keeps the recheck open for every event bound to the same fix requirement', async () => {
    seedEvent()
    const second = repo.createOpsEvent({
      eventId: 'ops-g3-b',
      project: 'testproj',
      checkId: 'check-2',
      resourceId: 'res-2',
      signature: 'sig-g3-b',
      title: 'slow',
      severity: 'minor',
      state: 'recovered',
      openedAt: '2026-11-05T09:00:00.000Z',
      updatedAt: '2026-11-05T09:00:00.000Z',
    })
    repo.updateOpsEvent(second.eventId, {
      fixRequirementId: REQ,
      updatedAt: '2026-11-05T09:10:00.000Z',
    })
    const build = buildStub()
    const { handoff, deployments, recheck } = makeHandoff(build)
    await handoff.tick()
    expect(recheck).toHaveBeenCalledTimes(2)
    expect(repo.deliveryStore.pendingRechecks(REQ)).toHaveLength(0)
    expect(deployments.list()).toHaveLength(1)
  })
})
