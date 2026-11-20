import {
  FAILURE_BUSINESS_REVIEW,
  FAILURE_FORMAL_TEST,
  FAILURE_IMPLEMENTATION_REVIEW,
  FAILURE_INTERRUPTED,
  FAILURE_PLANNING,
  FAILURE_USER_ACCEPTANCE,
  FAILURE_VERIFICATION,
} from './counting.js'
import { MalformedError } from './errors.js'
import { asRecord } from './json.js'

export const RELIABILITY_WINDOWS = ['7d', '30d', '90d', 'all'] as const
export type ReliabilityWindow = (typeof RELIABILITY_WINDOWS)[number]

export const RELIABILITY_WINDOW_DAYS: Record<Exclude<ReliabilityWindow, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

const DAY_MS = 86_400_000
export const SNAPSHOT_MAX_AGE_DAYS = 7
export const SNAPSHOT_MAX_BYTES = 256 * 1024
export const SNAPSHOT_MAX_GATES = 32
export const SNAPSHOT_MAX_FILES = 200

export const RELIABILITY_SAMPLE_MIN_INTERVAL_MS = 60_000
export const RELIABILITY_SAMPLE_HEARTBEAT_MS = 6 * 60 * 60 * 1000
export const RELIABILITY_SAMPLE_HISTORY_LIMIT = 24
export const SNAPSHOT_HISTORY_LIMIT = 12

export function parseReliabilityWindow(value: unknown): ReliabilityWindow | null {
  if (value === undefined) return 'all'
  if (typeof value !== 'string') return null
  switch (value) {
    case '7d':
    case '30d':
    case '90d':
    case 'all':
      return value
    default:
      return null
  }
}

export interface ReliabilityWindowRange {
  readonly from: Date | null
  readonly to: Date
}

export function reliabilityWindowRange(
  window: ReliabilityWindow,
  now: Date,
): ReliabilityWindowRange {
  if (window === 'all') return { from: null, to: now }
  return { from: new Date(now.getTime() - RELIABILITY_WINDOW_DAYS[window] * DAY_MS), to: now }
}

export function withinWindow(at: string, from: Date | null, to: Date): boolean {
  const time = Date.parse(at)
  if (Number.isNaN(time)) return false
  if (from && time < from.getTime()) return false
  return time <= to.getTime()
}

export interface ReliabilityRate {
  readonly pass: number
  readonly total: number
  readonly rate: number | null
}

export function rateOf(pass: number, total: number): ReliabilityRate {
  return { pass, total, rate: total === 0 ? null : Math.round((pass / total) * 1000) / 10 }
}

export interface VerificationFact {
  readonly reqId: string
  readonly verdict: 'pass' | 'block'
  readonly verifiedAt: string
}

export function firstPassVerificationRate(
  facts: readonly VerificationFact[],
  from: Date | null,
  to: Date,
): ReliabilityRate {
  const earliest = new Map<string, VerificationFact>()
  const windowRequirements = new Set<string>()
  for (const fact of facts) {
    const current = earliest.get(fact.reqId)
    if (!current || Date.parse(fact.verifiedAt) < Date.parse(current.verifiedAt)) {
      earliest.set(fact.reqId, fact)
    }
    if (withinWindow(fact.verifiedAt, from, to)) windowRequirements.add(fact.reqId)
  }
  let pass = 0
  for (const reqId of windowRequirements) {
    const first = earliest.get(reqId)
    if (first && first.verdict === 'pass' && withinWindow(first.verifiedAt, from, to)) pass += 1
  }
  return rateOf(pass, windowRequirements.size)
}

export interface ReviewFact {
  readonly reqId: string
  readonly verdict: 'pass' | 'block'
  readonly reviewedAt: string
}

export interface DeploymentFact {
  readonly reqId: string
  readonly state: string
  readonly recordedAt: string
  readonly checks: readonly unknown[]
}

export interface FailureRoundFact {
  readonly reqId: string
  readonly stage: string
  readonly occurredAt: string
}

