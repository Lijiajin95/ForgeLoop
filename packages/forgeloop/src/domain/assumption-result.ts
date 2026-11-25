import { MalformedError } from './errors.js'

export type AssumptionResultStatus = 'validated' | 'invalidated'

export const ASSUMPTION_RESULT_STATUSES: readonly AssumptionResultStatus[] = [
  'validated',
  'invalidated',
]

export interface AssumptionResult {
  readonly reqId: string
  readonly analysisVersion: number
  readonly assumptionId: string
  readonly status: AssumptionResultStatus
  readonly evidence: string
  readonly recordedBy: string
  readonly createdAt: string
}

export function assertAssumptionResult(input: {
  assumptionId: string
  status: string
  evidence: string
}): AssumptionResultStatus {
  if (!/^AS-\d+$/.test(input.assumptionId)) {
    throw new MalformedError(`假设编号必须形如 AS-1，实际 ${input.assumptionId}`)
  }
  const status = ASSUMPTION_RESULT_STATUSES.find((candidate) => candidate === input.status)
  if (!status) {
    throw new MalformedError('假设验证状态只能是 validated 或 invalidated')
  }
  if (input.evidence.trim().length < 4) {
    throw new MalformedError('假设验证必须给出可回查的证据说明')
  }
  return status
}
