import type { AgentSession } from './agent-runner.js'
import type { ProgressTracker } from '../domain/progress.js'

export function withProgressTracking(
  session: AgentSession,
  reqId: string | undefined,
  tracker: ProgressTracker,
): AgentSession {
  if (!reqId) return session
  return {
    sessionId: session.sessionId,
    send: (turn) =>
      session.send({
        ...turn,
        onActivity: (events) => {
          tracker.note(reqId)
          turn.onActivity?.(events)
        },
      }),
    close: () => session.close(),
  }
}
