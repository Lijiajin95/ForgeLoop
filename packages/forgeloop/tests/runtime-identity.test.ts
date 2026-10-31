import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { writeRuntimeIdentity } from '../src/runtime/identity.js'

let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('runtime identity', () => {
  it('writes the loaded version, pid and entry/service hashes into the package root', () => {
    root = mkdtempSync(join(tmpdir(), 'forgeloop-identity-'))
    mkdirSync(join(root, 'lib/runtime'), { recursive: true })
    writeFileSync(join(root, 'lib/index.js'), 'export const index = 1\n', 'utf8')
    writeFileSync(join(root, 'lib/runtime/service.js'), 'export const service = 1\n', 'utf8')
    const identity = writeRuntimeIdentity(pathToFileURL(join(root, 'lib/index.js')).href)
    expect(identity?.kind).toBe('forgeloop-runtime-identity')
    expect(identity?.pid).toBe(process.pid)
    expect(identity?.indexSha256).toHaveLength(64)
    expect(identity?.serviceSha256).toHaveLength(64)
    const saved = JSON.parse(readFileSync(join(root, 'runtime-identity.json'), 'utf8')) as { pid: number }
    expect(saved.pid).toBe(process.pid)
    expect(writeRuntimeIdentity('not-a-valid-url')).toBeNull()
  })
})
