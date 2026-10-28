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

    const unknown = await route.fetch(post(JSON.stringify({ endpoint: 'approve' })))
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

    const missingId = await route.fetch(post(JSON.stringify({ endpoint: 'detail' })))
    expect(missingId.status).toBe(400)

    const unknown = await route.fetch(post(JSON.stringify({ endpoint: 'detail', reqId: 'req-nope' })))
    expect(unknown.status).toBe(404)

    await host.cleanup()
  })

  it('stays inert in profiles without a browser Fetch registry', () => {
    const host = fakeHost({ withFetch: false })
    start(host)
    expect(host.injected()).toBe(true)
    expect(host.routes).toEqual([])
    host.cleanup()
  })
})
