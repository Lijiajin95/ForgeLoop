import { isAbsolute, relative, resolve } from 'node:path'
import {
  loadProjectProfile,
  projectDir,
  resolveConfig,
  type ForgeLoopConfig,
  type RawConfig,
} from '../config.js'
import type { Coordinator } from './coordinator.js'
import type { ForgeLoopRuntime } from './service.js'

export interface WorkspaceIdentity {
  readonly id: string
  readonly path: string
  readonly title: string
}

export interface Tenant {
  readonly workspace: WorkspaceIdentity
  readonly config: ForgeLoopConfig
  readonly runtime: ForgeLoopRuntime
  readonly coordinator: Coordinator
}

export interface WorkspaceSource {
  list(): Promise<readonly WorkspaceIdentity[]>
  byPath(path: string): Promise<WorkspaceIdentity | undefined>
}

export interface LegacyProject {
  readonly project: string
  readonly projectPath: string
}

export interface WorkspaceTenantsOptions {
  readonly raw: RawConfig
  readonly cwd: string
  readonly base: ForgeLoopConfig
  readonly legacy?: LegacyProject | undefined
  readonly workspaces: WorkspaceSource
  readonly sessionCwd: (sessionId: string) => Promise<string | undefined>
  readonly create: (config: ForgeLoopConfig) => {
    runtime: ForgeLoopRuntime
    coordinator: Coordinator
  }
  readonly log?: (message: string) => void
}

export function workspaceProjectName(id: string): string {
  const safe = id
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
  return `ws-${safe || 'workspace'}`
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function containsPath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class WorkspaceTenants {
  private readonly tenants = new Map<string, Tenant>()
  private reconcileTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: WorkspaceTenantsOptions) {}

  list(): Tenant[] {
    return [...this.tenants.values()]
  }

  get(id: string): Tenant | undefined {
    return this.tenants.get(id)
  }

  tenantOfCwd(cwd: string): Tenant | undefined {
    const target = resolve(cwd)
    let contained: Tenant | undefined
    let containedLength = -1
    for (const tenant of this.tenants.values()) {
      if (samePath(tenant.workspace.path, target)) return tenant
      if (containsPath(projectDir(tenant.config), target)) return tenant
      const workspacePath = resolve(tenant.workspace.path)
      if (containsPath(workspacePath, target) && workspacePath.length > containedLength) {
        contained = tenant
        containedLength = workspacePath.length
      }
    }
    return contained
  }

  async forCwd(cwd: string): Promise<Tenant | undefined> {
    const known = this.tenantOfCwd(cwd)
    if (known) return known
    const workspace = await this.options.workspaces.byPath(cwd)
    return workspace ? this.ensure(workspace) : undefined
  }

  async forSession(sessionId: string): Promise<Tenant | undefined> {
    const cwd = await this.options.sessionCwd(sessionId)
    if (!cwd) {
      this.options.log?.(`[forgeloop] 会话 ${sessionId} 没有可用的 header 目录，无法绑定工作区`)
      return undefined
    }
    const tenant = await this.forCwd(cwd)
    if (!tenant) {
      this.options.log?.(`[forgeloop] 会话 ${sessionId} 的目录 ${cwd} 不属于任何已注册工作区`)
    }
    return tenant
  }

  ensure(workspace: WorkspaceIdentity): Tenant {
    const existing = this.tenants.get(workspace.id)
    if (existing) return existing
    const config = this.configFor(workspace)
    const created = this.options.create(config)
    const tenant: Tenant = { workspace, config, ...created }
    this.tenants.set(workspace.id, tenant)
    created.coordinator.start()
    this.options.log?.(
      `[forgeloop] 工作区 ${workspace.id}（${workspace.path}）绑定项目 ${config.project}`,
    )
    return tenant
  }

  configFor(workspace: WorkspaceIdentity): ForgeLoopConfig {
    const legacy = this.options.legacy
    const isLegacy = legacy !== undefined && samePath(legacy.projectPath, workspace.path)
    const project = isLegacy ? legacy.project : workspaceProjectName(workspace.id)
    const raw: RawConfig = {
      ...this.options.raw,
      project,
      projectPath: workspace.path,
      recordsRoot: this.options.base.recordsRoot,
    }
    if (!isLegacy) {
      const profile = loadProjectProfile(workspace.path)
      const declaresOps = Object.prototype.hasOwnProperty.call(profile, 'ops')
      if (!declaresOps) {
        if (this.options.base.ops.enabled) raw.ops = { ...this.options.raw.ops, enabled: false }
      } else if (profile.ops) {
        if (!Object.prototype.hasOwnProperty.call(profile.ops, 'artifacts')) {
          raw.ops = { ...this.options.raw.ops, artifacts: [] }
        }
      }
    }
    return resolveConfig(raw, this.options.cwd)
  }

  async preload(): Promise<void> {
    for (const workspace of await this.options.workspaces.list()) {
      try {
        this.ensure(workspace)
      } catch (error) {
        this.options.log?.(
          `[forgeloop] 工作区 ${workspace.id} 启动失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  startReconcile(intervalMs = 60_000): void {
    if (this.reconcileTimer) return
    this.reconcileTimer = setInterval(() => {
      void this.reconcile()
    }, intervalMs)
    this.reconcileTimer.unref()
  }

  stopReconcile(): void {
    if (!this.reconcileTimer) return
    clearInterval(this.reconcileTimer)
    this.reconcileTimer = undefined
  }

  async reconcile(): Promise<void> {
    const workspaces = await this.registeredWorkspaces()
    if (!workspaces) return
    const registered = new Set(workspaces.map((workspace) => workspace.id))
    for (const [id, tenant] of [...this.tenants]) {
      if (!registered.has(id)) await this.releaseTenant(id, tenant)
    }
    for (const workspace of workspaces) {
      if (!this.tenants.has(workspace.id)) this.ensureSafely(workspace)
    }
  }

  private async registeredWorkspaces(): Promise<readonly WorkspaceIdentity[] | undefined> {
    try {
      return await this.options.workspaces.list()
    } catch (error) {
      this.options.log?.(
        `[forgeloop] 工作区列表读取失败：${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  private async releaseTenant(id: string, tenant: Tenant): Promise<void> {
    this.tenants.delete(id)
    try {
      await tenant.coordinator.stop()
    } catch (error) {
      this.options.log?.(
        `[forgeloop] 停止已删除工作区 ${id} 协调器失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    try {
      tenant.runtime.close()
    } catch (error) {
      this.options.log?.(
        `[forgeloop] 关闭已删除工作区 ${id} 记录库失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    this.options.log?.(`[forgeloop] 工作区 ${id} 已移除，租户已释放`)
  }

  private ensureSafely(workspace: WorkspaceIdentity): void {
    try {
      this.ensure(workspace)
    } catch (error) {
      this.options.log?.(
        `[forgeloop] 新工作区 ${workspace.id} 创建失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async dispose(): Promise<void> {
    this.stopReconcile()
    for (const tenant of this.tenants.values()) {
      try {
        await tenant.coordinator.stop()
      } catch (error) {
        this.options.log?.(
          `[forgeloop] 停止工作区 ${tenant.workspace.id} 协调器失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      try {
        tenant.runtime.close()
      } catch (error) {
        this.options.log?.(
          `[forgeloop] 关闭工作区 ${tenant.workspace.id} 记录库失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    this.tenants.clear()
  }
}
