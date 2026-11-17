/**
 * 把 CI 工件（nightly / quality 的 Actions artifact 目录）映射成可靠性快照。
 *
 * 页面只读 `reports/reliability/latest.json`；本模块让同一份 schema 也能承载 CI 结果：
 * - 行为测试：优先读 `vitest.json`（若 CI 上传），否则用 `reliability-advanced.json` 里
 *   coverage 段的 PASS/FAIL 推断（该 job 的 `make coverage` 会跑全量行为测试）。
 * - 覆盖率：`coverage-summary.json`（istanbul 格式，路径带 `/home/runner/...` 前缀，需归一）。
 * - 变异：`mutation-incremental.json`（受控范围）的 score / threshold。
 * 只读文件，不执行命令；不把缺失的数据伪造成通过。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import config from '../../packages/forgeloop/vitest.config.ts'

export interface CiSnapshotInput {
  readonly dir: string
  readonly now?: Date
  readonly runId?: string
  readonly workflow?: string
}

export interface CiSnapshotResult {
  readonly snapshot: Record<string, unknown>
  readonly warnings: readonly string[]
  readonly sources: {
    readonly reliabilityAdvanced: string | null
    readonly coverage: string | null
    readonly mutation: string | null
    readonly vitest: string | null
  }
}

const ARTIFACT_NAMES = {
  reliabilityAdvanced: 'reliability-advanced.json',
  stability: 'stability.json',
  mutation: 'mutation-incremental.json',
  coverage: 'coverage-summary.json',
  vitest: 'vitest.json',
} as const

const STATIC_GATES: readonly { id: string; label: string }[] = [
  { id: 'typecheck', label: '类型检查' },
  { id: 'lint', label: 'ESLint' },
  { id: 'format', label: '格式' },
  { id: 'contracts', label: '架构契约' },
  { id: 'token-budget', label: 'Token 预算' },
  { id: 'assertion-budget', label: '断言预算' },
]

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function pct(value: unknown): number | null {
  const row = record(value)
  const valueNum = row ? row.pct : undefined
  return typeof valueNum === 'number' && Number.isFinite(valueNum) ? valueNum : null
}

/** 在 artifact 目录里按文件名找（最多三层，容忍 nightly-* / 直接平铺两种结构）。 */
export function findArtifactFile(root: string, name: string, depth = 3): string | null {
  const walk = (dir: string, remaining: number): string | null => {
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return null
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isFile() && entry === name) return full
      if (stat.isDirectory() && remaining > 0) {
        const found = walk(full, remaining - 1)
        if (found) return found
      }
    }
    return null
  }
  return walk(root, depth)
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

function relativeArtifact(root: string, path: string): string {
  return path
    .slice(root.length)
    .replace(/^[\\/]+/, '')
    .split('\\')
    .join('/')
}

/** 覆盖率门槛与本地同源：从 vitest 配置读取，页面不复制第二份门槛。 */
function coverageThresholds(): {
  lines: number
  statements: number
  functions: number
  branches: number
} {
  const configured = record(config.test?.coverage?.thresholds) ?? {}
  return {
    lines: num(configured.lines, 90),
    statements: num(configured.statements, 90),
    functions: num(configured.functions, 95),
    branches: num(configured.branches, 85),
  }
}

/** istanbul 汇总 → 快照覆盖率结构；把 CI 绝对路径归一成 packages/forgeloop/...。 */
export function coverageSummaryOf(raw: Record<string, unknown>): Record<string, unknown> | null {
  const total = record(raw.total)
  if (!total) return null
  const files: Record<string, unknown>[] = []
  for (const [absolute, value] of Object.entries(raw)) {
    if (absolute === 'total') continue
    const marker = absolute.replace(/\\/g, '/').indexOf('/packages/forgeloop/')
    if (marker < 0) continue
    const relativePath = `packages/forgeloop/${absolute
      .replace(/\\/g, '/')
      .slice(marker + '/packages/forgeloop/'.length)}`
    if (!relativePath.startsWith('packages/forgeloop/src/')) continue
    const metrics = record(value)
    if (!metrics) continue
    files.push({
      path: relativePath,
      lines: pct(metrics.lines),
      statements: pct(metrics.statements),
      functions: pct(metrics.functions),
      branches: pct(metrics.branches),
    })
  }
  files.sort((left, right) => String(left.path).localeCompare(String(right.path)))
  return {
    lines: pct(total.lines),
    statements: pct(total.statements),
    functions: pct(total.functions),
    branches: pct(total.branches),
    thresholds: coverageThresholds(),
    files: files.slice(0, 200),
  }
}

