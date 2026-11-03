import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/cli/pack.js'

const control = vi.hoisted(() => ({
  packOutput: null as string | null,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) =>
      control.packOutput === null ? actual.execFileSync(...args) : control.packOutput,
  }
})

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-pack-'))
  control.packOutput = null
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function packageFixture(files: Record<string, unknown>): string {
  const packageDir = join(root, 'package')
  mkdirSync(join(packageDir, 'lib/nested'), { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: 'forgeloop-test', version: '1.2.3', ...files }),
    'utf8',
  )
  writeFileSync(join(packageDir, 'lib/index.js'), 'export const ok = 1\n', 'utf8')
  writeFileSync(join(packageDir, 'lib/nested/tool.js'), 'export const tool = 1\n', 'utf8')
  return packageDir
}

describe('candidate package cli', () => {
  it('packs a package and writes an artifact manifest', () => {
    const packageDir = packageFixture({})

    expect(main(packageDir)).toBe(0)
    const artifact = JSON.parse(readFileSync(join(packageDir, 'dist/artifact.json'), 'utf8'))
    expect(artifact).toMatchObject({
      name: 'forgeloop-test',
      version: '1.2.3',
      files: ['lib/index.js', 'lib/nested/tool.js'],
      gitHead: '',
      gitStatus: '',
    })
    expect(artifact.sha256).toHaveLength(64)
    expect(artifact.tarball).toContain('forgeloop-test-1.2.3.tgz')
  })

  it('rejects a pack result without a filename', () => {
    const packageDir = packageFixture({})
    control.packOutput = '[]'
    expect(() => main(packageDir)).toThrow('npm pack 没有返回产物信息')
  })

  it('rejects a package without a name', () => {
    const packageDir = packageFixture({ name: '' })
    control.packOutput = JSON.stringify([{ filename: 'artifact.tgz' }])
    mkdirSync(join(packageDir, 'dist'), { recursive: true })
    writeFileSync(join(packageDir, 'dist/artifact.tgz'), 'artifact', 'utf8')
    expect(() => main(packageDir)).toThrow('package.json 缺少 name/version')
  })

  it('rejects a package with a non-string version', () => {
    const packageDir = packageFixture({ version: 123 })
    control.packOutput = JSON.stringify([{ filename: 'artifact.tgz' }])
    mkdirSync(join(packageDir, 'dist'), { recursive: true })
    writeFileSync(join(packageDir, 'dist/artifact.tgz'), 'artifact', 'utf8')
    expect(() => main(packageDir)).toThrow('package.json 缺少 name/version')
  })
})
