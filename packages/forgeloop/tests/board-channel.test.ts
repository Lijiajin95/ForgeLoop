import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/index.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { sha256OfText } from '../src/domain/delivery.js'

/**
 * 插件装配测试：用假宿主验证 apply 真的把只读看板挂到 Connection 的认证 Fetch 路由上。
 * 这里不启动 DSH，也不访问浏览器；它固定的是 Web 页面的宿主半接线：
 * 路由路径、方法、请求体模式与应答形状。
 */

interface RegisteredRoute {
  path: string
  methods: string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-route-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fakeAgent(text: string) {
  return {
    create: async () => ({
      agent: {
        id: 'session-fake-agent',
        session: {
          ownEvents: () => [
            {
              type: 'assistant/message',
              seq: 1,
              time: 0,
              data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
            },
            { type: 'turn/end', seq: 2, time: 0, data: { reason: { kind: 'completed' } } },
          ],
        },
        followup: () => undefined,
        whenIdle: async () => undefined,
        cancel: () => undefined,
      },
      dispose: async () => undefined,
    }),
  }
}

function fakeHost(options: { withFetch?: boolean; agentText?: string } = {}) {
  const routes: RegisteredRoute[] = []
  let injected = false
  let disposed = false
  let cleanup: (() => unknown) | undefined
  const ctx = {
    agents: options.agentText ? fakeAgent(options.agentText) : {},
    agentLoop: {},
    tools: { register: () => () => {} },
    effect(callback: () => unknown) {
      cleanup = callback() as () => unknown
      return () => {}
    },
    inject(dependencies: string[], callback: (scope: unknown) => void) {
      injected = true
      expect(dependencies).toEqual(['connection'])
      callback({
        connection:
          options.withFetch === false
            ? {}
            : {
                fetch: {
                  register: (route: RegisteredRoute) => {
                    routes.push(route)
                    return async () => {
                      disposed = true
                    }
                  },
                },
              },
        effect: (fn: () => () => void) => {
          fn()
          return () => {}
        },
      })
    },
  }
  return {
    ctx,
    routes,
    injected: () => injected,
    disposed: () => disposed,
    cleanup: () => cleanup?.(),
  }
}

function start(host: ReturnType<typeof fakeHost>) {
  apply(host.ctx as never, {
    recordsRoot: join(dir, '.forgeloop'),
    project: 'testproj',
    projectPath: dir,
    agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
  })
}

function seedRequirement(reqId: string): void {
  const database = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
  const repository = new Repository(database)
  repository.submit({
    reqId,
    project: 'testproj',
    text: '看板需求详情',
    submittedBy: 'owner',
    source: 'test',
    now: '2026-10-23T00:00:00.000Z',
  })
  repository.close()
}

function post(body: string): Request {
  return new Request('http://127.0.0.1:1234/api/forgeloop/board', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

/** 计划评审通过是批准的硬门禁：路由测试必须先写入可核对的评审证据。 */
function seedPlanReview(repository: Repository, reqId: string, planVersion = 1): void {
  const stored = repository.taskPlan(reqId, planVersion)!
  const planSha256 = sha256OfText(JSON.stringify(stored))
  const review = {
    kind: 'plan-review',
    reqId,
    planVersion,
    requirementVersion: stored.requirementVersion,
    planSha256,
    verdict: 'pass',
    blocking: [],
    findings: [],
    summary: '任务包可进入实现',
    verification_plan: [
      {
        scenario: 'a 先改文档',
        acceptance_criterion: 'a 完成',
        method: '在独立候选上执行正式测试',
        required: true,
      },
    ],
    sessionId: 'session-plan-review',
    at: '2026-10-23T00:00:02.000Z',
  }
  const reportJson = `${JSON.stringify(review, null, 2)}\n`
  const reportPath = join(dir, 'reviews', reqId, `v${planVersion}`, 'plan', 'plan-review.json')
  mkdirSync(join(dir, 'reviews', reqId, `v${planVersion}`, 'plan'), { recursive: true })
  writeFileSync(reportPath, reportJson, 'utf8')
  repository.recordPlanReview({
    requirementId: reqId,
    planVersion,
    requirementVersion: stored.requirementVersion,
    planSha256,
    verdict: 'pass',
    reportJson,
    reportPath,
    reportSha256: sha256OfText(reportJson),
    sessionId: review.sessionId,
    reviewedAt: review.at,
  })
}

describe('web board host wiring', () => {
  it('registers an authenticated POST route for the read-only board', async () => {
    const host = fakeHost()
    start(host)
    expect(host.injected()).toBe(true)
    expect(host.routes).toHaveLength(1)
    const route = host.routes[0]!
    expect(route.path).toBe('/api/forgeloop/board')
    expect(route.methods).toEqual(['POST'])
    expect(route.requestBody).toBe('buffered')

    const response = await route.fetch(post(JSON.stringify({ endpoint: 'board' })))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      ok: boolean
      value: { project: string; requirements: unknown[]; tasks: unknown[]; issues: unknown[] }
    }
    expect(payload.ok).toBe(true)
    expect(payload.value.project).toBe('testproj')
    expect(payload.value.requirements).toEqual([])
    expect(payload.value.tasks).toEqual([])
    expect(payload.value.issues).toEqual([])

    await host.cleanup()
  })

  it('answers only the board endpoint and rejects other bodies explicitly', async () => {
    const host = fakeHost()
    start(host)
    const route = host.routes[0]!

    const unknown = await route.fetch(post(JSON.stringify({ endpoint: 'nope' })))
    expect(unknown.status).toBe(404)
    const unknownBody = (await unknown.json()) as { ok: boolean; error: { code: string } }
    expect(unknownBody.ok).toBe(false)
    expect(unknownBody.error.code).toBe('not_found')

    const malformed = await route.fetch(post('not json'))
    expect(malformed.status).toBe(400)
    const malformedBody = (await malformed.json()) as { error: { code: string } }
    expect(malformedBody.error.code).toBe('bad_request')

    await host.cleanup()
  })

  it('serves one requirement detail and rejects unknown identities', async () => {
    seedRequirement('req-detail-1')
    const host = fakeHost()
    start(host)
    const route = host.routes[0]!

    const found = await route.fetch(post(JSON.stringify({ endpoint: 'detail', reqId: 'req-detail-1' })))
    expect(found.status).toBe(200)
    const foundBody = (await found.json()) as {
      ok: boolean
      value: { reqId: string; status: string; analysis: unknown }
    }
    expect(foundBody.ok).toBe(true)
    expect(foundBody.value.reqId).toBe('req-detail-1')
    expect(foundBody.value.status).toBe('draft')
    expect(foundBody.value.analysis).toBeNull()

    const badTask = await route.fetch(post(JSON.stringify({ endpoint: 'task', reqId: 'req-detail-1' })))
    expect(badTask.status).toBe(400)
    const missingTask = await route.fetch(
      post(JSON.stringify({ endpoint: 'task', reqId: 'req-detail-1', taskId: 'a' })),
    )
    expect(missingTask.status).toBe(404)

    const missingId = await route.fetch(post(JSON.stringify({ endpoint: 'detail' })))
    expect(missingId.status).toBe(400)

    const unknown = await route.fetch(post(JSON.stringify({ endpoint: 'detail', reqId: 'req-nope' })))
    expect(unknown.status).toBe(404)

    await host.cleanup()
  })

  it('approves a plan and queues an explicit advance from the browser route', async () => {
    const reqId = 'req-approve-1'
    seedRequirement(reqId)
    const database = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository = new Repository(database)
    repository.recordTaskPlan({
      taskPlanId: `plan-${reqId}-1`,
      requirementId: reqId,
      project: 'testproj',
      planVersion: 1,
      requirementVersion: 1,
      createdAt: '2026-10-23T00:00:00.000Z',
      tasks: [
        {
          taskId: 'a',
          goal: '先改文档',
          files: ['docs/a.md'],
          acceptance: 'a 完成',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: [],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
        {
          taskId: 'b',
          goal: '再补测试',
          files: ['docs/b.md'],
          acceptance: 'b 完成',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: ['a'],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
      ],
    })
    repository.setStatus(reqId, 'plan_proposed')
    seedPlanReview(repository, reqId, 1)
    repository.close()

    const host = fakeHost()
    start(host)
    const route = host.routes[0]!

    const approved = await route.fetch(
      post(JSON.stringify({ endpoint: 'approve', reqId, planVersion: 1, sessionId: 'session-a' })),
    )
    expect(approved.status).toBe(200)
    const approvedBody = (await approved.json()) as {
      ok: boolean
      value: { authorizationSource: string; tasks: string[] }
    }
    expect(approvedBody.ok).toBe(true)
    expect(approvedBody.value.authorizationSource).toContain('plan-approval:req-approve-1:v1:')
    expect(approvedBody.value.tasks).toEqual(['a', 'b'])

    const advanced = await route.fetch(post(JSON.stringify({ endpoint: 'advance', reqId, sessionId: 'session-a' })))
    expect(advanced.status).toBe(200)
    const advancedBody = (await advanced.json()) as { ok: boolean; value: { requestId: string } }
    expect(advancedBody.ok).toBe(true)
    expect(advancedBody.value.requestId).toMatch(/^rq-/)
    host.cleanup()
  })

  it('queues plan and verify decisions only when their preconditions hold', async () => {
    const planReq = 'req-plan-decision'
    const verifyReq = 'req-verify-decision'
    seedRequirement(planReq)
    seedRequirement(verifyReq)
    const database = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository = new Repository(database)
    repository.recordTaskPlan({
      taskPlanId: `plan-${verifyReq}-1`,
      requirementId: verifyReq,
      project: 'testproj',
      planVersion: 1,
      requirementVersion: 1,
      createdAt: '2026-10-23T00:00:00.000Z',
      tasks: [
        {
          taskId: 'a',
          goal: '先改文档',
          files: ['docs/a.md'],
          acceptance: 'a 完成',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: [],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
        {
          taskId: 'b',
          goal: '再补测试',
          files: ['docs/b.md'],
          acceptance: 'b 完成',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: ['a'],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
      ],
    })
    repository.recordAnalysis({
      reqId: planReq,
      analysisVersion: 1,
      requirementVersion: 1,
      goal: '排队规划',
      scenarios: ['场景'],
      acceptanceCriteria: ['标准'],
      clarifications: [],
      createdAt: '2026-10-23T00:00:02.000Z',
    })
    seedPlanReview(repository, verifyReq, 1)
    repository.recordPlanApproval({
      requirementId: verifyReq,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-23T00:00:01.000Z',
      source: 'test',
    })
    for (const taskId of ['a', 'b']) {
      repository.recordTaskArtifact({
        requirementId: verifyReq,
        planVersion: 1,
        taskId,
        candidateSha256: `candidate-${taskId}`,
        testEvidenceSha256: `test-${taskId}`,
        reviewSha256: `review-${taskId}`,
        acceptance: '达成',
        authorizationSource: `plan-approval:${verifyReq}:v1:owner`,
        recordedAt: '2026-10-23T00:00:03.000Z',
        baselineCommit: 'abc',
      })
    }
    repository.close()

    const host = fakeHost()
    start(host)
    const route = host.routes[0]!

    const badPlan = await route.fetch(post(JSON.stringify({ endpoint: 'plan' })))
    expect(badPlan.status).toBe(400)
    const badVerify = await route.fetch(post(JSON.stringify({ endpoint: 'verify' })))
    expect(badVerify.status).toBe(400)

    const planned = await route.fetch(
      post(JSON.stringify({ endpoint: 'plan', reqId: planReq, sessionId: 'session-a' })),
    )
    expect(planned.status).toBe(200)
    const plannedBody = (await planned.json()) as { ok: boolean; value: { action: string } }
    expect(plannedBody.value.action).toBe('plan')

    const verified = await route.fetch(
      post(JSON.stringify({ endpoint: 'verify', reqId: verifyReq, sessionId: 'session-a' })),
    )
    expect(verified.status).toBe(200)
    const verifiedBody = (await verified.json()) as { ok: boolean; value: { action: string } }
    expect(verifiedBody.value.action).toBe('verify')

    // 独立验证是服务端门禁，不是按钮文案：没有任务包的需求不能借路由排队验证。
    const notReady = await route.fetch(
      post(JSON.stringify({ endpoint: 'verify', reqId: planReq, sessionId: 'session-a' })),
    )
    expect(notReady.status).toBe(409)
    const notReadyBody = (await notReady.json()) as { ok: boolean; error: { code: string } }
    expect(notReadyBody).toMatchObject({ ok: false, error: { code: 'plan_missing' } })
    host.cleanup()
  })

  it('rejects malformed and unauthorized decision actions', async () => {
    seedRequirement('req-advance-denied')
    const host = fakeHost()
    start(host)
    const route = host.routes[0]!

    const badApprove = await route.fetch(
      post(JSON.stringify({ endpoint: 'approve', reqId: 'req-x', planVersion: 0 })),
    )
    expect(badApprove.status).toBe(400)

    const missingApprove = await route.fetch(
      post(JSON.stringify({ endpoint: 'approve', reqId: 'req-missing', planVersion: 1 })),
    )
    expect(missingApprove.status).toBe(409)
    const missingBody = (await missingApprove.json()) as { error: { code: string } }
    expect(missingBody.error.code).toBe('not_found')

    const badAdvance = await route.fetch(post(JSON.stringify({ endpoint: 'advance' })))
    expect(badAdvance.status).toBe(400)

    const denied = await route.fetch(post(JSON.stringify({ endpoint: 'advance', reqId: 'req-advance-denied' })))
    expect(denied.status).toBe(409)
    const deniedBody = (await denied.json()) as { error: { code: string } }
    expect(deniedBody.error.code).toBe('plan_missing')

    host.cleanup()
  })

  it('wires acceptance and stop actions with explicit validation', async () => {
    seedRequirement('req-stop-1')
    const host = fakeHost()
    start(host)
    const route = host.routes[0]!

    const badAccept = await route.fetch(post(JSON.stringify({ endpoint: 'accept' })))
    expect(badAccept.status).toBe(400)
    const missingAccept = await route.fetch(post(JSON.stringify({ endpoint: 'accept', reqId: 'req-stop-1' })))
    expect(missingAccept.status).toBe(409)

    const badStop = await route.fetch(post(JSON.stringify({ endpoint: 'stop' })))
    expect(badStop.status).toBe(400)
    const stopped = await route.fetch(
      post(JSON.stringify({ endpoint: 'stop', reqId: 'req-stop-1', reason: '测试停止' })),
    )
    expect(stopped.status).toBe(200)
    const stoppedBody = (await stopped.json()) as { ok: boolean; value: { aborted: number } }
    expect(stoppedBody.ok).toBe(true)
    expect(stoppedBody.value.aborted).toBe(0)
    host.cleanup()
  })

  it('cancels a requirement from the interactive board', async () => {
    seedRequirement('req-cancel-1')
    const host = fakeHost()
    start(host)
    const route = host.routes[0]!

    const bad = await route.fetch(post(JSON.stringify({ endpoint: 'cancel' })))
    expect(bad.status).toBe(400)

    const cancelled = await route.fetch(
      post(JSON.stringify({ endpoint: 'cancel', reqId: 'req-cancel-1', reason: '误提交' })),
    )
    expect(cancelled.status).toBe(200)
    const body = (await cancelled.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    const detail = await route.fetch(post(JSON.stringify({ endpoint: 'detail', reqId: 'req-cancel-1' })))
    const detailBody = (await detail.json()) as { value: { status: string } }
    expect(detailBody.value.status).toBe('cancelled')
    host.cleanup()
  })

  it('serves search, bounded limits and a rich requirement detail for the workbench', async () => {
    const reqId = 'req-ui-detail'
    seedRequirement(reqId)
    const database = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository = new Repository(database)
    repository.recordTaskPlan({
      taskPlanId: `plan-${reqId}-1`,
      requirementId: reqId,
      project: 'testproj',
      planVersion: 1,
      requirementVersion: 1,
      createdAt: '2026-10-29T00:00:00.000Z',
      technicalSolution: {
        summary: '把工作台拆成总览与记录视图',
        approach: ['服务端提供事实', '客户端只渲染'],
        risks: [],
      },
      tasks: [
        {
          taskId: 'a',
          goal: '先做导航',
          files: ['docs/a.md'],
          acceptance: '导航可切换',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: [],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
        {
          taskId: 'b',
          goal: '再补测试',
          files: ['docs/b.md'],
          acceptance: '测试通过',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: ['a'],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
      ],
    })
    repository.recordPlanApproval({
      requirementId: reqId,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-29T00:00:01.000Z',
      source: 'test',
    })
    seedPlanReview(repository, reqId, 1)
    repository.setStatus(reqId, 'plan_proposed')
    repository.close()

    const host = fakeHost()
    start(host)
    const route = host.routes[0]!

    const matched = await route.fetch(post(JSON.stringify({ endpoint: 'board', query: '工作台' })))
    expect(matched.status).toBe(200)
    const matchedBody = (await matched.json()) as {
      value: { query: string; requirements: Array<{ reqId: string; actions: string[] }> }
    }
    expect(matchedBody.value.query).toBe('工作台')
    expect(matchedBody.value.requirements.map((item) => item.reqId)).toEqual([reqId])
    expect(matchedBody.value.requirements[0]!.actions).toEqual(['cancel'])

    const none = await route.fetch(post(JSON.stringify({ endpoint: 'board', query: '没有任何匹配' })))
    const noneBody = (await none.json()) as { value: { requirements: unknown[] } }
    expect(noneBody.value.requirements).toEqual([])

    const badLimit = await route.fetch(post(JSON.stringify({ endpoint: 'board', limit: 0 })))
    expect(badLimit.status).toBe(400)
    const badQuery = await route.fetch(post(JSON.stringify({ endpoint: 'board', query: 42 })))
    expect(badQuery.status).toBe(400)

    const detail = await route.fetch(post(JSON.stringify({ endpoint: 'detail', reqId })))
    expect(detail.status).toBe(200)
    const detailBody = (await detail.json()) as {
      value: {
        latestPlan: { tasks: unknown[]; technicalSolution: { summary: string } }
        artifacts: unknown[]
        progress: { total: number; delivered: number }
        acceptanceRecord: Record<string, string>
        planReview: { verdict: string; summary: string } | null
        verification: unknown
      }
    }
    expect(detailBody.value.latestPlan.tasks).toHaveLength(2)
    expect(detailBody.value.latestPlan.technicalSolution.summary).toContain('工作台')
    expect(detailBody.value.artifacts).toEqual([])
    expect(detailBody.value.progress).toMatchObject({ total: 2, delivered: 0 })
    expect(detailBody.value.acceptanceRecord.accepted_by).toBe('')
    // 详情页必须能看到实现前评审结论；没有独立验证时明确为空，而不是伪造“已通过”。
    expect(detailBody.value.planReview).toMatchObject({ verdict: 'pass' })
    expect(detailBody.value.verification).toBeNull()
    host.cleanup()
  })

  it('retries a failed task through an explicit two-step recovery', async () => {
    const reqId = 'req-retry-1'
    seedRequirement(reqId)
    const database = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository = new Repository(database)
    repository.recordTaskPlan({
      taskPlanId: `plan-${reqId}-1`,
      requirementId: reqId,
      project: 'testproj',
      planVersion: 1,
      requirementVersion: 1,
      createdAt: '2026-10-29T00:00:00.000Z',
      tasks: [
        {
          taskId: 'a',
          goal: '先改文档',
          files: ['docs/a.md'],
          acceptance: 'a 完成',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: [],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
        {
          taskId: 'b',
          goal: '再补测试',
          files: ['docs/b.md'],
          acceptance: 'b 完成',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: ['a'],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
      ],
    })
    repository.recordPlanApproval({
      requirementId: reqId,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-29T00:00:01.000Z',
      source: 'test',
    })
    repository.setStatus(reqId, 'blocked', '开发回合被停止')
    repository.recordTaskRun({
      requirementId: reqId,
      planVersion: 1,
      taskId: 'a',
      state: 'failed',
      reason: '正式测试失败（退出码 1）',
      executedSeconds: 1,
      updatedAt: '2026-10-29T00:00:02.000Z',
    })
    repository.recordFailureRound(reqId, {
      roundId: 'a-a1',
      stage: 'formal_test',
      summary: '正式测试退出码 1',
      occurredAt: '2026-10-29T00:00:03.000Z',
    })
    repository.recordRequest({
      requestId: 'rq-unknown',
      reqId,
      project: 'testproj',
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-29T00:00:04.000Z',
    })
    repository.resolveRequest('rq-unknown', 'unknown', '宿主停止', '2026-10-29T00:00:05.000Z')
    repository.close()

    const host = fakeHost()
    start(host)
    const route = host.routes[0]!

    const malformed = await route.fetch(post(JSON.stringify({ endpoint: 'retry', reqId })))
    expect(malformed.status).toBe(400)

    const first = await route.fetch(
      post(JSON.stringify({ endpoint: 'retry', reqId, planVersion: 1, taskId: 'a' })),
    )
    expect(first.status).toBe(409)
    const firstBody = (await first.json()) as { ok: boolean; error: { code: string } }
    expect(firstBody.ok).toBe(false)
    expect(firstBody.error.code).toBe('recovery_required')

    const confirmed = await route.fetch(
      post(
        JSON.stringify({
          endpoint: 'retry',
          reqId,
          planVersion: 1,
          taskId: 'a',
          confirmRecovery: true,
          sessionId: 'session-retry',
        }),
      ),
    )
    const rawBody = await confirmed.clone().text()
    if (confirmed.status !== 200) throw new Error(`status ${confirmed.status}: ${rawBody}`)
    const confirmedBody = (await confirmed.json()) as { ok: boolean; value: { requestId: string } }
    expect(confirmedBody.ok).toBe(true)
    expect(confirmedBody.value.requestId).toMatch(/^rq-/)

    const detail = await route.fetch(post(JSON.stringify({ endpoint: 'detail', reqId })))
    const detailBody = (await detail.json()) as { value: { pendingRequests: Array<{ action: string }> } }
    expect(detailBody.value.pendingRequests.map((request) => request.action)).toEqual(['advance'])
    host.cleanup()
  })

  it('closes unknown requests only after an explicit owner confirmation', async () => {
    const reqId = 'req-recover-route'
    seedRequirement(reqId)
    const database = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository = new Repository(database)
    repository.recordRequest({
      requestId: 'rq-recover-route',
      reqId,
      project: 'testproj',
      planVersion: 0,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-30T00:00:00.000Z',
    })
    repository.claimNextRequest('tester', '2026-10-30T00:00:01.000Z')
    repository.markClaimedUnknown('2026-10-30T00:00:02.000Z')
    repository.close()

    const host = fakeHost()
    start(host)
    const route = host.routes[0]!
    const refused = await route.fetch(post(JSON.stringify({ endpoint: 'recover', reqId })))
    expect(refused.status).toBe(409)
    const confirmed = await route.fetch(
      post(JSON.stringify({ endpoint: 'recover', reqId, confirmRecovery: true })),
    )
    expect(confirmed.status).toBe(200)
    const database2 = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository2 = new Repository(database2)
    expect(repository2.request('rq-recover-route')?.state).toBe('dismissed')
    repository2.close()
    host.cleanup()
  })

  it('keeps an approved task package frozen and no longer exposes replan', async () => {
    const reqId = 'req-frozen-1'
    seedRequirement(reqId)
    const database = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository = new Repository(database)
    repository.recordTaskPlan({
      taskPlanId: `plan-${reqId}-1`,
      requirementId: reqId,
      project: 'testproj',
      planVersion: 1,
      requirementVersion: 1,
      createdAt: '2026-10-29T00:00:00.000Z',
      tasks: [
        {
          taskId: 'a',
          goal: '先改文档',
          files: ['docs/a.md'],
          acceptance: 'a 完成',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: [],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
        {
          taskId: 'b',
          goal: '再补测试',
          files: ['docs/b.md'],
          acceptance: 'b 完成',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: ['a'],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
      ],
    })
    repository.recordPlanApproval({
      requirementId: reqId,
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-29T00:00:01.000Z',
      source: 'test',
    })
    repository.recordAnalysis({
      reqId,
      analysisVersion: 1,
      requirementVersion: 1,
      goal: '冻结任务包',
      scenarios: ['场景一'],
      acceptanceCriteria: ['标准一'],
      clarifications: [],
      createdAt: '2026-10-29T00:00:00.500Z',
    })
    repository.setStatus(reqId, 'blocked', '任务失败')
    repository.close()

    const host = fakeHost()
    start(host)
    const route = host.routes[0]!

    const removed = await route.fetch(
      post(JSON.stringify({ endpoint: 'replan', reqId, planVersion: 1, files: ['docs/a.md'] })),
    )
    expect(removed.status).toBe(404)

    const frozen = await route.fetch(post(JSON.stringify({ endpoint: 'plan', reqId })))
    expect(frozen.status).toBe(409)
    const frozenBody = (await frozen.json()) as { error: { code: string } }
    expect(frozenBody.error.code).toBe('plan_frozen')

    const permitted = await route.fetch(
      post(
        JSON.stringify({
          endpoint: 'plan',
          reqId,
          confirmPlanChange: true,
          reason: '任务包遗漏关键文件',
          sessionId: 'session-plan-change',
        }),
      ),
    )
    expect(permitted.status).toBe(200)
    const database2 = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository2 = new Repository(database2)
    const request = repository2
      .requestsFor(reqId)
      .find((candidate) => candidate.action === 'plan' && candidate.state === 'pending')
    expect(request?.source).toContain('plan-change:任务包遗漏关键文件')
    repository2.close()
    host.cleanup()
  })

  it('diagnoses an unknown request and releases the block when replay is safe', async () => {
    const reqId = 'req-diagnose-route'
    seedRequirement(reqId)
    const database = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository = new Repository(database)
    repository.recordTaskPlan({
      taskPlanId: `plan-${reqId}-1`,
      requirementId: reqId,
      project: 'testproj',
      planVersion: 1,
      requirementVersion: 1,
      createdAt: '2026-10-30T00:00:00.000Z',
      tasks: [
        {
          taskId: 'a',
          goal: '中断的任务',
          files: ['docs/a.md'],
          acceptance: 'a 完成',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: [],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
        {
          taskId: 'b',
          goal: '后续任务',
          files: ['docs/b.md'],
          acceptance: 'b 完成',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: ['a'],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
      ],
    })
    repository.setStatus(reqId, 'blocked', '开发回合被停止：工作副本可能有未收口改动，需核对')
    repository.recordTaskRun({
      requirementId: reqId,
      planVersion: 1,
      taskId: 'a',
      state: 'blocked',
      reason: '宿主中断：执行结果未收口',
      executedSeconds: 1,
      updatedAt: '2026-10-30T00:00:02.000Z',
    })
    repository.recordRequest({
      requestId: 'rq-unknown-diagnose',
      reqId,
      project: 'testproj',
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-30T00:00:03.000Z',
    })
    repository.resolveRequest('rq-unknown-diagnose', 'unknown', '宿主停止', '2026-10-30T00:00:04.000Z')
    repository.close()

    const host = fakeHost({
      agentText: JSON.stringify({
        root_cause: '宿主重启中断开发回合，快照内留未提交改动',
        solution: '丢弃一次性快照后重跑推进',
      }),
    })
    start(host)
    const route = host.routes[0]!
    const response = await route.fetch(post(JSON.stringify({ endpoint: 'diagnose', reqId })))
    const raw = await response.text()
    if (response.status !== 200) throw new Error(`status ${response.status}: ${raw}`)
    const body = JSON.parse(raw) as {
      ok: boolean
      value: { rootCause: string; replaySafe: boolean; closedRequests: number }
    }
    expect(body.ok).toBe(true)
    expect(body.value.replaySafe).toBe(true)
    expect(body.value.closedRequests).toBe(1)
    expect(Buffer.byteLength(body.value.rootCause, 'utf8')).toBeLessThanOrEqual(100)

    const database2 = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository2 = new Repository(database2)
    expect(repository2.request('rq-unknown-diagnose')?.state).toBe('dismissed')
    expect(repository2.unknownDiagnoses(reqId)).toHaveLength(1)
    repository2.close()
    host.cleanup()
  })

  it('rejects an over-long diagnosis and keeps the unknown request open', async () => {
    const reqId = 'req-diagnose-long'
    seedRequirement(reqId)
    const database = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository = new Repository(database)
    repository.recordRequest({
      requestId: 'rq-unknown-long',
      reqId,
      project: 'testproj',
      planVersion: 0,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-30T00:00:03.000Z',
    })
    repository.resolveRequest('rq-unknown-long', 'unknown', '宿主停止', '2026-10-30T00:00:04.000Z')
    repository.close()

    const host = fakeHost({
      agentText: JSON.stringify({ root_cause: '中'.repeat(40), solution: '重跑' }),
    })
    start(host)
    const route = host.routes[0]!
    const response = await route.fetch(post(JSON.stringify({ endpoint: 'diagnose', reqId })))
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('diagnosis_invalid')
    expect(body.error.message).toContain('超过 100 字节')

    const database2 = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository2 = new Repository(database2)
    expect(repository2.request('rq-unknown-long')?.state).toBe('unknown')
    repository2.close()
    host.cleanup()
  })

  it('serves the task public execution process with real session and evidence identities', async () => {
    const reqId = 'req-execution-1'
    seedRequirement(reqId)
    const database = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository = new Repository(database)
    repository.recordTaskPlan({
      taskPlanId: `plan-${reqId}-1`,
      requirementId: reqId,
      project: 'testproj',
      planVersion: 1,
      requirementVersion: 1,
      createdAt: '2026-10-29T00:00:00.000Z',
      tasks: [
        {
          taskId: 'a',
          goal: '实现执行过程',
          files: ['docs/a.md'],
          acceptance: '事件可回放',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: [],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
        {
          taskId: 'b',
          goal: '没有执行的后续任务',
          files: ['docs/b.md'],
          acceptance: '保持未开始',
          testCommand: ['node', '-e', 'process.exit(0)'],
          dependsOn: ['a'],
          limits: { limitSeconds: 60, maxFailureRounds: 3 },
          authorizationSource: '',
        },
      ],
    })
    repository.recordTaskRun({
      requirementId: reqId,
      planVersion: 1,
      taskId: 'a',
      state: 'delivered',
      reason: '',
      executedSeconds: 2,
      updatedAt: '2026-10-29T00:00:05.000Z',
    })
    repository.recordEvidence({
      requirementId: reqId,
      planVersion: 1,
      taskId: 'a',
      baselineCommit: 'base',
      workspacePath: '/tmp/workspace',
      candidatePath: '/tmp/candidate.diff',
      testLogPath: '/tmp/formal-test.log',
      reviewPath: '/tmp/review.json',
      devSession: 'session-dev-real',
      reviewSession: 'session-review-real',
      recordedAt: '2026-10-29T00:00:06.000Z',
    })
    repository.close()
    const taskDir = join(dir, '.forgeloop', 'projects', 'testproj', 'evidence', reqId, 'v1', 'a')
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(
      join(taskDir, 'dev.jsonl'),
      [
        JSON.stringify({ type: 'user/message', seq: 1, time: 1000, data: { content: [{ type: 'text', text: '任务输入' }] } }),
        JSON.stringify({
          type: 'assistant/message',
          seq: 2,
          time: 2000,
          data: { message: { content: [{ type: 'reasoning', text: '隐藏推理' }, { type: 'text', text: '公开消息' }] } },
        }),
        JSON.stringify({ type: 'tool/call', seq: 3, time: 2100, data: { callId: 'call-1', name: 'bash', arguments: '{}' } }),
        JSON.stringify({ type: 'tool/result', seq: 4, time: 2200, data: { toolCallId: 'call-1', message: { content: [{ type: 'text', text: 'ok' }], isError: false } } }),
        JSON.stringify({ type: 'step/start', seq: 5, time: 2300, data: {} }),
        JSON.stringify({ type: 'session-log-deepseek/delivery-accepted', seq: 6, time: 2400, data: { sessionId: 'session-dev-real' } }),
      ].join('\n'),
    )
    writeFileSync(
      join(taskDir, 'formal-test.log'),
      'command: "npm" "run" "check"\nstarted: 2026-10-29T00:00:03.000Z\nduration_ms: 1000\ntimed_out: false\naborted: false\nexit_code: 0\n',
    )
    writeFileSync(join(taskDir, 'review.json'), JSON.stringify({ verdict: 'pass', summary: '通过' }))

    const host = fakeHost()
    start(host)
    const route = host.routes[0]!
    const response = await route.fetch(
      post(JSON.stringify({ endpoint: 'execution', reqId, taskId: 'a', planVersion: 1, offset: 0, limit: 1 })),
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      value: {
        session: { dev: string; review: string }
        total: number
        truncated: boolean
        stepCount: number
        events: Array<{ kind: string; text?: string }>
        attempts: Array<{ sessionId: string; available: boolean }>
        test: { exitCode: number; available: boolean }
        review: { verdict: string }
      }
    }
    expect(payload.value.session).toMatchObject({ dev: 'session-dev-real', review: 'session-review-real' })
    expect(payload.value.total).toBe(3)
    expect(payload.value.truncated).toBe(true)
    expect(payload.value.stepCount).toBe(1)
    expect(payload.value.events).toHaveLength(1)
    expect(JSON.stringify(payload)).not.toContain('隐藏推理')
    expect(payload.value.attempts[0]).toMatchObject({ sessionId: 'session-dev-real', available: true })
    expect(payload.value.test).toMatchObject({ exitCode: 0, available: true })
    expect(payload.value.review.verdict).toBe('pass')

    const database2 = Database.open(join(dir, '.forgeloop', 'projects', 'testproj', 'records.sqlite'))
    const repository2 = new Repository(database2)
    repository2.recordFailureRound(reqId, {
      roundId: 'a-old',
      stage: 'formal_test',
      summary: '旧失败',
      occurredAt: '2026-10-29T00:00:07.000Z',
    })
    repository2.close()
    const history = await route.fetch(post(JSON.stringify({ endpoint: 'execution', reqId, taskId: 'a', planVersion: 1 })))
    const historyBody = (await history.json()) as { value: { attempts: Array<{ available: boolean; reason?: string }> } }
    expect(historyBody.value.attempts).toHaveLength(2)
    expect(historyBody.value.attempts[1]).toMatchObject({ available: false })

    const empty = await route.fetch(post(JSON.stringify({ endpoint: 'execution', reqId, taskId: 'b', planVersion: 1 })))
    const emptyBody = (await empty.json()) as { value: { total: number; attempts: Array<{ available: boolean; reason: string }>; reason: string } }
    expect(empty.status).toBe(200)
    expect(emptyBody.value.total).toBe(0)
    expect(emptyBody.value.attempts[0]).toMatchObject({ available: false })
    expect(emptyBody.value.reason).toContain('没有找到')
    host.cleanup()
  })

  it('stays inert in profiles without a browser Fetch registry', () => {
    const host = fakeHost({ withFetch: false })
    start(host)
    expect(host.injected()).toBe(true)
    expect(host.routes).toEqual([])
    host.cleanup()
  })
})
