import { describe, expect, it } from 'vitest'
import { ownerOnly } from '../src/runtime/deployment-access.js'

describe('deployment owner gate', () => {
  it('accepts the configured owner and rejects everyone else', () => {
    expect(ownerOnly('owner', 'owner')).toBeNull()
    expect(ownerOnly('owner', 'ops-agent')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(ownerOnly('owner', '')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(ownerOnly('owner', ' Owner ')).toMatchObject({ ok: false, code: 'forbidden' })
  })
})
