import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, type RawConfig } from '../src/config.js'

let dir = ''

function toolRoot(): string {
  return join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', 'tools')
}

function writeTool(name = 'deploy.py'): string {
  mkdirSync(toolRoot(), { recursive: true })
  const path = join(toolRoot(), name)
  writeFileSync(path, 'print("{}")\n')
  return path
}

function raw(deployments: Record<string, unknown>): RawConfig {
  return {
    project: 'testproj',
    projectPath: dir,
    recordsRoot: join(dir, '.forgeloop'),
    deployments: deployments as never,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-deploy-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('deployment configuration', () => {
  it('is disabled by default with the deployment-directory tool root', () => {
    const config = resolveConfig(
      { project: 'testproj', projectPath: dir, recordsRoot: join(dir, '.forgeloop') },
      dir,
    )
    expect(config.deployments).toEqual({
      enabled: false,
      toolRoot: join(dir, '.forgeloop', 'projects', 'testproj', 'deployments', 'tools'),
      verifyTimeoutSeconds: 600,
      alerts: { webhook: '', timeoutSeconds: 10 },
      retention: { days: 120, compressEveryDays: 30, maxBytes: 10 * 1024 * 1024 * 1024 },
      tools: [],
      targets: [],
    })
  })

  it('registers a tool under the deployment root and an auto target', () => {
    const path = writeTool()
    const config = resolveConfig(
      raw({
        enabled: true,
        alerts: { webhook: 'https://example.com/deploy-alert' },
        retention: { days: 90, compressEveryDays: 14 },
        tools: [
          {
            id: 'deploy-dsh',
            kind: 'python',
            path,
            capabilities: ['preflight', 'apply', 'status', 'rollback', 'data-rollback'],
            env: ['HOME'],
          },
        ],
        targets: [
          {
            id: 'web',
            toolId: 'deploy-dsh',
            requirementId: 'req-1',
            params: { profile: 'web' },
            data: { volumes: ['web-data'], migrations: ['add-log-table'] },
            approval: 'auto',
            rollback: { keep: 2 },
          },
        ],
      }),
      dir,
    )
    const tool = config.deployments.tools[0]!
    expect(tool.id).toBe('deploy-dsh')
    expect(tool.path).toContain('deploy.py')
    expect(tool.timeoutSeconds).toBe(300)
    expect(config.deployments.targets[0]).toEqual({
      id: 'web',
      toolId: 'deploy-dsh',
      requirementId: 'req-1',
      params: { profile: 'web' },
      data: { volumes: ['web-data'], migrations: ['add-log-table'] },
      approval: 'auto',
      rollback: { keep: 2 },
    })
    expect(config.deployments.retention.days).toBe(90)
    expect(config.deployments.retention.compressEveryDays).toBe(14)
  })

  it('rejects tools outside the trust root, bad kinds and incomplete capabilities', () => {
    const outside = join(dir, 'outside.py')
    writeFileSync(outside, 'print("{}")\n')
    const base = { id: 't', kind: 'python', path: outside, capabilities: ['preflight', 'apply'] }
    expect(() => resolveConfig(raw({ tools: [base] }), dir)).toThrow(
      '必须位于 deployments.toolRoot 内',
    )
    expect(() =>
      resolveConfig(raw({ tools: [{ ...base, kind: 'docker', path: writeTool() }] }), dir),
    ).toThrow('kind 只能是')
    expect(() =>
      resolveConfig(raw({ tools: [{ ...base, path: writeTool(), capabilities: ['apply'] }] }), dir),
    ).toThrow('缺少 preflight')
    expect(() =>
      resolveConfig(
        raw({ tools: [{ ...base, path: writeTool(), capabilities: ['preflight'] }] }),
        dir,
      ),
    ).toThrow('缺少 apply')
    expect(() => resolveConfig(raw({ tools: [{ ...base, path: 'relative.py' }] }), dir)).toThrow(
      '必须是绝对路径',
    )
    expect(() =>
      resolveConfig(
        raw({ tools: [{ ...base, path: writeTool(), capabilities: ['apply', 'apply'] }] }),
        dir,
      ),
    ).toThrow('重复')
  })

  it('requires alerts and a rollback slot for auto targets, and data-rollback for data scope', () => {
    const path = writeTool()
    const tool = { id: 't', kind: 'python', path, capabilities: ['preflight', 'apply'] }
    const target = {
      id: 'web',
      toolId: 't',
      requirementId: 'req-1',
      approval: 'auto',
      data: { volumes: ['web-data'] },
    }
    const toolWithData = { ...tool, capabilities: ['preflight', 'apply', 'data-rollback'] }
    expect(() => resolveConfig(raw({ tools: [toolWithData], targets: [target] }), dir)).toThrow(
      '必须配置 deployments.alerts.webhook',
    )
    expect(() =>
      resolveConfig(
        raw({ alerts: { webhook: 'https://example.com/hook' }, tools: [tool], targets: [target] }),
        dir,
      ),
    ).toThrow('data-rollback')
  })

  it('rejects malformed targets, retention and tool references', () => {
    const path = writeTool()
    const tool = { id: 't', kind: 'python', path, capabilities: ['preflight', 'apply'] }
    expect(() =>
      resolveConfig(
        raw({ tools: [tool], targets: [{ id: 'x', toolId: 'missing', requirementId: 'r' }] }),
        dir,
      ),
    ).toThrow('未登记的工具')
    expect(() =>
      resolveConfig(
        raw({
          tools: [tool],
          targets: [{ id: 'x', toolId: 't', requirementId: 'r', approval: 'maybe' }],
        }),
        dir,
      ),
    ).toThrow('owner 或 auto')
    expect(() =>
      resolveConfig(raw({ retention: { days: 10, compressEveryDays: 20 } }), dir),
    ).toThrow('不能大于 days')
    expect(() => resolveConfig(raw({ retention: { maxBytes: 1024 } }), dir)).toThrow(
      '不能小于 1 MiB',
    )
    expect(() => resolveConfig(raw({ verifyTimeoutSeconds: 5 }), dir)).toThrow('必须在 30')
    expect(() => resolveConfig(raw({ tools: [tool, { ...tool }] }), dir)).toThrow('重复：t')
  })
})
