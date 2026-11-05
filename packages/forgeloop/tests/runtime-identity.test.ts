import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import {
  buildIdentityFrom,
  writeRuntimeIdentity,
  type RuntimeIdentity,
} from '../src/runtime/identity.js'

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
    writeFileSync(join(root, 'client.js'), 'window.client = 1\n', 'utf8')
    const identity = writeRuntimeIdentity(pathToFileURL(join(root, 'lib/index.js')).href)
    expect(identity?.kind).toBe('forgeloop-runtime-identity')
    expect(identity?.pid).toBe(process.pid)
    expect(identity?.indexSha256).toHaveLength(64)
    expect(identity?.serviceSha256).toHaveLength(64)
    expect(identity?.clientSha256).toHaveLength(64)
    const saved = JSON.parse(readFileSync(join(root, 'runtime-identity.json'), 'utf8')) as {
      pid: number
    }
    expect(saved.pid).toBe(process.pid)
    expect(writeRuntimeIdentity('not-a-valid-url')).toBeNull()
  })

  it('records whether the running client matches the source client', () => {
    root = mkdtempSync(join(tmpdir(), 'forgeloop-identity-build-'))
    const project = join(root, 'project')
    mkdirSync(join(project, 'packages/forgeloop'), { recursive: true })
    writeFileSync(join(project, 'packages/forgeloop/client.js'), 'source-client', 'utf8')
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const identity: RuntimeIdentity = {
      kind: 'forgeloop-runtime-identity',
      version: '0.0.2',
      pid: 1,
      startedAt: '2026-11-05T00:00:00.000Z',
      cwd: project,
      indexSha256: 'i'.repeat(64),
      serviceSha256: 's'.repeat(64),
      clientSha256: hash('installed-client'),
    }
    const mismatch = buildIdentityFrom(identity, project)
    expect(mismatch.sourceMatches).toBe(false)
    expect(mismatch.sourceClientSha256).toBe(hash('source-client'))
    expect(mismatch.clientSha256).toBe(hash('installed-client'))

    const match = buildIdentityFrom({ ...identity, clientSha256: hash('source-client') }, project)
    expect(match.sourceMatches).toBe(true)

    const unknown = buildIdentityFrom(identity, undefined)
    expect(unknown.sourceMatches).toBeNull()
    expect(unknown.sourceClientSha256).toBe('')
  })

  it('keeps empty hashes when the loaded entry files are absent', () => {
    root = mkdtempSync(join(tmpdir(), 'forgeloop-identity-missing-'))
    const identity = writeRuntimeIdentity(pathToFileURL(join(root, 'lib/index.js')).href)
    expect(identity).toMatchObject({ indexSha256: '', serviceSha256: '', clientSha256: '' })
    expect(existsSync(join(root, 'runtime-identity.json'))).toBe(true)
  })
})
