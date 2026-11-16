import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  /** 全局 ops 配置；用于验证只有 legacy 工作区默认开启监控。 */
  readonly ops?: RawConfig['ops']
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
    ...(options.ops ? { ops: options.ops } : {}),
  }
  const base = resolveConfig(raw, dir)
  const created: ForgeLoopConfig[] = []
  const started: string[] = []
  const stopped: string[] = []
  const closed: string[] = []
  const log: string[] = []
  const registered = (options.workspaceIds ?? ['a', 'b']).map((id) => workspace(id, dir))
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
      list: async () => registered,
      byPath: async (path) =>
        registered.find((workspace) => workspace.path === path) ??
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
  return {
    dir,
    raw,
    base,
    tenants,
    created,
    started,
    stopped,
    closed,
    log,
    registered,
    legacyProjectPath,
  }
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

  it('applies each workspace project profile to its own engineering facts', () => {
    const { dir, tenants } = setup()
    const a = workspace('a', dir)
    const b = workspace('b', dir)
    mkdirSync(a.path, { recursive: true })
    writeFileSync(
      join(a.path, '.forgeloop.json'),
      JSON.stringify({ candidateBuildCommand: ['make', 'build'] }),
      'utf8',
    )

    expect(tenants.configFor(a).candidateBuildCommand).toEqual(['make', 'build'])
    expect(tenants.configFor(b).candidateBuildCommand).toEqual([])
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

  it('resolves a session opened in a workspace subdirectory', () => {
    const { dir, tenants } = setup()
    const a = workspace('a', dir)
    const tenant = tenants.ensure(a)

    expect(tenants.tenantOfCwd(join(a.path, 'src', 'service'))).toBe(tenant)
  })

  it('prefers the most specific workspace for nested workspaces', () => {
    const { dir, tenants } = setup()
    const outer = workspace('a', dir)
    const nested = tenants.ensure({
      id: 'nested',
      path: join(outer.path, 'inner'),
      title: 'nested',
    })
    tenants.ensure(outer)

    expect(tenants.tenantOfCwd(join(outer.path, 'inner', 'src'))).toBe(nested)
    expect(tenants.tenantOfCwd(join(outer.path, 'other'))).not.toBe(nested)
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

  it('releases removed workspaces and picks up new ones on reconcile', async () => {
    const { dir, tenants, registered, stopped, closed } = setup({
      workspaceIds: ['a', 'b'],
    })
    await tenants.preload()
    registered.splice(1)

    await tenants.reconcile()

    expect(tenants.list().map((tenant) => tenant.workspace.id)).toEqual(['a'])
    expect(stopped).toContain(workspaceProjectName('b'))
    expect(closed).toContain(workspaceProjectName('b'))

    registered.push(workspace('c', dir))
    await tenants.reconcile()
    expect(
      tenants
        .list()
        .map((tenant) => tenant.workspace.id)
        .sort(),
    ).toEqual(['a', 'c'])
  })

  it('runs host monitoring only for the legacy workspace unless the project opts in', () => {
    const { dir, tenants, legacyProjectPath } = setup({
      ops: {
        enabled: true,
        resources: [{ id: 'web', kind: 'app', label: 'web' }],
        checks: [
          { id: 'web-health', resourceId: 'web', command: ['node', '-e', 'process.exit(0)'] },
        ],
        artifacts: [
          { id: 'global', label: 'global', logs: [{ id: 'l', path: 'logs/global.log' }] },
        ],
      },
    })
    const legacy = tenants.configFor(legacyWorkspace(legacyProjectPath))
    const other = tenants.configFor(workspace('a', dir))
    expect(legacy.ops.enabled).toBe(true)
    expect(legacy.ops.artifacts).toHaveLength(1)
    expect(other.ops.enabled).toBe(false)

    mkdirSync(other.projectPath, { recursive: true })
    writeFileSync(join(other.projectPath, '.forgeloop.json'), '{"ops":{"enabled":true}}\n')
    const optedIn = tenants.configFor(workspace('a', dir))
    expect(optedIn.ops.enabled).toBe(true)
    // 未声明自己的制品清单时不继承全局路径，避免跨工作区读日志。
    expect(optedIn.ops.artifacts).toEqual([])

    writeFileSync(
      join(other.projectPath, '.forgeloop.json'),
      '{"ops":{"enabled":true,"artifacts":[{"id":"own","label":"own","logs":[{"id":"l","path":"logs/own.log"}]}]}}\n',
    )
    expect(tenants.configFor(workspace('a', dir)).ops.artifacts.map((item) => item.id)).toEqual([
      'own',
    ])
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
