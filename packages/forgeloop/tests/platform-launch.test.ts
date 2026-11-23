import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { windowsExecutable } from '../../../scripts/ts/platform.ts'

const missing = () => false

describe('Windows command resolution', () => {
  it('keeps a bare executable name that has no .cmd shim', () => {
    expect(windowsExecutable('docker', missing, [])).toBe('docker')
  })

  it('selects a .cmd shim found on PATH for a bare name', () => {
    const shim = join('/npm', 'dsh.cmd')
    const exists = (path: string) => path === shim
    expect(windowsExecutable('dsh', exists, ['/bin', '/npm'])).toBe('dsh.cmd')
  })

  it('keeps an explicit executable path unchanged', () => {
    const docker = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
    expect(windowsExecutable(docker, () => true, [])).toBe(docker)
  })

  it('keeps an extensionless path that has no .cmd shim', () => {
    expect(windowsExecutable('C:\\tools\\run', missing, [])).toBe('C:\\tools\\run')
  })

  it('selects an existing .cmd shim for an extensionless path', () => {
    const exists = (path: string) => path === 'C:\\tools\\run.cmd'
    expect(windowsExecutable('C:\\tools\\run', exists, [])).toBe('C:\\tools\\run.cmd')
  })
})
