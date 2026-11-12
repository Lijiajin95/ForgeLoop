import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { projectDir, resolveConfig, type RawConfig } from '../src/config.js'
import { installSessionSurface } from '../src/session/index.js'
import type { WorkspaceIdentity } from '../src/runtime/workspace-tenants.js'

/**
 * 插件装配层的工作区模式：有 DSH 工作区服务时按会话解析租户并拒绝未绑定会话；
 * 没有该服务的宿主（headless）保持单项目兼容。这里不启动真实 DSH，只固定装配接线。
 */

interface RegisteredRoute {
  path: string
  methods: string[]
  fetch: (request: Request) => Promise<Response>
}

interface RegisteredTool {
  name: string
  execute(args: unknown, exec: Record<string, unknown>): Promise<unknown>
}

let dir = ''
let cleanups: Array<() => Promise<void> | void> = []

function workspace(id: string): WorkspaceIdentity {
  return { id, path: join(dir, `workspace-${id}`), title: id }
}

function host(
  options: {
    workspaces?: readonly WorkspaceIdentity[]
    sessions?: Record<string, string>
    readSession?: (sessionId: string) => Promise<{ header?: { cwd?: string } }>
    byPathThrows?: boolean
  } = {},
) {
  const tools: RegisteredTool[] = []
  const routes: RegisteredRoute[] = []
  const services: Record<string, unknown> = {}
  if (options.workspaces) {
    services.workspaceRegistry = {
      list: () => [...options.workspaces!],
      resolveByPath: async (path: string) => {
        if (options.byPathThrows) throw new Error('ENOENT')
        return options.workspaces!.find((item) => item.path === path)
      },
    }
  }
  services.sessions = {
    get: (sessionId: string) => {
      const cwd = options.sessions?.[sessionId]
      return cwd ? { header: { cwd } } : undefined
    },
  }
  if (options.readSession) {
    services.sessionQuery = { readSession: options.readSession }
  }
  const ctx: Record<string, unknown> = {
    agents: {},
    agentLoop: {},
    get: (name: string) => services[name],
    tools: {
      register: (definition: unknown) => {
        tools.push(definition as RegisteredTool)
        return () => undefined
      },
    },
    effect: (callback: () => unknown) => {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => Promise<void>)
      return () => undefined
    },
    inject: (_deps: readonly string[], callback: (scope: unknown) => void) => {
      callback({
        connection: {
          fetch: {
            register: (route: RegisteredRoute) => {
              routes.push(route)
              return async () => undefined
            },
          },
        },
        effect: (callback2: () => unknown) => {
          const cleanup = callback2()
          if (typeof cleanup === 'function') cleanups.push(cleanup as () => Promise<void>)
          return () => undefined
        },
      })
    },
  }
  return { ctx, tools, routes }
}

function rawConfig(): RawConfig {
  return {
    project: 'legacy',
    projectPath: join(dir, 'legacy-project'),
    recordsRoot: join(dir, 'records'),
    owner: 'owner',
    pollSeconds: 3600,
    autoAdvance: false,
  }
}

