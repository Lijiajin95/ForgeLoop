import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { SessionOrchestrator } from '../src/runtime/orchestrator.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import type { Requirement, RequirementAnalysis } from '../src/domain/requirement.js'

const NOW = '2026-11-02T10:00:00.000Z'

let root = ''
let repository: Repository

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-dev-sessions-'))
  repository = new Repository(Database.open(join(root, 'records.sqlite')))
})

afterEach(() => {
  repository.close()
  rmSync(root, { recursive: true, force: true })
})

function register(sessionId: string, workspace: string, project = 'forgeloop'): void {
  repository.upsertDevSession({ sessionId, project, workspace, now: NOW })
}

function bind(reqId: string, version: number, sessionId: string, workspace: string): void {
  repository.bindRequirementDevSession({
    reqId,
    requirementVersion: version,
    sessionId,
    workspace,
    baselineCommit: 'baseline-1',
    snapshotCommit: 'snapshot-1',
    selectedBy: 'orchestrator',
    reason: '同模块需求',
    now: NOW,
  })
}

describe('dev session records', () => {
  it('registers a session once and keeps its identity when the workspace moves', () => {
    register('session-a', '/tmp/workspace-a')
    expect(repository.devSession('session-a')).toMatchObject({
      sessionId: 'session-a',
      project: 'forgeloop',
      workspace: '/tmp/workspace-a',
      state: 'idle',
      createdAt: NOW,
    })
    expect(repository.devSession('session-missing')).toBeNull()

    register('session-a', '/tmp/workspace-b')
    const session = repository.devSession('session-a')
    expect(session?.workspace).toBe('/tmp/workspace-b')
    expect(session?.createdAt).toBe(NOW)
  })

  it('filters sessions by project and updates only the fields that were given', () => {
    register('session-a', '/tmp/a')
    register('session-a2', '/tmp/a2')
    repository.upsertDevSession({
      sessionId: 'session-b',
      project: 'other',
      workspace: '/tmp/b',
      now: NOW,
    })

    expect(
      repository
        .devSessions()
        .map((session) => session.sessionId)
        .sort(),
    ).toEqual(['session-a', 'session-a2', 'session-b'])
    expect(
      repository
        .devSessions('forgeloop')
        .map((session) => session.sessionId)
        .sort(),
    ).toEqual(['session-a', 'session-a2'])

    repository.updateDevSession('session-a', {
      lastReqId: 'req-1',
      summary: '本轮完成会话路由',
      summarySha256: 'sha-1',
      summaryPath: '/tmp/summary.md',
      updatedAt: NOW,
    })
    expect(repository.devSession('session-a')).toMatchObject({
      lastReqId: 'req-1',
      summary: '本轮完成会话路由',
      summarySha256: 'sha-1',
      summaryPath: '/tmp/summary.md',
      leaseRequestId: '',
    })
  })

  it('leases only an idle session and frees it on release or host restart', () => {
    register('session-a', '/tmp/a')

    expect(repository.leaseDevSession('session-a', 'request-1', NOW)).toBe(true)
    expect(repository.devSession('session-a')).toMatchObject({
      state: 'busy',
      leaseRequestId: 'request-1',
    })
    expect(repository.leaseDevSession('session-a', 'request-2', NOW)).toBe(false)

    repository.releaseDevSession('session-a', NOW)
    expect(repository.devSession('session-a')).toMatchObject({ state: 'idle', leaseRequestId: '' })

    expect(repository.leaseDevSession('session-a', 'request-3', NOW)).toBe(true)
    expect(repository.resetBusyDevSessions(NOW)).toBe(1)
    expect(repository.devSession('session-a')).toMatchObject({ state: 'idle', leaseRequestId: '' })
    expect(repository.resetBusyDevSessions(NOW)).toBe(0)
  })

  it('binds a requirement version to one session and keeps the previous baseline', () => {
    register('session-a', '/tmp/a')
    bind('req-1', 1, 'session-a', '/tmp/a')
    expect(repository.requirementDevSession('req-1', 1)).toMatchObject({
      sessionId: 'session-a',
      baselineCommit: 'baseline-1',
      snapshotCommit: 'snapshot-1',
      selectedBy: 'orchestrator',
      releasedAt: '',
    })
    expect(repository.requirementDevSession('req-1', 2)).toBeNull()

    repository.bindRequirementDevSession({
      reqId: 'req-1',
      requirementVersion: 1,
      sessionId: 'session-a',
      workspace: '/tmp/a-rebuilt',
      selectedBy: 'orchestrator',
      reason: '工作区重建',
      now: NOW,
    })
    expect(repository.requirementDevSession('req-1', 1)).toMatchObject({
      workspace: '/tmp/a-rebuilt',
      baselineCommit: 'baseline-1',
      reason: '工作区重建',
    })

    repository.releaseRequirementDevSession('req-1', 1, NOW)
    expect(repository.requirementDevSession('req-1', 1)?.releasedAt).toBe(NOW)
  })

  it('lists bindings per project and per session', () => {
    repository.submit({
      reqId: 'req-1',
      project: 'forgeloop',
      text: '把需求路由到既有研发会话',
      submittedBy: 'owner',
      source: 'dsh-session:owner',
      now: NOW,
    })
    repository.submit({
      reqId: 'req-2',
      project: 'other',
      text: '另一个项目的需求',
      submittedBy: 'owner',
      source: 'dsh-session:owner',
      now: NOW,
    })
    bind('req-1', 1, 'session-a', '/tmp/a')
    bind('req-2', 1, 'session-b', '/tmp/b')

    expect(
      repository
        .requirementDevSessions()
        .map((entry) => entry.reqId)
        .sort(),
    ).toEqual(['req-1', 'req-2'])
    expect(repository.requirementDevSessions('forgeloop').map((entry) => entry.reqId)).toEqual([
      'req-1',
    ])
  })

  it('keeps one summary per session and requirement, newest first', () => {
    repository.recordDevSessionSummary({
      sessionId: 'session-a',
      reqId: 'req-1',
      summary: '第一轮',
      summarySha256: 'sha-1',
      summaryPath: '/tmp/req-1.md',
      now: NOW,
    })
    repository.recordDevSessionSummary({
      sessionId: 'session-a',
      reqId: 'req-2',
      summary: '第二轮',
      summarySha256: 'sha-2',
      summaryPath: '/tmp/req-2.md',
      now: '2026-11-02T11:00:00.000Z',
    })
    expect(repository.devSessionSummary('session-a', 'req-3')).toBeNull()

    repository.recordDevSessionSummary({
      sessionId: 'session-a',
      reqId: 'req-1',
      summary: '第一轮（补充）',
      summarySha256: 'sha-1b',
      summaryPath: '/tmp/req-1b.md',
      now: NOW,
    })
    expect(repository.devSessionSummary('session-a', 'req-1')?.summary).toBe('第一轮（补充）')
    expect(repository.devSessionSummaries('session-a')).toHaveLength(2)
    expect(repository.latestDevSessionSummary('session-a')?.reqId).toBe('req-2')
    expect(repository.latestDevSessionSummary('session-missing')).toBeNull()
  })
})

