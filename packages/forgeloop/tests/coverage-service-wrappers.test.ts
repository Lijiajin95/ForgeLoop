import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime } from '../src/runtime/service.js'

let dir = ''
let runtime: ForgeLoopRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-service-wrappers-'))
  const config = resolveConfig(
    { project: 'demo', projectPath: dir, recordsRoot: join(dir, '.forgeloop') },
    dir,
  )
  runtime = new ForgeLoopRuntime({ ctx: {}, config })
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('runtime facade wrappers', () => {
  it('serves reliability for the requested window', () => {
    const report = runtime.reliability('7d')
    expect(report.project).toBe('demo')
    expect(report.window.key).toBe('7d')
    expect(report.warnings).toEqual(expect.any(Array))
  })

  it('forwards ops close and fix requests to the ops runtime', () => {
    expect(
      runtime.opsClose({ eventId: 'ops-missing', by: 'owner', reason: '处理完成' }),
    ).toMatchObject({ ok: false, code: 'not_found' })
    expect(
      runtime.opsRequestFix({ eventId: 'ops-missing', by: 'owner', source: 'test:ops' }),
    ).toMatchObject({ ok: false, code: 'not_found' })
  })
})
