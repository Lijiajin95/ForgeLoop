import { describe, expect, it, vi } from 'vitest'
import { withProgressTracking } from '../src/runtime/agent-progress.js'
import { ProgressTracker } from '../src/domain/progress.js'
import type { AgentSession, AgentTurnRequest } from '../src/runtime/agent-runner.js'

function session(seen: AgentTurnRequest[]): AgentSession {
  return {
    sessionId: 's1',
    async send(turn) {
      seen.push(turn)
      return {
        status: 'completed',
        text: 'ok',
        sessionId: 's1',
        reason: '',
        transcriptPath: turn.transcriptPath,
        durationMs: 1,
        toolCalls: [],
      }
    },
    async close() {},
  }
}

describe('progress tracking wrapper', () => {
  it('records progress and keeps the caller activity handler', async () => {
    const tracker = new ProgressTracker()
    const seen: AgentTurnRequest[] = []
    const wrapped = withProgressTracking(session(seen), 'req-1', tracker)
    const onActivity = vi.fn()
    await wrapped.send({ prompt: 'p', transcriptPath: '/tmp/t', onActivity })
    seen[0]?.onActivity?.([{ type: 'tool' }])
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(tracker.last('req-1')).toBeGreaterThan(0)
  })

  it('returns the original session when no requirement is bound', () => {
    const base = session([])
    expect(withProgressTracking(base, undefined, new ProgressTracker())).toBe(base)
  })
})
