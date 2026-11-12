import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  projectDir,
  recordsPath,
  resolveConfig,
  type ForgeLoopConfig,
  type RawConfig,
} from '../src/config.js'
import {
  WorkspaceTenants,
  workspaceProjectName,
  type WorkspaceIdentity,
} from '../src/runtime/workspace-tenants.js'

interface BuildOptions {
  readonly legacyProjectPath?: string
  /** 已注册工作区 id；默认 a、b，路径为 `<临时目录>/<id>`。 */
  readonly workspaceIds?: readonly string[]
  /** 指定项目名在创建运行时抛错，用于验证单个工作区失败不影响其余工作区。 */
  readonly failForProject?: string
}

function setup(options: BuildOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-tenant-'))
  const legacyProjectPath = options.legacyProjectPath ?? join(dir, 'legacy-project')
  const raw: RawConfig = {
    project: 'legacy',
    projectPath: legacyProjectPath,
    recordsRoot: join(dir, 'records'),
    owner: 'owner',
    pollSeconds: 2,
    autoAdvance: true,
  }
  const base = resolveConfig(raw, dir)
  const created: ForgeLoopConfig[] = []
  const started: string[] = []
  const stopped: string[] = []
  const closed: string[] = []
  const log: string[] = []
  const workspaces = (options.workspaceIds ?? ['a', 'b']).map((id) => workspace(id, dir))
  const sessionCwds = new Map<string, string>([
    ['session-legacy', legacyProjectPath],
    ['session-a', join(dir, 'a')],
  ])
  const tenants = new WorkspaceTenants({
    raw,
    cwd: dir,
    base,
    legacy: { project: 'legacy', projectPath: legacyProjectPath },
    workspaces: {
      list: async () => workspaces,
      byPath: async (path) =>
        workspaces.find((workspace) => workspace.path === path) ??
        (path === legacyProjectPath ? legacyWorkspace(legacyProjectPath) : undefined),
    },
    sessionCwd: async (sessionId) => sessionCwds.get(sessionId),
    create: (config) => {
      if (config.project === options.failForProject) throw new Error('boom')
      created.push(config)
      return {
        runtime: {
          close: () => {
            closed.push(config.project)
          },
        } as never,
        coordinator: {
          start: () => {
            started.push(config.project)
          },
          stop: async () => {
            stopped.push(config.project)
          },
        } as never,
      }
    },
    log: (message) => {
      log.push(message)
    },
  })
  return { dir, raw, base, tenants, created, started, stopped, closed, log, legacyProjectPath }
}

function legacyWorkspace(path: string): WorkspaceIdentity {
  return { id: 'legacy-id', path, title: 'legacy' }
}

function workspace(id: string, dir: string): WorkspaceIdentity {
  return { id, path: join(dir, id), title: id }
}

