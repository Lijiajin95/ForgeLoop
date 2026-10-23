import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { resolveConfig, recordsPath } from '../src/config.js'

describe('project storage across Desktop and Web hosts', () => {
  const projectPath = join(tmpdir(), 'forgeloop-host-project')

  it('uses the configured project for default records regardless of the host working directory', () => {
    const desktop = resolveConfig({ projectPath }, join(tmpdir(), 'desktop-launch'))
    const web = resolveConfig({ projectPath }, projectPath)

    expect(desktop.recordsRoot).toBe(join(projectPath, '.forgeloop'))
    expect(recordsPath(desktop)).toBe(recordsPath(web))
  })

  it('resolves relative records directories against the project, not the application directory', () => {
    const config = resolveConfig({ projectPath, recordsRoot: 'records' }, '/Applications')

    expect(config.recordsRoot).toBe(join(projectPath, 'records'))
  })

  it('expands home paths consistently in both hosts', () => {
    const config = resolveConfig({ projectPath: '~/Project/example', recordsRoot: '~/.forgeloop' }, '/')

    expect(config.projectPath).toBe(join(homedir(), 'Project/example'))
    expect(config.recordsRoot).toBe(join(homedir(), '.forgeloop'))
  })

  it('preserves an explicitly configured absolute shared records directory', () => {
    const recordsRoot = join(tmpdir(), 'forgeloop-shared-records')
    const config = resolveConfig({ projectPath, recordsRoot }, '/Applications')

    expect(config.recordsRoot).toBe(recordsRoot)
  })
})
