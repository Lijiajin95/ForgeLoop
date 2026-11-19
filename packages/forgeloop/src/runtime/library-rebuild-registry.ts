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
  readonly libraryRebuild?: LibraryRebuildService | undefined
}

const services = new WeakMap<object, LibraryRebuildService>()

export function libraryRebuildOf(host: LibraryRebuildHost): LibraryRebuildService {
  if (host.libraryRebuild) return host.libraryRebuild
  const existing = services.get(host)
  if (existing) return existing
  const created = createLibraryRebuild(host.config, host.repo, host.runner)
  services.set(host, created)
  return created
}
