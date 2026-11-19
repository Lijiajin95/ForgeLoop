import { MalformedError } from './errors.js'
import { asRecord } from './json.js'

export const DEPLOYMENT_TOOL_VERSION = 'deployment-tool-v1'

export const DEPLOYMENT_TOOL_KINDS = ['python', 'shell', 'k8s'] as const
export type DeploymentToolKind = (typeof DEPLOYMENT_TOOL_KINDS)[number]

export const DEPLOYMENT_CAPABILITIES = [
  'preflight',
  'apply',
  'status',
  'rollback',
  'data-rollback',
  'logs',
] as const
export type DeploymentCapability = (typeof DEPLOYMENT_CAPABILITIES)[number]

/** 主控实际会调用的工具操作；`logs` 只声明能力，不进入状态机。 */
export const DEPLOYMENT_OPERATIONS = [
  'preflight',
  'apply',
  'status',
  'rollback',
  'data-rollback',
] as const
export type DeploymentOperation = (typeof DEPLOYMENT_OPERATIONS)[number]

export const DEPLOYMENT_STATES = [
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
] as const
export type DeploymentAttemptState = (typeof DEPLOYMENT_STATES)[number]

const TRANSITIONS: Readonly<Record<DeploymentAttemptState, readonly DeploymentAttemptState[]>> = {
  draft: ['preflight_failed', 'awaiting_approval', 'ready'],
  preflight_failed: [],
  awaiting_approval: ['rejected', 'ready'],
  rejected: [],
  // 表示这次部署没有越过工具调用。
  ready: ['applying', 'preflight_failed'],
  applying: ['applied_pending_verify', 'failed'],
  applied_pending_verify: ['verifying', 'verify_failed', 'rolling_back'],
  verifying: ['verified', 'verify_failed', 'failed'],
  verified: ['rolling_back'],
  verify_failed: ['rolling_back'],
  failed: ['rolling_back'],
  rolling_back: ['rolled_back', 'failed'],
  rolled_back: [],
}

export function canTransition(from: DeploymentAttemptState, to: DeploymentAttemptState): boolean {
  return TRANSITIONS[from].includes(to)
}

export interface DeploymentToolResult {
  readonly ok: boolean
  readonly state: string
  readonly version: string
  readonly artifactSha256: string
  readonly runningArtifactSha256: string
  readonly runningPid: number
  readonly runningStartedAt: string
  readonly detail: string
  readonly steps: readonly string[]
  readonly restorePoint: string
}

const MAX_DETAIL = 2_000
const MAX_STEPS = 50
const MAX_STEP = 300

function bounded(value: string, max: number): string {
  const text = value.trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function textField(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key]
  return typeof value === 'string' ? bounded(value, max) : ''
}

function pidOf(record: Record<string, unknown>): number {
  const value = record.runningPid
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
}

export function parseDeploymentToolResult(stdout: string): DeploymentToolResult {
  const text = stdout.trim()
  if (!text) throw new MalformedError('工具没有输出')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new MalformedError(`工具输出不是 JSON：${error instanceof Error ? error.message : ''}`)
  }
  const record = asRecord(parsed)
  if (!record) throw new MalformedError('工具输出必须是 JSON 对象')
  if (typeof record.ok !== 'boolean') throw new MalformedError('工具输出缺少布尔 ok')
  if (typeof record.state !== 'string' || !record.state.trim()) {
    throw new MalformedError('工具输出缺少 state')
  }
  const steps = Array.isArray(record.steps)
    ? record.steps
        .filter((step): step is string => typeof step === 'string' && step.trim() !== '')
        .slice(0, MAX_STEPS)
        .map((step) => bounded(step, MAX_STEP))
    : []
  return {
    ok: record.ok,
    state: bounded(record.state, 60),
    version: textField(record, 'version', 120),
    artifactSha256: textField(record, 'artifactSha256', 120),
    runningArtifactSha256: textField(record, 'runningArtifactSha256', 120),
    runningPid: pidOf(record),
    runningStartedAt: textField(record, 'runningStartedAt', 60),
    detail: textField(record, 'detail', MAX_DETAIL),
    steps,
    restorePoint: textField(record, 'restorePoint', 300),
  }
}

export interface DeploymentArtifact {
  readonly sha256: string
  readonly path: string
  readonly version: string
}

export interface DeploymentDataScope {
  readonly volumes: readonly string[]
  readonly migrations: readonly string[]
}

export interface DeploymentIntentRecord {
  readonly intentId: string
  readonly project: string
  readonly targetId: string
  readonly requirementId: string
  readonly artifactSha256: string
  readonly artifactPath: string
  readonly artifactVersion: string
  readonly source: string
  readonly approval: 'owner' | 'auto'
  state: DeploymentAttemptState
  readonly createdAt: string
  updatedAt: string
}

export interface DeploymentAttemptRecord {
  readonly intentId: string
  readonly op: DeploymentOperation
  readonly state: DeploymentAttemptState
  readonly exitCode: number
  readonly resultJson: string
  readonly detail: string
  readonly toolSha256: string
  readonly evidencePath: string
  readonly startedAt: string
  readonly finishedAt: string
}

export interface DeploymentToolScriptRecord {
  readonly toolId: string
  readonly path: string
  readonly sha256: string
  readonly size: number
  readonly recordedAt: string
}

export interface DeploymentToolChangeRecord {
  readonly changeId: string
  readonly toolId: string
  readonly path: string
  readonly previousSha256: string
  readonly sha256: string
  readonly changedAt: string
}
