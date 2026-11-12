import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import { readArtifactLog, readArtifactState } from '../src/runtime/ops-artifacts.js'
import { sha256OfBytes } from '../src/domain/delivery.js'

let dir = ''
let config: ForgeLoopConfig

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function buildConfig(): ForgeLoopConfig {
  return resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      dshProfilesRoot: join(dir, 'profiles'),
      ops: {
        enabled: true,
        monitor: { enabled: true },
        artifacts: [
          {
            id: 'host',
            label: 'ForgeLoop 宿主',
            profile: 'web',
            logs: [
              { id: 'run', path: 'logs/host.log', errorPattern: 'ERROR' },
              { id: 'empty', path: 'logs/missing.log' },
            ],
          },
          {
            id: 'logs-only',
            logs: [{ id: 'run', path: 'logs/host.log' }],
          },
        ],
      },
    },
    dir,
  )
}

function installProfile(): void {
  const root = join(dir, 'profiles', 'web', 'node_modules', 'forgeloop-dsh')
  const index = 'export const index = 1\n'
  const service = 'export const service = 1\n'
  write(join(root, 'package.json'), JSON.stringify({ name: 'forgeloop-dsh', version: '1.0.0' }))
  write(join(root, 'lib', 'index.js'), index)
  write(join(root, 'lib', 'runtime', 'service.js'), service)
  write(
    join(root, 'runtime-identity.json'),
    JSON.stringify({
      kind: 'forgeloop-runtime-identity',
      version: '1.0.0',
      pid: process.pid,
      startedAt: '2026-11-03T00:00:00.000Z',
      indexSha256: sha256OfBytes(Buffer.from(index)),
      serviceSha256: sha256OfBytes(Buffer.from(service)),
    }),
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-artifacts-'))
  write(
    join(dir, 'logs', 'host.log'),
    ['boot ok', 'INFO ready', 'ERROR boom', 'ERROR again', 'INFO tail'].join('\n') + '\n',
  )
  config = buildConfig()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('artifact logs', () => {
  it('reads the tail with error counts and a case-insensitive literal filter', () => {
    const read = readArtifactLog(config, { artifactId: 'host', logId: 'run' })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.data.path).toBe(join(dir, 'logs', 'host.log'))
    expect(read.data.totalLines).toBe(5)
    expect(read.data.matchedLines).toBe(5)
    expect(read.data.errorMatches).toBe(2)
    expect(read.data.lines).toEqual([
      'boot ok',
      'INFO ready',
      'ERROR boom',
      'ERROR again',
      'INFO tail',
    ])
    expect(read.data.sizeBytes).toBeGreaterThan(0)

    const filtered = readArtifactLog(config, {
      artifactId: 'host',
      logId: 'run',
      lines: 1,
      contains: 'error',
    })
    expect(filtered.ok).toBe(true)
    if (!filtered.ok) return
    expect(filtered.data.matchedLines).toBe(2)
    expect(filtered.data.lines).toEqual(['ERROR again'])
    expect(filtered.data.errorMatches).toBe(2)
  })

  it('exposes the plugin runtime log as a built-in artifact', () => {
    const path = join(dir, '.forgeloop', 'projects', 'testproj', 'logs', 'plugin.log')
    write(
      path,
      [
        '{"ts":"2026-11-03T00:00:00.000Z","level":"INFO","message":"boot"}',
        '{"ts":"2026-11-03T00:00:01.000Z","level":"ERROR","message":"boom"}',
      ].join('\n') + '\n',
    )
    const read = readArtifactLog(config, { artifactId: 'forgeloop-plugin', logId: 'plugin' })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.data.path).toBe(path)
    expect(read.data.totalLines).toBe(2)
    expect(read.data.errorMatches).toBe(1)
    const state = readArtifactState(config, 'forgeloop-plugin')
    expect(state.ok).toBe(true)
    if (!state.ok) return
    expect(state.data.profile).toBe('')
    expect(state.data.runtime).toBeNull()
    expect(state.data.logs[0]).toMatchObject({ id: 'plugin', exists: true, errorMatches: 1 })
  })

  it('lets an explicit artifact override the built-in plugin log id', () => {
    const base = buildConfig()
    const overridden: ForgeLoopConfig = {
      ...base,
      ops: {
        ...base.ops,
        artifacts: [
          ...base.ops.artifacts,
          {
            id: 'forgeloop-plugin',
            label: 'custom',
            profile: '',
            logs: [{ id: 'plugin', path: join(dir, 'logs', 'host.log'), errorPattern: '' }],
          },
        ],
      },
    }
    const read = readArtifactLog(overridden, { artifactId: 'forgeloop-plugin', logId: 'plugin' })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.data.path).toBe(join(dir, 'logs', 'host.log'))
  })

  it('reports unknown artifacts, unknown logs, bad bounds and unreadable files', () => {
    expect(readArtifactLog(config, { artifactId: 'nope', logId: 'run' })).toEqual({
      ok: false,
      reason: '未登记研发制品：nope',
    })
    expect(readArtifactLog(config, { artifactId: 'host', logId: 'nope' })).toEqual({
      ok: false,
      reason: '制品 host 没有登记日志：nope',
    })
    for (const lines of [0, 501, 1.5]) {
      const bad = readArtifactLog(config, { artifactId: 'host', logId: 'run', lines })
      expect(bad.ok).toBe(false)
      if (bad.ok) continue
      expect(bad.reason).toContain('lines 必须是 1–500 的整数')
    }
    const long = readArtifactLog(config, {
      artifactId: 'host',
      logId: 'run',
      contains: 'x'.repeat(121),
    })
    expect(long.ok).toBe(false)
    if (long.ok) return
    expect(long.reason).toContain('不能超过 120 字符')

    const missing = readArtifactLog(config, { artifactId: 'host', logId: 'empty' })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.reason).toContain('不可读')
  })

  it('resolves absolute paths and truncates an overlong line', () => {
    write(join(dir, 'logs', 'long.log'), `${'x'.repeat(600)}\n`)
    const absolute = resolveConfig(
      {
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        dshProfilesRoot: join(dir, 'profiles'),
        ops: {
          enabled: true,
          monitor: { enabled: true },
          artifacts: [
            { id: 'abs', logs: [{ id: 'run', path: join(dir, 'logs', 'host.log') }] },
            { id: 'long', logs: [{ id: 'run', path: 'logs/long.log' }] },
          ],
        },
      },
      dir,
    )
    const host = readArtifactLog(absolute, { artifactId: 'abs', logId: 'run' })
    expect(host.ok).toBe(true)
    if (!host.ok) return
    expect(host.data.path).toBe(join(dir, 'logs', 'host.log'))
    expect(host.data.lines[0]).toBe('boot ok')

    const long = readArtifactLog(absolute, { artifactId: 'long', logId: 'run', lines: 1 })
    expect(long.ok).toBe(true)
    if (!long.ok) return
    expect(long.data.lines[0]).toHaveLength(501)
    expect(long.data.lines[0]?.endsWith('…')).toBe(true)
  })

  it('treats an invalid registered regex as unmeasured instead of failing', () => {
    const artifact = config.ops.artifacts[0]!
    const broken = {
      ...config,
      ops: {
        ...config.ops,
        artifacts: [
          { ...artifact, logs: [{ id: 'run', path: 'logs/host.log', errorPattern: '[' }] },
        ],
      },
    } as ForgeLoopConfig
    const read = readArtifactLog(broken, { artifactId: 'host', logId: 'run' })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.data.errorMatches).toBeNull()
  })

  it('keeps a bounded number of characters per call', () => {
    const wide = Array.from({ length: 300 }, (_, i) => `${i}-${'x'.repeat(495)}`)
    write(join(dir, 'logs', 'host.log'), wide.join('\n'))
    const read = readArtifactLog(config, { artifactId: 'logs-only', logId: 'run', lines: 500 })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.data.totalLines).toBeGreaterThan(0)
    expect(read.data.lines.length).toBeLessThan(read.data.totalLines)
    expect(read.data.lines.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(60_000)
  })
})

