import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
let fixture = ''

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'forgeloop-contract-'))
  for (const path of [
    'packages/forgeloop/src',
    'packages/forgeloop/client.js',
    'packages/forgeloop/package.json',
    'packages/forgeloop/icon.svg',
    'packages/forgeloop/locale',
    'scripts/ts/contracts.ts',
    'contracts/architecture.json',
    'docs/architecture.md',
  ]) {
    const target = join(fixture, path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(root, path), target, { recursive: true })
  }
})

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true })
})

function check() {
  return spawnSync(process.execPath, [join(fixture, 'scripts/ts/contracts.ts'), '--architecture'], {
    cwd: fixture,
    encoding: 'utf8',
  })
}

function addFile(path: string): void {
  const target = join(fixture, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, 'retired implementation fixture\n')
}

describe('retired implementation admission', () => {
  it('accepts the current TypeScript plugin without retired product paths', () => {
    const result = check()
    expect(result.status, result.stderr).toBe(0)
  })

  it.each([
    ['legacy', 'legacy/python/src/forgeloop/__init__.py'],
    ['src/forgeloop', 'src/forgeloop/__init__.py'],
    ['frontend', 'frontend/src/app.ts'],
    ['scripts/install_local_service.sh', 'scripts/install_local_service.sh'],
  ])('rejects reintroducing %s', (path, file) => {
    addFile(file)
    const result = check()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain(path)
  })

  it('rejects old active source even when a legacy snapshot is also present', () => {
    addFile('src/forgeloop/__init__.py')
    addFile('legacy/python/src/forgeloop/__init__.py')
    const result = check()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('src/forgeloop')
  })
})
