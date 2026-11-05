import { describe, expect, it } from 'vitest'
import { createBoardFetch } from '../src/runtime/board-route.js'
import type { Coordinator } from '../src/runtime/coordinator.js'
import type { ForgeLoopRuntime } from '../src/runtime/service.js'
import type { ForgeLoopConfig } from '../src/config.js'

/**
 * 看板路由的契约测试：每个端点固定四件事——缺参 400、业务失败 409（读取类 404）、
 * 成功 200、以及错误信封中的 code/message 原文。风险最高的部分是所有者写入动作：
 * 它们必须提交 `by=owner` 与可追溯的 `web-decision:<session>:<action>` 来源。
 */

interface RuntimeResult {
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
  readonly data?: unknown
}

interface Call {
  readonly method: string
  readonly input?: unknown
}

interface SetupOptions {
  readonly results?: Partial<Record<string, RuntimeResult>>
  readonly repo?: Record<string, unknown>
  readonly deployment?: Record<string, unknown>
  readonly aborted?: boolean
}

interface Route {
  readonly status: number
  readonly body: any
}

const OWNER = 'owner'

function setup(options: SetupOptions = {}) {
  const calls: Call[] = []
  const result = (method: string, data: unknown = {}): RuntimeResult =>
    options.results?.[method] ?? { ok: true, code: 'ok', message: 'ok', data }
  const record = (method: string, input?: unknown): void => {
    calls.push({ method, input })
  }

  const runtime = {
    requirementDetail: (reqId: string) => {
      record('requirementDetail', reqId)
      return result('requirementDetail', { reqId })
    },
    taskDetail: (reqId: string, taskId: string, planVersion?: number) => {
      record('taskDetail', { reqId, taskId, planVersion })
      return result('taskDetail', { reqId, taskId })
    },
    taskExecution: (input: unknown) => {
      record('taskExecution', input)
      return result('taskExecution', {})
    },
    sessionSummary: (sessionId: string) => {
      record('sessionSummary', sessionId)
      return { sessionId }
    },
    requestOperation: (input: unknown) => {
      record('requestOperation', input)
      return result('requestOperation', {})
    },
    approvePlan: (input: unknown) => {
      record('approvePlan', input)
      return result('approvePlan', {})
    },
    requeue: (input: unknown) => {
      record('requeue', input)
      return result('requeue', {})
    },
    analysisQueue: {
      retry: (input: unknown) => {
        record('retryAnalysis', input)
        return result('retryAnalysis', {})
      },
    },
    buildCandidate: (input: unknown) => {
      record('buildCandidate', input)
      return result('buildCandidate', {})
    },
    verifyDeployment: (input: unknown) => {
      record('verifyDeployment', input)
      return result('verifyDeployment', {})
    },
    retryTask: (input: unknown) => {
      record('retryTask', input)
      return result('retryTask', {})
    },
    accept: (input: unknown) => {
      record('accept', input)
      return result('accept', {})
    },
    cancel: (input: unknown) => {
      record('cancel', input)
      return result('cancel', {})
    },
    stop: (input: unknown) => {
      record('stop', input)
      return result('stop', {})
    },
    opsStatus: (eventId?: string) => {
      record('opsStatus', eventId)
      return result('opsStatus', { eventId })
    },
    opsDecide: (input: unknown) => {
      record('opsDecide', input)
      return result('opsDecide', {})
    },
    opsClose: (input: unknown) => {
      record('opsClose', input)
      return result('opsClose', {})
    },
    opsRequestFix: (input: unknown) => {
      record('opsRequestFix', input)
      return result('opsRequestFix', {})
    },
    statusBoard: (limit?: number, query?: string) => {
      record('statusBoard', { limit, query })
      return { requirements: [], limit, query }
    },
    reliability: (window: string) => {
      record('reliability', window)
      return { window: { key: window } }
    },
    repo: options.repo ?? {},
    deploymentService: {
      rollouts: (limit: number) => {
        record('rollouts', limit)
        return { targets: [], rollouts: [] }
      },
      rollout: (intentId: string) => {
        record('rollout', intentId)
        return intentId === 'dep-1' ? { intent: { intentId } } : null
      },
      request: async (input: unknown) => {
        record('deploymentRequest', input)
        return result('deploymentRequest', { intentId: 'dep-1' })
      },
      approve: async (input: unknown) => {
        record('deploymentApprove', input)
        return result('deploymentApprove', {})
      },
      reject: (input: unknown) => {
        record('deploymentReject', input)
        return result('deploymentReject', {})
      },
      verify: async (input: unknown) => {
        record('deploymentVerify', input)
        return result('deploymentVerify', {})
      },
      rollback: async (input: unknown) => {
        record('deploymentRollback', input)
        return result('deploymentRollback', {})
      },
      ...(options.deployment ?? {}),
    },
  } as unknown as ForgeLoopRuntime

  const coordinator = {
    abortRequirement: (reqId: string) => {
      record('abortRequirement', reqId)
      return options.aborted ?? true
    },
  } as unknown as Coordinator
  const config = { owner: OWNER } as ForgeLoopConfig
  return {
    calls,
    fetch: createBoardFetch(runtime, config, coordinator),
    last: (): Call | undefined => calls.at(-1),
    callsOf: (method: string): Call[] => calls.filter((call) => call.method === method),
  }
}

