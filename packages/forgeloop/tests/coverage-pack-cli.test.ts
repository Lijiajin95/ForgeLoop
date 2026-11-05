import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/cli/pack.js'

const control = vi.hoisted(() => ({
  packOutput: null as string | null,
  npmArgs: [] as string[][],
  hideNpmCli: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      control.hideNpmCli && String(path).endsWith('npm-cli.js') ? false : actual.existsSync(path),
  }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const isNpm = (file: unknown, argv: unknown): boolean =>
    file === 'npm' || (Array.isArray(argv) && /npm-cli\.js$/.test(String(argv[0] ?? '')))
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      const [file, argv] = args
      const npm = isNpm(file, argv)
      if (npm && Array.isArray(argv)) {
        control.npmArgs.push(argv.map(String).filter((value) => !/npm-cli\.js$/.test(value)))
      }
      if (npm && control.packOutput !== null) return control.packOutput
      return actual.execFileSync(...args)
    },
  }
})

let root = ''
let logs: string[] = []

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
  return result.stdout.trim()
}

function initRepository(packageDir: string): string {
  git(packageDir, ['init', '-q'])
  git(packageDir, ['config', 'user.email', 'pack@example.com'])
  git(packageDir, ['config', 'user.name', 'Pack Fixture'])
  writeFileSync(join(packageDir, '.gitignore'), 'dist/\n', 'utf8')
  git(packageDir, ['add', '-A'])
  git(packageDir, ['commit', '-qm', 'fixture'])
  return git(packageDir, ['rev-parse', 'HEAD'])
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-pack-'))
  control.packOutput = null
  control.npmArgs = []
  control.hideNpmCli = false
  logs = []
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
    logs.push(String(message))
  })
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
    const head = initRepository(packageDir)
    writeFileSync(join(packageDir, 'notes.txt'), 'dirty\n', 'utf8')

    expect(main(packageDir)).toBe(0)
    const artifact = JSON.parse(readFileSync(join(packageDir, 'dist/artifact.json'), 'utf8'))
    expect(artifact).toMatchObject({
      name: 'forgeloop-test',
      version: '1.2.3',
      files: ['lib/index.js', 'lib/nested/tool.js'],
      gitHead: head,
      gitStatus: '?? notes.txt',
    })
    expect(artifact.sha256).toHaveLength(64)
    expect(artifact.tarball).toContain('forgeloop-test-1.2.3.tgz')
    const packArgs = control.npmArgs.at(-1) ?? []
    expect(packArgs).toContain('--cache')
    expect(packArgs[packArgs.indexOf('--cache') + 1]).toMatch(/[\\/]\.cache[\\/]npm-cache$/)
    expect(logs.join('\n')).toContain('"name": "forgeloop-test"')
  })

  it('falls back to the npm command when the bundled CLI is missing', () => {
    const packageDir = packageFixture({})
    control.hideNpmCli = true
    control.packOutput = JSON.stringify([{ filename: 'forgeloop-test-1.2.3.tgz' }])
    mkdirSync(join(packageDir, 'dist'), { recursive: true })
    writeFileSync(join(packageDir, 'dist/forgeloop-test-1.2.3.tgz'), 'tarball', 'utf8')

    expect(main(packageDir)).toBe(0)
    const packArgs = control.npmArgs.at(-1) ?? []
    expect(packArgs[0]).toBe('pack')
    expect(packArgs).toContain('--cache')
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

  it('rejects a package with a non-string name', () => {
    const packageDir = packageFixture({ name: 123 })
    control.packOutput = JSON.stringify([{ filename: 'artifact.tgz' }])
    mkdirSync(join(packageDir, 'dist'), { recursive: true })
    writeFileSync(join(packageDir, 'dist/artifact.tgz'), 'artifact', 'utf8')
    expect(() => main(packageDir)).toThrow('package.json 缺少 name/version')
  })
})
