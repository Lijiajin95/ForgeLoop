import { describe, expect, it } from 'vitest'
import { restrictToolNames } from '../src/runtime/agent-runner.js'

function tools(names: string[]) {
  return { schemas: () => names.map((name) => ({ name })) } as never
}

describe('tool allowlist enforcement', () => {
  it('denies every tool outside the allowlist', () => {
    const calls: unknown[] = []
    const ctx = {
      tools: { restrict: (filter: unknown) => calls.push(filter) },
    }
    restrictToolNames(ctx as never, tools(['a', 'b', 'c']), ['a'])
    expect(calls).toEqual([{ deny: ['b', 'c'] }])
  })

  it('refuses to run when the host cannot restrict tools', () => {
    expect(() => restrictToolNames({} as never, tools(['a']), ['a'])).toThrow(
      '宿主未提供工具限制服务',
    )
  })

  it('denies everything when no allowlist is given', () => {
    const calls: unknown[] = []
    const ctx = { tools: { restrict: (filter: unknown) => calls.push(filter) } }
    restrictToolNames(ctx as never, tools(['a', 'b']))
    expect(calls).toEqual([{ deny: ['a', 'b'] }])
  })
})