function coveragePasses(coverage: Record<string, unknown> | null): boolean {
  if (!coverage) return false
  const thresholds = record(coverage.thresholds) ?? {}
  const lines = coverage.lines
  const functions = coverage.functions
  const branches = coverage.branches
  if (typeof lines !== 'number' || typeof functions !== 'number' || typeof branches !== 'number') {
    return false
  }
  return (
    lines >= num(thresholds.lines, 90) &&
    functions >= num(thresholds.functions, 95) &&
    branches >= num(thresholds.branches, 85)
  )
}

export function mutationSummaryOf(raw: Record<string, unknown>): Record<string, unknown> | null {
  const totals = record(raw.totals)
  const statuses = record(raw.statuses)
  if (!totals && !statuses) return null
  return {
    score: typeof raw.score === 'number' ? raw.score : null,
    killed: num(totals?.killed ?? statuses?.Killed),
    survived: num(totals?.survived ?? statuses?.Survived),
    timeout: num(totals?.timeout ?? statuses?.Timeout),
    noCoverage: num(totals?.noCoverage ?? statuses?.NoCoverage),
    thresholds: {
      break: num(raw.break, 80),
      low: num(raw.low, 85),
      high: num(raw.high, 95),
    },
  }
}

function gate(input: {
  id: string
  label: string
  status: 'pass' | 'fail' | 'skipped' | 'not_run'
  command: string
  measured: number | null
  unit: string
  threshold: number | null
  durationMs: number | null
  at: string
}): Record<string, unknown> {
  return { ...input }
}

function sectionOf(
  advanced: Record<string, unknown> | null,
  id: string,
): Record<string, unknown> | null {
  const sections = Array.isArray(advanced?.sections) ? advanced?.sections : []
  for (const item of sections) {
    const row = record(item)
    if (row && row.id === id) return row
  }
  return null
}

