/**
 * DSH 工作区到 ForgeLoop 租户的绑定与运行时注册表。
 *
 * 所有者确认的绑定规则：
 * - 每个 DSH Workspace 一个租户，租户键取工作区 id，记录目录为
 *   `<recordsRoot>/projects/ws-<id>`；同一工作区内的会话共享同一份记录。
 * - profile 里显式配置的 `project` / `projectPath` 只作为旧目录兼容：仅当工作区路径
 *   与旧 `projectPath` 完全相同时复用旧项目名，避免把旧数据搬移或暴露给其他工作区。
 * - 会话按 `header.cwd` 归属：等于工作区路径，或位于该租户记录目录内
 *   （研发、验证、运维子会话都落在记录目录里）。
 * - 无法归属任何工作区的会话一律拒绝，不回退到默认项目。
 *
 * 隔离靠“一租户一配置一运行时一记录库”实现：现有 `projectDir()` 及其下游目录
 * 都由派生配置决定，因此不存在跨租户的共享库或共享工作区。
 */

import { isAbsolute, relative, resolve } from 'node:path'
import { projectDir, resolveConfig, type ForgeLoopConfig, type RawConfig } from '../config.js'
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

/** DSH 工作区发现接缝：生产实现读 `ctx.workspaceRegistry`，测试用假实现。 */
export interface WorkspaceSource {
  list(): Promise<readonly WorkspaceIdentity[]>
  byPath(path: string): Promise<WorkspaceIdentity | undefined>
}

export interface LegacyProject {
  readonly project: string
  readonly projectPath: string
}

export interface WorkspaceTenantsOptions {
  /** 合并后的原始配置：派生租户配置时重新解析，部署等相对路径才会落到租户目录。 */
  readonly raw: RawConfig
  /** 解析相对配置的基准目录（宿主启动目录）。 */
  readonly cwd: string
  /** 已解析的全局模板：提供 recordsRoot、owner 等共享值。 */
  readonly base: ForgeLoopConfig
  readonly legacy?: LegacyProject | undefined
  readonly workspaces: WorkspaceSource
  /** 会话身份 → 原始项目目录；找不到时返回 undefined。 */
  readonly sessionCwd: (sessionId: string) => Promise<string | undefined>
  readonly create: (config: ForgeLoopConfig) => {
    runtime: ForgeLoopRuntime
    coordinator: Coordinator
  }
  readonly log?: (message: string) => void
}

/** 工作区 id 派生出的项目名；只保留配置允许的字符，并加 `ws-` 前缀避免与旧项目重名。 */
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

/** 路径是否等于 root 或位于其下（按路径边界，不接受前缀字符串匹配）。 */
function containsPath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class WorkspaceTenants {
  private readonly tenants = new Map<string, Tenant>()

  constructor(private readonly options: WorkspaceTenantsOptions) {}

  list(): Tenant[] {
    return [...this.tenants.values()]
  }

  get(id: string): Tenant | undefined {
    return this.tenants.get(id)
  }

  /**
   * 按目录找到已加载租户：工作区路径本身，或租户记录目录内的子会话目录。
   * 只匹配已创建的租户；新工作区由 {@link forCwd} 通过工作区注册表发现。
   */
  tenantOfCwd(cwd: string): Tenant | undefined {
    const target = resolve(cwd)
    for (const tenant of this.tenants.values()) {
      if (samePath(tenant.workspace.path, target)) return tenant
      if (containsPath(projectDir(tenant.config), target)) return tenant
    }
    return undefined
  }

  /** 按目录解析租户；目录是已注册工作区时按需创建，否则 undefined。 */
  async forCwd(cwd: string): Promise<Tenant | undefined> {
    const known = this.tenantOfCwd(cwd)
    if (known) return known
    const workspace = await this.options.workspaces.byPath(cwd)
    return workspace ? this.ensure(workspace) : undefined
  }

  /** 按会话身份解析租户；读取会话 header 的原始 cwd，不受模型 cd 影响。 */
  async forSession(sessionId: string): Promise<Tenant | undefined> {
    const cwd = await this.options.sessionCwd(sessionId)
    return cwd ? this.forCwd(cwd) : undefined
  }

  /** 幂等创建租户运行时并启动其协调器；同一工作区只创建一次。 */
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

  /** 派生租户配置：旧目录仅按完全相同路径复用，其余一律使用工作区专属项目名。 */
  configFor(workspace: WorkspaceIdentity): ForgeLoopConfig {
    const legacy = this.options.legacy
    const project =
      legacy && samePath(legacy.projectPath, workspace.path)
        ? legacy.project
        : workspaceProjectName(workspace.id)
    return resolveConfig(
      {
        ...this.options.raw,
        project,
        projectPath: workspace.path,
        recordsRoot: this.options.base.recordsRoot,
      },
      this.options.cwd,
    )
  }

  /** 启动时枚举已注册工作区；单个工作区创建失败只记录，不影响其余工作区。 */
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

  /** 停止所有租户协调器并关闭记录库；失败逐个记录，不阻断其余释放。 */
  async dispose(): Promise<void> {
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
