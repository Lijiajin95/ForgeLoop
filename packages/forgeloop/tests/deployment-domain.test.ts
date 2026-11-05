import { describe, expect, it } from 'vitest'
import {
  canTransition,
  parseDeploymentToolResult,
  type DeploymentAttemptState,
} from '../src/domain/deployment.js'

describe('deployment state machine', () => {
  it('allows only the declared transitions', () => {
    expect(canTransition('draft', 'awaiting_approval')).toBe(true)
    expect(canTransition('awaiting_approval', 'ready')).toBe(true)
    expect(canTransition('ready', 'applying')).toBe(true)
    // apply 前复核失败：没有越过工具调用，收口为 preflight_failed。
    expect(canTransition('ready', 'preflight_failed')).toBe(true)
    expect(canTransition('applying', 'applied_pending_verify')).toBe(true)
    expect(canTransition('applied_pending_verify', 'verified')).toBe(false)
    expect(canTransition('applied_pending_verify', 'verifying')).toBe(true)
    expect(canTransition('verifying', 'verified')).toBe(true)
    expect(canTransition('verified', 'rolling_back')).toBe(true)
    expect(canTransition('verified', 'applying')).toBe(false)
    expect(canTransition('rolled_back', 'applying')).toBe(false)
    expect(canTransition('rejected', 'ready')).toBe(false)
  })

  it('covers every state without leaving an unknown target', () => {
    const states: DeploymentAttemptState[] = [
      'draft',
      'preflight_failed',
      'awaiting_approval',
      'rejected',
      'ready',
      'applying',
      'applied_pending_verify',
      'verifying',
      'verified',
      'failed',
      'verify_failed',
      'rolling_back',
      'rolled_back',
    ]
    for (const from of states) {
      expect(typeof canTransition(from, 'verified')).toBe('boolean')
    }
  })
})

describe('deployment tool result', () => {
  it('parses a well-formed result and bounds long text', () => {
    const parsed = parseDeploymentToolResult(
      JSON.stringify({
        ok: true,
        state: 'applied',
        version: '0.0.2',
        detail: '装好了',
        steps: ['copy', 7, '', 'restart'],
        restorePoint: 'snap-1',
      }),
    )
    expect(parsed).toEqual({
      ok: true,
      state: 'applied',
      version: '0.0.2',
      artifactSha256: '',
      runningArtifactSha256: '',
      runningPid: 0,
      runningStartedAt: '',
      detail: '装好了',
      steps: ['copy', 'restart'],
      restorePoint: 'snap-1',
    })
    const long = parseDeploymentToolResult(
      JSON.stringify({
        ok: false,
        state: 'failed',
        detail: 'x'.repeat(5000),
        version: 'y'.repeat(500),
      }),
    )
    expect(long.detail.length).toBeLessThanOrEqual(2001)
    expect(long.version.length).toBeLessThanOrEqual(121)
  })

  it('reads runtime identity fields with correct types and bounds', () => {
    const parsed = parseDeploymentToolResult(
      JSON.stringify({
        ok: true,
        state: 'applied',
        artifactSha256: 'a'.repeat(64),
        runningArtifactSha256: 'b'.repeat(64),
        runningPid: 4242,
        runningStartedAt: '2026-11-05T00:00:00.000Z',
        detail: 'ok',
        steps: [],
        restorePoint: '',
      }),
    )
    expect(parsed.artifactSha256).toBe('a'.repeat(64))
    expect(parsed.runningArtifactSha256).toBe('b'.repeat(64))
    expect(parsed.runningPid).toBe(4242)
    expect(parsed.runningStartedAt).toBe('2026-11-05T00:00:00.000Z')

    // 非安全整数、非数字与超长文本都按缺省处理，不猜测运行中身份。
    for (const runningPid of [
      1.5,
      Number.MAX_SAFE_INTEGER + 2,
      '4242',
      null,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        parseDeploymentToolResult(JSON.stringify({ ok: true, state: 'applied', runningPid }))
          .runningPid,
      ).toBe(0)
    }
    const long = parseDeploymentToolResult(
      JSON.stringify({
        ok: true,
        state: 'applied',
        runningStartedAt: 'x'.repeat(200),
        artifactSha256: 'y'.repeat(300),
        runningArtifactSha256: 'z'.repeat(300),
      }),
    )
    expect(long.runningStartedAt).toHaveLength(61)
    expect(long.artifactSha256).toHaveLength(121)
    expect(long.runningArtifactSha256).toHaveLength(121)
    expect(
      parseDeploymentToolResult(JSON.stringify({ ok: true, state: 'applied', runningStartedAt: 7 }))
        .runningStartedAt,
    ).toBe('')
  })

  it('rejects empty, non-object and incomplete output', () => {
    expect(() => parseDeploymentToolResult('')).toThrow('没有输出')
    expect(() => parseDeploymentToolResult('not json')).toThrow('不是 JSON')
    expect(() => parseDeploymentToolResult('[]')).toThrow('必须是 JSON 对象')
    expect(() => parseDeploymentToolResult('{"state":"applied"}')).toThrow('布尔 ok')
    expect(() => parseDeploymentToolResult('{"ok":true}')).toThrow('缺少 state')
    expect(() => parseDeploymentToolResult('{"ok":true,"state":"  "}')).toThrow('缺少 state')
  })
})
