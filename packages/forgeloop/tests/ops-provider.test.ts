import { describe, expect, it } from 'vitest'
import {
  BUILTIN_OPS_PROVIDER_ID,
  OPS_PROVIDER_REGISTRY,
  OPS_PROVIDER_VERSION,
  describeOpsProviders,
  findOpsProvider,
} from '../src/domain/ops-provider.js'

describe('ops provider registry', () => {
  it('registers only the builtin collector today', () => {
    expect(OPS_PROVIDER_REGISTRY.map((provider) => provider.id)).toEqual([BUILTIN_OPS_PROVIDER_ID])
    const builtin = findOpsProvider(BUILTIN_OPS_PROVIDER_ID)
    expect(builtin?.kind).toBe('builtin')
    expect(builtin?.version).toBe(OPS_PROVIDER_VERSION)
    expect(builtin?.capabilities).toContain('host')
    expect(builtin?.capabilities).toContain('checks')
  })

  it('does not resolve external providers that are not registered yet', () => {
    expect(findOpsProvider('glances')).toBeUndefined()
    expect(findOpsProvider('prometheus')).toBeUndefined()
    expect(describeOpsProviders()).toContain('builtin')
    expect(describeOpsProviders()).not.toContain('glances')
  })
})
