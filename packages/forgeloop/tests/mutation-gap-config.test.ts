import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultConfigPath,
  evidenceDir,
  loadConfigFile,
  loadConfigOrThrow,
  mergeConfig,
  projectDir,
  recordsPath,
  resolveConfig,
} from '../src/config.js'

function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-config-gap-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('config file loading', () => {
  it('returns an empty object for a missing file and merges file over base', () => {
    withDir((dir) => {
      expect(loadConfigFile(join(dir, 'missing.json'))).toEqual({})
      expect(mergeConfig({ project: 'base', owner: 'a' }, { owner: 'b' })).toEqual({
        project: 'base',
        owner: 'b',
      })
    })
  })

  it('rejects invalid JSON and non-object roots with the path in the message', () => {
    withDir((dir) => {
      const bad = join(dir, 'bad.json')
      writeFileSync(bad, '{nope')
      expect(() => loadConfigFile(bad)).toThrow(`ForgeLoop 配置文件不是合法 JSON：${bad}：`)
      writeFileSync(bad, '[]')
      expect(() => loadConfigFile(bad)).toThrow(`ForgeLoop 配置文件必须是 JSON 对象：${bad}`)
      writeFileSync(bad, 'null')
      expect(() => loadConfigFile(bad)).toThrow(`ForgeLoop 配置文件必须是 JSON 对象：${bad}`)
    })
  })

  it('prefers explicit base paths and fails when no file exists', () => {
    withDir((dir) => {
      const path = join(dir, 'config.json')
      expect(loadConfigOrThrow({ recordsRoot: '/tmp/records' }, path)).toEqual({
        recordsRoot: '/tmp/records',
      })
      expect(loadConfigOrThrow({ projectPath: '/tmp/project' }, path)).toEqual({
        projectPath: '/tmp/project',
      })
      expect(() => loadConfigOrThrow({}, path)).toThrow(
        `ForgeLoop 配置缺失：请写入 ${path}（或用 FORGELOOP_CONFIG 指定路径），不要依赖默认目录`,
      )
      writeFileSync(path, JSON.stringify({ owner: 'file-owner' }))
      expect(loadConfigOrThrow({}, path)).toEqual({ owner: 'file-owner' })
    })
  })

  it('derives the default path from HOME', () => {
    expect(defaultConfigPath()).toBe(join(process.env.HOME ?? '', '.forgeloop', 'config.json'))
  })
})

describe('resolveConfig', () => {
  it('applies defaults and resolves project-relative paths', () => {
    const config = resolveConfig({ project: 'demo', projectPath: '/tmp/project' }, '/tmp')
    expect(config).toMatchObject({
      project: 'demo',
      projectPath: '/tmp/project',
      recordsRoot: '/tmp/project/.forgeloop',
      owner: 'local-owner',
      pollSeconds: 5,
      autoAdvance: false,
      agent: {
        provider: '',
        model: '',
        timeoutSeconds: -1,
        maxTurnSeconds: -1,
        idleTimeoutSeconds: -1,
      },
      formalTestTimeoutSeconds: -1,
      maxTaskAttempts: -1,
      failureRoundsPerGrant: -1,
      maxVerificationAttempts: -1,
      worktreePrepareCommand: [],
      candidateBuildCommand: [],
      candidatePackageCommand: [],
      candidateArtifactPath: '',
      deployments: expect.any(Object),
      ops: expect.any(Object),
    })
    expect(projectDir(config)).toBe('/tmp/project/.forgeloop/projects/demo')
    expect(recordsPath(config)).toBe('/tmp/project/.forgeloop/projects/demo/records.sqlite')
    expect(evidenceDir(config, 'req-1', 2, 't1')).toBe(
      '/tmp/project/.forgeloop/projects/demo/evidence/req-1/v2/t1',
    )
  })

  it('rejects unsafe projects and invalid numeric limits', () => {
    expect(() => resolveConfig({ project: 'Bad Name' })).toThrow(
      '配置 project 只能是安全的项目名，实际 "Bad Name"',
    )
    expect(() => resolveConfig({ project: 'ok', pollSeconds: 0 })).toThrow(
      '配置 pollSeconds 必须是正数，实际 0',
    )
    expect(() => resolveConfig({ pollSeconds: 0.5 })).toThrow('配置 pollSeconds 不能小于 1 秒')
    expect(() => resolveConfig({ maxTaskAttempts: 0 })).toThrow(
      '配置 maxTaskAttempts 必须为 -1 或正整数（-1 表示不限），实际 0',
    )
    expect(() => resolveConfig({ maxTaskAttempts: 1.5 })).toThrow(
      '配置 maxTaskAttempts 必须为 -1 或正整数',
    )
    expect(() => resolveConfig({ formalTestTimeoutSeconds: 0 })).toThrow(
      '配置 formalTestTimeoutSeconds 必须为 -1 或正数（-1 表示不限），实际 0',
    )
    expect(() => resolveConfig({ agent: { timeoutSeconds: -2 } })).toThrow(
      '配置 agent.timeoutSeconds 必须为 -1 或正数（-1 表示不限），实际 -2',
    )
    expect(() => resolveConfig({ worktreePrepareCommand: 'npm' })).toThrow(
      '配置 worktreePrepareCommand 必须是字符串数组',
    )
    expect(() => resolveConfig({ worktreePrepareCommand: ['ok', 1] })).toThrow(
      '配置 worktreePrepareCommand 必须是字符串数组',
    )
  })

  it('normalizes strings, booleans, lists and paths', () => {
    const config = resolveConfig({
      project: 'demo',
      projectPath: ' ./project ',
      recordsRoot: ' records ',
      owner: ' owner ',
      pollSeconds: 1,
      autoAdvance: true,
      agent: {
        provider: ' p ',
        model: ' m ',
        timeoutSeconds: 10,
        maxTurnSeconds: -1,
        idleTimeoutSeconds: 5,
      },
      maxTaskAttempts: 2,
      failureRoundsPerGrant: 3,
      maxVerificationAttempts: 4,
      worktreePrepareCommand: ['a', 'b'],
      candidateBuildCommand: ['c'],
      candidatePackageCommand: ['d'],
      candidateArtifactPath: ' artifact ',
    })
    expect(config).toMatchObject({
      projectPath: expect.stringContaining('/project'),
      recordsRoot: expect.stringContaining('/project/records'),
      owner: 'owner',
      pollSeconds: 1,
      autoAdvance: true,
      agent: {
        provider: 'p',
        model: 'm',
        timeoutSeconds: 10,
        maxTurnSeconds: -1,
        idleTimeoutSeconds: 5,
      },
      maxTaskAttempts: 2,
      failureRoundsPerGrant: 3,
      maxVerificationAttempts: 4,
      worktreePrepareCommand: ['a', 'b'],
      candidateBuildCommand: ['c'],
      candidatePackageCommand: ['d'],
      candidateArtifactPath: 'artifact',
    })
    expect(config.autoAdvance).toBe(true)
    expect(resolveConfig({ autoAdvance: 'true' }).autoAdvance).toBe(false)
  })
})
