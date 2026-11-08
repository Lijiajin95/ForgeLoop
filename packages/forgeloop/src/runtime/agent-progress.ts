import type { AgentSession } from './agent-runner.js'
import type { ProgressTracker } from '../domain/progress.js'

/** 把会话里可观测到的活动记成需求进展；没有活动就说明执行器不再推进。 */
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
