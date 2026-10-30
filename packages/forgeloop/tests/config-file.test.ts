import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfigFile, loadConfigOrThrow, mergeConfig, resolveConfig } from '../src/config.js'

/**
 * ForgeLoop 独立配置文件：默认路径、缺失回落、非法 JSON 失败、覆盖宿主装载参数。
 * 目的是让业务配置不再写进 DSH 的 cordis 配置。
 */

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('external config file', () => {
  it('returns an empty object when the file is missing', () => {
    expect(loadConfigFile(join(dir, 'missing.json'))).toEqual({})
  })

  it('loads a JSON object from the given path', () => {
    const path = join(dir, 'config.json')
    writeFileSync(
      path,
      JSON.stringify({ project: 'forgeloop', autoAdvance: true, pollSeconds: 2 }),
      'utf8',
    )
    expect(loadConfigFile(path)).toEqual({ project: 'forgeloop', autoAdvance: true, pollSeconds: 2 })
  })

  it('fails loudly on malformed JSON or non-objects', () => {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json', 'utf8')
    expect(() => loadConfigFile(bad)).toThrow('不是合法 JSON')
    const array = join(dir, 'array.json')
    writeFileSync(array, '[]', 'utf8')
    expect(() => loadConfigFile(array)).toThrow('必须是 JSON 对象')
  })

  it('fails instead of silently falling back to a default records root', () => {
    expect(() => loadConfigOrThrow({}, join(dir, 'missing.json'))).toThrow('ForgeLoop 配置缺失')
    // 宿主已显式给出关键路径时以宿主为准（测试场景），不再读取本机文件。
    expect(
      loadConfigOrThrow({ projectPath: '/tmp/project' }, join(dir, 'missing.json')),
    ).toEqual({ projectPath: '/tmp/project' })
  })

  it('lets the external file supply config when the mount has none', () => {
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ projectPath: '/tmp/project', project: 'p' }), 'utf8')
    expect(loadConfigOrThrow({}, path)).toEqual({ projectPath: '/tmp/project', project: 'p' })
  })

  it('merges file over mount values when both are present', () => {
    const merged = mergeConfig({ project: 'from-dsh', pollSeconds: 9 }, { pollSeconds: 2 })
    expect(merged).toEqual({ project: 'from-dsh', pollSeconds: 2 })
    const config = resolveConfig(merged, dir)
    expect(config.pollSeconds).toBe(2)
    expect(config.project).toBe('from-dsh')
  })
})