async function post(
  fetch: (request: Request) => Promise<Response>,
  body: unknown,
  raw = false,
): Promise<Route> {
  const request = new Request('http://127.0.0.1/api/forgeloop/board', {
    method: 'POST',
    body: raw ? String(body) : JSON.stringify(body),
  })
  const response = await fetch(request)
  return { status: response.status, body: await response.json() }
}

/** 业务动作的成功信封统一为 `{ok:true, value}`，这里要求整包相等。 */
function ok(value: unknown = {}): Route {
  return { status: 200, body: { ok: true, value } }
}

function failure(status: number, code: string, message: string): Route {
  return { status, body: { ok: false, error: { code, message, details: {} } } }
}

describe('board route envelope', () => {
  it('rejects a non-JSON body with the exact bad request envelope', async () => {
    const { fetch } = setup()
    expect(await post(fetch, 'not-json', true)).toEqual(
      failure(400, 'bad_request', '请求体不是 JSON'),
    )
  })

  it('reports unknown endpoint names and non-object payloads explicitly', async () => {
    const { fetch } = setup()
    expect(await post(fetch, { endpoint: 'missing' })).toEqual(
      failure(404, 'not_found', '未知的看板端点 missing'),
    )
    expect(await post(fetch, {})).toEqual(failure(404, 'not_found', '未知的看板端点 undefined'))
    expect(await post(fetch, [1, 2])).toEqual(failure(404, 'not_found', '未知的看板端点 undefined'))
    expect(await post(fetch, { endpoint: 12 })).toEqual(
      failure(404, 'not_found', '未知的看板端点 12'),
    )
  })

  it('wraps a thrown runtime error as an internal failure', async () => {
    const fetch = createBoardFetch(
      {
        statusBoard: () => {
          throw new Error('boom')
        },
      } as unknown as ForgeLoopRuntime,
      { owner: OWNER } as ForgeLoopConfig,
      {} as Coordinator,
    )
    expect(await post(fetch, { endpoint: 'board' })).toEqual(
      failure(500, 'internal', '看板读取失败：boom'),
    )
  })
})

