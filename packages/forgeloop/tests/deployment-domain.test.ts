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

  it('rejects empty, non-object and incomplete output', () => {
    expect(() => parseDeploymentToolResult('')).toThrow('没有输出')
    expect(() => parseDeploymentToolResult('not json')).toThrow('不是 JSON')
    expect(() => parseDeploymentToolResult('[]')).toThrow('必须是 JSON 对象')
    expect(() => parseDeploymentToolResult('{"state":"applied"}')).toThrow('布尔 ok')
    expect(() => parseDeploymentToolResult('{"ok":true}')).toThrow('缺少 state')
    expect(() => parseDeploymentToolResult('{"ok":true,"state":"  "}')).toThrow('缺少 state')
  })
})
