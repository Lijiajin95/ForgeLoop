import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveConfig } from '../src/config.js'

const cwd = resolve('/tmp/config-fixture')

describe('configuration defaults', () => {
  it('falls back to the documented defaults', () => {
    const config = resolveConfig({}, cwd)
    expect(config.project).toBe('forgeloop')
    expect(config.owner).toBe('local-owner')
    expect(config.pollSeconds).toBe(5)
    expect(config.autoAdvance).toBe(false)
    expect(config.agent).toEqual({
      provider: '',
      model: '',
      timeoutSeconds: -1,
      maxTurnSeconds: -1,
      idleTimeoutSeconds: -1,
    })
    expect(config.formalTestTimeoutSeconds).toBe(-1)
    expect(config.maxTaskAttempts).toBe(-1)
    expect(config.failureRoundsPerGrant).toBe(-1)
    expect(config.maxVerificationAttempts).toBe(-1)
    expect(config.candidateArtifactPath).toBe('')
    expect(config.projectPath).toBe(cwd)
    expect(config.recordsRoot).toBe(join(cwd, '.forgeloop'))
  })

  it('defaults to JSON logging at info level with a 10 MiB rotation ceiling', () => {
    expect(resolveConfig({}, cwd).logging).toEqual({
      level: 'info',
      format: 'json',
      maxBytes: 10 * 1024 * 1024,
    })
    expect(
      resolveConfig({ logging: { level: 'warn', format: 'text', maxBytes: 1024 } }, cwd).logging,
    ).toEqual({ level: 'warn', format: 'text', maxBytes: 1024 })
    expect(resolveConfig({ logging: { maxBytes: 0 } }, cwd).logging.maxBytes).toBe(0)
  })

  it('rejects unknown log levels, formats and invalid rotation sizes', () => {
    expect(() => resolveConfig({ logging: { level: 'debug' } }, cwd)).toThrow(
      '配置 logging.level 只能是 info、warn 或 error',
    )
    expect(() => resolveConfig({ logging: { format: 'xml' } }, cwd)).toThrow(
      '配置 logging.format 只能是 json 或 text',
    )
    expect(() => resolveConfig({ logging: { maxBytes: -1 } }, cwd)).toThrow(
      '配置 logging.maxBytes 必须是 0 到 1073741824 之间的整数',
    )
    expect(() => resolveConfig({ logging: { maxBytes: 1.5 } }, cwd)).toThrow(
      '配置 logging.maxBytes 必须是 0 到 1073741824 之间的整数',
    )
    expect(() => resolveConfig({ logging: { maxBytes: 1024 * 1024 * 1024 + 1 } }, cwd)).toThrow(
      '配置 logging.maxBytes 必须是 0 到 1073741824 之间的整数',
    )
  })

  it('accepts an explicit long-task turn cap', () => {
    const config = resolveConfig({ agent: { timeoutSeconds: 600, maxTurnSeconds: 10800 } }, cwd)
    expect(config.agent.timeoutSeconds).toBe(600)
    expect(config.agent.maxTurnSeconds).toBe(10800)
    expect(config.agent.idleTimeoutSeconds).toBe(-1)
  })

  it('resolves the project path and records root against the selected project', () => {
    const config = resolveConfig(
      { project: 'proj-1', projectPath: 'sub', recordsRoot: 'records' },
      cwd,
    )
    expect(config.projectPath).toBe(join(cwd, 'sub'))
    expect(config.recordsRoot).toBe(join(cwd, 'sub', 'records'))
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
    expect(() => resolveConfig({ project: 'Bad Name' }, cwd)).toThrow(
      '配置 project 只能是安全的项目名',
    )
    expect(() => resolveConfig({ project: '/etc' }, cwd)).toThrow('配置 project 只能是安全的项目名')
  })

  it('rejects a non-positive or non-numeric poll interval', () => {
    expect(() => resolveConfig({ pollSeconds: 0 }, cwd)).toThrow('配置 pollSeconds 必须是正数')
    expect(() => resolveConfig({ pollSeconds: '5' as never }, cwd)).toThrow(
      '配置 pollSeconds 必须是正数',
    )
    expect(() => resolveConfig({ pollSeconds: Number.NaN }, cwd)).toThrow(
      '配置 pollSeconds 必须是正数',
    )
    expect(() => resolveConfig({ pollSeconds: 0.5 }, cwd)).toThrow('配置 pollSeconds 不能小于 1 秒')
  })

  it('accepts -1 as unlimited and rejects zero or other negatives', () => {
    expect(resolveConfig({ agent: { timeoutSeconds: -1 } }, cwd).agent.timeoutSeconds).toBe(-1)
    expect(() => resolveConfig({ agent: { timeoutSeconds: 0 } }, cwd)).toThrow(
      '配置 agent.timeoutSeconds 必须为 -1 或正数',
    )
    expect(() => resolveConfig({ agent: { timeoutSeconds: -2 } }, cwd)).toThrow(
      '配置 agent.timeoutSeconds 必须为 -1 或正数',
    )
    expect(resolveConfig({ formalTestTimeoutSeconds: -1 }, cwd).formalTestTimeoutSeconds).toBe(-1)
    expect(() => resolveConfig({ formalTestTimeoutSeconds: 0 }, cwd)).toThrow(
      '配置 formalTestTimeoutSeconds 必须为 -1 或正数',
    )
  })

  it('accepts -1 for unbounded integer attempts and rejects zero', () => {
    expect(resolveConfig({ maxTaskAttempts: -1 }, cwd).maxTaskAttempts).toBe(-1)
    expect(() => resolveConfig({ maxTaskAttempts: 0 }, cwd)).toThrow(
      '配置 maxTaskAttempts 必须为 -1 或正整数',
    )
    expect(() => resolveConfig({ maxTaskAttempts: -2 }, cwd)).toThrow(
      '配置 maxTaskAttempts 必须为 -1 或正整数',
    )
    expect(() => resolveConfig({ maxTaskAttempts: 1.5 }, cwd)).toThrow(
      '配置 maxTaskAttempts 必须为 -1 或正整数',
    )
  })

  it('accepts -1 for unbounded failure quotas and verification retries', () => {
    expect(resolveConfig({ failureRoundsPerGrant: -1 }, cwd).failureRoundsPerGrant).toBe(-1)
    expect(() => resolveConfig({ failureRoundsPerGrant: 0 }, cwd)).toThrow(
      '配置 failureRoundsPerGrant 必须为 -1 或正整数',
    )
    expect(() => resolveConfig({ failureRoundsPerGrant: -2 }, cwd)).toThrow(
      '配置 failureRoundsPerGrant 必须为 -1 或正整数',
    )
    expect(resolveConfig({ maxVerificationAttempts: -1 }, cwd).maxVerificationAttempts).toBe(-1)
    expect(() => resolveConfig({ maxVerificationAttempts: 0 }, cwd)).toThrow(
      '配置 maxVerificationAttempts 必须为 -1 或正整数',
    )
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
