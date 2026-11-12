import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectDir, recordsPath, resolveConfig, type RawConfig } from '../src/config.js'
import type { Coordinator } from '../src/runtime/coordinator.js'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { createScopedBoardFetch } from '../src/runtime/board-route.js'
import {
  WorkspaceTenants,
  workspaceProjectName,
  type WorkspaceIdentity,
} from '../src/runtime/workspace-tenants.js'
import { buildScopedTools, type ToolScopeResolution } from '../src/tools.js'

/**
 * 多工作区隔离：两个真实 SQLite 租户，验证工具与看板只能看到调用者会话所属工作区。
 * 拒绝侧与放行侧都断言，避免“只测了不报错”。
 */

let dir = ''
let tenants: WorkspaceTenants | undefined
let cleanups: Array<() => void> = []

function workspace(id: string): WorkspaceIdentity {
  return { id, path: join(dir, `workspace-${id}`), title: id }
}

const stubCoordinator = {
  start: () => undefined,
  stop: async () => undefined,
} as unknown as Coordinator

/** 镜像生产装配的解析规则：等值工作区路径或租户记录目录内的会话目录。 */
function resolver(
  source: WorkspaceTenants,
): (exec: Record<string, unknown>) => Promise<ToolScopeResolution> {
  return async (exec) => {
    const agent = exec.agent as { session?: { header?: { cwd?: string } } } | undefined
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || !cwd) {
      return {
        ok: false,
        text: '当前工具调用没有会话目录：ForgeLoop 只在已绑定 DSH 工作区的会话中工作',
      }
    }
    const tenant = await source.forCwd(cwd)
    if (!tenant) return { ok: false, text: '当前会话没有绑定 DSH 工作区' }
    return { ok: true, scope: { runtime: tenant.runtime, config: tenant.config } }
  }
}

function execAt(cwd: string): { agent: { session: { header: { cwd: string } } } } {
  return { agent: { session: { header: { cwd } } } }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-isolation-'))
  cleanups = []
  const raw: RawConfig = {
    project: 'legacy',
    projectPath: join(dir, 'legacy-project'),
    recordsRoot: join(dir, 'records'),
    owner: 'owner',
    pollSeconds: 3600,
    autoAdvance: false,
  }
  const base = resolveConfig(raw, dir)
  tenants = new WorkspaceTenants({
    raw,
    cwd: dir,
    base,
    workspaces: {
      list: async () => [workspace('a'), workspace('b')],
      byPath: async (path) => [workspace('a'), workspace('b')].find((item) => item.path === path),
    },
    sessionCwd: async (sessionId) =>
      sessionId === 'session-a'
        ? workspace('a').path
        : sessionId === 'session-b'
          ? workspace('b').path
          : undefined,
    create: (config) => {
      const runtime = new ForgeLoopRuntime({ ctx: {}, config })
      cleanups.push(() => runtime.close())
      return { runtime, coordinator: stubCoordinator }
    },
    log: () => undefined,
  })
})

