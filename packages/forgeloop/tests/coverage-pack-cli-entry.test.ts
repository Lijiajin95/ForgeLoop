import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

const originalArgv = process.argv[1]
const originalExitCode = process.exitCode

vi.mock('node:child_process', () => ({
  execFileSync: () => '[]',
}))

afterEach(() => {
  if (originalArgv === undefined) delete process.argv[1]
  else process.argv[1] = originalArgv
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
})

describe('candidate package cli entrypoint', () => {
  it('reports a failed pack when executed as a script', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message))
    })
    process.argv[1] = fileURLToPath(new URL('../src/cli/pack.ts', import.meta.url))
    vi.resetModules()
    await import('../src/cli/pack.js')
    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('[forgeloop-pack]')
    expect(errors.join('\n')).toContain('npm pack 没有返回产物信息')
  })

  it('does not run when imported outside the script entry', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message))
    })
    process.argv[1] = '/tmp/forgeloop-not-the-pack-cli.js'
    process.exitCode = 0
    vi.resetModules()
    await import('../src/cli/pack.js')
    expect(process.exitCode).toBe(0)
    expect(errors).toEqual([])
  })
})