export interface TaskRunFact {
  readonly reqId: string
  readonly state: string
}

export interface OpsEventFact {
  readonly eventId: string
  readonly state: string
  readonly title: string
  readonly openedAt: string
  readonly recoveredAt: string
  /** 可选：老记录或测试夹具没有该字段时按空串处理。 */
  readonly closedAt?: string
  readonly updatedAt?: string
}

export interface CandidateBuildFact {
  readonly reqId: string
  readonly builtAt: string
}

export function reviewRate(
  facts: readonly ReviewFact[],
  from: Date | null,
  to: Date,
): ReliabilityRate {
  const windowed = facts.filter((fact) => withinWindow(fact.reviewedAt, from, to))
  return rateOf(windowed.filter((fact) => fact.verdict === 'pass').length, windowed.length)
}

export function deploymentRate(
  facts: readonly DeploymentFact[],
  from: Date | null,
  to: Date,
): ReliabilityRate {
  const windowed = facts.filter((fact) => withinWindow(fact.recordedAt, from, to))
  return rateOf(windowed.filter((fact) => fact.state === 'verified').length, windowed.length)
}

export const FAILURE_STAGE_ORDER = [
  FAILURE_PLANNING,
  FAILURE_IMPLEMENTATION_REVIEW,
  FAILURE_FORMAL_TEST,
  FAILURE_INTERRUPTED,
  FAILURE_VERIFICATION,
  FAILURE_BUSINESS_REVIEW,
  FAILURE_USER_ACCEPTANCE,
] as const

export type FailureStageName = (typeof FAILURE_STAGE_ORDER)[number]

export function failureStageCounts(
  facts: readonly FailureRoundFact[],
): Record<FailureStageName, number> {
  const counts: Record<FailureStageName, number> = {
    [FAILURE_PLANNING]: 0,
    [FAILURE_IMPLEMENTATION_REVIEW]: 0,
    [FAILURE_FORMAL_TEST]: 0,
    [FAILURE_INTERRUPTED]: 0,
    [FAILURE_VERIFICATION]: 0,
    [FAILURE_BUSINESS_REVIEW]: 0,
    [FAILURE_USER_ACCEPTANCE]: 0,
  }
  for (const fact of facts) {
    switch (fact.stage) {
      case FAILURE_PLANNING:
        counts[FAILURE_PLANNING] += 1
        break
      case FAILURE_IMPLEMENTATION_REVIEW:
        counts[FAILURE_IMPLEMENTATION_REVIEW] += 1
        break
      case FAILURE_FORMAL_TEST:
        counts[FAILURE_FORMAL_TEST] += 1
        break
      case FAILURE_INTERRUPTED:
        counts[FAILURE_INTERRUPTED] += 1
        break
      case FAILURE_VERIFICATION:
        counts[FAILURE_VERIFICATION] += 1
        break
      case FAILURE_BUSINESS_REVIEW:
        counts[FAILURE_BUSINESS_REVIEW] += 1
        break
      case FAILURE_USER_ACCEPTANCE:
        counts[FAILURE_USER_ACCEPTANCE] += 1
        break
      default:
        break
    }
  }
  return counts
}

export interface FailureSummary {
  readonly total: number
  readonly requirements: number
  readonly perRequirement: number | null
  readonly byStage: Record<FailureStageName, number>
}

export function failureSummary(facts: readonly FailureRoundFact[]): FailureSummary {
  const requirements = new Set(facts.map((fact) => fact.reqId)).size
  return {
    total: facts.length,
    requirements,
    perRequirement: requirements === 0 ? null : Math.round((facts.length / requirements) * 10) / 10,
    byStage: failureStageCounts(facts),
  }
}

export interface TaskRunSummary {
  readonly total: number
  readonly delivered: number
  readonly failed: number
  readonly blocked: number
  readonly awaitingUser: number
  readonly running: number
}

export function taskRunSummary(facts: readonly TaskRunFact[]): TaskRunSummary {
  const count = (state: string): number => facts.filter((fact) => fact.state === state).length
  return {
    total: facts.length,
    delivered: count('delivered'),
    failed: count('failed'),
    blocked: count('blocked'),
    awaitingUser: count('awaiting_user'),
    running: count('running'),
  }
}