afterEach(async () => {
  await tenants?.dispose()
  tenants = undefined
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch {
      // 已由 dispose 关闭时忽略重复关闭。
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('workspace data isolation', () => {
  it('gives each workspace its own database file', async () => {
    const a = await tenants!.forCwd(workspace('a').path)
    const b = await tenants!.forCwd(workspace('b').path)

    expect(recordsPath(a!.config)).not.toBe(recordsPath(b!.config))
    expect(projectDir(a!.config)).toContain(workspaceProjectName('a'))
    expect(projectDir(b!.config)).toContain(workspaceProjectName('b'))
  })

  it('lets a session read its own workspace and refuses another workspace', async () => {
    const a = await tenants!.forCwd(workspace('a').path)
    const b = await tenants!.forCwd(workspace('b').path)
    const submitted = a!.runtime.submit({
      text: '工作区 A 的需求',
      by: 'owner',
      source: 'test',
      clientKey: 'isolation-1',
      analyze: false,
    })
    const reqId = (submitted.data as { reqId: string }).reqId
    const tools = buildScopedTools(resolver(tenants!))
    const status = tools.find((tool) => tool.name === 'forgeloop_status')!
    const show = tools.find((tool) => tool.name === 'forgeloop_show_requirement')!
    const boardA = await status.execute({}, execAt(workspace('a').path))
    const boardB = await status.execute({}, execAt(workspace('b').path))

    expect(JSON.stringify(boardA)).toContain(reqId)
    expect(JSON.stringify(boardB)).not.toContain(reqId)

    const own = (await show.execute({ req_id: reqId }, execAt(workspace('a').path))) as {
      ok: boolean
    }
    const foreign = (await show.execute({ req_id: reqId }, execAt(workspace('b').path))) as {
      ok: boolean
      text: string
    }
    expect(own.ok).toBe(true)
    expect(foreign.ok).toBe(false)
    expect(foreign.text).toContain(reqId)
    expect(b!.runtime.status(reqId).ok).toBe(false)
  })

  it('refuses tool calls without a workspace-bound session', async () => {
    const tools = buildScopedTools(resolver(tenants!))
    const status = tools.find((tool) => tool.name === 'forgeloop_status')!

    const noAgent = (await status.execute({}, {})) as { ok: boolean; text: string }
    const unbound = (await status.execute({}, execAt(join(dir, 'not-a-workspace')))) as {
      ok: boolean
      text: string
    }

    expect(noAgent.ok).toBe(false)
    expect(noAgent.text).toContain('工作区')
    expect(unbound.ok).toBe(false)
    expect(unbound.text).toContain('工作区')
  })
})

describe('workspace board isolation', () => {
  function fetchFor(source: WorkspaceTenants) {
    return createScopedBoardFetch(async (sessionId) => {
      const tenant = await source.forSession(sessionId)
      return tenant
        ? { runtime: tenant.runtime, config: tenant.config, coordinator: tenant.coordinator }
        : undefined
    })
  }

  async function call(
    fetch: (request: Request) => Promise<Response>,
    body: Record<string, unknown>,
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const response = await fetch(
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

  it('serves only the workspace of the requesting session', async () => {
    const fetch = fetchFor(tenants!)
    const a = await tenants!.forSession('session-a')
    const reqId = (
      a!.runtime.submit({
        text: '工作区 A 的需求',
        by: 'owner',
        source: 'test',
        clientKey: 'board-1',
        analyze: false,
      }).data as { reqId: string }
    ).reqId

    const boardA = await call(fetch, { endpoint: 'board', sessionId: 'session-a' })
    const boardB = await call(fetch, { endpoint: 'board', sessionId: 'session-b' })

    expect(boardA.status).toBe(200)
    expect(boardA.payload.ok).toBe(true)
    expect(JSON.stringify(boardA.payload)).toContain(reqId)
    expect(boardB.status).toBe(200)
    expect(JSON.stringify(boardB.payload)).not.toContain(reqId)
    expect((boardA.payload.value as { project: string }).project).toBe(workspaceProjectName('a'))
    expect((boardB.payload.value as { project: string }).project).toBe(workspaceProjectName('b'))
  })

  it('rejects a detail request from another workspace', async () => {
    const fetch = fetchFor(tenants!)
    const a = await tenants!.forSession('session-a')
    const reqId = (
      a!.runtime.submit({
        text: '工作区 A 的需求',
        by: 'owner',
        source: 'test',
        clientKey: 'board-2',
        analyze: false,
      }).data as { reqId: string }
    ).reqId

    const own = await call(fetch, { endpoint: 'detail', reqId, sessionId: 'session-a' })
    const foreign = await call(fetch, { endpoint: 'detail', reqId, sessionId: 'session-b' })

    expect(own.status).toBe(200)
    expect(foreign.status).toBe(404)
    expect((foreign.payload.error as { code: string }).code).toBe('not_found')
  })

  it('rejects a request without a session or with an unbound session', async () => {
    const fetch = fetchFor(tenants!)

    const missing = await call(fetch, { endpoint: 'board' })
    const unbound = await call(fetch, { endpoint: 'board', sessionId: 'session-unknown' })

    expect(missing.status).toBe(400)
    expect((missing.payload.error as { code: string }).code).toBe('session_required')
    expect(unbound.status).toBe(403)
    expect((unbound.payload.error as { code: string }).code).toBe('workspace_unbound')
  })
})
