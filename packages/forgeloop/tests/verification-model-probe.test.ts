import { describe, expect, it } from 'vitest'
import { MODEL_PROXY_PROBE, modelProxyProbe } from '../../../scripts/ts/verification-model-probe.ts'

describe('model proxy readiness probe', () => {
  it('builds a docker exec probe that targets the proxy port and prints readiness', () => {
    const args = modelProxyProbe('forgeloop-verify-run')
    expect(args.slice(0, 4)).toEqual(['exec', 'forgeloop-verify-run', 'node', '-e'])
    expect(args[4]).toBe(MODEL_PROXY_PROBE)
    expect(MODEL_PROXY_PROBE).toContain('127.0.0.1:8123')
    expect(MODEL_PROXY_PROBE).toContain("console.log('ready')")
    expect(MODEL_PROXY_PROBE).toContain('statusCode===403')
  })

  it('keeps every argument free of shell metacharacters so cmd.exe cannot redirect it', () => {
    const args = modelProxyProbe('proxy')
    for (const arg of args) {
      expect(arg).not.toMatch(/[><&|^]/)
    }
    expect(MODEL_PROXY_PROBE).not.toContain('=>')
  })
})