async function call(
  route: RegisteredRoute,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await route.fetch(
    new Request('http://localhost/api/forgeloop/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return {
    status: response.status,
    payload: (await response.json()) as Record<string, unknown>,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-wiring-'))
  cleanups = []
})

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup()
    } catch {
      // 每个清理独立执行。
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('plugin wiring with DSH workspaces', () => {
  it('preloads registered workspaces into isolated record directories', async () => {
    const hosted = host({ workspaces: [workspace('a'), workspace('b')] })
    apply(hosted.ctx, rawConfig())

    const config = resolveConfig(rawConfig(), dir)
    const projectA = projectDir({
      ...config,
      project: 'ws-a',
      projectPath: workspace('a').path,
    })
    await waitFor(() => existsSync(projectA))

    expect(projectA).toContain('ws-a')
    expect(hosted.routes).toHaveLength(1)
    expect(hosted.tools.length).toBeGreaterThan(0)
  })

  it('rejects tool calls and board requests that are not bound to a workspace', async () => {
    const hosted = host({
      workspaces: [workspace('a')],
      sessions: { 'session-a': workspace('a').path, 'session-unknown': join(dir, 'elsewhere') },
    })
    apply(hosted.ctx, rawConfig())
    const status = hosted.tools.find((tool) => tool.name === 'forgeloop_status')
    expect(status).toBeDefined()

    const noAgent = (await status!.execute({}, {})) as { ok: boolean; text: string }
    expect(noAgent.ok).toBe(false)
    expect(noAgent.text).toContain('工作区')

    const missing = await call(hosted.routes[0]!, { endpoint: 'board' })
    expect(missing.status).toBe(400)
    expect((missing.payload.error as { code: string }).code).toBe('session_required')

    const unbound = await call(hosted.routes[0]!, {
      endpoint: 'board',
      sessionId: 'session-unknown',
    })
    expect(unbound.status).toBe(403)
    expect((unbound.payload.error as { code: string }).code).toBe('workspace_unbound')

    const unboundTool = (await status!.execute(
      {},
      { agent: { session: { header: { cwd: join(dir, 'not-a-workspace') } } } },
    )) as { ok: boolean; text: string }
    expect(unboundTool.ok).toBe(false)
    expect(unboundTool.text).toContain('工作区')
  })

  it('resolves a cold session through its persisted header', async () => {
    const hosted = host({
      workspaces: [workspace('a')],
      readSession: async () => ({ header: { cwd: workspace('a').path } }),
    })
    apply(hosted.ctx, rawConfig())

    const board = await call(hosted.routes[0]!, { endpoint: 'board', sessionId: 'session-cold' })

    expect(board.status).toBe(200)
    expect((board.payload.value as { project: string }).project).toBe('ws-a')
  })

  it('rejects a session whose persisted lookup fails or records no cwd', async () => {
    const throwing = host({
      workspaces: [workspace('a')],
      readSession: async () => {
        throw new Error('missing session')
      },
    })
    apply(throwing.ctx, rawConfig())
    const failed = await call(throwing.routes[0]!, {
      endpoint: 'board',
      sessionId: 'session-missing',
    })
    expect(failed.status).toBe(403)

    const empty = host({
      workspaces: [workspace('a')],
      readSession: async () => ({ header: {} }),
    })
    apply(empty.ctx, rawConfig())
    const noCwd = await call(empty.routes[0]!, { endpoint: 'board', sessionId: 'session-nocwd' })
    expect(noCwd.status).toBe(403)
  })

  it('treats a registry path lookup failure as an unbound session', async () => {
    const hosted = host({
      workspaces: [workspace('a')],
      byPathThrows: true,
      sessions: { 'session-x': join(dir, 'somewhere') },
    })
    apply(hosted.ctx, rawConfig())

    const board = await call(hosted.routes[0]!, { endpoint: 'board', sessionId: 'session-x' })

    expect(board.status).toBe(403)
    expect((board.payload.error as { code: string }).code).toBe('workspace_unbound')
  })

  it('refuses business input from a session outside every workspace', async () => {
    const hosted = host({ workspaces: [workspace('a')] })
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    hosted.ctx.on = (_event: string, handler: typeof listener) => {
      listener = handler
      return () => undefined
    }
    hosted.ctx.agentPresets = {
      register: async () => async () => undefined,
      composedPreset: () => 'forgeloop',
    }
    apply(hosted.ctx, rawConfig())

    const decision = await listener!(
      {
        agent: {
          session: {
            id: 'session-outside',
            header: { agentPreset: 'forgeloop', cwd: join(dir, 'outside') },
            append: (type: string, data: Record<string, unknown>) => {
              events.push({ type, data })
            },
          },
          ctx: {},
        },
        messages: [
          { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '需求' }] },
        ],
        turn: 1,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )

    expect(decision).toEqual({ kind: 'reject' })
    expect(events.some((event) => event.type === 'plugin:forgeloop/error')).toBe(true)
  })

  it('serves the workspace board for a bound session', async () => {
    const hosted = host({
      workspaces: [workspace('a')],
      sessions: { 'session-a': workspace('a').path },
    })
    apply(hosted.ctx, rawConfig())
    const status = hosted.tools.find((tool) => tool.name === 'forgeloop_status')!
    const scoped = (await status.execute(
      {},
      {
        agent: { session: { header: { cwd: workspace('a').path } } },
      },
    )) as { ok: boolean }
    expect(scoped.ok).toBe(true)

    const board = await call(hosted.routes[0]!, { endpoint: 'board', sessionId: 'session-a' })
    expect(board.status).toBe(200)
    expect((board.payload.value as { project: string }).project).toBe('ws-a')
  })
})

