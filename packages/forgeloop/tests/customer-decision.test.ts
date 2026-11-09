import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, type RawConfig } from '../src/config.js'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { createBoardFetch } from '../src/runtime/board-route.js'
import type { Coordinator } from '../src/runtime/coordinator.js'

/**
 * 客户决定入口的行为测试：只走公共入口（运行时方法 + 已认证看板路由），
 * 验证伪造来源、错误身份、过期决定与跨需求复用都被拒绝；合法修订/替代推进准入，
 * 拒绝新需求保留阻断理由，普通无冲突需求继续自动准入。
 */

const OWNER = 'owner'
let dir = ''
let runtime: ForgeLoopRuntime

const conflict = {
  existingReqId: 'req-old',
  commitment: '旧承诺：统一入口',
  conflict: '共享入口',
  options: ['保留旧承诺', '替换'],
  decisionNeeded: '请所有者选择保留还是替换',
}

function config(overrides: Partial<RawConfig> = {}): RawConfig {
  return {
    project: 'demo',
    projectPath: dir,
    recordsRoot: join(dir, '.forgeloop'),
    owner: OWNER,
    pollSeconds: 1,
    autonomy: { enabled: true, allowCodeCommit: true, allowAnySource: false, requireOwner: true },
    ...overrides,
  }
}

function makeRuntime(overrides: Partial<RawConfig> = {}): ForgeLoopRuntime {
  return new ForgeLoopRuntime({ ctx: {}, config: resolveConfig(config(overrides), dir) })
}

function submitAndAnalyze(
  reqId: string,
  conflicts: readonly (typeof conflict)[] = [conflict],
): void {
  runtime.repo.submit({
    reqId,
    project: 'demo',
    text: '实现共享入口的新需求',
    submittedBy: OWNER,
    source: 'dsh-session:s1',
    now: '2026-11-09T00:00:00.000Z',
  })
  runtime.repo.recordAnalysis({
    reqId,
    analysisVersion: 1,
    requirementVersion: 1,
    goal: '目标',
    scenarios: ['场景'],
    acceptanceCriteria: ['验收'],
    clarifications: [],
    conflicts: [...conflicts],
    createdAt: '2026-11-09T00:01:00.000Z',
  })
}

function boardFetch(): (request: Request) => Promise<Response> {
  return createBoardFetch(runtime, runtime.config, {} as Coordinator)
}