export function buildCiSnapshot(input: CiSnapshotInput): CiSnapshotResult {
  const now = input.now ?? new Date()
  const generatedAt = now.toISOString()
  const warnings: string[] = []
  const reliabilityAdvancedPath = findArtifactFile(input.dir, ARTIFACT_NAMES.reliabilityAdvanced)
  const coveragePath = findArtifactFile(input.dir, ARTIFACT_NAMES.coverage)
  const mutationPath = findArtifactFile(input.dir, ARTIFACT_NAMES.mutation)
  const vitestPath = findArtifactFile(input.dir, ARTIFACT_NAMES.vitest)
  if (!reliabilityAdvancedPath && !coveragePath && !mutationPath && !vitestPath) {
    throw new Error(
      `CI artifact 目录里没有可识别的报告（需要 ${Object.values(ARTIFACT_NAMES).join(' / ')}）：${input.dir}`,
    )
  }
  const advanced = reliabilityAdvancedPath ? readJson(reliabilityAdvancedPath) : null
  const coverageRaw = coveragePath ? readJson(coveragePath) : null
  const mutationRaw = mutationPath ? readJson(mutationPath) : null
  const vitestRaw = vitestPath ? readJson(vitestPath) : null
  if (reliabilityAdvancedPath && !advanced) warnings.push('reliability-advanced.json 无法解析')
  if (coveragePath && !coverageRaw) warnings.push('coverage-summary.json 无法解析')
  if (mutationPath && !mutationRaw) warnings.push('mutation-incremental.json 无法解析')

  const coverage = coverageRaw ? coverageSummaryOf(coverageRaw) : null
  const mutation = mutationRaw ? mutationSummaryOf(mutationRaw) : null
  const coverageSection = sectionOf(advanced, 'coverage')
  const head = typeof advanced?.head === 'string' ? advanced.head : ''
  if (!head) warnings.push('artifact 里没有提交身份（head），快照会按过期处理')

  const gates: Record<string, unknown>[] = STATIC_GATES.map((item) =>
    gate({
      id: item.id,
      label: item.label,
      status: 'skipped',
      command: 'CI artifact 未包含静态门禁结果',
      measured: null,
      unit: '',
      threshold: null,
      durationMs: null,
      at: generatedAt,
    }),
  )

  let tests: Record<string, unknown> | null = null
  if (vitestRaw) {
    const files = Array.isArray(vitestRaw.testResults) ? vitestRaw.testResults.length : 0
    tests = {
      files,
      total: num(vitestRaw.numTotalTests),
      passed: num(vitestRaw.numPassedTests),
      failed: num(vitestRaw.numFailedTests),
      skipped: num(vitestRaw.numPendingTests),
      durationMs: num(vitestRaw.durationMs),
    }
    const failed = num(vitestRaw.numFailedTests)
    gates.push(
      gate({
        id: 'tests',
        label: '行为测试',
        status: failed === 0 ? 'pass' : 'fail',
        command: 'CI: vitest run',
        measured: failed,
        unit: 'failed tests',
        threshold: 0,
        durationMs: num(vitestRaw.durationMs) || null,
        at: generatedAt,
      }),
    )
  } else if (coverageSection) {
    const passed = coverageSection.status === 'PASS'
    gates.push(
      gate({
        id: 'tests',
        label: '行为测试',
        status: passed ? 'pass' : 'fail',
        command: 'CI: make coverage（内含全量行为测试）',
        measured: passed ? 0 : null,
        unit: 'failed tests',
        threshold: 0,
        durationMs:
          typeof coverageSection.durationMs === 'number' ? coverageSection.durationMs : null,
        at: typeof coverageSection.at === 'string' ? coverageSection.at : generatedAt,
      }),
    )
    if (!vitestRaw) {
      warnings.push('没有 vitest.json；行为测试结果由 coverage 段推断（job 失败即证据）')
    }
  } else {
    gates.push(
      gate({
        id: 'tests',
        label: '行为测试',
        status: 'not_run',
        command: 'CI artifact 未包含行为测试结果',
        measured: null,
        unit: 'failed tests',
        threshold: 0,
        durationMs: null,
        at: generatedAt,
      }),
    )
  }

  gates.push(
    coverage
      ? gate({
          id: 'coverage',
          label: '覆盖率',
          status: coveragePasses(coverage) ? 'pass' : 'fail',
          command: 'CI: make coverage',
          measured: typeof coverage.lines === 'number' ? coverage.lines : null,
          unit: '% lines',
          threshold: num(record(coverage.thresholds)?.lines, 90),
          durationMs: null,
          at: generatedAt,
        })
      : gate({
          id: 'coverage',
          label: '覆盖率',
          status: 'not_run',
          command: 'CI artifact 未包含 coverage-summary.json',
          measured: null,
          unit: '% lines',
          threshold: 90,
          durationMs: null,
          at: generatedAt,
        }),
  )

  gates.push(
    mutation
      ? gate({
          id: 'mutation',
          label: '变异测试',
          status:
            mutationRaw?.status === 'PASS' &&
            typeof mutation.score === 'number' &&
            mutation.score >= num(record(mutation.thresholds)?.break, 80)
              ? 'pass'
              : 'fail',
          command: `CI: mutation-incremental（${String(mutationRaw?.scope ?? 'unknown')}）`,
          measured: typeof mutation.score === 'number' ? mutation.score : null,
          unit: '% score',
          threshold: num(record(mutation.thresholds)?.break, 80),
          durationMs: typeof mutationRaw?.durationMs === 'number' ? mutationRaw.durationMs : null,
          at: generatedAt,
        })
      : gate({
          id: 'mutation',
          label: '变异测试',
          status: 'not_run',
          command: 'CI artifact 未包含 mutation-incremental.json',
          measured: null,
          unit: '% score',
          threshold: 80,
          durationMs: null,
          at: generatedAt,
        }),
  )

  const dirName =
    input.dir
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  const runId = input.runId ?? (/^\d+$/.test(dirName) ? dirName : '')
  const artifacts: Record<string, string | null> = {
    vitest: vitestPath ? relativeArtifact(input.dir, vitestPath) : null,
    coverage: coveragePath ? relativeArtifact(input.dir, coveragePath) : null,
    mutation: mutationPath ? relativeArtifact(input.dir, mutationPath) : null,
    reliability: reliabilityAdvancedPath
      ? relativeArtifact(input.dir, reliabilityAdvancedPath)
      : null,
  }

  // 工作流名按 artifact 目录名判断：gh 下载后的目录形如 nightly-* / reliability-advanced。
  const artifactPaths = Object.values(artifacts).filter((path): path is string => path !== null)
  const workflow =
    input.workflow ??
    (artifactPaths.some((path) => path.split('/').some((segment) => segment.startsWith('nightly-')))
      ? 'Nightly quality'
      : 'Engineering quality')

  const snapshot: Record<string, unknown> = {
    schemaVersion: 1,
    project: 'ForgeLoop',
    source: 'ci',
    generatedAt,
    ci: {
      runId,
      workflow,
      head,
      artifactDir: input.dir,
    },
    git: { head, branch: '', dirty: false },
    package: { name: 'forgeloop-dsh', version: '' },
    gates,
    tests,
    coverage,
    mutation,
    budgets: null,
    suppressions: null,
    artifacts,
  }
  return {
    snapshot,
    warnings,
    sources: {
      reliabilityAdvanced: reliabilityAdvancedPath,
      coverage: coveragePath,
      mutation: mutationPath,
      vitest: vitestPath,
    },
  }
}

/** 判断目录是否存在，供 CLI 提前给出明确错误。 */
export function assertArtifactDir(dir: string): void {
  if (!existsSync(dir)) throw new Error(`CI artifact 目录不存在：${dir}`)
}
