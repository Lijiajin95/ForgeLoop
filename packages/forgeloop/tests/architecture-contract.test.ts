import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  return spawnSync(process.execPath, [join(fixture, 'scripts/ts/contracts.ts')], {
    cwd: fixture,
    encoding: 'utf8',
  })
}

function addFile(path: string): void {
  const target = join(fixture, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, 'retired implementation fixture\n')
}

function addFileContent(path: string, content: string): void {
  const target = join(fixture, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
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

  it('auto-discovers a new source file without a manual modules registration', () => {
    addFileContent('packages/forgeloop/src/domain/extra.ts', 'export const extra = 1\n')
    const result = check()
    expect(result.status, result.stderr).toBe(0)
  })

  it('rejects a cross-layer import', () => {
    addFileContent(
      'packages/forgeloop/src/domain/bad-layer.ts',
      "import type { ForgeLoopRuntime } from '../runtime/service.js'\nexport type Bad = ForgeLoopRuntime\n",
    )
    const result = check()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('domain')
    expect(result.stderr).toContain('runtime')
  })

  it('rejects a source import cycle', () => {
    addFileContent('packages/forgeloop/src/domain/cycle-a.ts', "import { b } from './cycle-b.js'\nexport const a = b\n")
    addFileContent('packages/forgeloop/src/domain/cycle-b.ts', "import { a } from './cycle-a.js'\nexport const b = a\n")
    const result = check()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('循环依赖')
    expect(result.stderr).toContain('cycle-a.ts')
  })

  it('rejects an endpoint added to the server allowlist without a dispatch branch', () => {
    const index = join(fixture, 'packages/forgeloop/src/index.ts')
    const source = readFileSync(index, 'utf8')
    const patched = source.replace(
      /const BOARD_ENDPOINTS = \[([^\]]*)\]/,
      (_match, body: string) => `const BOARD_ENDPOINTS = [${body}, 'fake']`,
    )
    expect(patched).not.toBe(source)
    writeFileSync(index, patched)
    const result = check()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('fake')
  })

  it('rejects a model tool without the contract prefix', () => {
    const tools = join(fixture, 'packages/forgeloop/src/tools.ts')
    writeFileSync(tools, `${readFileSync(tools, 'utf8')}\nconst badTool = { name: 'bad_tool' }\n`)
    const result = check()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('bad_tool')
    expect(result.stderr).toContain('forgeloop_')
  })

  it('rejects a session event that the client does not register', () => {
    const events = join(fixture, 'packages/forgeloop/src/session/events.ts')
    writeFileSync(events, `${readFileSync(events, 'utf8')}\nexport const EXTRA = 'plugin:forgeloop/extra'\n`)
    const result = check()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('plugin:forgeloop/extra')
  })

  it('rejects old active source even when a legacy snapshot is also present', () => {
    addFile('src/forgeloop/__init__.py')
    addFile('legacy/python/src/forgeloop/__init__.py')
    const result = check()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('src/forgeloop')
  })
})