describe('workspace tenant binding', () => {
  it('derives an isolated project, record root and deployment root per workspace', () => {
    const { dir, tenants } = setup()
    const a = workspace('a', dir)
    const b = workspace('b', dir)

    const configA = tenants.configFor(a)
    const configB = tenants.configFor(b)

    expect(configA.project).toBe(workspaceProjectName(a.id))
    expect(configB.project).toBe(workspaceProjectName(b.id))
    expect(configA.project).not.toBe(configB.project)
    expect(configA.projectPath).toBe(a.path)
    expect(configB.projectPath).toBe(b.path)
    expect(projectDir(configA)).not.toBe(projectDir(configB))
    expect(recordsPath(configA)).not.toBe(recordsPath(configB))
    expect(configA.deployments.toolRoot).not.toBe(configB.deployments.toolRoot)
  })

  it('reuses the legacy project only when the workspace path is identical', () => {
    const { dir, tenants, legacyProjectPath } = setup()
    const legacy = tenants.configFor(legacyWorkspace(legacyProjectPath))
    const other = tenants.configFor(legacyWorkspace(join(dir, 'other-project')))

    expect(legacy.project).toBe('legacy')
    expect(projectDir(legacy)).toBe(join(dir, 'records', 'projects', 'legacy'))
    expect(other.project).toBe(workspaceProjectName('legacy-id'))
    expect(other.project).not.toBe('legacy')
  })

  it('creates exactly one runtime and coordinator per workspace', () => {
    const { dir, tenants, created, started } = setup()
    const a = workspace('a', dir)

    const first = tenants.ensure(a)
    const second = tenants.ensure(a)

    expect(first).toBe(second)
    expect(created).toHaveLength(1)
    expect(started).toEqual([workspaceProjectName(a.id)])
    expect(tenants.get(a.id)).toBe(first)
    expect(tenants.list()).toEqual([first])
  })

  it('resolves a tenant by workspace path or a directory inside its records', () => {
    const { dir, tenants } = setup()
    const a = workspace('a', dir)
    const b = workspace('b', dir)
    const tenantB = tenants.ensure(b)

    expect(tenants.tenantOfCwd(b.path)).toBe(tenantB)
    expect(
      tenants.tenantOfCwd(join(projectDir(tenantB.config), 'workspaces', 'req-1', 'dev')),
    ).toBe(tenantB)
    expect(tenants.tenantOfCwd(join(dir, 'unrelated'))).toBeUndefined()
    expect(tenants.tenantOfCwd(a.path)).toBeUndefined()
  })

  it('does not treat a sibling path prefix as containment', () => {
    const { dir, tenants } = setup()
    const tenant = tenants.ensure(workspace('a', dir))
    const sibling = `${projectDir(tenant.config)}-evil`

    expect(tenants.tenantOfCwd(sibling)).toBeUndefined()
  })

  it('discovers a registered workspace by path and caches it', async () => {
    const { dir, tenants, created } = setup()
    const a = workspace('a', dir)

    const first = await tenants.forCwd(a.path)
    const second = await tenants.forCwd(a.path)

    expect(first).toBe(second)
    expect(created).toHaveLength(1)
    expect(await tenants.forCwd(join(dir, 'unknown'))).toBeUndefined()
  })

  it('resolves a tenant by session header cwd', async () => {
    const { dir, tenants } = setup()
    const a = workspace('a', dir)

    const tenant = await tenants.forSession('session-a')

    expect(tenant?.workspace).toEqual(a)
    expect(await tenants.forSession('session-unknown')).toBeUndefined()
  })

  it('preloads every registered workspace and disposes them all', async () => {
    const { tenants, started, stopped, closed } = setup({ workspaceIds: ['a', 'b'] })

    await tenants.preload()
    expect(tenants.list()).toHaveLength(2)
    expect(started).toHaveLength(2)

    await tenants.dispose()
    expect(tenants.list()).toHaveLength(0)
    expect(stopped).toHaveLength(2)
    expect(closed).toHaveLength(2)
  })

  it('keeps preloading when one workspace fails to start', async () => {
    const { tenants, log, started } = setup({
      workspaceIds: ['a', 'b'],
      failForProject: workspaceProjectName('a'),
    })

    await tenants.preload()

    expect(tenants.list().map((tenant) => tenant.workspace.id)).toEqual(['b'])
    expect(started).toEqual([workspaceProjectName('b')])
    expect(log.join('\n')).toContain('boom')
  })
})

describe('workspaceProjectName', () => {
  it('keeps the id readable and prefix-safe', () => {
    expect(workspaceProjectName('3F2A-11')).toBe('ws-3f2a-11')
  })

  it('strips characters the project name rule rejects', () => {
    expect(workspaceProjectName('我的/工作区')).toBe('ws-workspace')
    expect(workspaceProjectName('///')).toBe('ws-workspace')
    expect(workspaceProjectName('a b.c')).toBe('ws-a-b-c')
  })
})
