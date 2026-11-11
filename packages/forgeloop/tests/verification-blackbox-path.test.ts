import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import { VerificationPipeline } from '../src/runtime/verification-pipeline.js'
import type { Repository } from '../src/records/repository.js'
import type { Requirement, RequirementAnalysis } from '../src/domain/requirement.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import type {
  LegacyVerificationSession,
  LegacyVerifyInput,
} from '../src/runtime/legacy-verification.js'

/**
 * 黑盒验证路径（ADR 0012 选项 A）：显式 verify 把已交付候选交给连续推进的受限测试会话。
 * 这里固定三件事：结果翻译（pass/block/repair）、失败关闭（打不开会话即阻断），
 * 以及交给 legacy 的候选身份（候选已烘焙进 snapshotCommit，补丁为空）。
 */

let root = ''
let projectPath = ''

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

const requirement = {
  reqId: 'req-blackbox',
  project: 'demo',
  versions: [
    {
      version: 1,
      text: '黑盒验证',
      submittedBy: 'owner',
      source: 'test',
      at: '2026-11-11T00:00:00.000Z',
    },
  ],
} as unknown as Requirement

const analysis = {
  reqId: 'req-blackbox',
  requirementVersion: 1,
  clarifications: [],
} as unknown as RequirementAnalysis

const plan = {
  taskPlanId: 'plan-1',
  requirementId: 'req-blackbox',
  project: 'demo',
  planVersion: 1,
  requirementVersion: 1,
  createdAt: '2026-11-11T00:00:00.000Z',
  tasks: [],
} as unknown as TaskPlan

interface Harness {
  pipeline: VerificationPipeline
  opened: LegacyVerificationSession[]
  received: LegacyVerifyInput[]
  statuses: string[]
}

function harness(
  outcome:
    | { ok: true; state?: 'pass' | 'block'; repairRecommended?: boolean }
    | { ok: false; detail: string },
): Harness {
  const opened: LegacyVerificationSession[] = []
  const received: LegacyVerifyInput[] = []
  const statuses: string[] = []
  const repo = {
    getRequirement: () => requirement,
    latestAnalysis: () => analysis,
    taskArtifacts: () => [],
    planReview: () => ({
      verdict: 'pass',
      reportJson: JSON.stringify({
        verdict: 'pass',
        blocking: [],
        findings: [],
        summary: 'ok',
        verification_plan: [
          {
            scenario: '黑盒场景',
            acceptance_criterion: '通过',
            method: '命令',
            required: true,
          },
        ],
      }),
    }),
    verificationAttemptsForCandidate: () => [],
    ensureBudget: () => undefined,
    budget: () => ({ limitSeconds: -1, consumedSeconds: 0, extensions: [] }),
    setStatus: (_reqId: string, status: string) => {
      statuses.push(status)
    },
    nextVerificationAttempt: () => ({ attemptNumber: 1, previousAttemptId: '' }),
  } as unknown as Repository
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath,
      recordsRoot: join(root, 'records'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
    },
    root,
  )
  const pipeline = new VerificationPipeline({
    config,
    repo,
    now: () => '2026-11-11T00:00:00.000Z',
    charge: () => undefined,
    runner: {
      run: () => {
        throw new Error('黑盒路径不应启动默认工具面的 Agent')
      },
    },
    formalTest: () => {
      throw new Error('黑盒路径的命令由 legacy 注册表执行')
    },
    ctx: {},
    openAgent: () => {
      throw new Error('黑盒路径不应打开多轮研发会话')
    },
    candidateIdentity: () => 'candidate-blackbox',
    requireAuthorizedPlan: () => ({ ok: true, value: { plan } }),
    applyDiffFile: () => ({ ok: true, detail: '' }),
    reopenDeliveredTasks: () => [],
    verificationBaseline: () => {
      throw new Error('黑盒路径不重新计算验证基线')
    },
    remainingFailureRounds: () => 3,
    openBlackBoxSession: async () => {
      if (!outcome.ok) {
        return {
          ok: false as const,
          result: { state: 'block' as const, detail: outcome.detail, blocking: [outcome.detail] },
        }
      }
      const session: LegacyVerificationSession = {
        session: {} as LegacyVerificationSession['session'],
        sessionId: 'verify-session',
        plan: { scenarios: [] },
        close: async () => undefined,
      }
      opened.push(session)
      return { ok: true as const, value: session }
    },
    verifyCandidateBlackBox: async (input) => {
      received.push(input)
      return {
        state: outcome.ok && outcome.state === 'block' ? 'block' : 'pass',
        detail: '黑盒验证结论',
        blocking: outcome.ok && outcome.state === 'block' ? ['候选未满足需求'] : [],
        repairRecommended: outcome.ok ? outcome.repairRecommended : undefined,
      }
    },
  })
  return { pipeline, opened, received, statuses }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-blackbox-'))
  projectPath = join(root, 'project')
  mkdirSync(projectPath, { recursive: true })
  writeFileSync(join(projectPath, 'README.md'), 'fixture\n', 'utf8')
  git(['init', '-q'], projectPath)
  git(['config', 'user.email', 'forgeloop@localhost'], projectPath)
  git(['config', 'user.name', 'ForgeLoop Test'], projectPath)
  git(['add', '-A'], projectPath)
  git(['commit', '-qm', 'baseline'], projectPath)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('black box verification path', () => {
  it('hands the delivered candidate to the restricted session and reports success', async () => {
    const { pipeline, opened, received } = harness({ ok: true })
    const outcome = await pipeline.executeVerificationBlackBox(
      'req-blackbox',
      new AbortController().signal,
    )
    expect(outcome).toEqual({ state: 'done', detail: '黑盒验证结论' })
    expect(opened).toHaveLength(1)
    expect(opened[0]!.plan.scenarios).toEqual([])
    expect(received).toHaveLength(1)
    // 候选已经包含在 snapshotCommit 里，补丁必须为空，避免二次应用。
    expect(received[0]!.candidate.diffSha256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(received[0]!.candidate.snapshotCommit).toBe(
      git(['rev-parse', 'HEAD'], received[0]!.devWorkspace),
    )
    expect(received[0]!.candidate.candidateSha256).toBe('candidate-blackbox')
  })

  it('maps a repairable block back to development and an unrepairable one to failure', async () => {
    const repairable = harness({ ok: true, state: 'block', repairRecommended: true })
    expect(
      await repairable.pipeline.executeVerificationBlackBox(
        'req-blackbox',
        new AbortController().signal,
      ),
    ).toMatchObject({ state: 'repair' })
    expect(repairable.opened[0]).toBeDefined()

    const blocked = harness({ ok: true, state: 'block', repairRecommended: false })
    expect(
      await blocked.pipeline.executeVerificationBlackBox(
        'req-blackbox',
        new AbortController().signal,
      ),
    ).toMatchObject({ state: 'failed' })
  })

  it('fails closed when the restricted session cannot be opened', async () => {
    const { pipeline, statuses, received } = harness({
      ok: false,
      detail: '宿主未提供工具限制服务',
    })
    const outcome = await pipeline.executeVerificationBlackBox(
      'req-blackbox',
      new AbortController().signal,
    )
    expect(outcome).toEqual({ state: 'failed', detail: '宿主未提供工具限制服务' })
    expect(statuses).toContain('blocked')
    expect(received).toHaveLength(0)
  })
})
