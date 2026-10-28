/** 任务执行记录与交付材料；实际推进和材料准入由运行时接线。 */

import type { TaskRunState } from './status.js'

export interface TaskArtifact {
  readonly requirementId: string
  readonly planVersion: number
  readonly taskId: string
  readonly candidateSha256: string
  readonly testEvidenceSha256: string
  readonly reviewSha256: string
  readonly acceptance: string
  readonly authorizationSource: string
  readonly recordedAt: string
  readonly baselineCommit: string
}

export interface TaskRun {
  readonly requirementId: string
  readonly planVersion: number
  readonly taskId: string
  readonly state: TaskRunState
  readonly reason: string
  readonly executedSeconds: number
  readonly updatedAt: string
}