describe('orchestrator session routing', () => {
  const requirement: Requirement = {
    reqId: 'req-1',
    project: 'forgeloop',
    status: 'specified',
    blockedReason: '',
    versions: [
      {
        version: 1,
        text: '把新需求交给最合适的研发会话',
        createdAt: NOW,
        revisedBy: 'owner',
        source: 'dsh-session:owner',
      },
    ],
    submittedBy: 'owner',
    source: 'dsh-session:owner',
  }
  const analysis: RequirementAnalysis = {
    analysisVersion: 1,
    requirementVersion: 1,
    goal: '新需求走既有研发会话',
    scenarios: ['会话空闲时直接执行'],
    acceptanceCriteria: ['需求与会话 ID 绑定'],
    clarifications: [],
    createdAt: NOW,
  }

  function orchestrator(
    run: (request: AgentRunRequest) => Promise<AgentRunResult>,
    projectPath = root,
  ) {
    return new SessionOrchestrator({
      config: resolveConfig(
        {
          project: 'forgeloop',
          projectPath,
          recordsRoot: join(projectPath, '.forgeloop'),
          agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
        },
        projectPath,
      ),
      repo: repository,
      run,
    })
  }

  function runResult(text: string, status: AgentRunResult['status'] = 'completed') {
    return async (): Promise<AgentRunResult> => ({
      status,
      text,
      sessionId: 'session-orchestrator',
      reason: status === 'completed' ? '' : '模型失败',
      transcriptPath: '/tmp/orchestrator.jsonl',
      durationMs: 1,
      toolCalls: [],
    })
  }

  function withSession(sessionId: string): string {
    const workspace = join(root, sessionId)
    mkdirSync(join(workspace, '.git'), { recursive: true })
    register(sessionId, workspace)
    return workspace
  }

  it('creates a new session without calling a model when nothing can be reused', async () => {
    let called = 0
    const choice = await orchestrator(async () => {
      called += 1
      return (await runResult('{}')()) as AgentRunResult
    }).choose({ requirement, analysis, signal: new AbortController().signal })

    expect(choice).toMatchObject({ sessionId: null, source: 'fallback' })
    expect(called).toBe(0)
  })

  it('ignores sessions whose workspace has no Git metadata', async () => {
    register('session-broken', join(root, 'gone'))
    const choice = await orchestrator(runResult('{}')).choose({
      requirement,
      analysis,
      signal: new AbortController().signal,
    })

    expect(choice.sessionId).toBeNull()
    expect(choice.source).toBe('fallback')
  })

  it('routes to the session the model picked and keeps its reason', async () => {
    withSession('session-a')
    withSession('session-b')
    const choice = await orchestrator(
      runResult(JSON.stringify({ session_id: 'session-b', reason: '同属会话模块' })),
    ).choose({ requirement, analysis, signal: new AbortController().signal })

    expect(choice).toMatchObject({
      sessionId: 'session-b',
      reason: '同属会话模块',
      source: 'model',
    })
  })

  it('falls back to a new session for an unknown or malformed answer', async () => {
    withSession('session-a')
    for (const text of [
      JSON.stringify({ session_id: 'session-unknown', reason: '猜的' }),
      '不是一个对象',
    ]) {
      const choice = await orchestrator(runResult(text)).choose({
        requirement,
        analysis,
        signal: new AbortController().signal,
      })
      expect(choice.sessionId).toBeNull()
      expect(choice.source).toBe('fallback')
    }
  })

  it('accepts the model deciding that no existing session fits', async () => {
    withSession('session-a')
    const choice = await orchestrator(
      runResult(JSON.stringify({ session_id: '', reason: '没有合适的会话' })),
    ).choose({ requirement, analysis, signal: new AbortController().signal })

    expect(choice).toMatchObject({ sessionId: null, reason: '没有合适的会话', source: 'model' })
  })

  it('offers the other candidates as fallbacks for the chosen session', async () => {
    withSession('session-a')
    withSession('session-b')
    const choice = await orchestrator(
      runResult(JSON.stringify({ session_id: 'session-b', reason: '同属会话模块' })),
    ).choose({ requirement, analysis, signal: new AbortController().signal })

    expect(choice.alternatives).toContain('session-a')
    expect(choice.alternatives).not.toContain('session-b')
  })

  it('caps the candidate list and the summary length it feeds the model', async () => {
    for (let index = 0; index < 25; index += 1) {
      withSession(`session-${index}`)
    }
    repository.recordDevSessionSummary({
      sessionId: 'session-0',
      reqId: 'req-old',
      summary: 'x'.repeat(5_000),
      summarySha256: 'sha-old',
      summaryPath: '/tmp/old.md',
      now: NOW,
    })
    let prompt = ''
    const choice = await orchestrator(async (request) => {
      prompt = request.prompt
      return runResult(JSON.stringify({ session_id: 'session-1', reason: '最近的会话' }))()
    }).choose({ requirement, analysis, signal: new AbortController().signal })

    expect(choice.sessionId).toBe('session-1')
    expect(choice.alternatives).toHaveLength(19)
    expect(prompt.match(/- 会话 /g)?.length).toBe(20)
    expect(prompt.length).toBeLessThan(20_000)
  })

  it('drops the routing result when the request was stopped while the model ran', async () => {
    withSession('session-a')
    const controller = new AbortController()
    const choice = await orchestrator(async () => {
      controller.abort()
      return runResult(JSON.stringify({ session_id: 'session-a', reason: '复用' }))()
    }).choose({ requirement, analysis, signal: controller.signal })

    expect(choice.sessionId).toBeNull()
    expect(choice.reason).toContain('停止请求')
    expect(choice.alternatives).toEqual([])
  })

  it('falls back when the model fails, times out or the request is already stopped', async () => {
    withSession('session-a')
    const failed = await orchestrator(runResult('', 'error')).choose({
      requirement,
      analysis,
      signal: new AbortController().signal,
    })
    expect(failed.sessionId).toBeNull()

    const thrown = await orchestrator(async () => {
      throw new Error('模型不可用')
    }).choose({ requirement, analysis, signal: new AbortController().signal })
    expect(thrown.reason).toContain('模型不可用')

    const controller = new AbortController()
    controller.abort()
    const stopped = await orchestrator(runResult('{}')).choose({
      requirement,
      analysis,
      signal: controller.signal,
    })
    expect(stopped.reason).toContain('停止请求')
  })
})
