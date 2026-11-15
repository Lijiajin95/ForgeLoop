import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import { RuleViolationError } from '../src/domain/errors.js'

const roots: string[] = []

function projectDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-profile-'))
  roots.push(root)
  return root
}

function writeProfile(root: string, value: unknown): void {
  writeFileSync(join(root, '.forgeloop.json'), JSON.stringify(value, null, 2), 'utf8')
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('project profile', () => {
  it('takes the client entry and package allowance from the profile', () => {
    const root = projectDir()
    writeProfile(root, { clientEntryFile: 'src/main.ts', allowNewPackages: true })
    const config = resolveConfig({ project: 'demo', projectPath: root }, root)
    expect(config.clientEntryFile).toBe('src/main.ts')
    expect(config.allowNewPackages).toBe(true)
  })

  it('defaults the client entry to the ForgeLoop path and forbids new packages', () => {
    const root = projectDir()
    const config = resolveConfig({ project: 'demo', projectPath: root }, root)
    expect(config.clientEntryFile).toBe('packages/forgeloop/client.js')
    expect(config.allowNewPackages).toBe(false)
  })

  it('treats an explicitly empty activeRoots as no scope restriction', () => {
    const root = projectDir()
    writeProfile(root, { activeRoots: [] })
    const config = resolveConfig({ project: 'demo', projectPath: root }, root)
    expect(config.activeRoots).toEqual([])
  })

  it('takes engineering facts and the version file from the project profile', () => {
    const root = projectDir()
    writeProfile(root, {
      engineeringFacts: ['源码在 src/', '检查命令：["npm","test"]'],
      candidateVersionFile: 'package.json',
    })
    const config = resolveConfig({ project: 'demo', projectPath: root }, root)
    expect(config.engineeringFacts).toEqual(['源码在 src/', '检查命令：["npm","test"]'])
    expect(config.candidateVersionFile).toBe('package.json')
  })

  it('keeps ForgeLoop defaults for facts and version file when unset', () => {
    const root = projectDir()
    const config = resolveConfig({ project: 'demo', projectPath: root }, root)
    expect(config.engineeringFacts).toEqual([])
    expect(config.candidateVersionFile).toBe('packages/forgeloop/package.json')
  })

  it('rejects an absolute or escaping version file', () => {
    const first = projectDir()
    writeProfile(first, { candidateVersionFile: '../escape.json' })
    expect(() => resolveConfig({ project: 'demo', projectPath: first }, first)).toThrow(/不能包含/)
    const second = projectDir()
    writeProfile(second, { candidateVersionFile: 'C:/abs/package.json' })
    expect(() => resolveConfig({ project: 'demo', projectPath: second }, second)).toThrow(
      /项目内相对路径/,
    )
  })

  it('keeps the default business-context path when nothing overrides it', () => {
    const root = projectDir()
    const config = resolveConfig({ project: 'demo', projectPath: root }, root)
    expect(config.businessContextDoc).toBe('docs/product/business-context.md')
  })

  it('takes the business-context path from the project profile', () => {
    const root = projectDir()
    writeProfile(root, { businessContextDoc: 'docs/business/context.md' })
    const config = resolveConfig({ project: 'demo', projectPath: root }, root)
    expect(config.businessContextDoc).toBe('docs/business/context.md')
  })

  it('keeps the global engineering facts when the project has no profile', () => {
    const root = projectDir()
    const config = resolveConfig(
      { project: 'demo', projectPath: root, candidateBuildCommand: ['npm', 'run', 'build'] },
      root,
    )

    expect(config.candidateBuildCommand).toEqual(['npm', 'run', 'build'])
    expect(config.activeRoots).toBeUndefined()
  })

  it('applies the profile engineering facts over the global config', () => {
    const root = projectDir()
    writeProfile(root, {
      activeRoots: ['src/', 'test/'],
      candidateBuildCommand: ['make', 'build'],
      candidatePackageCommand: ['make', 'pack'],
      candidateArtifactPath: 'dist/artifact.json',
      worktreePrepareCommand: ['make', 'setup'],
      formalTestTimeoutSeconds: 33,
      maxTaskAttempts: 4,
    })

    const config = resolveConfig(
      {
        project: 'demo',
        projectPath: root,
        activeRoots: ['packages/'],
        candidateBuildCommand: ['npm', 'run', 'build'],
        candidatePackageCommand: ['npm', 'pack'],
        candidateArtifactPath: 'pack/artifact.json',
        worktreePrepareCommand: [],
        formalTestTimeoutSeconds: -1,
        maxTaskAttempts: 2,
      },
      root,
    )

    expect(config.activeRoots).toEqual(['src/', 'test/'])
    expect(config.candidateBuildCommand).toEqual(['make', 'build'])
    expect(config.candidatePackageCommand).toEqual(['make', 'pack'])
    expect(config.candidateArtifactPath).toBe('dist/artifact.json')
    expect(config.worktreePrepareCommand).toEqual(['make', 'setup'])
    expect(config.formalTestTimeoutSeconds).toBe(33)
    expect(config.maxTaskAttempts).toBe(4)
  })

  it('keeps the global value for every key the profile does not set', () => {
    const root = projectDir()
    writeProfile(root, { candidateBuildCommand: ['make', 'build'] })

    const config = resolveConfig(
      {
        project: 'demo',
        projectPath: root,
        owner: 'owner-a',
        candidateBuildCommand: ['npm', 'run', 'build'],
        pollSeconds: 7,
      },
      root,
    )

    expect(config.candidateBuildCommand).toEqual(['make', 'build'])
    expect(config.owner).toBe('owner-a')
    expect(config.pollSeconds).toBe(7)
  })

  it('rejects a malformed profile file instead of silently ignoring it', () => {
    const root = projectDir()
    writeFileSync(join(root, '.forgeloop.json'), '{ not json', 'utf8')

    expect(() => resolveConfig({ project: 'demo', projectPath: root }, root)).toThrow(
      RuleViolationError,
    )
    expect(() => resolveConfig({ project: 'demo', projectPath: root }, root)).toThrow(
      /\.forgeloop\.json/,
    )
  })

  it('rejects keys that are not project engineering facts', () => {
    const root = projectDir()
    writeProfile(root, { owner: 'someone-else' })

    expect(() => resolveConfig({ project: 'demo', projectPath: root }, root)).toThrow(/owner/)
    expect(() => resolveConfig({ project: 'demo', projectPath: root }, root)).toThrow(
      RuleViolationError,
    )
  })

  it('rejects a non-object profile', () => {
    const root = projectDir()
    writeProfile(root, ['not', 'an', 'object'])

    expect(() => resolveConfig({ project: 'demo', projectPath: root }, root)).toThrow(
      RuleViolationError,
    )
  })

  it('validates profile value types with the same rules as the global config', () => {
    const root = projectDir()
    writeProfile(root, { maxTaskAttempts: 'four' })

    expect(() => resolveConfig({ project: 'demo', projectPath: root }, root)).toThrow(
      /maxTaskAttempts/,
    )
  })
})
