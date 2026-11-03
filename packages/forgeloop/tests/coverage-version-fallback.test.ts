import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
})

describe('plugin version fallbacks', () => {
  it('reports unavailable when package.json cannot be read', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return {
        ...actual,
        readFileSync: () => {
          throw new Error('missing package.json')
        },
      }
    })
    vi.resetModules()
    const version = await import('../src/runtime/version.js')
    expect(version.PLUGIN_VERSION).toBe('unavailable')
  })

  it('reports unavailable when package.json has no version string', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return { ...actual, readFileSync: () => '{}' }
    })
    vi.resetModules()
    const version = await import('../src/runtime/version.js')
    expect(version.PLUGIN_VERSION).toBe('unavailable')
  })
})
