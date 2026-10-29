import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/index.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'

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

function fakeHost(options: { withFetch?: boolean } = {}) {
  const routes: RegisteredRoute[] = []
  let injected = false
  let disposed = false
  let cleanup: (() => unknown) | undefined
  const ctx = {
    agents: {},
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
      }
    }
    expect(detailBody.value.latestPlan.tasks).toHaveLength(2)
    expect(detailBody.value.latestPlan.technicalSolution.summary).toContain('工作台')
    expect(detailBody.value.artifacts).toEqual([])
    expect(detailBody.value.progress).toMatchObject({ total: 2, delivered: 0 })
    expect(detailBody.value.acceptanceRecord.accepted_by).toBe('')
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
    expect(confirmed.status).toBe(200)
    const confirmedBody = (await confirmed.json()) as { ok: boolean; value: { requestId: string } }
    expect(confirmedBody.ok).toBe(true)
    expect(confirmedBody.value.requestId).toMatch(/^rq-/)

    const detail = await route.fetch(post(JSON.stringify({ endpoint: 'detail', reqId })))
    const detailBody = (await detail.json()) as { value: { pendingRequests: Array<{ action: string }> } }
    expect(detailBody.value.pendingRequests.map((request) => request.action)).toEqual(['advance'])
    host.cleanup()
  })

  it('creates a new plan version through replan after explicit unknown recovery', async () => {
    const reqId = 'req-replan-1'
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
    repository.recordRequest({
      requestId: 'rq-unknown-replan',
      reqId,
      project: 'testproj',
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'test',
      now: '2026-10-29T00:00:04.000Z',
    })
    repository.resolveRequest('rq-unknown-replan', 'unknown', '宿主停止', '2026-10-29T00:00:05.000Z')
    repository.close()

    const host = fakeHost()
    start(host)
    const route = host.routes[0]!
    const malformed = await route.fetch(post(JSON.stringify({ endpoint: 'replan', reqId, planVersion: 1 })))
    expect(malformed.status).toBe(400)

    const unconfirmed = await route.fetch(
      post(JSON.stringify({ endpoint: 'replan', reqId, planVersion: 1, files: ['contracts/architecture.json'] })),
    )
    expect(unconfirmed.status).toBe(409)
    const unconfirmedBody = (await unconfirmed.json()) as { error: { code: string } }
    expect(unconfirmedBody.error.code).toBe('recovery_required')

    const confirmed = await route.fetch(
      post(
        JSON.stringify({
          endpoint: 'replan',
          reqId,
          planVersion: 1,
          files: ['contracts/architecture.json'],
          confirmRecovery: true,
          sessionId: 'session-replan',
        }),
      ),
    )
    expect(confirmed.status).toBe(200)
    const confirmedBody = (await confirmed.json()) as {
      ok: boolean
      value: { planVersion: number; taskId: string; files: string[]; recovered: number }
    }
    expect(confirmedBody.ok).toBe(true)
    expect(confirmedBody.value).toMatchObject({
      planVersion: 2,
      taskId: 'a',
      files: ['contracts/architecture.json'],
      recovered: 1,
    })

    const detail = await route.fetch(post(JSON.stringify({ endpoint: 'detail', reqId })))
    const detailBody = (await detail.json()) as {
      value: {
        status: string
        approval: unknown
        latestPlan: { planVersion: number; tasks: Array<{ files: string[] }> }
      }
    }
    expect(detailBody.value.status).toBe('plan_proposed')
    expect(detailBody.value.latestPlan.planVersion).toBe(2)
    expect(detailBody.value.approval).toBeNull()
    expect(detailBody.value.latestPlan.tasks[0]?.files).toEqual(['docs/a.md', 'contracts/architecture.json'])
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
