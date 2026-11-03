import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DevSessionRegistry } from '../src/runtime/dev-sessions.js'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import type { AgentSession } from '../src/runtime/agent-runner.js'
import type { Requirement } from '../src/domain/requirement.js'

const NOW = '2026-11-03T10:00:00.000Z'

let root = ''
let config: ForgeLoopConfig
let repo: Repository
let registry: DevSessionRegistry
let status = { exists: false, clean: true }
let prepareCalls = 0
let prepareFailure: Error | null = null
let prepareFailureCall = -1

function session(sessionId: string): AgentSession {
  return {
    sessionId,
    async send() {
      return {
        status: 'completed',
        text: '总结',
        sessionId,
        reason: '',
        transcriptPath: join(root, 'transcript.jsonl'),
        durationMs: 1,
        toolCalls: [],
      }
    },
    async close() {},
  }
}

function executionDev() {
  return {
    workspaceStatus: () => status,
    prepareDevWorkspace: () => {
      prepareCalls += 1
      if (prepareFailure !== null && prepareFailureCall === prepareCalls) throw prepareFailure
      return { baselineCommit: 'baseline-1', snapshotCommit: 'snapshot-1' }
    },
  }
}

function buildRegistry(
  openAgent?: (sessionId: string) => Promise<AgentSession>,
): DevSessionRegistry {
  return new DevSessionRegistry({
    config,
    repo,
    now: () => NOW,
    openAgent: openAgent ?? ((request) => Promise.resolve(session(request.sessionId))),
    executionDev: executionDev() as never,
  })
}

function submit(): string {
  repo.submit({
    reqId: 'req-1',
    project: 'demo',
    text: '实现一个改动',
    submittedBy: 'owner',
    source: 'test',
    now: NOW,
  })
  return 'req-1'
}

function bind(reqId: string, version: number, sessionId: string): void {
  repo.bindRequirementDevSession({
    reqId,
    requirementVersion: version,
    sessionId,
    workspace: join(root, 'workspace'),
    baselineCommit: 'baseline-1',
    snapshotCommit: 'snapshot-1',
    selectedBy: 'orchestrator',
    reason: '复用会话',
    now: NOW,
  })
}