describe('board query', () => {
  it('defaults to no limit and an empty query', async () => {
    const { fetch, last } = setup()
    expect(await post(fetch, { endpoint: 'board' })).toEqual(
      ok({ requirements: [], limit: undefined, query: '' }),
    )
    expect(last()).toEqual({ method: 'statusBoard', input: { limit: undefined, query: '' } })
  })

  it('trims and bounds the query text to 200 characters', async () => {
    const { fetch, last } = setup()
    expect((await post(fetch, { endpoint: 'board', query: '  hello  ' })).status).toBe(200)
    expect(last()?.input).toEqual({ limit: undefined, query: 'hello' })
    expect((await post(fetch, { endpoint: 'board', query: 'x'.repeat(250) })).status).toBe(200)
    expect(last()?.input).toEqual({ limit: undefined, query: 'x'.repeat(200) })
  })

  it('rejects non-string queries and out-of-range limits', async () => {
    const { fetch } = setup()
    for (const body of [
      { endpoint: 'board', query: 1 },
      { endpoint: 'board', query: null },
      { endpoint: 'board', limit: 0 },
      { endpoint: 'board', limit: 101 },
      { endpoint: 'board', limit: 1.5 },
      { endpoint: 'board', limit: '5' },
      { endpoint: 'board', limit: null },
    ]) {
      expect((await post(fetch, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await post(fetch, { endpoint: 'board', query: 1 })).toEqual(
      failure(400, 'bad_request', 'query 必须是字符串'),
    )
    expect(await post(fetch, { endpoint: 'board', limit: 0 })).toEqual(
      failure(400, 'bad_request', 'limit 必须是 1..100 的整数'),
    )
  })

  it('accepts both limit boundaries', async () => {
    const { fetch, last } = setup()
    expect((await post(fetch, { endpoint: 'board', limit: 1 })).status).toBe(200)
    expect(last()?.input).toEqual({ limit: 1, query: '' })
    expect((await post(fetch, { endpoint: 'board', limit: 100 })).status).toBe(200)
    expect(last()?.input).toEqual({ limit: 100, query: '' })
  })
})

describe('read endpoints', () => {
  it('requires reqId for detail and echoes the delegated result', async () => {
    const { fetch } = setup()
    for (const body of [{ endpoint: 'detail' }, { endpoint: 'detail', reqId: '   ' }]) {
      expect(await post(fetch, body)).toEqual(failure(400, 'bad_request', '缺少需求身份 reqId'))
    }
    expect(await post(fetch, { endpoint: 'detail', reqId: '  r1  ' })).toEqual(ok({ reqId: 'r1' }))
  })

  it('maps a missing requirement detail to 404 with the runtime code', async () => {
    const { fetch } = setup({
      results: {
        requirementDetail: { ok: false, code: 'not_found', message: '未找到需求 r9' },
      },
    })
    expect(await post(fetch, { endpoint: 'detail', reqId: 'r9' })).toEqual(
      failure(404, 'not_found', '未找到需求 r9'),
    )
  })

  it('requires both identities for task detail and forwards a numeric planVersion', async () => {
    const { fetch, last } = setup()
    for (const body of [
      { endpoint: 'task' },
      { endpoint: 'task', reqId: 'r1' },
      { endpoint: 'task', reqId: 'r1', taskId: '  ' },
    ]) {
      expect(await post(fetch, body)).toEqual(
        failure(400, 'bad_request', '任务详情需要 reqId 与 taskId'),
      )
    }
    expect(await post(fetch, { endpoint: 'task', reqId: 'r1', taskId: 't1' })).toEqual(
      ok({ reqId: 'r1', taskId: 't1' }),
    )
    expect(last()?.input).toEqual({ reqId: 'r1', taskId: 't1', planVersion: undefined })
    expect(
      (await post(fetch, { endpoint: 'task', reqId: 'r1', taskId: 't1', planVersion: 2 })).status,
    ).toBe(200)
    expect(last()?.input).toEqual({ reqId: 'r1', taskId: 't1', planVersion: 2 })
    expect(
      (await post(fetch, { endpoint: 'task', reqId: 'r1', taskId: 't1', planVersion: '2' })).status,
    ).toBe(200)
    expect(last()?.input).toEqual({ reqId: 'r1', taskId: 't1', planVersion: undefined })
  })

  it('accepts execution pagination defaults and rejects every malformed bound', async () => {
    const { fetch, last } = setup()
    const pageMessage = '执行过程需要 reqId、taskId 与合法分页参数'
    for (const body of [
      { endpoint: 'execution', reqId: 'r1' },
      { endpoint: 'execution', reqId: 'r1', taskId: 't1', offset: -1 },
      { endpoint: 'execution', reqId: 'r1', taskId: 't1', offset: 1.5 },
      { endpoint: 'execution', reqId: 'r1', taskId: 't1', limit: 0 },
      { endpoint: 'execution', reqId: 'r1', taskId: 't1', limit: 201 },
      { endpoint: 'execution', reqId: 'r1', taskId: 't1', planVersion: 0 },
      { endpoint: 'execution', reqId: 'r1', taskId: 't1', planVersion: 1.5 },
    ]) {
      expect(await post(fetch, body), JSON.stringify(body)).toEqual(
        failure(400, 'bad_request', pageMessage),
      )
    }
    expect(await post(fetch, { endpoint: 'execution', reqId: 'r1', taskId: 't1' })).toEqual(ok())
    expect(last()?.input).toEqual({ reqId: 'r1', taskId: 't1', offset: 0, limit: 100 })
    expect(
      (
        await post(fetch, {
          endpoint: 'execution',
          reqId: 'r1',
          taskId: 't1',
          planVersion: 2,
          offset: 5,
          limit: 1,
        })
      ).status,
    ).toBe(200)
    expect(last()?.input).toEqual({
      reqId: 'r1',
      taskId: 't1',
      planVersion: 2,
      offset: 5,
      limit: 1,
    })
    expect(
      (await post(fetch, { endpoint: 'execution', reqId: 'r1', taskId: 't1', limit: 200 })).status,
    ).toBe(200)
    expect(last()?.input).toEqual({ reqId: 'r1', taskId: 't1', offset: 0, limit: 200 })
  })

  it('requires a session id and returns the session summary verbatim', async () => {
    const { fetch } = setup()
    expect(await post(fetch, { endpoint: 'session' })).toEqual(
      failure(400, 'bad_request', '缺少会话身份 sessionId'),
    )
    expect(await post(fetch, { endpoint: 'session', sessionId: 's1' })).toEqual(
      ok({ sessionId: 's1' }),
    )
  })

  it('validates the reliability window and defaults to all', async () => {
    const { fetch, last } = setup()
    expect((await post(fetch, { endpoint: 'reliability' })).status).toBe(200)
    expect(last()?.input).toBe('all')
    for (const window of ['7d', '30d', '90d', 'all']) {
      expect(await post(fetch, { endpoint: 'reliability', window })).toEqual(
        ok({ window: { key: window } }),
      )
      expect(last()?.input).toBe(window)
    }
    expect(await post(fetch, { endpoint: 'reliability', window: '12h' })).toEqual(
      failure(400, 'bad_request', '可靠性窗口只能是 7d、30d、90d 或 all'),
    )
  })
})

describe('deployment reads', () => {
  it('lists rollouts with a default and bounded limit', async () => {
    const { fetch, last } = setup()
    expect((await post(fetch, { endpoint: 'deployments' })).status).toBe(200)
    expect(last()).toEqual({ method: 'rollouts', input: 20 })
    expect((await post(fetch, { endpoint: 'deployments', limit: 1 })).status).toBe(200)
    expect(last()).toEqual({ method: 'rollouts', input: 1 })
    expect((await post(fetch, { endpoint: 'deployments', limit: 100 })).status).toBe(200)
    expect(last()).toEqual({ method: 'rollouts', input: 100 })
    for (const limit of [0, 101, 2.5, '3']) {
      expect(await post(fetch, { endpoint: 'deployments', limit }), String(limit)).toEqual(
        failure(400, 'bad_request', 'limit 必须是 1..100 的整数'),
      )
    }
  })

  it('requires an intent id and distinguishes missing from unknown deployments', async () => {
    const { fetch } = setup()
    expect(await post(fetch, { endpoint: 'deployment' })).toEqual(
      failure(400, 'bad_request', '部署详情需要 intentId'),
    )
    expect(await post(fetch, { endpoint: 'deployment', intentId: 'dep-x' })).toEqual(
      failure(404, 'not_found', '未找到部署 dep-x'),
    )
    expect(await post(fetch, { endpoint: 'deployment', intentId: 'dep-1' })).toEqual(
      ok({ intent: { intentId: 'dep-1' } }),
    )
  })
})

describe('deployment actions', () => {
  it('records the owner and session source when requesting an intent', async () => {
    const { fetch, callsOf } = setup()
    expect(await post(fetch, { endpoint: 'deployment-intent' })).toEqual(
      failure(400, 'bad_request', '部署提议需要 targetId'),
    )
    expect(
      await post(fetch, { endpoint: 'deployment-intent', targetId: 'web', sessionId: 's1' }),
    ).toEqual(ok({ intentId: 'dep-1' }))
    expect(callsOf('deploymentRequest').at(-1)?.input).toEqual({
      targetId: 'web',
      by: OWNER,
      source: 'web-decision:s1:deployment-intent',
    })
    expect(await post(fetch, { endpoint: 'deployment-intent', targetId: 'web' })).toEqual(
      ok({ intentId: 'dep-1' }),
    )
    expect(callsOf('deploymentRequest').at(-1)?.input).toEqual({
      targetId: 'web',
      by: OWNER,
      source: 'web-decision:unknown-session:deployment-intent',
    })
  })

  it('maps deployment decision failures to 403/404/400/409', async () => {
    expect(await post(setup().fetch, { endpoint: 'deployment-approve' })).toEqual(
      failure(400, 'bad_request', '批准部署需要 intentId'),
    )
    for (const [intentId, status, code] of [
      ['dep-forbidden', 403, 'forbidden'],
      ['dep-missing', 404, 'not_found'],
      ['dep-bad', 400, 'bad_request'],
      ['dep-conflict', 409, 'invalid_state'],
    ] as const) {
      const { fetch, callsOf } = setup({
        results: { deploymentApprove: { ok: false, code, message: `拒绝 ${code}` } },
      })
      expect(await post(fetch, { endpoint: 'deployment-approve', intentId }), intentId).toEqual(
        failure(status, code, `拒绝 ${code}`),
      )
      expect(callsOf('deploymentApprove').at(-1)?.input).toEqual({ intentId, by: OWNER })
    }
    const { fetch, callsOf } = setup()
    expect(await post(fetch, { endpoint: 'deployment-approve', intentId: 'dep-ok' })).toEqual(ok())
    expect(callsOf('deploymentApprove').at(-1)?.input).toEqual({ intentId: 'dep-ok', by: OWNER })

    const denied = setup({
      results: { deploymentRequest: { ok: false, code: 'forbidden', message: '拒绝 forbidden' } },
    })
    expect(await post(denied.fetch, { endpoint: 'deployment-intent', targetId: 'plate' })).toEqual(
      failure(403, 'forbidden', '拒绝 forbidden'),
    )
  })

  it('requires an intent id for every deployment action', async () => {
    const { fetch } = setup()
    for (const [endpoint, message] of [
      ['deployment-approve', '批准部署需要 intentId'],
      ['deployment-reject', '拒绝部署需要 intentId'],
      ['deployment-verify', '核对部署需要 intentId'],
      ['deployment-rollback', '回退部署需要 intentId'],
    ] as const) {
      expect(await post(fetch, { endpoint }), endpoint).toEqual(
        failure(400, 'bad_request', message),
      )
    }
  })

  it('forwards reject, verify and rollback actions with reasons and the owner', async () => {
    const { fetch, callsOf } = setup()
    expect(await post(fetch, { endpoint: 'deployment-reject', intentId: 'dep-1' })).toEqual(ok())
    expect(callsOf('deploymentReject').at(-1)?.input).toEqual({
      intentId: 'dep-1',
      by: OWNER,
      reason: '',
    })
    expect(
      await post(fetch, {
        endpoint: 'deployment-rollback',
        intentId: 'dep-1',
        reason: '  回退  ',
      }),
    ).toEqual(ok())
    expect(callsOf('deploymentRollback').at(-1)?.input).toEqual({
      intentId: 'dep-1',
      by: OWNER,
      reason: '回退',
    })
    expect(await post(fetch, { endpoint: 'deployment-verify', intentId: 'dep-1' })).toEqual(ok())
    expect(callsOf('deploymentVerify').at(-1)?.input).toEqual({ intentId: 'dep-1', by: OWNER })
  })

  it('maps reject, verify and rollback conflicts to 409', async () => {
    const conflict = { ok: false, code: 'invalid_state', message: '状态冲突' }
    const { fetch } = setup({
      results: {
        deploymentReject: conflict,
        deploymentVerify: conflict,
        deploymentRollback: conflict,
      },
    })
    for (const endpoint of ['deployment-reject', 'deployment-verify', 'deployment-rollback']) {
      expect(await post(fetch, { endpoint, intentId: 'dep-1' }), endpoint).toEqual(
        failure(409, 'invalid_state', '状态冲突'),
      )
    }
  })
})

describe('owner write endpoints', () => {
  it('rejects every action without its required identities with an exact message', async () => {
    const { fetch } = setup()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ endpoint: 'plan' }, '重新生成任务包需要 reqId'],
      [{ endpoint: 'advance' }, '推进需要 reqId'],
      [{ endpoint: 'verify' }, '独立验证需要 reqId'],
      [{ endpoint: 'requeue' }, '重新执行需要 reqId'],
      [{ endpoint: 'retry-analysis' }, '重新分析需要 reqId'],
      [{ endpoint: 'build' }, '构建候选需要 reqId'],
      [{ endpoint: 'accept' }, '验收需要 reqId'],
      [{ endpoint: 'cancel' }, '取消需要 reqId'],
      [{ endpoint: 'stop' }, '停止需要 reqId'],
      [{ endpoint: 'extend-budget' }, '延长工时需要 reqId'],
      [{ endpoint: 'grant-rounds' }, '追加授权需要 reqId'],
      [{ endpoint: 'deploy' }, '上线核对需要 reqId 与 targetProfile'],
      [{ endpoint: 'deploy', reqId: 'r1' }, '上线核对需要 reqId 与 targetProfile'],
      [{ endpoint: 'deploy', targetProfile: 'p1' }, '上线核对需要 reqId 与 targetProfile'],
      [{ endpoint: 'approve', planVersion: 1 }, '批准需要 reqId 与正整数 planVersion'],
      [{ endpoint: 'retry', planVersion: 1 }, '重试需要 reqId、taskId 与正整数 planVersion'],
      [
        { endpoint: 'retry', reqId: 'r1', planVersion: 1 },
        '重试需要 reqId、taskId 与正整数 planVersion',
      ],
      [
        { endpoint: 'retry', taskId: 't1', planVersion: 1 },
        '重试需要 reqId、taskId 与正整数 planVersion',
      ],
    ]
    for (const [body, message] of cases) {
      expect(await post(fetch, body), JSON.stringify(body)).toEqual(
        failure(400, 'bad_request', message),
      )
    }
  })

  it('rejects malformed plan versions for approve and retry', async () => {
    const { fetch } = setup()
    for (const planVersion of [0, 1.5, '1', undefined]) {
      expect(
        await post(fetch, { endpoint: 'approve', reqId: 'r1', planVersion }),
        String(planVersion),
      ).toEqual(failure(400, 'bad_request', '批准需要 reqId 与正整数 planVersion'))
      expect(
        await post(fetch, { endpoint: 'retry', reqId: 'r1', taskId: 't1', planVersion }),
        String(planVersion),
      ).toEqual(failure(400, 'bad_request', '重试需要 reqId、taskId 与正整数 planVersion'))
    }
  })

  it('submits owner decisions with the plan action source', async () => {
    const { fetch, callsOf } = setup()
    expect(await post(fetch, { endpoint: 'plan', reqId: 'r1', sessionId: 's1' })).toEqual(ok())
    expect(callsOf('requestOperation').at(-1)?.input).toEqual({
      reqId: 'r1',
      action: 'plan',
      by: OWNER,
      source: 'web-decision:s1:plan',
    })
    expect(
      await post(fetch, {
        endpoint: 'plan',
        reqId: 'r1',
        sessionId: 's1',
        confirmPlanChange: true,
        reason: '  范围变更  ',
      }),
    ).toEqual(ok())
    expect(callsOf('requestOperation').at(-1)?.input).toEqual({
      reqId: 'r1',
      action: 'plan',
      by: OWNER,
      source: 'web-decision:s1:plan',
      confirmPlanChange: true,
      reason: '范围变更',
    })
    expect(
      await post(fetch, {
        endpoint: 'plan',
        reqId: 'r1',
        confirmPlanChange: false,
        reason: '   ',
      }),
    ).toEqual(ok())
    expect(callsOf('requestOperation').at(-1)?.input).toEqual({
      reqId: 'r1',
      action: 'plan',
      by: OWNER,
      source: 'web-decision:unknown-session:plan',
    })
  })

  it('approves a plan with the plan version in the source', async () => {
    const { fetch, callsOf } = setup()
    expect((await post(fetch, { endpoint: 'approve', reqId: 'r1', planVersion: 2 })).status).toBe(
      200,
    )
    expect(callsOf('approvePlan').at(-1)?.input).toEqual({
      reqId: 'r1',
      planVersion: 2,
      by: OWNER,
      source: 'web-decision:unknown-session:plan-v2',
    })
  })

  it('maps write failures to 409 with the runtime code', async () => {
    const { fetch } = setup({
      results: {
        requestOperation: { ok: false, code: 'admission_required', message: '缺少准入材料' },
        approvePlan: { ok: false, code: 'conflict', message: '计划已冻结' },
        retryAnalysis: { ok: false, code: 'busy', message: '正在执行' },
        buildCandidate: { ok: false, code: 'not_ready', message: '尚未批准' },
        verifyDeployment: { ok: false, code: 'bad_request', message: '缺少目标' },
        retryTask: { ok: false, code: 'not_failed', message: '任务未失败' },
        accept: { ok: false, code: 'not_delivered', message: '尚未交付' },
        cancel: { ok: false, code: 'terminal', message: '已终止' },
        stop: { ok: false, code: 'terminal', message: '已终止' },
        requeue: { ok: false, code: 'busy', message: '正在执行' },
      },
    })
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ endpoint: 'advance', reqId: 'r1' }, 'admission_required', '缺少准入材料'],
      [{ endpoint: 'verify', reqId: 'r1' }, 'admission_required', '缺少准入材料'],
      [{ endpoint: 'requeue', reqId: 'r1' }, 'busy', '正在执行'],
      [{ endpoint: 'approve', reqId: 'r1', planVersion: 1 }, 'conflict', '计划已冻结'],
      [{ endpoint: 'plan', reqId: 'r1' }, 'admission_required', '缺少准入材料'],
      [{ endpoint: 'retry-analysis', reqId: 'r1' }, 'busy', '正在执行'],
      [{ endpoint: 'build', reqId: 'r1' }, 'not_ready', '尚未批准'],
      [{ endpoint: 'deploy', reqId: 'r1', targetProfile: 'p1' }, 'bad_request', '缺少目标'],
      [
        { endpoint: 'retry', reqId: 'r1', taskId: 't1', planVersion: 1 },
        'not_failed',
        '任务未失败',
      ],
      [{ endpoint: 'accept', reqId: 'r1' }, 'not_delivered', '尚未交付'],
      [{ endpoint: 'cancel', reqId: 'r1' }, 'terminal', '已终止'],
      [{ endpoint: 'stop', reqId: 'r1' }, 'terminal', '已终止'],
    ]
    for (const [body, code, message] of cases) {
      expect(await post(fetch, body), JSON.stringify(body)).toEqual(failure(409, code, message))
    }
  })

  it('returns normalized success bodies for the remaining owner actions', async () => {
    const { fetch } = setup()
    for (const body of [
      { endpoint: 'advance', reqId: 'r1', sessionId: 's1' },
      { endpoint: 'verify', reqId: 'r1' },
      { endpoint: 'requeue', reqId: 'r1' },
      { endpoint: 'retry-analysis', reqId: 'r1', sessionId: 's1' },
      { endpoint: 'build', reqId: 'r1' },
      { endpoint: 'deploy', reqId: 'r1', targetProfile: 'p1' },
      { endpoint: 'retry', reqId: 'r1', taskId: 't1', planVersion: 1 },
      { endpoint: 'accept', reqId: 'r1' },
      { endpoint: 'cancel', reqId: 'r1' },
    ]) {
      expect(await post(fetch, body), JSON.stringify(body)).toEqual(ok())
    }
  })

  it('forwards optional build version and acceptance digest only when present', async () => {
    const { fetch, callsOf } = setup()
    expect((await post(fetch, { endpoint: 'build', reqId: 'r1' })).status).toBe(200)
    expect(callsOf('buildCandidate').at(-1)?.input).toEqual({ reqId: 'r1', by: OWNER })
    expect(
      (await post(fetch, { endpoint: 'build', reqId: 'r1', version: '  1.2.3 ' })).status,
    ).toBe(200)
    expect(callsOf('buildCandidate').at(-1)?.input).toEqual({
      reqId: 'r1',
      by: OWNER,
      version: '1.2.3',
    })
    expect((await post(fetch, { endpoint: 'accept', reqId: 'r1' })).status).toBe(200)
    expect(callsOf('accept').at(-1)?.input).toEqual({
      reqId: 'r1',
      by: OWNER,
      source: 'web-decision:unknown-session:accept',
    })
    expect(
      (await post(fetch, { endpoint: 'accept', reqId: 'r1', artifactSha256: '  abc  ' })).status,
    ).toBe(200)
    expect(callsOf('accept').at(-1)?.input).toEqual({
      reqId: 'r1',
      by: OWNER,
      source: 'web-decision:unknown-session:accept',
      artifactSha256: 'abc',
    })
  })

  it('cancels through the coordinator and falls back to the web reason', async () => {
    const { fetch, callsOf } = setup()
    expect((await post(fetch, { endpoint: 'cancel', reqId: 'r1', sessionId: 's1' })).status).toBe(
      200,
    )
    expect(callsOf('abortRequirement').at(-1)?.input).toBe('r1')
    expect(callsOf('cancel').at(-1)?.input).toEqual({
      reqId: 'r1',
      by: OWNER,
      reason: 'Web 取消请求（s1）',
    })
    expect((await post(fetch, { endpoint: 'cancel', reqId: 'r1', reason: '不要了' })).status).toBe(
      200,
    )
    expect(callsOf('cancel').at(-1)?.input).toEqual({
      reqId: 'r1',
      by: OWNER,
      reason: '不要了',
    })
    expect((await post(fetch, { endpoint: 'cancel', reqId: 'r1' })).status).toBe(200)
    expect(callsOf('cancel').at(-1)?.input).toEqual({
      reqId: 'r1',
      by: OWNER,
      reason: 'Web 取消请求（unknown-session）',
    })
  })

  it('merges the abort flag into the stop result', async () => {
    const { fetch, callsOf } = setup({
      aborted: false,
      results: { stop: { ok: true, code: 'ok', message: 'ok', data: { stopped: true } } },
    })
    expect(await post(fetch, { endpoint: 'stop', reqId: 'r1' })).toEqual(
      ok({ stopped: true, aborted: false }),
    )
    expect(callsOf('stop').at(-1)?.input).toEqual({
      reqId: 'r1',
      by: OWNER,
      reason: 'Web 停止请求',
    })
    expect(callsOf('abortRequirement').at(-1)?.input).toBe('r1')
  })

  it('keeps the abort flag when the stop result is not an object', async () => {
    const { fetch } = setup({
      aborted: true,
      results: { stop: { ok: true, code: 'ok', message: 'ok', data: null } },
    })
    expect(await post(fetch, { endpoint: 'stop', reqId: 'r1' })).toEqual(ok({ aborted: true }))
  })

  it('extends the work budget and grants rounds through the repository', async () => {
    const extensions: Array<Record<string, unknown>> = []
    const repository = {
      getRequirement: () => ({
        reqId: 'r1',
        status: 'blocked',
        blockedReason: '执行工时已用尽；需要延长',
      }),
      budget: () => ({ limitSeconds: 100, consumedSeconds: 10 }),
      extendBudget: (_reqId: string, seconds: number) => 100 + seconds,
      recordBudgetExtension: (input: Record<string, unknown>) => {
        extensions.push(input)
      },
      grantCount: () => 1,
      appendGrant: () => 2,
      setStatus: () => undefined,
    }
    const { fetch } = setup({ repo: repository })
    expect(
      await post(fetch, {
        endpoint: 'extend-budget',
        reqId: 'r1',
        seconds: '3600',
        sessionId: 's1',
      }),
    ).toEqual(ok({ limitSeconds: 3700, consumedSeconds: 10, extendedSeconds: 3600 }))
    expect(extensions.at(-1)).toMatchObject({
      reqId: 'r1',
      seconds: 3600,
      extendedBy: OWNER,
      source: 'web-decision:s1:extend-budget',
    })
    expect(await post(fetch, { endpoint: 'extend-budget', reqId: 'r1', seconds: 60 })).toEqual(
      ok({ limitSeconds: 160, consumedSeconds: 10, extendedSeconds: 60 }),
    )
    expect(extensions.at(-1)).toMatchObject({
      reqId: 'r1',
      seconds: 60,
      extendedBy: OWNER,
      source: 'web-decision:unknown-session:extend-budget',
    })
    expect(await post(fetch, { endpoint: 'grant-rounds', reqId: 'r1', sessionId: 's1' })).toEqual(
      ok({ grantCount: 2, addedRounds: 3 }),
    )
  })

  it('maps repository refusals for budget and grants to 409', async () => {
    const { fetch } = setup({ repo: { getRequirement: () => null } })
    expect(await post(fetch, { endpoint: 'extend-budget', reqId: 'r9', seconds: 60 })).toEqual(
      failure(409, 'not_found', '未找到需求 r9'),
    )
    expect(await post(fetch, { endpoint: 'grant-rounds', reqId: 'r9' })).toEqual(
      failure(409, 'not_found', '未找到需求 r9'),
    )
  })
})

