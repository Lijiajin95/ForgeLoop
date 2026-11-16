/**
 * 每个项目运行时一个需求库重建服务：首次使用时按需创建，之后复用同一实例，
 * 以便“同一项目同时只允许一轮”的判定跨请求生效。
 *
 * 单独放在这里而不是塞进 `service.ts`：运行时主类已接近体积预算，
 * 而重建只是看板侧的一个只读/受控动作入口。
 */

import type { ForgeLoopConfig } from '../config.js'
import {
  createLibraryRebuild,
  type LibraryRebuildRepo,
  type LibraryRebuildRunner,
  type LibraryRebuildService,
} from './library-rebuild.js'

export interface LibraryRebuildHost {
  readonly config: ForgeLoopConfig
  readonly repo: LibraryRebuildRepo
  readonly runner: LibraryRebuildRunner
  /** 测试与隔离宿主可注入替身；存在时直接返回。 */
  readonly libraryRebuild?: LibraryRebuildService | undefined
}

const services = new WeakMap<object, LibraryRebuildService>()

/** 取当前运行时的重建服务；没有则创建并缓存到该运行时。 */
export function libraryRebuildOf(host: LibraryRebuildHost): LibraryRebuildService {
  if (host.libraryRebuild) return host.libraryRebuild
  const existing = services.get(host)
  if (existing) return existing
  const created = createLibraryRebuild(host.config, host.repo, host.runner)
  services.set(host, created)
  return created
}
