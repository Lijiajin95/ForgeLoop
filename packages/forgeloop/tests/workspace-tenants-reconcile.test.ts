import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig, type RawConfig } from '../src/config.js'
import {
  WorkspaceTenants,
  workspaceProjectName,
  type WorkspaceIdentity,
} from '../src/runtime/workspace-tenants.js'

interface SetupOptions {
  readonly stopThrows?: boolean
  readonly closeThrows?: boolean
  readonly listThrows?: boolean
  /** 该工作区 id 创建运行时抛错。 */
  readonly failForWorkspace?: string
}

function workspace(id: string, dir: string): WorkspaceIdentity {
  return { id, path: join(dir, id), title: id }
}

function setup(options: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-tenant-reconcile-'))
  const raw: RawConfig = {
    project: 'legacy',
    projectPath: join(dir, 'legacy'),
    recordsRoot: join(dir, 'records'),
    owner: 'owner',
    pollSeconds: 2,
    autoAdvance: true,
  }
  const base = resolveConfig(raw, dir)
  const log: string[] = []
  const stopped: string[] = []
  const closed: string[] = []
  let registered: WorkspaceIdentity[] = [workspace('a', dir), workspace('b', dir)]
  const tenants = new WorkspaceTenants({
    raw,
    cwd: dir,
    base,
    workspaces: {
      list: async () => {
        if (options.listThrows) throw new Error('list failed')
        return registered
      },
      byPath: async (path) => registered.find((item) => item.path === path),
    },
    sessionCwd: async () => undefined,
    create: (config) => {
      if (
        options.failForWorkspace &&
        config.project === workspaceProjectName(options.failForWorkspace)
      ) {
        throw new Error('boom')
      }
      return {
        runtime: {
          close: () => {
            closed.push(config.project)
            if (options.closeThrows) throw new Error('close failed')
          },
        } as never,
        coordinator: {
          start: () => undefined,
          stop: async () => {
            stopped.push(config.project)
            if (options.stopThrows) throw new Error('stop failed')
          },
        } as never,
      }
    },
    log: (message) => log.push(message),
  })
  return {
    dir,
    tenants,
    log,
    stopped,
    closed,
    setRegistered: (next: readonly WorkspaceIdentity[]) => {
      registered = [...next]
    },
    workspace: (id: string) => workspace(id, dir),
  }
}

describe('workspace tenant reconciliation', () => {
  it('creates a workspace that appears in the registry after preload', async () => {
    const { tenants, setRegistered, workspace: make } = setup()
    await tenants.preload()
    expect(tenants.get('c')).toBeUndefined()

    setRegistered([make('a'), make('b'), make('c')])
    await tenants.reconcile()
    expect(tenants.get('c')).toBeDefined()
  })

  it('releases a workspace removed from the registry', async () => {
    const { tenants, log, stopped, closed, setRegistered, workspace: make } = setup()
    await tenants.preload()

    setRegistered([make('b')])
    await tenants.reconcile()

    expect(tenants.get('a')).toBeUndefined()
    expect(stopped).toContain(workspaceProjectName('a'))
    expect(closed).toContain(workspaceProjectName('a'))
    expect(log.some((line) => line.includes('工作区 a 已移除'))).toBe(true)
  })

  it('keeps tenants when the registry cannot be listed', async () => {
    const { tenants, log } = setup({ listThrows: true })
    await tenants.reconcile()
    expect(log.some((line) => line.includes('工作区列表读取失败'))).toBe(true)
  })

  it('logs release failures and still removes the tenant', async () => {
    const {
      tenants,
      log,
      setRegistered,
      workspace: make,
    } = setup({
      stopThrows: true,
      closeThrows: true,
    })
    await tenants.preload()

    setRegistered([make('b')])
    await tenants.reconcile()

    expect(tenants.get('a')).toBeUndefined()
    expect(log.some((line) => line.includes('停止已删除工作区 a 协调器失败'))).toBe(true)
    expect(log.some((line) => line.includes('关闭已删除工作区 a 记录库失败'))).toBe(true)
  })

  it('logs a new workspace that fails to start and keeps the rest', async () => {
    const { tenants, log, setRegistered, workspace: make } = setup({ failForWorkspace: 'c' })
    await tenants.preload()

    setRegistered([make('a'), make('b'), make('c')])
    await tenants.reconcile()

    expect(tenants.get('c')).toBeUndefined()
    expect(tenants.get('a')).toBeDefined()
    expect(log.some((line) => line.includes('新工作区 c 创建失败'))).toBe(true)
  })

  it('starts reconciliation once and stops it safely twice', () => {
    const { tenants } = setup()
    tenants.startReconcile(60_000)
    tenants.startReconcile(60_000)
    tenants.stopReconcile()
    tenants.stopReconcile()
  })

  it('disposes every tenant and logs stop and close failures', async () => {
    const { tenants, log } = setup({ stopThrows: true, closeThrows: true })
    await tenants.preload()

    await tenants.dispose()

    expect(tenants.list()).toEqual([])
    expect(log.some((line) => line.includes('停止工作区'))).toBe(true)
    expect(log.some((line) => line.includes('关闭工作区'))).toBe(true)
  })
})