describe('ops endpoints', () => {
  it('serves the ops overview without event identity', async () => {
    const { fetch } = setup({
      results: { opsStatus: { ok: true, code: 'ok', message: 'ok', data: { events: [] } } },
    })
    expect(await post(fetch, { endpoint: 'ops' })).toEqual(ok({ events: [] }))
  })

  it('requires an event id for ops detail and maps misses to 404', async () => {
    const { fetch } = setup()
    expect(await post(fetch, { endpoint: 'ops-detail' })).toEqual(
      failure(400, 'bad_request', '缺少运维事件 eventId'),
    )
    expect(await post(fetch, { endpoint: 'ops-detail', eventId: 'e1' })).toEqual(
      ok({ eventId: 'e1' }),
    )
    const { fetch: failing } = setup({
      results: { opsStatus: { ok: false, code: 'not_found', message: '未找到事件 e9' } },
    })
    expect(await post(failing, { endpoint: 'ops-detail', eventId: 'e9' })).toEqual(
      failure(404, 'not_found', '未找到事件 e9'),
    )
  })

  it('accepts only approve/decline decisions and records the source', async () => {
    const { fetch, callsOf } = setup()
    const message = '处置决定需要 eventId 与 approve/decline'
    expect(await post(fetch, { endpoint: 'ops-decide', eventId: 'e1' })).toEqual(
      failure(400, 'bad_request', message),
    )
    expect(
      await post(fetch, { endpoint: 'ops-decide', eventId: 'e1', decision: 'ignore' }),
    ).toEqual(failure(400, 'bad_request', message))
    expect(
      await post(fetch, { endpoint: 'ops-decide', eventId: 'e1', decision: 'decline' }),
    ).toEqual(ok())
    expect(callsOf('opsDecide').at(-1)?.input).toEqual({
      eventId: 'e1',
      decision: 'decline',
      by: OWNER,
      source: 'web-decision:unknown-session:ops-decline',
    })
    expect(
      await post(fetch, {
        endpoint: 'ops-decide',
        eventId: 'e1',
        decision: 'approve',
        sessionId: 's2',
        reason: '  先恢复流量  ',
      }),
    ).toEqual(ok())
    expect(callsOf('opsDecide').at(-1)?.input).toEqual({
      eventId: 'e1',
      decision: 'approve',
      by: OWNER,
      source: 'web-decision:s2:ops-approve',
      reason: '先恢复流量',
    })
  })

  it('closes an event with a web fallback reason', async () => {
    const { fetch, callsOf } = setup()
    expect(await post(fetch, { endpoint: 'ops-close' })).toEqual(
      failure(400, 'bad_request', '关闭事件需要 eventId'),
    )
    expect(await post(fetch, { endpoint: 'ops-close', eventId: 'e1' })).toEqual(ok())
    expect(callsOf('opsClose').at(-1)?.input).toEqual({
      eventId: 'e1',
      by: OWNER,
      reason: 'Web 关闭（unknown-session）',
    })
    expect(
      await post(fetch, {
        endpoint: 'ops-close',
        eventId: 'e1',
        sessionId: 's1',
        reason: '已处理',
      }),
    ).toEqual(ok())
    expect(callsOf('opsClose').at(-1)?.input).toEqual({
      eventId: 'e1',
      by: OWNER,
      reason: '已处理',
    })
    expect(await post(fetch, { endpoint: 'ops-close', eventId: 'e1', sessionId: 's1' })).toEqual(
      ok(),
    )
    expect(callsOf('opsClose').at(-1)?.input).toEqual({
      eventId: 'e1',
      by: OWNER,
      reason: 'Web 关闭（s1）',
    })
  })

  it('requests a fix requirement with the ops source', async () => {
    const { fetch, callsOf } = setup()
    expect(await post(fetch, { endpoint: 'ops-request-fix' })).toEqual(
      failure(400, 'bad_request', '生成修复需求需要 eventId'),
    )
    expect(
      await post(fetch, { endpoint: 'ops-request-fix', eventId: 'e1', sessionId: 's2' }),
    ).toEqual(ok())
    expect(callsOf('opsRequestFix').at(-1)?.input).toEqual({
      eventId: 'e1',
      by: OWNER,
      source: 'web-decision:s2:ops-fix',
    })
  })

  it('maps ops write conflicts to 409', async () => {
    const { fetch } = setup({
      results: {
        opsDecide: { ok: false, code: 'invalid_state', message: '事件已关闭' },
        opsClose: { ok: false, code: 'invalid_state', message: '事件已关闭' },
        opsRequestFix: { ok: false, code: 'not_found', message: '未找到事件 e9' },
      },
    })
    expect(
      await post(fetch, { endpoint: 'ops-decide', eventId: 'e1', decision: 'approve' }),
    ).toEqual(failure(409, 'invalid_state', '事件已关闭'))
    expect(await post(fetch, { endpoint: 'ops-close', eventId: 'e1' })).toEqual(
      failure(409, 'invalid_state', '事件已关闭'),
    )
    expect(await post(fetch, { endpoint: 'ops-request-fix', eventId: 'e9' })).toEqual(
      failure(409, 'not_found', '未找到事件 e9'),
    )
  })
})