async function post(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await boardFetch()(
    new Request('http://127.0.0.1/api/forgeloop/board', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}

function admissionCode(reqId: string): { code: string; reason: string } {
  // 通过公共只读入口观察准入结论，而不是复制领域计算。
  const decision = runtime.admissionDecision(reqId)
  expect(decision).toBeTruthy()
  return { code: decision?.code ?? '', reason: decision?.reason ?? '' }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-customer-decision-'))
  runtime = makeRuntime()
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('customer decision entry', () => {
  it('records a trusted decision through the authenticated board route', async () => {
    submitAndAnalyze('req-new')
    const response = await post({
      endpoint: 'resolve-commitment',
      reqId: 'req-new',
      existingReqId: 'req-old',
      decision: 'replace',
      reason: '所有者选择替换旧承诺',
      sessionId: 'session-customer',
    })
    expect(response.status).toBe(200)
    const decisionId = response.body.value.decisionId as string
    expect(decisionId).toMatch(/^cd-/)
    const recorded = runtime.repo.commitments.customerDecision(decisionId)
    expect(recorded).toMatchObject({
      reqId: 'req-new',
      requirementVersion: 1,
      existingReqId: 'req-old',
      decision: 'replace',
      decidedBy: OWNER,
      decisionSource: 'web-decision:session-customer:commitment-replace',
    })
    expect(admissionCode('req-new').code).toBe('admitted')
  })

  it('rejects a decision for a requirement without that commitment conflict', async () => {
    submitAndAnalyze('req-new')
    const response = await post({
      endpoint: 'resolve-commitment',
      reqId: 'req-new',
      existingReqId: 'req-unknown',
      decision: 'replace',
      reason: '不存在的承诺',
    })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('commitment_not_found')
  })

  it('rejects a forged source that is not the authenticated customer channel', () => {
    submitAndAnalyze('req-new')
    const forged = runtime.resolveCommitment({
      reqId: 'req-new',
      existingReqId: 'req-old',
      decision: 'replace',
      reason: '模型自己决定',
      by: OWNER,
      source: 'agent:model',
    })
    expect(forged).toMatchObject({ ok: false, code: 'untrusted_source' })
    expect(admissionCode('req-new').code).toBe('commitment_conflict')
  })

  it('rejects a wrong identity even when the source looks trusted', () => {
    submitAndAnalyze('req-new')
    const wrong = runtime.resolveCommitment({
      reqId: 'req-new',
      existingReqId: 'req-old',
      decision: 'replace',
      reason: '不是所有者',
      by: 'intruder',
      source: 'web-decision:intruder:commitment-replace',
    })
    expect(wrong).toMatchObject({ ok: false, code: 'identity_mismatch' })
    expect(runtime.repo.commitments.customerDecisions('req-new')).toEqual([])
    expect(admissionCode('req-new').code).toBe('commitment_conflict')
  })

  it('rejects a decision reused after the requirement version moved on', () => {
    submitAndAnalyze('req-new')
    const first = runtime.resolveCommitment({
      reqId: 'req-new',
      existingReqId: 'req-old',
      decision: 'replace',
      reason: '第一次决定',
      by: OWNER,
      source: 'web-decision:s1:commitment-replace',
    })
    expect(first.ok).toBe(true)
    const decisionId = (first.data as { decisionId: string }).decisionId
    runtime.revise({
      reqId: 'req-new',
      text: '需求修订：范围扩大',
      by: OWNER,
      source: 'web-decision:s1:revise',
    })
    const reused = runtime.resolveCommitment({
      reqId: 'req-new',
      existingReqId: 'req-old',
      decision: 'replace',
      reason: '复用旧决定',
      by: OWNER,
      source: 'web-decision:s1:commitment-replace',
      decisionId,
    })
    expect(reused).toMatchObject({ ok: false, code: 'decision_expired' })
    // 新版本重新分析后，准入按当前版本判定：旧决定带出的解除依据已过期。
    runtime.repo.recordAnalysis({
      reqId: 'req-new',
      analysisVersion: 2,
      requirementVersion: 2,
      goal: '目标',
      scenarios: ['场景'],
      acceptanceCriteria: ['验收'],
      clarifications: [],
      conflicts: [conflict],
      createdAt: '2026-11-09T00:05:00.000Z',
    })
    const admission = admissionCode('req-new')
    expect(admission.code).toBe('commitment_conflict')
    expect(admission.reason).toContain('已过期')
  })

  it('rejects reusing a decision recorded for another requirement', () => {
    submitAndAnalyze('req-new')
    submitAndAnalyze('req-other')
    const other = runtime.resolveCommitment({
      reqId: 'req-other',
      existingReqId: 'req-old',
      decision: 'replace',
      reason: '另一个需求的决定',
      by: OWNER,
      source: 'web-decision:s2:commitment-replace',
    })
    expect(other.ok).toBe(true)
    const decisionId = (other.data as { decisionId: string }).decisionId
    const reused = runtime.resolveCommitment({
      reqId: 'req-new',
      existingReqId: 'req-old',
      decision: 'replace',
      reason: '跨需求复用',
      by: OWNER,
      source: 'web-decision:s1:commitment-replace',
      decisionId,
    })
    expect(reused).toMatchObject({ ok: false, code: 'decision_cross_requirement' })
  })

  it('keeps the blocking reason when the customer rejects the new requirement', async () => {
    submitAndAnalyze('req-new')
    const response = await post({
      endpoint: 'resolve-commitment',
      reqId: 'req-new',
      existingReqId: 'req-old',
      decision: 'reject',
      reason: '与旧承诺冲突且不再需要',
    })
    expect(response.status).toBe(200)
    expect(runtime.repo.getRequirement('req-new')?.status).toBe('rejected')
    expect(runtime.repo.getRequirement('req-new')?.blockedReason).toContain(
      '客户决定拒绝：与旧承诺冲突且不再需要',
    )
  })

  it('rejects a decision for an unknown requirement or a terminal one', () => {
    expect(
      runtime.resolveCommitment({
        reqId: 'req-missing',
        existingReqId: 'req-old',
        decision: 'replace',
        reason: '不存在',
        by: OWNER,
        source: 'web-decision:s1:commitment-replace',
      }),
    ).toMatchObject({ ok: false, code: 'not_found' })
    expect(runtime.admissionDecision('req-missing')).toBeNull()

    submitAndAnalyze('req-terminal')
    runtime.cancel({ reqId: 'req-terminal', by: OWNER, reason: '终态' })
    expect(
      runtime.resolveCommitment({
        reqId: 'req-terminal',
        existingReqId: 'req-old',
        decision: 'replace',
        reason: '终态需求',
        by: OWNER,
        source: 'web-decision:s1:commitment-replace',
      }),
    ).toMatchObject({ ok: false, code: 'terminal' })
  })

  it('requires a reason and a known commitment conflict', () => {
    submitAndAnalyze('req-new')
    expect(
      runtime.resolveCommitment({
        reqId: 'req-new',
        existingReqId: 'req-old',
        decision: 'revise',
        reason: '   ',
        by: OWNER,
        source: 'web-decision:s1:commitment-revise',
      }),
    ).toMatchObject({ ok: false, code: 'reason_required' })
    expect(
      runtime.resolveCommitment({
        reqId: 'req-new',
        existingReqId: 'req-unknown',
        decision: 'revise',
        reason: '不存在的承诺',
        by: OWNER,
        source: 'web-decision:s1:commitment-revise',
      }),
    ).toMatchObject({ ok: false, code: 'commitment_not_found' })
  })

  it('reuses a recorded decision only when commitment and decision agree', () => {
    submitAndAnalyze('req-new')
    const first = runtime.resolveCommitment({
      reqId: 'req-new',
      existingReqId: 'req-old',
      decision: 'replace',
      reason: '第一次决定',
      by: OWNER,
      source: 'web-decision:s1:commitment-replace',
    })
    const decisionId = (first.data as { decisionId: string }).decisionId
    expect(
      runtime.resolveCommitment({
        reqId: 'req-new',
        existingReqId: 'req-old',
        decision: 'replace',
        reason: '复用同一条',
        by: OWNER,
        source: 'web-decision:s1:commitment-replace',
        decisionId,
      }),
    ).toMatchObject({ ok: true })
    expect(
      runtime.resolveCommitment({
        reqId: 'req-new',
        existingReqId: 'req-other-commitment',
        decision: 'replace',
        reason: '承诺不一致',
        by: OWNER,
        source: 'web-decision:s1:commitment-replace',
        decisionId,
      }),
    ).toMatchObject({ ok: false, code: 'decision_commitment_mismatch' })
    expect(
      runtime.resolveCommitment({
        reqId: 'req-new',
        existingReqId: 'req-old',
        decision: 'revise',
        reason: '方式不一致',
        by: OWNER,
        source: 'web-decision:s1:commitment-revise',
        decisionId,
      }),
    ).toMatchObject({ ok: false, code: 'decision_mismatch' })
    expect(
      runtime.resolveCommitment({
        reqId: 'req-new',
        existingReqId: 'req-old',
        decision: 'replace',
        reason: '编号不存在',
        by: OWNER,
        source: 'web-decision:s1:commitment-replace',
        decisionId: 'cd-missing',
      }),
    ).toMatchObject({ ok: false, code: 'decision_not_found' })
  })

  it('refuses to reuse a stored decision recorded by another identity', () => {
    submitAndAnalyze('req-new')
    const stored = runtime.repo.commitments.recordCustomerDecision({
      reqId: 'req-new',
      requirementVersion: 1,
      existingReqId: 'req-old',
      decision: 'replace',
      decidedBy: 'intruder',
      decisionSource: 'web-decision:intruder:commitment-replace',
      reason: '伪造身份写入',
      decidedAt: '2026-11-09T00:02:00.000Z',
    })
    expect(
      runtime.resolveCommitment({
        reqId: 'req-new',
        existingReqId: 'req-old',
        decision: 'replace',
        reason: '复用他人决定',
        by: OWNER,
        source: 'web-decision:s1:commitment-replace',
        decisionId: stored.decisionId,
      }),
    ).toMatchObject({ ok: false, code: 'identity_mismatch' })
  })

  it('names the empty identity and source explicitly in refusals', () => {
    submitAndAnalyze('req-new')
    const noIdentity = runtime.resolveCommitment({
      reqId: 'req-new',
      existingReqId: 'req-old',
      decision: 'replace',
      reason: '空身份',
      by: '',
      source: 'web-decision:s1:commitment-replace',
    })
    expect(noIdentity).toMatchObject({ ok: false, code: 'identity_mismatch' })
    expect(noIdentity.message).toContain('（空）')
    const noSource = runtime.resolveCommitment({
      reqId: 'req-new',
      existingReqId: 'req-old',
      decision: 'replace',
      reason: '空来源',
      by: OWNER,
      source: '',
    })
    expect(noSource).toMatchObject({ ok: false, code: 'untrusted_source' })
    expect(noSource.message).toContain('（空）')

    const stored = runtime.repo.commitments.recordCustomerDecision({
      reqId: 'req-new',
      requirementVersion: 1,
      existingReqId: 'req-old',
      decision: 'replace',
      decidedBy: '',
      decisionSource: 'web-decision:s1:commitment-replace',
      reason: '空身份写入',
      decidedAt: '2026-11-09T00:03:00.000Z',
    })
    const reused = runtime.resolveCommitment({
      reqId: 'req-new',
      existingReqId: 'req-old',
      decision: 'replace',
      reason: '复用空身份决定',
      by: OWNER,
      source: 'web-decision:s1:commitment-replace',
      decisionId: stored.decisionId,
    })
    expect(reused).toMatchObject({ ok: false, code: 'identity_mismatch' })
    expect(reused.message).toContain('（空）')
  })

  it('blocks a requirement whose analysis is missing', () => {
    runtime.repo.submit({
      reqId: 'req-bare',
      project: 'demo',
      text: '还没有分析的需求',
      submittedBy: OWNER,
      source: 'dsh-session:s1',
      now: '2026-11-09T00:00:00.000Z',
    })
    expect(runtime.admissionDecision('req-bare')?.code).toBe('analysis_required')
  })

  it('keeps an ordinary requirement on the automatic admission path', () => {
    submitAndAnalyze('req-plain', [])
    expect(admissionCode('req-plain')).toMatchObject({ code: 'admitted' })
    expect(runtime.admissionDecision('req-plain')?.admit).toBe(true)
  })
})
