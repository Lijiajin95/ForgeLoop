/**
 * 部署领域：工具种类与能力、attempt 状态机、工具结果解析。
 *
 * 部署的副作用只来自登记的外部工具；本模块只做确定性校验，不执行任何命令，
 * 也不接受模型提供的脚本、参数或路径。
 */

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
  ready: ['applying'],
  applying: ['applied_pending_verify', 'failed'],
  applied_pending_verify: ['verifying', 'verify_failed', 'rolling_back'],
  verifying: ['verified', 'verify_failed', 'failed'],
  verified: ['rolling_back'],
  verify_failed: ['rolling_back'],
  failed: ['rolling_back'],
  rolling_back: ['rolled_back', 'failed'],
  rolled_back: [],
}

/** 只有显式声明的迁移才允许；不允许从终态回到进行中。 */
export function canTransition(from: DeploymentAttemptState, to: DeploymentAttemptState): boolean {
  return TRANSITIONS[from].includes(to)
}

/** 工具调用结果：stdout 上唯一的 JSON 对象。 */
export interface DeploymentToolResult {
  readonly ok: boolean
  readonly state: string
  readonly version: string
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

/**
 * 严格解析工具输出：必须是一个 JSON 对象，`ok` 为布尔、`state` 为非空字符串。
 * 其余字段只取已知类型，出现未知字段不影响；畸形输出按失败处理，不猜测成功。
 */
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
    version: typeof record.version === 'string' ? bounded(record.version, 120) : '',
    detail: typeof record.detail === 'string' ? bounded(record.detail, MAX_DETAIL) : '',
    steps,
    restorePoint: typeof record.restorePoint === 'string' ? bounded(record.restorePoint, 300) : '',
  }
}

/** 制品：部署只绑定摘要与路径，不在这里重新构建。 */
export interface DeploymentArtifact {
  readonly sha256: string
  readonly path: string
  readonly version: string
}

/** 目标声明的数据范围：容器卷与数据库迁移；执行与恢复由工具负责。 */
export interface DeploymentDataScope {
  readonly volumes: readonly string[]
  readonly migrations: readonly string[]
}

/** 一次部署请求的持久记录；state 与 attempt 状态机共用。 */
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

/** 一次工具调用：op、退出码、结果 JSON 与证据路径。 */
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