function acquire(
  reqId: string,
  overrides: { selectedSessionId?: string | null; allowRebind?: boolean } = {},
) {
  return registry.acquire({
    reqId,
    requirementVersion: 1,
    selectedSessionId: overrides.selectedSessionId ?? null,
    selectionReason: '没有合适会话',
    selectedBy: 'orchestrator',
    requestId: 'request-1',
    signal: new AbortController().signal,
    allowRebind: overrides.allowRebind,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-registry-'))
  config = resolveConfig({
    project: 'demo',
    projectPath: root,
    recordsRoot: join(root, '.forgeloop'),
  })
  repo = new Repository(Database.open(join(root, 'records.sqlite')))
  registry = buildRegistry()
  status = { exists: false, clean: true }
  prepareCalls = 0
  prepareFailure = null
  prepareFailureCall = -1
})

afterEach(() => {
  repo.close()
  rmSync(root, { recursive: true, force: true })
})

describe('dev session registry edge paths', () => {
  it('tracks live sessions and releases an abandoned one without a summary', async () => {
    const reqId = submit()
    expect(registry.liveSession('missing')).toBeUndefined()
    const result = await acquire(reqId)
    expect(result.ok, result.ok ? '' : result.detail).toBe(true)
    if (!result.ok) return
    expect(registry.liveSession(result.sessionId)).toBeDefined()
    registry.release({ sessionId: result.sessionId })
    expect(repo.devSession(result.sessionId)?.leaseRequestId).toBe('')
  })

  it('reports an unavailable host instead of pretending to resume a session', async () => {
    const reqId = submit()
    repo.upsertDevSession({
      sessionId: 'session-old',
      project: 'demo',
      workspace: join(root, 'w'),
      now: NOW,
    })
    bind(reqId, 1, 'session-old')
    const result = await registry.acquire({
      reqId,
      requirementVersion: 1,
      selectedSessionId: 'session-old',
      selectionReason: '',
      selectedBy: 'orchestrator',
      requestId: 'r1',
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      ok: false,
      state: 'unavailable',
      detail: expect.stringContaining('宿主不支持恢复研发会话'),
    })
  })

  it('refuses to silently switch away from a missing bound session', async () => {
    const reqId = submit()
    bind(reqId, 1, 'session-missing')
    const result = await acquire(reqId)
    expect(result).toMatchObject({
      ok: false,
      state: 'unavailable',
      detail: expect.stringContaining('不能静默换会话'),
    })
  })

  it('rebinds to a fresh session when recovery is allowed', async () => {
    const reqId = submit()
    bind(reqId, 1, 'session-missing')
    const result = await acquire(reqId, { allowRebind: true })
    expect(result.ok, result.ok ? '' : result.detail).toBe(true)
    if (!result.ok) return
    expect(result.selectedBy).toBe('recovery')
    expect(result.reason).toContain('会话记录缺失')
  })

  it('clips a long recovery reason before storing the binding', async () => {
    const reqId = submit()
    repo.upsertDevSession({
      sessionId: 'session-broken',
      project: 'demo',
      workspace: join(root, 'w'),
      now: NOW,
    })
    bind(reqId, 1, 'session-broken')
    prepareFailure = new Error('x'.repeat(400))
    prepareFailureCall = 1
    const result = await acquire(reqId, { allowRebind: true })
    expect(result.ok, result.ok ? '' : result.detail).toBe(true)
    if (!result.ok) return
    expect(result.reason).toContain('…')
    expect(result.reason.length).toBeLessThan(500)
  })

  it('releases a fresh session when it cannot be leased', async () => {
    const reqId = submit()
    vi.spyOn(repo, 'leaseDevSession').mockReturnValueOnce(false)
    const result = await acquire(reqId)
    expect(result).toMatchObject({
      ok: false,
      state: 'unavailable',
      detail: expect.stringContaining('无法占用'),
    })
  })

  it('reports workspace preparation failures from a fresh session', async () => {
    const reqId = submit()
    prepareFailure = new Error('workspace unavailable')
    prepareFailureCall = 1
    const result = await acquire(reqId)
    expect(result).toMatchObject({
      ok: false,
      state: 'unavailable',
      detail: expect.stringContaining('workspace unavailable'),
    })
  })

  it('falls back to a deterministic summary when the model summary cannot be produced', async () => {
    const reqId = submit()
    repo.upsertDevSession({
      sessionId: 'session-summary',
      project: 'demo',
      workspace: join(root, 'w'),
      now: NOW,
    })
    const broken: AgentSession = {
      sessionId: 'session-summary',
      async send() {
        throw new Error('model down')
      },
      async close() {},
    }
    const requirement: Requirement = { reqId, versions: [] } as never
    const result = await registry.finish({
      reqId,
      requirementVersion: 1,
      sessionId: 'session-summary',
      session: broken,
      requirement,
      plan: null,
      outcome: '失败',
    })
    expect(result.source).toBe('fallback')
    expect(result.summary).toContain('（无标题）')
    expect(result.summary).toContain('本次未形成任务包')
    expect(result.summarySha256).toHaveLength(64)
  })

  it('names an empty plan in the fallback summary', async () => {
    const reqId = submit()
    repo.upsertDevSession({
      sessionId: 'session-summary',
      project: 'demo',
      workspace: join(root, 'w'),
      now: NOW,
    })
    const requirement = {
      reqId,
      versions: [{ version: 1, text: '', at: NOW }],
    } as never
    const result = await registry.finish({
      reqId,
      requirementVersion: 1,
      sessionId: 'session-summary',
      session: {
        sessionId: 'session-summary',
        async send() {
          throw new Error('model down')
        },
        async close() {},
      },
      requirement,
      plan: {
        taskPlanId: 'plan-1',
        requirementId: reqId,
        project: 'demo',
        planVersion: 1,
        requirementVersion: 1,
        tasks: [],
        createdAt: NOW,
      },
      outcome: '完成',
    })
    expect(result.summary).toContain('无任务')
  })
})
