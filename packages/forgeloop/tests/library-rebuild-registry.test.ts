import { describe, expect, it } from 'vitest'
import type { LibraryRebuildService } from '../src/runtime/library-rebuild.js'
import {
  libraryRebuildOf,
  type LibraryRebuildHost,
} from '../src/runtime/library-rebuild-registry.js'

function host(overrides: Partial<LibraryRebuildHost> = {}): LibraryRebuildHost {
  return {
    config: { project: 'p', projectPath: '/tmp/p', recordsRoot: '/tmp/r', owner: 'owner' } as never,
    repo: { libraryRebuildStore: {} as never, syncLibrary: () => undefined },
    runner: {
      run: async () => ({
        status: 'completed',
        text: '{"candidates":[]}',
        sessionId: '',
        reason: '',
        transcriptPath: '',
        durationMs: 0,
        toolCalls: [],
      }),
    },
    ...overrides,
  }
}

describe('library rebuild registry', () => {
  it('creates one service per runtime and reuses it across requests', () => {
    const first = host()
    const created = libraryRebuildOf(first)
    expect(libraryRebuildOf(first)).toBe(created)
    expect(libraryRebuildOf(host())).not.toBe(created)
  })

  it('returns an injected service without creating another', () => {
    const injected = {
      status: () => null,
      start: () => ({ runId: 'run-x', status: {} }),
      cancel: () => false,
    } as unknown as LibraryRebuildService
    const runtime = host({ libraryRebuild: injected })
    expect(libraryRebuildOf(runtime)).toBe(injected)
    expect(libraryRebuildOf(runtime)).toBe(injected)
  })
})
