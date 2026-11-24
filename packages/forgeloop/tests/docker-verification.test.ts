import { describe, expect, it } from 'vitest'
import {
  assertLocalDockerHost,
  verificationSettings,
  VERIFICATION_TARGETS,
} from '../../../scripts/ts/verification-container.ts'
import { modelHostFor } from '../../../scripts/ts/verification-model-egress.ts'

describe('Docker verification inputs', () => {
  it('registers every automated real-host, installer, and model scenario', () => {
    expect(Object.keys(VERIFICATION_TARGETS).sort()).toEqual([
      'e2e',
      'e2e-board',
      'm0-loop-e2e',
      'm1-seed',
      'real-deploy-interrupt',
      'real-model-e2e',
      'real-ops-e2e',
      'real-self-e2e',
      'verify-e2e',
      'verify-plugin',
    ])
  })

  it('isolates offline runs from the launching shell and its model credentials', () => {
    const settings = verificationSettings('e2e', {
      DSH_HOME: '/production/dsh',
      FORGELOOP_CONFIG: '/production/config.json',
      FORGELOOP_TEST_DEEPSEEK_API_KEY: 'test-key',
      HTTPS_PROXY: 'http://production-proxy',
    })
    expect(settings.modelHosts).toEqual([])
    expect(settings.env).toEqual({})
  })

  it('injects only dedicated test credentials and explicitly supported controls', () => {
    const settings = verificationSettings('real-model-e2e', {
      DEEPSEEK_API_KEY: 'production-key',
      FORGELOOP_TEST_DEEPSEEK_API_KEY: 'test-key',
      FORGELOOP_REAL_MODEL_DEPLOY: '1',
      FORGELOOP_REAL_MODEL_PATCH: '/production/provider.yml',
      FORGELOOP_TEST_MODEL_PATCH: '/test/provider.yml',
    })
    expect(settings.modelHosts).toEqual(['api.deepseek.com'])
    expect(settings.env).toEqual({
      DEEPSEEK_API_KEY: 'test-key',
      FORGELOOP_REAL_MODEL: '1',
      FORGELOOP_REAL_MODEL_DEPLOY: '1',
    })
    expect(settings.modelPatch).toBe('/test/provider.yml')
  })

  it('registers every documented Qwen token-plan host for a Qwen test key', () => {
    const settings = verificationSettings('real-model-e2e', {
      FORGELOOP_TEST_QWEN_TOKEN_PLAN_CN_API_KEY: 'qwen-key',
      FORGELOOP_TEST_MODEL_PATCH: '/test/provider.yml',
    })
    expect(settings.modelHosts).toEqual([
      'token-plan.cn-beijing.maas.aliyuncs.com',
      'token-plan.maas.qianwenaiapi.com',
    ])
    for (const host of settings.modelHosts) {
      expect(modelHostFor(`${host}:443`, settings.modelHosts)).toBe(host)
    }
    expect(settings.env).toEqual({
      QWEN_TOKEN_PLAN_CN_API_KEY: 'qwen-key',
      FORGELOOP_REAL_MODEL: '1',
    })
  })

  it('passes the requirement-only scope through to the container', () => {
    const settings = verificationSettings('real-model-e2e', {
      FORGELOOP_TEST_QWEN_TOKEN_PLAN_CN_API_KEY: 'qwen-key',
      FORGELOOP_TEST_MODEL_PATCH: '/test/provider.yml',
      FORGELOOP_REAL_MODEL_SCOPE: 'requirement',
    })
    expect(settings.env.FORGELOOP_REAL_MODEL_SCOPE).toBe('requirement')
  })

  it('refuses to fall back to ordinary model credentials or inspect production records', () => {
    expect(() =>
      verificationSettings('verify-e2e', { DEEPSEEK_API_KEY: 'production-key' }),
    ).toThrow('FORGELOOP_TEST_DEEPSEEK_API_KEY')
    expect(() => verificationSettings('m0-loop-e2e', { FORGELOOP_M0_REAL_ARTIFACT: '1' })).toThrow(
      '生产',
    )
  })

  it('accepts local Docker sockets and rejects remote engines', () => {
    expect(() => assertLocalDockerHost('unix:///var/run/docker.sock')).not.toThrow()
    expect(() => assertLocalDockerHost('npipe:////./pipe/docker_engine')).not.toThrow()
    for (const host of [
      'tcp://127.0.0.1:2375',
      'ssh://owner@outside',
      'npipe:////outside/pipe/docker',
    ]) {
      expect(() => assertLocalDockerHost(host)).toThrow('本地')
    }
  })

  it('refuses host project overrides before creating a verification run', () => {
    expect(() =>
      verificationSettings('real-model-e2e', {
        FORGELOOP_REAL_MODEL_PROJECT_DIR: '/production/repo',
        FORGELOOP_TEST_DEEPSEEK_API_KEY: 'test-key',
      }),
    ).toThrow('FORGELOOP_REAL_MODEL_PROJECT_DIR')
  })
})

describe('model egress authority', () => {
  it('only accepts HTTPS to a provider configured for this attempt', () => {
    const hosts = ['api.deepseek.com']
    expect(modelHostFor('api.deepseek.com:443', hosts)).toBe('api.deepseek.com')
    for (const authority of [
      'api.deepseek.com:80',
      'api.deepseek.com.unrelated:443',
      'localhost:443',
      'api.deepseek.com:443/path',
      'token-plan.cn-beijing.maas.aliyuncs.com:443',
    ]) {
      expect(modelHostFor(authority, hosts)).toBeUndefined()
    }
  })
})