export interface OpsRecoverySummary {
  readonly opened: number
  readonly closed: number
  readonly recovered: number
  readonly mttrSeconds: number | null
}

export function opsRecoverySummary(
  facts: readonly OpsEventFact[],
  from: Date | null,
  to: Date,
): OpsRecoverySummary {
  const opened = facts.filter((fact) => withinWindow(fact.openedAt, from, to))
  const recovered = opened.filter((fact) => recoveredBy(fact, to))
  const closed = opened.filter((fact) => closedBy(fact, to))
  return {
    opened: opened.length,
    closed: closed.length,
    recovered: recovered.length,
    mttrSeconds: medianSeconds(
      recovered.map((fact) => ({ start: fact.openedAt, end: fact.recoveredAt })),
    ),
  }
}

function recoveredBy(fact: OpsEventFact, to: Date): boolean {
  return fact.recoveredAt !== '' && withinWindow(fact.recoveredAt, null, to)
}

function closedBy(fact: OpsEventFact, to: Date): boolean {
  if (recoveredBy(fact, to)) return true
  if (fact.closedAt && withinWindow(fact.closedAt, null, to)) return true
  if (fact.state === 'unresolved') {
    return !fact.updatedAt || withinWindow(fact.updatedAt, null, to)
  }
  if (fact.state === 'closed') return !fact.closedAt || withinWindow(fact.closedAt, null, to)
  return false
}

export function medianSeconds(pairs: readonly { start: string; end: string }[]): number | null {
  const values = pairs
    .map((pair) => Date.parse(pair.end) - Date.parse(pair.start))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right)
  if (values.length === 0) return null
  const middle = Math.floor(values.length / 2)
  const upper = values[middle]
  if (upper === undefined) return null
  if (values.length % 2 === 1) return Math.round(upper / 1000)
  const lower = values[middle - 1]
  if (lower === undefined) return null
  return Math.round((lower + upper) / 2 / 1000)
}

export function unresolvedOpsAsOf(facts: readonly OpsEventFact[], to: Date): number {
  return facts.filter((fact) => {
    if (!withinWindow(fact.openedAt, null, to)) return false
    if (recoveredBy(fact, to)) return false
    if (fact.closedAt && withinWindow(fact.closedAt, null, to)) return false
    if (!fact.closedAt && fact.state === 'closed') return false
    return true
  }).length
}

export interface DeploymentFailure {
  readonly checkId: string
  readonly count: number
}

