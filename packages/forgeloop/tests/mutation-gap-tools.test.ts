import { describe, expect, it } from 'vitest'
import { buildTools } from '../src/tools.js'
import { resolveConfig } from '../src/config.js'

describe('tool surface', () => {
  it('keeps names, descriptions, parameters and output schemas stable', () => {
    const runtime = new Proxy(
      {},
      {
        get: () => () => ({ ok: true, message: '', data: {} }),
      },
    )
    const config = resolveConfig({
      project: 'demo',
      projectPath: '/tmp/demo',
      recordsRoot: '/tmp/demo/.forgeloop',
    })
    const tools = buildTools(runtime as never, config)
    expect(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: tool.output.schema,
      })),
    ).toMatchSnapshot()
  })
})