describe('artifact runtime state', () => {
  it('reports the installed version, live identity and log facts', () => {
    installProfile()
    const state = readArtifactState(config, 'host')
    expect(state.ok).toBe(true)
    if (!state.ok) return
    expect(state.data.label).toBe('ForgeLoop 宿主')
    expect(state.data.profile).toBe('web')
    expect(state.data.runtime?.packagePresent).toBe(true)
    expect(state.data.runtime?.installedVersion).toBe('1.0.0')
    expect(state.data.runtime?.identityPresent).toBe(true)
    expect(state.data.runtime?.pid).toBe(process.pid)
    expect(state.data.runtime?.alive).toBe(true)
    expect(state.data.runtime?.matchesInstalled).toBe(true)
    expect(state.data.runtime?.startedAt).toBe('2026-11-03T00:00:00.000Z')
    expect(state.data.runtime?.detail).toContain('一致')
    expect(state.data.logs[0]).toMatchObject({
      id: 'run',
      exists: true,
      errorMatches: 2,
      error: '',
    })
    expect(state.data.logs[1]).toMatchObject({ id: 'empty', exists: false, error: '文件不存在' })
  })

  it('flags an identity that no longer matches the installed files', () => {
    installProfile()
    write(
      join(dir, 'profiles', 'web', 'node_modules', 'forgeloop-dsh', 'lib', 'index.js'),
      'changed\n',
    )
    const state = readArtifactState(config, 'host')
    expect(state.ok).toBe(true)
    if (!state.ok) return
    expect(state.data.runtime?.matchesInstalled).toBe(false)
    expect(state.data.runtime?.detail).toContain('不一致')
  })

  it('handles a missing, malformed or partially typed runtime identity', () => {
    installProfile()
    const identityPath = join(
      dir,
      'profiles',
      'web',
      'node_modules',
      'forgeloop-dsh',
      'runtime-identity.json',
    )

    rmSync(identityPath)
    const missing = readArtifactState(config, 'host')
    expect(missing.ok).toBe(true)
    if (!missing.ok) return
    expect(missing.data.runtime?.identityPresent).toBe(false)
    expect(missing.data.runtime?.detail).toContain('没有运行身份文件')

    write(identityPath, '{bad')
    const malformed = readArtifactState(config, 'host')
    expect(malformed.ok).toBe(true)
    if (!malformed.ok) return
    expect(malformed.data.runtime?.identityPresent).toBe(false)
    expect(malformed.data.runtime?.detail).toContain('无法解析')

    write(
      identityPath,
      JSON.stringify({
        pid: 'not-a-pid',
        kind: 1,
        version: 2,
        startedAt: 3,
        indexSha256: 4,
        serviceSha256: 5,
      }),
    )
    const partial = readArtifactState(config, 'host')
    expect(partial.ok).toBe(true)
    if (!partial.ok) return
    expect(partial.data.runtime).toMatchObject({
      identityPresent: true,
      pid: 0,
      identityKind: '',
      identityVersion: '',
      startedAt: '',
      matchesInstalled: false,
    })
    expect(partial.data.runtime?.detail).toContain('不一致')
  })

  it('reports an identity whose installed files cannot be hashed', () => {
    installProfile()
    rmSync(join(dir, 'profiles', 'web', 'node_modules', 'forgeloop-dsh', 'lib', 'index.js'))
    const state = readArtifactState(config, 'host')
    expect(state.ok).toBe(true)
    if (!state.ok) return
    expect(state.data.runtime?.identityPresent).toBe(true)
    expect(state.data.runtime?.matchesInstalled).toBe(false)
    expect(state.data.runtime?.detail).toContain('无法读取安装文件摘要')
  })

  it('reports a registered log path that is a directory without throwing', () => {
    mkdirSync(join(dir, 'logs', 'dir'), { recursive: true })
    const withDirectory = resolveConfig(
      {
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        dshProfilesRoot: join(dir, 'profiles'),
        ops: {
          enabled: true,
          monitor: { enabled: true },
          artifacts: [{ id: 'dir', logs: [{ id: 'run', path: 'logs/dir' }] }],
        },
      },
      dir,
    )
    const state = readArtifactState(withDirectory, 'dir')
    expect(state.ok).toBe(true)
    if (!state.ok) return
    expect(state.data.logs[0]).toMatchObject({ id: 'run', exists: true })
    expect(state.data.logs[0]?.error).not.toBe('')
  })

  it('reports a missing package and a logs-only artifact without inventing runtime', () => {
    const ghost = resolveConfig(
      {
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        dshProfilesRoot: join(dir, 'profiles'),
        ops: {
          enabled: true,
          monitor: { enabled: true },
          artifacts: [{ id: 'ghost', profile: 'missing' }],
        },
      },
      dir,
    )
    const state = readArtifactState(ghost, 'ghost')
    expect(state.ok).toBe(true)
    if (!state.ok) return
    expect(state.data.runtime?.packagePresent).toBe(false)
    expect(state.data.runtime?.identityPresent).toBe(false)
    expect(state.data.runtime?.detail).toContain('没有安装产物')

    const logsOnly = readArtifactState(config, 'logs-only')
    expect(logsOnly.ok).toBe(true)
    if (!logsOnly.ok) return
    expect(logsOnly.data.runtime).toBeNull()
    expect(logsOnly.data.logs).toHaveLength(1)
  })

  it('rejects an unknown artifact', () => {
    expect(readArtifactState(config, 'nope')).toEqual({
      ok: false,
      reason: '未登记研发制品：nope',
    })
  })
})