describe('plugin wiring without a workspace service', () => {
  it('keeps the single-project mode for hosts without DSH workspaces', async () => {
    const hosted = host()
    apply(hosted.ctx, rawConfig())
    const status = hosted.tools.find((tool) => tool.name === 'forgeloop_status')!

    const unscoped = (await status.execute({}, {})) as { ok: boolean }
    expect(unscoped.ok).toBe(true)

    const board = await call(hosted.routes[0]!, { endpoint: 'board' })
    expect(board.status).toBe(200)
    expect((board.payload.value as { project: string }).project).toBe('legacy')
  })
})

describe('business session intake with workspaces', () => {
  it('rejects a business session that is not bound to any workspace', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const ctx = {
      on: (_event: string, handler: typeof listener) => {
        listener = handler
        return () => undefined
      },
      agentPresets: { register: async () => async () => undefined },
    }
    const surface = installSessionSurface(ctx, {
      log: () => undefined,
      tenants: { forCwd: async () => undefined },
    })
    expect(listener).toBeDefined()
    const decision = await listener!(
      {
        agent: {
          session: {
            id: 'session-unbound',
            header: { agentPreset: 'forgeloop', cwd: join(dir, 'not-a-workspace') },
            append: (type: string, data: Record<string, unknown>) => {
              events.push({ type, data })
            },
          },
          ctx: {},
        },
        messages: [
          {
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: '做一个业务功能' }],
          },
        ],
        turn: 1,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )

    expect(decision).toEqual({ kind: 'reject' })
    const error = events.find((event) => event.type === 'plugin:forgeloop/error')
    expect(error?.data.message).toContain('工作区')
    await surface.dispose()
  })

  it('reuses one intake per workspace for bound sessions', async () => {
    const submissions: unknown[] = []
    const runtime = {
      pendingClarifications: () => [],
      submit: (input: unknown) => {
        submissions.push(input)
        return { ok: false, message: '测试阻止继续', data: undefined }
      },
    } as never
    const config = { owner: 'owner' } as never
    let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const surface = installSessionSurface(
      {
        on: (_event: string, handler: typeof listener) => {
          listener = handler
          return () => undefined
        },
        agentPresets: { register: async () => async () => undefined },
      },
      {
        log: () => undefined,
        tenants: {
          forCwd: async (cwd) =>
            cwd === workspace('a').path ? { id: 'tenant-a', runtime, config } : undefined,
        },
      },
    )
    const payload = {
      agent: {
        session: {
          id: 'session-a',
          header: { agentPreset: 'forgeloop', cwd: workspace('a').path },
          append: () => undefined,
        },
        ctx: {},
      },
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '需求一' }] },
      ],
      turn: 1,
    }

    await listener!(payload, async () => ({ kind: 'enter', messages: [] }))
    await listener!(
      {
        ...payload,
        messages: [
          {
            id: 'message-2',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: '需求二' }],
          },
        ],
        turn: 2,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )

    expect(submissions).toHaveLength(2)
    await surface.dispose()
  })

  it('rejects when no workspace source and no single-project runtime exist', async () => {
    let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const surface = installSessionSurface(
      {
        on: (_event: string, handler: typeof listener) => {
          listener = handler
          return () => undefined
        },
        agentPresets: { register: async () => async () => undefined },
      },
      {},
    )

    const decision = await listener!({ agent: undefined, messages: [] }, async () => ({
      kind: 'enter',
      messages: [],
    }))

    expect(decision).toEqual({ kind: 'reject' })
    await surface.dispose()
  })

  it('leaves non-ForgeLoop presets to the next handler and survives registration failures', async () => {
    let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const surface = installSessionSurface(
      {
        on: (_event: string, handler: typeof listener) => {
          listener = handler
          return () => {
            throw new Error('listener dispose failed')
          }
        },
        agentPresets: {
          composedPreset: (ctx: { preset?: string }) => ctx.preset,
          register: async () => {
            throw new Error('register failed')
          },
        },
      },
      { tenants: { forCwd: async () => undefined } },
    )
    const ready = await surface.ready
    expect(ready.ok).toBe(false)
    expect(ready.reason).toContain('register failed')

    const decision = await listener!(
      {
        agent: {
          session: { id: 'chat', header: { agentPreset: 'forgeloop' } },
          ctx: { preset: 'standard' },
        },
        messages: [
          { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '聊天' }] },
        ],
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [] })

    const noCwd = await listener!(
      {
        agent: {
          session: { id: 'no-cwd', header: { agentPreset: 'forgeloop' } },
          ctx: { preset: 'forgeloop' },
        },
        messages: [
          { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '需求' }] },
        ],
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(noCwd).toEqual({ kind: 'reject' })

    await surface.dispose()
  })
})
