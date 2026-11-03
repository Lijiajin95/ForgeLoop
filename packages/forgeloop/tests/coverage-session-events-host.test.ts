import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let dir = ''
let originalArgv = ''

afterEach(() => {
  vi.resetModules()
  if (originalArgv) process.argv[1] = originalArgv
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
  originalArgv = ''
  delete (globalThis as { __forgeloopRecords?: unknown }).__forgeloopRecords
})

describe('host session append record', () => {
  it('uses the DSH appendPluginRecord when the host module resolves', async () => {
    dir = mkdtempSync(join(tmpdir(), 'forgeloop-events-'))
    originalArgv = process.argv[1] ?? ''
    const entry = join(dir, 'entry.mjs')
    writeFileSync(entry, '', 'utf8')
    const hostPackage = join(dir, 'node_modules', '@deepseek-ai', 'dsh-session')
    mkdirSync(hostPackage, { recursive: true })
    writeFileSync(
      join(hostPackage, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-session', type: 'module', main: 'index.js' }),
      'utf8',
    )
    writeFileSync(
      join(hostPackage, 'index.js'),
      [
        'export function appendPluginRecord(session, type, data) {',
        '  globalThis.__forgeloopRecords = [...(globalThis.__forgeloopRecords ?? []), { session, type, data }]',
        '}',
      ].join('\n'),
      'utf8',
    )
    process.argv[1] = entry
    vi.resetModules()
    const events = await import('../src/session/events.js')
    const session = { id: 's' }
    expect(events.appendSessionEvent(session, 'plugin:test', { a: 1 })).toBe(true)
    const records = (globalThis as { __forgeloopRecords?: unknown[] }).__forgeloopRecords
    expect(records).toHaveLength(1)
    expect(records?.[0]).toMatchObject({ session, type: 'plugin:test', data: { a: 1 } })
  })

  it('falls back to session.append when the host entry is unknown', async () => {
    originalArgv = process.argv[1] ?? ''
    delete process.argv[1]
    vi.resetModules()
    const events = await import('../src/session/events.js')
    const appended: unknown[] = []
    const session = { append: (...args: unknown[]) => appended.push(args) }
    expect(events.appendSessionEvent(session, 'plugin:test', { a: 1 })).toBe(true)
    expect(appended).toHaveLength(1)
    expect(events.appendSessionEvent({}, 'plugin:test', { a: 1 })).toBe(false)
  })

  it('ignores a host module that does not export appendPluginRecord', async () => {
    dir = mkdtempSync(join(tmpdir(), 'forgeloop-events-'))
    originalArgv = process.argv[1] ?? ''
    const entry = join(dir, 'entry.mjs')
    writeFileSync(entry, '', 'utf8')
    const hostPackage = join(dir, 'node_modules', '@deepseek-ai', 'dsh-session')
    mkdirSync(hostPackage, { recursive: true })
    writeFileSync(
      join(hostPackage, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-session', type: 'module', main: 'index.js' }),
      'utf8',
    )
    writeFileSync(join(hostPackage, 'index.js'), 'export const unrelated = true\n', 'utf8')
    process.argv[1] = entry
    vi.resetModules()
    const events = await import('../src/session/events.js')
    const appended: unknown[] = []
    const session = { append: (...args: unknown[]) => appended.push(args) }
    expect(events.appendSessionEvent(session, 'plugin:test', { a: 1 })).toBe(true)
    expect(appended).toHaveLength(1)
  })
})
