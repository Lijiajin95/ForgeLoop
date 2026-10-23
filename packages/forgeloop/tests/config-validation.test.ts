import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'

const cwd = '/tmp/config-fixture'

describe('configuration defaults', () => {
  it('falls back to the documented defaults', () => {
    const config = resolveConfig({}, cwd)
    expect(config.project).toBe('forgeloop')
    expect(config.owner).toBe('local-owner')
    expect(config.pollSeconds).toBe(5)
    expect(config.autoAdvance).toBe(false)
    expect(config.agent).toEqual({ provider: '', model: '', timeoutSeconds: 1800 })
    expect(config.formalTestTimeoutSeconds).toBe(1800)
    expect(config.maxTaskAttempts).toBe(3)
    expect(config.candidateArtifactPath).toBe('')
    expect(config.projectPath).toBe('/tmp/config-fixture')
    expect(config.recordsRoot).toBe('/tmp/config-fixture/.forgeloop')
  })

  it('resolves the project path and records root against the selected project', () => {
    const config = resolveConfig({ project: 'proj-1', projectPath: 'sub', recordsRoot: 'records' }, cwd)
    expect(config.projectPath).toBe('/tmp/config-fixture/sub')
    expect(config.recordsRoot).toBe('/tmp/config-fixture/sub/records')
  })

  it('expands a bare home and a home-prefixed path', () => {
    expect(resolveConfig({ recordsRoot: '~' }, cwd).recordsRoot).toBe(homedir())
    expect(resolveConfig({ recordsRoot: '~/data' }, cwd).recordsRoot).toBe(join(homedir(), 'data'))
  })

  it('trims blank optional values and enables auto advance only when true', () => {
    const config = resolveConfig(
      { owner: '  owner-x  ', candidateArtifactPath: '   ', autoAdvance: true },
      cwd,
    )
    expect(config.owner).toBe('owner-x')
    expect(config.candidateArtifactPath).toBe('')
    expect(config.autoAdvance).toBe(true)
    expect(resolveConfig({ autoAdvance: 'yes' as never }, cwd).autoAdvance).toBe(false)
  })
})

describe('configuration validation', () => {
  it('rejects unsafe project names', () => {
    expect(() => resolveConfig({ project: 'Bad Name' }, cwd)).toThrow('配置 project 只能是安全的项目名')
    expect(() => resolveConfig({ project: '/etc' }, cwd)).toThrow('配置 project 只能是安全的项目名')
  })

  it('rejects a non-positive or non-numeric poll interval', () => {
    expect(() => resolveConfig({ pollSeconds: 0 }, cwd)).toThrow('配置 pollSeconds 必须是正数')
    expect(() => resolveConfig({ pollSeconds: '5' as never }, cwd)).toThrow('配置 pollSeconds 必须是正数')
    expect(() => resolveConfig({ pollSeconds: Number.NaN }, cwd)).toThrow('配置 pollSeconds 必须是正数')
    expect(() => resolveConfig({ pollSeconds: 0.5 }, cwd)).toThrow('配置 pollSeconds 不能小于 1 秒')
  })

  it('rejects a non-positive agent timeout', () => {
    expect(() => resolveConfig({ agent: { timeoutSeconds: -1 } }, cwd)).toThrow(
      '配置 agent.timeoutSeconds 必须是正数',
    )
    expect(() => resolveConfig({ formalTestTimeoutSeconds: 0 }, cwd)).toThrow(
      '配置 formalTestTimeoutSeconds 必须是正数',
    )
  })

  it('rejects non-integer task attempt budgets', () => {
    expect(() => resolveConfig({ maxTaskAttempts: 0 }, cwd)).toThrow('配置 maxTaskAttempts 必须是正整数')
    expect(() => resolveConfig({ maxTaskAttempts: 1.5 }, cwd)).toThrow('配置 maxTaskAttempts 必须是正整数')
  })

  it('rejects command lists that are not non-empty strings', () => {
    expect(() => resolveConfig({ worktreePrepareCommand: 'npm' as never }, cwd)).toThrow(
      '配置 worktreePrepareCommand 必须是字符串数组',
    )
    expect(() => resolveConfig({ worktreePrepareCommand: ['npm', ' '] }, cwd)).toThrow(
      '配置 worktreePrepareCommand 必须是字符串数组',
    )
    expect(() => resolveConfig({ candidateBuildCommand: [''] }, cwd)).toThrow(
      '配置 candidateBuildCommand 必须是字符串数组',
    )
    expect(() => resolveConfig({ candidatePackageCommand: [1] as never }, cwd)).toThrow(
      '配置 candidatePackageCommand 必须是字符串数组',
    )
  })

  it('accepts explicit valid overrides', () => {
    const config = resolveConfig(
      {
        project: 'ok_project-1',
        pollSeconds: 1,
        maxTaskAttempts: 1,
        worktreePrepareCommand: ['npm', 'install'],
        candidateBuildCommand: ['npm', 'run', 'build'],
        candidatePackageCommand: ['npm', 'pack'],
        candidateArtifactPath: 'dist/artifact.json',
        agent: { provider: 'p', model: 'm', timeoutSeconds: 30 },
      },
      cwd,
    )
    expect(config.project).toBe('ok_project-1')
    expect(config.pollSeconds).toBe(1)
    expect(config.worktreePrepareCommand).toEqual(['npm', 'install'])
    expect(config.candidateBuildCommand).toEqual(['npm', 'run', 'build'])
    expect(config.candidatePackageCommand).toEqual(['npm', 'pack'])
    expect(config.candidateArtifactPath).toBe('dist/artifact.json')
  })
})
