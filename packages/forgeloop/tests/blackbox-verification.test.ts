import { describe, expect, it } from 'vitest'
import { blackBoxVerificationDeps } from '../src/runtime/blackbox-verification.js'
import type {
  LegacyVerificationSession,
  LegacyVerifyInput,
} from '../src/runtime/legacy-verification.js'

/**
 * 显式 verify 的黑盒接线：两个依赖都必须转发到连续推进的 legacy 实例，
 * 且取实例是惰性的（流水线先构造、legacy 后赋值）。
 */

const session = { sessionId: 'verify-session' } as unknown as LegacyVerificationSession
const verifyInput = { reqId: 'req-bb' } as unknown as LegacyVerifyInput

describe('black box verification deps', () => {
  it('forwards both calls to the legacy instance lazily', async () => {
    const calls: string[] = []
    const legacy: unknown = {}
    const deps = blackBoxVerificationDeps(() => {
      expect(legacy).toBeDefined()
      return {
        openVerification: async (input) => {
          calls.push(`open:${input.reqId}`)
          return { ok: true as const, value: session }
        },
        verifyCandidate: async (input) => {
          calls.push(`verify:${input.reqId}`)
          return { state: 'pass' as const, detail: 'ok', blocking: [] }
        },
      }
    })
    // 构造时不解析 legacy，运行时才取：服务里流水线先于 legacy 创建。
    await expect(
      deps.openBlackBoxSession({
        reqId: 'req-bb',
        requirement: {} as never,
        analysis: {} as never,
        plan: {} as never,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ ok: true, value: session })
    await expect(deps.verifyCandidateBlackBox(verifyInput)).resolves.toMatchObject({
      state: 'pass',
    })
    expect(calls).toEqual(['open:req-bb', 'verify:req-bb'])
  })
})