describe('response and attribution contracts', () => {
  it('labels every response, including failures, as JSON', async () => {
    const { fetch } = setup()
    const okResponse = await fetch(
      new Request('http://127.0.0.1/api/forgeloop/board', {
        method: 'POST',
        body: JSON.stringify({ endpoint: 'board' }),
      }),
    )
    expect(okResponse.headers.get('content-type')).toBe('application/json')
    const badResponse = await fetch(
      new Request('http://127.0.0.1/api/forgeloop/board', {
        method: 'POST',
        body: 'not-json',
      }),
    )
    expect(badResponse.status).toBe(400)
    expect(badResponse.headers.get('content-type')).toBe('application/json')
  })

  it('stamps the owner and a session-scoped source on every write action', async () => {
    const cases: Array<[Record<string, unknown>, string, string, string]> = [
      [
        { endpoint: 'plan', reqId: 'r1' },
        'requestOperation',
        'web-decision:s1:plan',
        'web-decision:unknown-session:plan',
      ],
      [
        { endpoint: 'approve', reqId: 'r1', planVersion: 1 },
        'approvePlan',
        'web-decision:s1:plan-v1',
        'web-decision:unknown-session:plan-v1',
      ],
      [
        { endpoint: 'advance', reqId: 'r1' },
        'requestOperation',
        'web-decision:s1:advance',
        'web-decision:unknown-session:advance',
      ],
      [
        { endpoint: 'verify', reqId: 'r1' },
        'requestOperation',
        'web-decision:s1:verify',
        'web-decision:unknown-session:verify',
      ],
      [
        { endpoint: 'requeue', reqId: 'r1' },
        'requeue',
        'web-decision:s1',
        'web-decision:unknown-session',
      ],
      [
        { endpoint: 'retry-analysis', reqId: 'r1' },
        'retryAnalysis',
        'web-decision:s1',
        'web-decision:unknown-session',
      ],
      [
        { endpoint: 'deploy', reqId: 'r1', targetProfile: 'p1' },
        'verifyDeployment',
        'web-decision:s1:deploy',
        'web-decision:unknown-session:deploy',
      ],
      [
        { endpoint: 'retry', reqId: 'r1', taskId: 't1', planVersion: 1 },
        'retryTask',
        'web-decision:s1',
        'web-decision:unknown-session',
      ],
      [
        { endpoint: 'accept', reqId: 'r1' },
        'accept',
        'web-decision:s1:accept',
        'web-decision:unknown-session:accept',
      ],
      [
        { endpoint: 'ops-decide', eventId: 'e1', decision: 'approve' },
        'opsDecide',
        'web-decision:s1:ops-approve',
        'web-decision:unknown-session:ops-approve',
      ],
      [
        { endpoint: 'ops-request-fix', eventId: 'e1' },
        'opsRequestFix',
        'web-decision:s1:ops-fix',
        'web-decision:unknown-session:ops-fix',
      ],
    ]
    for (const [body, method, withSession, withoutSession] of cases) {
      const first = setup()
      expect((await post(first.fetch, { ...body, sessionId: 's1' })).status).toBe(200)
      expect(first.callsOf(method).at(-1)?.input).toMatchObject({
        by: OWNER,
        source: withSession,
      })
      const second = setup()
      expect((await post(second.fetch, body)).status).toBe(200)
      expect(second.callsOf(method).at(-1)?.input).toMatchObject({
        by: OWNER,
        source: withoutSession,
      })
    }
  })
})
