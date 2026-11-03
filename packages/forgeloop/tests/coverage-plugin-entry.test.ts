import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, BOARD_HTTP_PATH, inject, name } from '../src/index.js'

let root = ''
let cleanups: Array<() => Promise<void> | void> = []
let registrations: unknown[] = []
let logs: string[] = []

function rawConfig() {
  return {
    project: 'demo',
    projectPath: root,
    recordsRoot: join(root, '.forgeloop'),
    owner: 'owner',
    pollSeconds: 3600,
    agent: { provider: 'fake', model: 'fake', timeoutSeconds: 10 },
    formalTestTimeoutSeconds: 10,
  }
}

function host(
  options: {
    inject?: boolean
    connection?: boolean
    effect?: boolean
    throwOnDispose?: boolean
  } = {},
) {
  const registered: unknown[] = []
  let disposals = 0
  let routeDisposals = 0
  const ctx: Record<string, unknown> = {
    tools: {
      register: () => {
        registrations.push(true)
        return () => {
          disposals += 1
          if (options.throwOnDispose) throw new Error('dispose failed')
        }
      },
    },
    effect: (callback: () => unknown) => {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => Promise<void>)
      return () => undefined
    },
  }
  if (options.inject !== false) {
    ctx.inject = (_deps: readonly string[], callback: (scope: unknown) => void) => {
      const scope: Record<string, unknown> = {}
      if (options.connection !== false) {
        scope.connection = {
          fetch: {
            register: (route: unknown) => {
              registered.push(route)
              return () => {
                routeDisposals += 1
                return Promise.resolve()
              }
            },
          },
        }
      }
      if (options.effect !== false) {
        scope.effect = (callback: () => unknown) => {
          const cleanup = callback()
          if (typeof cleanup === 'function') cleanups.push(cleanup as () => Promise<void>)
          return () => undefined
        }
      }
      callback(scope)
    }
  }
  return {
    ctx,
    registered,
    get disposals() {
      return disposals
    },
    get routeDisposals() {
      return routeDisposals
    },
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-entry-'))
  cleanups = []
  registrations = []
  logs = []
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
    logs.push(String(message))
  })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup()
    } catch {
      // 每个清理独立执行，一个失败不阻止其余清理。
    }
  }
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('plugin entry wiring', () => {
  it('exposes the plugin name, inject list and board path', () => {
    expect(name).toBe('forgeloop')
    expect(inject).toEqual(['agents', 'agentLoop', 'tools'])
    expect(BOARD_HTTP_PATH).toBe('/api/forgeloop/board')
  })

  it('starts the runtime, registers tools and a board route, then disposes them', async () => {
    const hosted = host()
    apply(hosted.ctx, rawConfig())
    expect(registrations.length).toBeGreaterThan(0)
    expect(hosted.registered).toHaveLength(1)
    expect(hosted.registered[0]).toMatchObject({ path: '/api/forgeloop/board', methods: ['POST'] })
    expect(cleanups).toHaveLength(2)
    expect(logs.join('\n')).toContain('[forgeloop] 已加载 records=')
    // 看板 effect 在运行时 effect 内注册，先入栈；执行后必须真正注销注册。
    const disposeRoute = cleanups[0]
    cleanups.splice(0, 1)
    await disposeRoute?.()
    expect(hosted.routeDisposals).toBe(1)
  })

  it('starts without a connection service or a board effect', async () => {
    const first = host({ connection: false })
    apply(first.ctx, rawConfig())
    expect(first.registered).toHaveLength(0)

    const second = host({ effect: false })
    apply(second.ctx, rawConfig())
    expect(second.registered).toHaveLength(0)
  })

  it('starts without an inject hook at all', async () => {
    const { ctx, registered } = host({ inject: false })
    apply(ctx, rawConfig())
    expect(registered).toHaveLength(0)
  })

  it('keeps disposing the remaining tools when one cleanup fails', async () => {
    const hosted = host({ throwOnDispose: true })
    apply(hosted.ctx, rawConfig())
    // 运行时 effect 在外层注册，后入栈。
    const stop = cleanups[1]
    cleanups.splice(1, 1)
    await stop?.()
    expect(registrations.length).toBeGreaterThan(0)
    expect(hosted.disposals).toBe(registrations.length)
  })

  it('requires the tools service', () => {
    expect(() => apply({ effect: () => undefined }, rawConfig())).toThrow('tools 服务')
  })

  it('requires the effect service', () => {
    expect(() => apply({ tools: { register: () => () => undefined } }, rawConfig())).toThrow(
      'effect 服务',
    )
  })
})
