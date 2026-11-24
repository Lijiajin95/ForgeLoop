import { describe, expect, it } from 'vitest'
import { egressLine, modelHostFor } from '../../../scripts/ts/verification-model-egress.ts'

describe('verification model egress', () => {
  it('matches only the registered model hosts on port 443', () => {
    const hosts = ['api.deepseek.com', 'token-plan.cn-beijing.maas.aliyuncs.com']
    expect(modelHostFor('api.deepseek.com:443', hosts)).toBe('api.deepseek.com')
    expect(modelHostFor('API.DEEPSEEK.COM:443', hosts)).toBe('api.deepseek.com')
    expect(modelHostFor('api.deepseek.com:8443', hosts)).toBeUndefined()
    expect(modelHostFor('example.com:443', hosts)).toBeUndefined()
    expect(modelHostFor(undefined, hosts)).toBeUndefined()
  })

  it('reports rejected targets and whether the proxy credential was present', () => {
    expect(egressLine('reject', 'example.com:443', 'host', false)).toBe(
      '[egress] reject target=example.com:443 reason=host auth=absent',
    )
    expect(egressLine('reject', 'api.deepseek.com:443', 'auth', true)).toBe(
      '[egress] reject target=api.deepseek.com:443 reason=auth auth=present',
    )
    expect(egressLine('allow', 'api.deepseek.com:443', '', true)).toBe(
      '[egress] allow target=api.deepseek.com:443 auth=present',
    )
  })

  it('never writes the proxy credential into the log line', () => {
    const line = egressLine('reject', 'api.deepseek.com:443', 'auth', true)
    expect(line).not.toMatch(/Basic|forge:|password/)
  })
})
