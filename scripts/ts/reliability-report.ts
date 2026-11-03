/**
 * 生成代码可靠性看板使用的质量快照。
 *
 * 显式运行，不在页面请求中执行检查：
 *   node scripts/ts/reliability-report.ts [--fast]
 *
 * `--fast` 跳过变异测试，并把该项记为 not_run；其余检查照常执行。
 * 快照写入 reports/reliability/latest.json（reports/ 已被忽略），历史保留 30 份。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../../packages/forgeloop/vitest.config.ts'

const ROOT = process.cwd()
const PKG_DIR = join(ROOT, 'packages', 'forgeloop')
const REPORT_DIR = join(ROOT, 'reports', 'reliability')
const HISTORY_DIR = join(REPORT_DIR, 'history')
const LATEST = join(REPORT_DIR, 'latest.json')
const VITEST_REPORT = join(ROOT, 'reports', 'vitest.json')
const COVERAGE_REPORT = join(PKG_DIR, 'coverage', 'coverage-summary.json')
const MUTATION_REPORT = join(PKG_DIR, 'reports', 'mutation.json')
const FAST = process.argv.includes('--fast')
const HISTORY_LIMIT = 30
const VITEST_BIN = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'))

interface RunResult {
  readonly ok: boolean
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

interface GateRow {
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

interface TestsSummary {
  readonly files: number
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly skipped: number
  readonly durationMs: number
}

interface CoverageFileRow {
  readonly path: string
  readonly lines: number | null
  readonly statements: number | null
  readonly functions: number | null
  readonly branches: number | null
}

interface CoverageSummary {
  readonly lines: number | null
  readonly statements: number | null
  readonly functions: number | null
  readonly branches: number | null
  readonly thresholds: {
    readonly lines: number
    readonly statements: number
    readonly functions: number
    readonly branches: number
  }
  readonly files: CoverageFileRow[]
}

interface MutationSummary {
  readonly score: number | null
  readonly killed: number
  readonly survived: number
  readonly timeout: number
  readonly noCoverage: number
  readonly thresholds: { readonly break: number; readonly low: number; readonly high: number }
}

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
  if (!row) return null
  return typeof row.pct === 'number' && Number.isFinite(row.pct) ? row.pct : null
}

function run(command: string, args: readonly string[], cwd: string, timeoutMs: number): RunResult {
  const started = Date.now()
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
  })
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs: Date.now() - started,
  }
}

function gate(
  id: string,
  label: string,
  result: RunResult,
  command: string,
  measured: number | null = null,
  unit = '',
  threshold: number | null = null,
  status?: GateRow['status'],
): GateRow {
  return {
    id,
    label,
    status: status ?? (result.ok ? 'pass' : 'fail'),
    command,
    measured,
    unit,
    threshold,
    durationMs: result.durationMs,
    at: new Date().toISOString(),
  }
}

function notRun(id: string, label: string, command: string): GateRow {
  return {
    id,
    label,
    status: 'not_run',
    command,
    measured: null,
    unit: '',
    threshold: null,
    durationMs: null,
    at: new Date().toISOString(),
  }
}

function isFresh(path: string, since: number): boolean {
  try {
    return statSync(path).mtimeMs >= since - 2_000
  } catch {
    return false
  }
}

function parseTests(since: number): TestsSummary | null {
  if (!isFresh(VITEST_REPORT, since)) return null
  try {
    const raw: unknown = JSON.parse(readFileSync(VITEST_REPORT, 'utf8'))
    const row = record(raw)
    if (!row) return null
    const files = Array.isArray(row.testResults) ? row.testResults.length : 0
    return {
      files,
      total: num(row.numTotalTests),
      passed: num(row.numPassedTests),
      failed: num(row.numFailedTests),
      skipped: num(row.numPendingTests),
      durationMs: 0,
    }
  } catch {
    return null
  }
}

function parseCoverage(since: number): CoverageSummary | null {
  if (!isFresh(COVERAGE_REPORT, since)) return null
  try {
    const raw: unknown = JSON.parse(readFileSync(COVERAGE_REPORT, 'utf8'))
    const row = record(raw)
    if (!row) return null
    const total = record(row.total)
    const thresholdsRow = record(config.test?.coverage?.thresholds) ?? {}
    const files: CoverageFileRow[] = []
    for (const [absolute, value] of Object.entries(row)) {
      if (absolute === 'total') continue
      const rel = relative(ROOT, absolute)
      if (rel.startsWith('..') || rel.includes(`..${sep}`)) continue
      if (!rel.startsWith(`packages${sep}forgeloop${sep}src${sep}`)) continue
      const metrics = record(value)
      if (!metrics) continue
      files.push({
        path: rel.split(sep).join('/'),
        lines: pct(metrics.lines),
        statements: pct(metrics.statements),
        functions: pct(metrics.functions),
        branches: pct(metrics.branches),
      })
    }
    files.sort((left, right) => left.path.localeCompare(right.path))
    return {
      lines: pct(total?.lines),
      statements: pct(total?.statements),
      functions: pct(total?.functions),
      branches: pct(total?.branches),
      thresholds: {
        lines: num(thresholdsRow.lines, 90),
        statements: num(thresholdsRow.statements, 90),
        functions: num(thresholdsRow.functions, 93),
        branches: num(thresholdsRow.branches, 84),
      },
      files: files.slice(0, 200),
    }
  } catch {
    return null
  }
}

function coveragePasses(coverage: CoverageSummary | null): boolean {
  if (!coverage) return false
  if (coverage.lines === null || coverage.functions === null || coverage.branches === null)
    return false
  if (coverage.lines < coverage.thresholds.lines) return false
  if (coverage.functions < coverage.thresholds.functions) return false
  if (coverage.branches < coverage.thresholds.branches) return false
  const keyThresholds = config.test?.coverage?.thresholds
  const configured = record(keyThresholds)
  if (!configured) return true
  for (const [path, expectedValue] of Object.entries(configured)) {
    if (path === 'lines' || path === 'statements' || path === 'functions' || path === 'branches') {
      continue
    }
    const expected = record(expectedValue)
    const file = coverage.files.find(
      (item) => item.path.endsWith(`/${path}`) || item.path.endsWith(path),
    )
    if (!expected || !file) return false
    if (
      file.lines === null ||
      file.branches === null ||
      file.functions === null ||
      file.lines < num(expected.lines) ||
      file.branches < num(expected.branches) ||
      file.functions < num(expected.functions)
    ) {
      return false
    }
  }
  return true
}

function parseMutation(since: number): MutationSummary | null {
  if (!isFresh(MUTATION_REPORT, since)) return null
  try {
    const raw: unknown = JSON.parse(readFileSync(MUTATION_REPORT, 'utf8'))
    const row = record(raw)
    if (!row) return null
    const files = record(row.files) ?? {}
    let killed = 0
    let survived = 0
    let timeout = 0
    let noCoverage = 0
    for (const value of Object.values(files)) {
      const file = record(value)
      const mutants = Array.isArray(file?.mutants) ? file.mutants : []
      for (const mutant of mutants) {
        const status = record(mutant)?.status
        if (status === 'Killed') killed += 1
        else if (status === 'Survived') survived += 1
        else if (status === 'Timeout') timeout += 1
        else if (status === 'NoCoverage') noCoverage += 1
      }
    }
    const denominator = killed + timeout + survived + noCoverage
    const thresholds = record(row.thresholds) ?? {}
    return {
      score:
        denominator === 0 ? null : Math.round(((killed + timeout) / denominator) * 10000) / 100,
      killed,
      survived,
      timeout,
      noCoverage,
      thresholds: {
        break: num(thresholds.break, 80),
        low: num(thresholds.low, 85),
        high: num(thresholds.high, 95),
      },
    }
  } catch {
    return null
  }
}

function parseTokens(text: string): {
  overLimit: number
  maxFile: string
  maxTokens: number | null
} {
  const maxMatch = /最大：[^]*?([^\s，]+)\s+(\d+)/.exec(text)
  const maxFile = maxMatch?.[1]?.split('/').pop() ?? ''
  const maxTokens = maxMatch?.[2] ? Number(maxMatch[2]) : null
  const overLimit = text.split('\n').filter((line) => line.includes('tokens >')).length
  return { overLimit, maxFile, maxTokens }
}

function parseAssertions(text: string): { current: number; baseline: number } {
  const match = /合计\s+(\d+)（baseline\s+(\d+)）/.exec(text)
  return {
    current: match?.[1] ? Number(match[1]) : 0,
    baseline: match?.[2] ? Number(match[2]) : 0,
  }
}

function suppressionCount(): number {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(ROOT, 'eslint-suppressions.json'), 'utf8'))
    return Object.keys(record(raw) ?? {}).length
  } catch {
    return 0
  }
}

function gitText(args: readonly string[]): string {
  const result = run('git', args, ROOT, 10_000)
  return result.ok ? result.stdout.trim() : ''
}

function dirtyStatus(): boolean {
  const lines = gitText(['status', '--porcelain']).split('\n').filter(Boolean)
  return lines.some((line) => {
    const path = line.slice(3).trim()
    return !(
      path.startsWith('packages/forgeloop/coverage/') ||
      path.startsWith('packages/forgeloop/reports/') ||
      path.startsWith('reports/') ||
      path.startsWith('.forgeloop/')
    )
  })
}

function pruneHistory(): void {
  try {
    const files = readdirSync(HISTORY_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
    for (const name of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) {
      unlinkSync(join(HISTORY_DIR, name))
    }
  } catch {
    // 历史清理失败不阻断本次快照。
  }
}

function main(): void {
  mkdirSync(HISTORY_DIR, { recursive: true })
  const gates: GateRow[] = []

  const typecheck = run('make', ['typecheck'], ROOT, 180_000)
  gates.push(gate('typecheck', '类型检查', typecheck, 'make typecheck', null, 'errors', 0))

  const lint = run('make', ['lint'], ROOT, 180_000)
  gates.push(gate('lint', 'ESLint', lint, 'make lint', null, 'errors', 0))

  const format = run('make', ['format'], ROOT, 120_000)
  gates.push(gate('format', '格式', format, 'make format', null, 'files', 0))

  const contracts = run('make', ['contracts'], ROOT, 120_000)
  gates.push(gate('contracts', '架构契约', contracts, 'make contracts', null, 'violations', 0))

  const budget = run('make', ['budget'], ROOT, 120_000)
  const tokenValues = parseTokens(`${budget.stdout}\n${budget.stderr}`)
  gates.push(
    gate(
      'token-budget',
      'Token 预算',
      budget,
      'make budget',
      tokenValues.overLimit,
      'over-limit files',
      0,
    ),
  )

  const assertions = run('make', ['assertions'], ROOT, 120_000)
  const assertionValues = parseAssertions(`${assertions.stdout}\n${assertions.stderr}`)
  gates.push(
    gate(
      'assertion-budget',
      '断言预算',
      assertions,
      'make assertions',
      assertionValues.current,
      'assertions',
      assertionValues.baseline,
    ),
  )

  const testsStarted = Date.now()
  const tests = run(
    process.execPath,
    [
      VITEST_BIN,
      'run',
      '--coverage',
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${VITEST_REPORT}`,
    ],
    PKG_DIR,
    900_000,
  )
  const testsSummary = parseTests(testsStarted)
  gates.push(
    gate(
      'tests',
      '行为测试',
      tests,
      'vitest run --coverage --reporter=json',
      testsSummary?.failed ?? null,
      'failed tests',
      0,
      testsSummary && testsSummary.failed === 0 ? 'pass' : 'fail',
    ),
  )

  const coverage = parseCoverage(testsStarted)
  gates.push(
    gate(
      'coverage',
      '覆盖率',
      tests,
      'vitest run --coverage',
      coverage?.lines ?? null,
      '% lines',
      coverage?.thresholds.lines ?? 90,
      coveragePasses(coverage) ? 'pass' : 'fail',
    ),
  )

  let mutation: MutationSummary | null = null
  if (FAST) {
    gates.push(notRun('mutation', '变异测试', 'make mutation'))
  } else {
    const mutationStarted = Date.now()
    const mutationRun = run('make', ['mutation'], ROOT, 1_800_000)
    mutation = parseMutation(mutationStarted)
    gates.push(
      gate(
        'mutation',
        '变异测试',
        mutationRun,
        'make mutation',
        mutation?.score ?? null,
        '% score',
        mutation?.thresholds.break ?? 80,
        mutation && mutation.score !== null && mutation.score >= mutation.thresholds.break
          ? 'pass'
          : 'fail',
      ),
    )
  }

  const packageRow = record(JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')))
  const snapshot = {
    schemaVersion: 1,
    project: 'ForgeLoop',
    generatedAt: new Date().toISOString(),
    git: {
      head: gitText(['rev-parse', 'HEAD']),
      branch: gitText(['branch', '--show-current']),
      dirty: dirtyStatus(),
    },
    package: {
      name: typeof packageRow?.name === 'string' ? packageRow.name : 'forgeloop-dsh',
      version: typeof packageRow?.version === 'string' ? packageRow.version : '',
    },
    gates,
    tests: testsSummary ? { ...testsSummary, durationMs: tests.durationMs } : null,
    coverage,
    mutation,
    budgets: {
      assertions: { current: assertionValues.current, baseline: assertionValues.baseline },
      tokens: {
        fileLimit: 25_000,
        overLimit: tokenValues.overLimit,
        maxFile: tokenValues.maxFile,
        maxTokens: tokenValues.maxTokens,
      },
    },
    suppressions: suppressionCount(),
    artifacts: {
      vitest: 'reports/vitest.json',
      coverage: 'packages/forgeloop/coverage/coverage-summary.json',
      mutation: 'packages/forgeloop/reports/mutation.json',
    },
  }
  const text = `${JSON.stringify(snapshot, null, 2)}\n`
  writeFileSync(LATEST, text, 'utf8')
  const stamp = snapshot.generatedAt.replace(/[:.]/g, '-')
  const head = snapshot.git.head.slice(0, 7) || 'nogit'
  writeFileSync(join(HISTORY_DIR, `${stamp}-${head}.json`), text, 'utf8')
  pruneHistory()

  const failed = gates.filter((item) => item.status === 'fail')
  const passed = gates.filter((item) => item.status === 'pass')
  console.log(
    `[reliability] 快照 ${relative(ROOT, LATEST)}；门禁 ${passed.length}/${passed.length + failed.length} 通过` +
      `${failed.length > 0 ? `，失败：${failed.map((item) => item.label).join('、')}` : ''}` +
      `${FAST ? '；变异测试未运行' : ''}`,
  )
  if (failed.length > 0) process.exitCode = 1
}

main()