export function deploymentFailures(
  facts: readonly DeploymentFact[],
  from: Date | null,
  to: Date,
): DeploymentFailure[] {
  const counts = new Map<string, number>()
  for (const fact of facts) {
    if (fact.state === 'verified' || !withinWindow(fact.recordedAt, from, to)) continue
    for (const item of fact.checks) {
      const check = asRecord(item)
      if (!check || check.ok !== false || typeof check.id !== 'string' || !check.id.trim()) continue
      counts.set(check.id, (counts.get(check.id) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([checkId, count]) => ({ checkId, count }))
    .sort((left, right) => right.count - left.count || left.checkId.localeCompare(right.checkId))
    .slice(0, 5)
}

export interface WeeklyReliability {
  readonly weekStart: string
  readonly verificationPass: number
  readonly verificationBlock: number
  readonly failureRounds: number
  readonly deploymentsVerified: number
  readonly deploymentsFailed: number
}

export function weeklyReliability(input: {
  readonly verifications: readonly VerificationFact[]
  readonly failureRounds: readonly FailureRoundFact[]
  readonly deployments: readonly DeploymentFact[]
  readonly now: Date
  readonly weeks?: number
}): WeeklyReliability[] {
  const weeks = input.weeks ?? 8
  const current = startOfUtcWeek(input.now)
  const result: WeeklyReliability[] = []
  for (let index = weeks - 1; index >= 0; index -= 1) {
    const start = new Date(current.getTime() - index * 7 * DAY_MS)
    const end = new Date(start.getTime() + 7 * DAY_MS)
    const inWeek = (at: string): boolean => {
      const time = Date.parse(at)
      return Number.isFinite(time) && time >= start.getTime() && time < end.getTime()
    }
    const verifications = input.verifications.filter((fact) => inWeek(fact.verifiedAt))
    const deployments = input.deployments.filter((fact) => inWeek(fact.recordedAt))
    result.push({
      weekStart: start.toISOString(),
      verificationPass: verifications.filter((fact) => fact.verdict === 'pass').length,
      verificationBlock: verifications.filter((fact) => fact.verdict === 'block').length,
      failureRounds: input.failureRounds.filter((fact) => inWeek(fact.occurredAt)).length,
      deploymentsVerified: deployments.filter((fact) => fact.state === 'verified').length,
      deploymentsFailed: deployments.filter((fact) => fact.state !== 'verified').length,
    })
  }
  return result
}

function startOfUtcWeek(date: Date): Date {
  const start = new Date(date.getTime())
  start.setUTCHours(0, 0, 0, 0)
  const day = (start.getUTCDay() + 6) % 7
  start.setUTCDate(start.getUTCDate() - day)
  return start
}

export interface SnapshotStaleness {
  readonly stale: boolean
  readonly reasons: readonly string[]
  readonly ageSeconds: number | null
}

export function snapshotStaleness(
  snapshot: {
    readonly generatedAt: string
    readonly git: { readonly head: string; readonly dirty: boolean }
  },
  currentHead: string | null,
  now: Date,
  maxAgeDays = SNAPSHOT_MAX_AGE_DAYS,
): SnapshotStaleness {
  const reasons: string[] = []
  const generated = Date.parse(snapshot.generatedAt)
  const ageSeconds = Number.isNaN(generated)
    ? null
    : Math.max(0, Math.round((now.getTime() - generated) / 1000))
  if (!Number.isFinite(generated)) {
    reasons.push('快照生成时间无效')
  } else if (now.getTime() - generated > maxAgeDays * DAY_MS) {
    reasons.push(`快照已超过 ${maxAgeDays} 天`)
  }
  if (currentHead === null) {
    reasons.push('无法读取当前 HEAD，按过期处理')
  } else if (snapshot.git.head !== currentHead) {
    reasons.push('快照提交与当前 HEAD 不一致')
  }
  if (snapshot.git.dirty) reasons.push('快照生成时工作树有未提交改动')
  return { stale: reasons.length > 0, reasons, ageSeconds }
}

export interface ReliabilityGate {
  readonly id: string
  readonly label: string
  readonly status: 'pass' | 'fail' | 'skipped' | 'not_run'
  readonly command: string
  readonly measured: number | null
  readonly unit: string
  readonly threshold: number | null
  readonly durationMs: number | null
  readonly at: string
}

export interface ReliabilityTests {
  readonly files: number | null
  readonly total: number | null
  readonly passed: number | null
  readonly failed: number | null
  readonly skipped: number | null
  readonly durationMs: number | null
}

export interface CoveragePercentages {
  readonly lines: number | null
  readonly statements: number | null
  readonly functions: number | null
  readonly branches: number | null
}

export interface CoverageFile extends CoveragePercentages {
  readonly path: string
}

export interface ReliabilityCoverage extends CoveragePercentages {
  readonly thresholds: {
    readonly lines: number
    readonly statements: number
    readonly functions: number
    readonly branches: number
  }
  readonly files: readonly CoverageFile[]
}

export const KEY_COVERAGE_THRESHOLDS = {
  'src/runtime/service.ts': { lines: 90, functions: 95, branches: 85 },
  'src/runtime/coordinator.ts': { lines: 90, functions: 99, branches: 85 },
  'src/records/repository.ts': { lines: 97, functions: 98, branches: 86 },
  'src/domain/verification.ts': { lines: 94, functions: 99, branches: 88 },
  'src/domain/admission.ts': { lines: 100, functions: 100, branches: 100 },
  'src/domain/retry-policy.ts': { lines: 100, functions: 100, branches: 100 },
} as const

export interface KeyCoverageFile extends CoveragePercentages {
  readonly path: string
  readonly present: boolean
  readonly thresholds: {
    readonly lines: number
    readonly functions: number
    readonly branches: number
  }
  readonly passed: boolean
}

export interface KeyCoverageSummary {
  readonly total: number
  readonly passed: number
  readonly files: readonly KeyCoverageFile[]
}

export function keyCoverage(files: readonly CoverageFile[]): KeyCoverageSummary {
  const rows = Object.entries(KEY_COVERAGE_THRESHOLDS).map(([suffix, thresholds]) => {
    const file = files.find(
      (item) => item.path.endsWith(suffix) || item.path.endsWith(`/${suffix}`),
    )
    const passed = Boolean(
      file &&
      file.lines !== null &&
      file.functions !== null &&
      file.branches !== null &&
      file.lines >= thresholds.lines &&
      file.functions >= thresholds.functions &&
      file.branches >= thresholds.branches,
    )
    return {
      path: suffix,
      present: Boolean(file),
      lines: file?.lines ?? null,
      statements: file?.statements ?? null,
      functions: file?.functions ?? null,
      branches: file?.branches ?? null,
      thresholds,
      passed,
    }
  })
  return {
    total: rows.length,
    passed: rows.filter((row) => row.passed).length,
    files: rows,
  }
}

export interface ReliabilityMutation {
  readonly score: number | null
  readonly killed: number
  readonly survived: number
  readonly timeout: number
  readonly noCoverage: number
  readonly thresholds: { readonly break: number; readonly low: number; readonly high: number }
}

export interface ReliabilityBudgets {
  readonly assertions: { readonly current: number; readonly baseline: number }
  readonly tokens: {
    readonly fileLimit: number
    readonly overLimit: number
    readonly maxFile: string
    readonly maxTokens: number | null
  }
}

export interface ReliabilitySnapshot {
  readonly schemaVersion: 1
  readonly project: string
  readonly generatedAt: string
  readonly git: { readonly head: string; readonly branch: string; readonly dirty: boolean }
  readonly package: { readonly name: string; readonly version: string }
  readonly gates: readonly ReliabilityGate[]
  readonly tests: ReliabilityTests | null
  readonly coverage: ReliabilityCoverage | null
  readonly mutation: ReliabilityMutation | null
  readonly budgets: ReliabilityBudgets | null
  readonly suppressions: number
  readonly artifacts: Readonly<Record<string, string>>
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MalformedError(`可靠性快照字段 ${field} 必须是非空字符串`)
  }
  return value.trim()
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown, field: string, fallback: number | null = null): number | null {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MalformedError(`可靠性快照字段 ${field} 必须是有限数字`)
  }
  return value
}

function percentValue(value: unknown, field: string): number | null {
  const number = numberValue(value, field)
  if (number === null) return null
  if (number < 0 || number > 100) {
    throw new MalformedError(`可靠性快照字段 ${field} 必须在 0..100 之间`)
  }
  return number
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const record = asRecord(value)
  if (!record) throw new MalformedError(`可靠性快照字段 ${field} 必须是对象`)
  return record
}

function gateStatus(value: unknown, index: number): ReliabilityGate['status'] {
  switch (value) {
    case 'pass':
    case 'fail':
    case 'skipped':
    case 'not_run':
      return value
    default:
      throw new MalformedError(`可靠性快照 gates[${index}].status 取值非法`)
  }
}

function parseGate(value: unknown, index: number): ReliabilityGate {
  const record = requireRecord(value, `gates[${index}]`)
  const status = gateStatus(record.status, index)
  const threshold = numberValue(record.threshold, `gates[${index}].threshold`)
  return {
    id: nonEmpty(record.id, `gates[${index}].id`),
    label: stringValue(record.label) || stringValue(record.id),
    status,
    command: stringValue(record.command),
    measured: numberValue(record.measured, `gates[${index}].measured`),
    unit: stringValue(record.unit),
    threshold,
    durationMs: numberValue(record.durationMs, `gates[${index}].durationMs`),
    at: stringValue(record.at),
  }
}

function parseTests(value: unknown): ReliabilityTests | null {
  if (value === null || value === undefined) return null
  const record = requireRecord(value, 'tests')
  return {
    files: numberValue(record.files, 'tests.files'),
    total: numberValue(record.total, 'tests.total'),
    passed: numberValue(record.passed, 'tests.passed'),
    failed: numberValue(record.failed, 'tests.failed'),
    skipped: numberValue(record.skipped, 'tests.skipped'),
    durationMs: numberValue(record.durationMs, 'tests.durationMs'),
  }
}

function parseCoverage(value: unknown): ReliabilityCoverage | null {
  if (value === null || value === undefined) return null
  const record = requireRecord(value, 'coverage')
  const thresholds = requireRecord(record.thresholds, 'coverage.thresholds')
  const files = Array.isArray(record.files) ? record.files : []
  if (files.length > SNAPSHOT_MAX_FILES) {
    throw new MalformedError(`可靠性快照 coverage.files 超过 ${SNAPSHOT_MAX_FILES} 项`)
  }
  return {
    lines: percentValue(record.lines, 'coverage.lines'),
    statements: percentValue(record.statements, 'coverage.statements'),
    functions: percentValue(record.functions, 'coverage.functions'),
    branches: percentValue(record.branches, 'coverage.branches'),
    thresholds: {
      lines: numberValue(thresholds.lines, 'coverage.thresholds.lines') ?? 0,
      statements: numberValue(thresholds.statements, 'coverage.thresholds.statements') ?? 0,
      functions: numberValue(thresholds.functions, 'coverage.thresholds.functions') ?? 0,
      branches: numberValue(thresholds.branches, 'coverage.thresholds.branches') ?? 0,
    },
    files: files.map((item, index) => {
      const file = requireRecord(item, `coverage.files[${index}]`)
      return {
        path: nonEmpty(file.path, `coverage.files[${index}].path`),
        lines: percentValue(file.lines, `coverage.files[${index}].lines`),
        statements: percentValue(file.statements, `coverage.files[${index}].statements`),
        functions: percentValue(file.functions, `coverage.files[${index}].functions`),
        branches: percentValue(file.branches, `coverage.files[${index}].branches`),
      }
    }),
  }
}

function parseMutation(value: unknown): ReliabilityMutation | null {
  if (value === null || value === undefined) return null
  const record = requireRecord(value, 'mutation')
  const thresholds = requireRecord(record.thresholds, 'mutation.thresholds')
  return {
    score: percentValue(record.score, 'mutation.score'),
    killed: numberValue(record.killed, 'mutation.killed') ?? 0,
    survived: numberValue(record.survived, 'mutation.survived') ?? 0,
    timeout: numberValue(record.timeout, 'mutation.timeout') ?? 0,
    noCoverage: numberValue(record.noCoverage, 'mutation.noCoverage') ?? 0,
    thresholds: {
      break: numberValue(thresholds.break, 'mutation.thresholds.break') ?? 0,
      low: numberValue(thresholds.low, 'mutation.thresholds.low') ?? 0,
      high: numberValue(thresholds.high, 'mutation.thresholds.high') ?? 0,
    },
  }
}

function parseBudgets(value: unknown): ReliabilityBudgets | null {
  if (value === null || value === undefined) return null
  const record = requireRecord(value, 'budgets')
  const assertions = requireRecord(record.assertions, 'budgets.assertions')
  const tokens = requireRecord(record.tokens, 'budgets.tokens')
  return {
    assertions: {
      current: numberValue(assertions.current, 'budgets.assertions.current') ?? 0,
      baseline: numberValue(assertions.baseline, 'budgets.assertions.baseline') ?? 0,
    },
    tokens: {
      fileLimit: numberValue(tokens.fileLimit, 'budgets.tokens.fileLimit') ?? 25_000,
      overLimit: numberValue(tokens.overLimit, 'budgets.tokens.overLimit') ?? 0,
      maxFile: stringValue(tokens.maxFile),
      maxTokens: numberValue(tokens.maxTokens, 'budgets.tokens.maxTokens'),
    },
  }
}

export interface ReliabilitySamplePayload {
  readonly asOf: string
  readonly commit: string
  readonly verification: ReliabilityRate
  readonly firstPassVerification: ReliabilityRate
  readonly businessReview: ReliabilityRate
  readonly deployment: ReliabilityRate
  readonly failureRounds: { readonly total: number; readonly requirements: number }
  readonly tasks: TaskRunSummary
  readonly ops: {
    readonly opened: number
    readonly closed: number
    readonly recovered: number
    readonly unresolved: number
    readonly mttrSeconds: number | null
  }
  readonly candidateBuilds: number
  readonly deploymentIntents: {
    readonly verified: number
    readonly failed: number
    readonly rolledBack: number
    readonly pending: number
  }
}

export interface ReliabilitySample extends ReliabilitySamplePayload {
  readonly sampleId: number
  readonly project: string
  readonly sampledAt: string
  readonly revision: string
}

function sampleCount(value: unknown, field: string): number {
  const number = numberValue(value, field)
  if (number === null || !Number.isInteger(number) || number < 0) {
    throw new MalformedError(`可靠性指标样本字段 ${field} 必须是非负整数`)
  }
  return number
}

function sampleRate(value: unknown, field: string): ReliabilityRate {
  const record = requireRecord(value, field)
  const pass = sampleCount(record.pass, `${field}.pass`)
  const total = sampleCount(record.total, `${field}.total`)
  if (pass > total) throw new MalformedError(`可靠性指标样本字段 ${field}.pass 不能大于 total`)
  return { pass, total, rate: numberValue(record.rate, `${field}.rate`) }
}

export function parseReliabilitySample(value: unknown): ReliabilitySamplePayload {
  const record = requireRecord(value, 'sample')
  const rounds = requireRecord(record.failureRounds, 'sample.failureRounds')
  const tasks = requireRecord(record.tasks, 'sample.tasks')
  const ops = requireRecord(record.ops, 'sample.ops')
  const intents = requireRecord(record.deploymentIntents, 'sample.deploymentIntents')
  return {
    asOf: stringValue(record.asOf),
    commit: stringValue(record.commit),
    verification: sampleRate(record.verification, 'sample.verification'),
    firstPassVerification: sampleRate(record.firstPassVerification, 'sample.firstPassVerification'),
    businessReview: sampleRate(record.businessReview, 'sample.businessReview'),
    deployment: sampleRate(record.deployment, 'sample.deployment'),
    failureRounds: {
      total: sampleCount(rounds.total, 'sample.failureRounds.total'),
      requirements: sampleCount(rounds.requirements, 'sample.failureRounds.requirements'),
    },
    tasks: {
      total: sampleCount(tasks.total, 'sample.tasks.total'),
      delivered: sampleCount(tasks.delivered, 'sample.tasks.delivered'),
      failed: sampleCount(tasks.failed, 'sample.tasks.failed'),
      blocked: sampleCount(tasks.blocked, 'sample.tasks.blocked'),
      awaitingUser: sampleCount(tasks.awaitingUser, 'sample.tasks.awaitingUser'),
      running: sampleCount(tasks.running, 'sample.tasks.running'),
    },
    ops: {
      opened: sampleCount(ops.opened, 'sample.ops.opened'),
      closed: sampleCount(ops.closed, 'sample.ops.closed'),
      recovered: sampleCount(ops.recovered, 'sample.ops.recovered'),
      unresolved: sampleCount(ops.unresolved, 'sample.ops.unresolved'),
      mttrSeconds: numberValue(ops.mttrSeconds, 'sample.ops.mttrSeconds'),
    },
    candidateBuilds: sampleCount(record.candidateBuilds, 'sample.candidateBuilds'),
    deploymentIntents: {
      verified: sampleCount(intents.verified, 'sample.deploymentIntents.verified'),
      failed: sampleCount(intents.failed, 'sample.deploymentIntents.failed'),
      rolledBack: sampleCount(intents.rolledBack, 'sample.deploymentIntents.rolledBack'),
      pending: sampleCount(intents.pending, 'sample.deploymentIntents.pending'),
    },
  }
}

export function parseReliabilitySnapshot(value: unknown): ReliabilitySnapshot {
  const record = requireRecord(value, 'root')
  if (record.schemaVersion !== 1) {
    throw new MalformedError('可靠性快照 schemaVersion 必须为 1')
  }
  const gates = Array.isArray(record.gates)
    ? record.gates.map((gate, index) => parseGate(gate, index))
    : []
  if (gates.length === 0) throw new MalformedError('可靠性快照必须包含至少一项门禁')
  if (gates.length > SNAPSHOT_MAX_GATES) {
    throw new MalformedError(`可靠性快照门禁数超过 ${SNAPSHOT_MAX_GATES} 项`)
  }
  const git = requireRecord(record.git, 'git')
  const pkg = requireRecord(record.package, 'package')
  const artifacts =
    record.artifacts === undefined ? {} : requireRecord(record.artifacts, 'artifacts')
  const artifactEntries = Object.entries(artifacts)
  if (artifactEntries.length > 20) throw new MalformedError('可靠性快照 artifacts 超过 20 项')
  return {
    schemaVersion: 1,
    project: nonEmpty(record.project, 'project'),
    generatedAt: nonEmpty(record.generatedAt, 'generatedAt'),
    git: {
      head: stringValue(git.head),
      branch: stringValue(git.branch),
      dirty: git.dirty === true,
    },
    package: {
      name: stringValue(pkg.name),
      version: stringValue(pkg.version),
    },
    gates,
    tests: parseTests(record.tests),
    coverage: parseCoverage(record.coverage),
    mutation: parseMutation(record.mutation),
    budgets: parseBudgets(record.budgets),
    suppressions: numberValue(record.suppressions, 'suppressions') ?? 0,
    artifacts: Object.fromEntries(artifactEntries.map(([key, item]) => [key, stringValue(item)])),
  }
}

export interface SnapshotHistoryPoint {
  readonly generatedAt: string
  readonly commit: string
  readonly branch: string
  readonly dirty: boolean
  readonly gates: {
    readonly pass: number
    readonly fail: number
    readonly skipped: number
    readonly notRun: number
  }
  readonly tests: {
    readonly passed: number | null
    readonly total: number | null
    readonly failed: number | null
    readonly skipped: number | null
  } | null
  readonly coverage: {
    readonly lines: number | null
    readonly functions: number | null
    readonly branches: number | null
  } | null
  readonly mutation: { readonly score: number | null } | null
}

export function snapshotHistoryPoint(snapshot: ReliabilitySnapshot): SnapshotHistoryPoint {
  const gates = { pass: 0, fail: 0, skipped: 0, notRun: 0 }
  for (const gate of snapshot.gates) {
    if (gate.status === 'pass') gates.pass += 1
    else if (gate.status === 'fail') gates.fail += 1
    else if (gate.status === 'skipped') gates.skipped += 1
    else gates.notRun += 1
  }
  return {
    generatedAt: snapshot.generatedAt,
    commit: snapshot.git.head,
    branch: snapshot.git.branch,
    dirty: snapshot.git.dirty,
    gates,
    tests: snapshot.tests
      ? {
          passed: snapshot.tests.passed,
          total: snapshot.tests.total,
          failed: snapshot.tests.failed,
          skipped: snapshot.tests.skipped,
        }
      : null,
    coverage: snapshot.coverage
      ? {
          lines: snapshot.coverage.lines,
          functions: snapshot.coverage.functions,
          branches: snapshot.coverage.branches,
        }
      : null,
    mutation: snapshot.mutation ? { score: snapshot.mutation.score } : null,
  }
}
