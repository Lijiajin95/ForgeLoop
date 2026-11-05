#!/usr/bin/env node
/**
 * 进阶可靠性报告：真实运行并汇总 registry / 稳定性 / 属性 / 状态机 / 场景 / 回归 / 覆盖率 / 增量变异。
 *
 * 用法：
 *   node scripts/ts/reliability-report-advanced.ts
 *   node scripts/ts/reliability-report-advanced.ts --scope controlled   # 受控范围变异
 *
 * 输出：
 *   reports/reliability-advanced.json（机器可读，reports/ 已被忽略）
 *   控制台 Markdown 摘要
 *
 * 状态只有 PASS / FAIL / ERROR / NOT_APPLICABLE：
 * - ERROR（工具没跑起来、报告缺失、JSON 不可解析）一律不算 PASS；
 * - NOT_APPLICABLE 必须带理由，且总体不计为该项通过。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import vitestConfig from '../../packages/forgeloop/vitest.config.ts'
import {
  loadContract,
  REPORTS,
  ROOT,
  run,
  runVitestFiles,
  writeJson,
  type Status,
} from './reliability-lib.ts'

interface Section {
  readonly id: string
  readonly title: string
  readonly status: Status
  readonly numerator: number | null
  readonly denominator: number | null
  readonly unit: string
  readonly scope: string
  readonly command: string
  readonly durationMs: number | null
  readonly at: string
  readonly detail: string
  readonly reportPath: string | null
}

const contract = loadContract()
const scopeArgIndex = process.argv.indexOf('--scope')
const mutationScope =
  scopeArgIndex >= 0 ? (process.argv[scopeArgIndex + 1] ?? 'incremental') : 'incremental'
const startedAt = Date.now()

function gitText(args: readonly string[]): string {
  const result = run('git', args, { cwd: ROOT, timeoutMs: 30_000 })
  return result.ok ? result.stdout.trim() : ''
}

function resolveBase(): string {
  if (process.env.FORGELOOP_BASE) {
    const resolved = gitText(['rev-parse', process.env.FORGELOOP_BASE])
    if (resolved) return resolved
  }
  for (const candidate of ['origin/main', 'main', 'HEAD~1']) {
    const base = gitText(['merge-base', candidate, 'HEAD'])
    if (base) return base
  }
  return gitText(['rev-parse', 'HEAD'])
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function section(input: Omit<Section, 'at'>): Section {
  return { ...input, at: new Date().toISOString() }
}

function runGateScript(
  id: string,
  title: string,
  command: string,
  args: readonly string[],
  options: { unit: string; scope: string; reportPath: string | null },
): Section {
  const result = run(process.execPath, args, { cwd: ROOT, timeoutMs: 60 * 60_000 })
  let status: Status = result.ok ? 'PASS' : 'FAIL'
  let numerator: number | null = null
  let denominator: number | null = null
  const detail: string[] = []
  if (options.reportPath && existsSync(join(ROOT, options.reportPath))) {
    const parsed = readJson<Record<string, unknown>>(join(ROOT, options.reportPath))
    if (parsed) {
      if (typeof parsed.status === 'string') {
        const reported = parsed.status as Status
        if (reported === 'ERROR') status = 'ERROR'
        else if (reported === 'FAIL') status = 'FAIL'
        else if (reported === 'NOT_APPLICABLE' && status === 'PASS') status = 'NOT_APPLICABLE'
        if (reported !== 'PASS' && status === 'PASS') status = reported
      }
      const counts = parsed.counts as Record<string, unknown> | undefined
      if (counts && typeof counts.total === 'number') {
        numerator = typeof counts.passed === 'number' ? counts.passed : null
        denominator = counts.total
      }
      if (typeof parsed.reason === 'string') detail.push(parsed.reason)
      if (typeof parsed.detail === 'string' && parsed.detail.trim()) detail.push(parsed.detail)
      if (typeof parsed.score === 'number' || parsed.score === null) {
        const totals = parsed.totals as { killed?: number; timeout?: number } | undefined
        numerator =
          typeof totals?.killed === 'number' && typeof totals.timeout === 'number'
            ? totals.killed + totals.timeout
            : null
        denominator = typeof parsed.denominator === 'number' ? parsed.denominator : null
        if (typeof parsed.score === 'number') detail.push(`有效变异得分 ${parsed.score}%`)
        if (Array.isArray(parsed.criticalSurvivors)) {
          detail.push(`关键存活 ${parsed.criticalSurvivors.length}`)
        }
      }
    }
  } else if (!result.ok) {
    status = 'ERROR'
    detail.push('门禁进程失败且缺少机器可读报告')
  }
  if (!result.ok && status === 'PASS') status = 'FAIL'
  if (result.timedOut) status = 'ERROR'
  if (!result.ok) {
    const tailText = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-10).join('\n')
    if (tailText) detail.push(tailText)
  }
  return section({
    id,
    title,
    status,
    numerator,
    denominator,
    unit: options.unit,
    scope: options.scope,
    command,
    durationMs: result.durationMs,
    detail: detail.join('\n'),
    reportPath: options.reportPath,
  })
}

// ---------------------------------------------------------------- 1. 清单
const registry = runGateScript(
  'registry',
  '可靠性清单校验',
  'node scripts/ts/reliability-registry.ts',
  ['scripts/ts/reliability-registry.ts'],
  {
    unit: 'checks',
    scope: 'contracts/reliability.json',
    reportPath: null,
  },
)
const registrySection: Section = {
  ...registry,
  numerator: registry.status === 'PASS' ? 1 : 0,
  denominator: 1,
  detail: registry.detail || '结构、文件、门禁/NA、状态机闭包与变异门槛一致',
}

// ---------------------------------------------------------------- 2. 属性
const properties = runGateScript(
  'properties',
  '属性测试',
  'node scripts/ts/reliability-tests.ts properties',
  ['scripts/ts/reliability-tests.ts', 'properties'],
  {
    unit: 'property tests',
    scope: `${contract.invariants.length} invariants, seed ${
      process.env.FORGELOOP_PROPERTY_SEED || contract.stability.seed
    }, runs>=${process.env.FORGELOOP_PROPERTY_RUNS || 200}`,
    reportPath: 'reports/reliability-properties-tests.json',
  },
)

// ---------------------------------------------------------------- 3/4. 状态机与场景
const stateMachines = runGateScript(
  'state-machine',
  '状态机测试',
  'node scripts/ts/reliability-tests.ts state-machine',
  ['scripts/ts/reliability-tests.ts', 'state-machine'],
  {
    unit: 'state machine tests',
    scope: `${contract.state_machines.length} machines`,
    reportPath: 'reports/reliability-state-machine-tests.json',
  },
)
const scenarios = runGateScript(
  'scenarios',
  'P0 边界与异常场景',
  'node scripts/ts/reliability-tests.ts scenarios',
  ['scripts/ts/reliability-tests.ts', 'scenarios'],
  {
    unit: 'scenario tests',
    scope: `${contract.scenarios.length} scenarios`,
    reportPath: 'reports/reliability-scenarios-tests.json',
  },
)

// ---------------------------------------------------------------- 5. 回归（已知 flaky seed）
const regressionOutcome = runVitestFiles(
  [
    'packages/forgeloop/tests/property-invariants.test.ts',
    'packages/forgeloop/tests/property-invariants-advanced.test.ts',
  ],
  {
    group: 'regression-seed-61697261',
    env: {
      FORGELOOP_PROPERTY_RUNS: process.env.FORGELOOP_PROPERTY_RUNS ?? '200',
      FORGELOOP_PROPERTY_SEED: '61697261',
    },
  },
)
const regression = section({
  id: 'regression',
  title: '已知 flaky 回归（seed 61697261）',
  status: regressionOutcome.status,
  numerator: regressionOutcome.counts.passed,
  denominator: regressionOutcome.counts.total,
  unit: 'property tests',
  scope: 'property-invariants + advanced, fixed seed 61697261',
  command: 'vitest run <property files> FORGELOOP_PROPERTY_SEED=61697261',
  durationMs: regressionOutcome.durationMs,
  detail: regressionOutcome.detail || '原失败 seed 下属性测试通过',
  reportPath: relative(ROOT, join(REPORTS, 'reliability-regression-seed-61697261.json')),
})

// ---------------------------------------------------------------- 6. 稳定性
const stabilityRun = run(process.execPath, ['scripts/ts/stability.ts'], {
  cwd: ROOT,
  timeoutMs: 60 * 60_000,
})
const stabilityReport = readJson<Record<string, unknown>>(join(REPORTS, 'stability.json'))
let stabilityStatus: Status
let stabilityDetail: string
let stabilityNumerator: number | null = null
let stabilityDenominator: number | null = null
if (stabilityReport) {
  const reported = String(stabilityReport.status ?? '')
  stabilityStatus =
    reported === 'PASS' || reported === 'FAIL' || reported === 'ERROR'
      ? (reported as Status)
      : 'ERROR'
  const tests = Array.isArray(stabilityReport.tests) ? stabilityReport.tests : []
  stabilityDenominator = tests.length
  stabilityNumerator = tests.filter(
    (test) => (test as Record<string, unknown>).status === 'PASS',
  ).length
  const attempts = tests.flatMap((test) =>
    Array.isArray((test as Record<string, unknown>).attempts)
      ? ((test as Record<string, unknown>).attempts as unknown[])
      : [],
  )
  stabilityDetail = `${tests.length} 个文件 × ${String(stabilityReport.rounds)} 轮，共 ${attempts.length} 次；失败 ${
    stabilityRun.ok ? 0 : 1
  }`
} else {
  stabilityStatus = 'ERROR'
  stabilityDetail = '未生成 reports/stability.json'
}
if (stabilityRun.timedOut) stabilityStatus = 'ERROR'
const stability = section({
  id: 'stability',
  title: '稳定性（串行独立运行）',
  status: stabilityStatus,
  numerator: stabilityNumerator,
  denominator: stabilityDenominator,
  unit: 'test files',
  scope: `${contract.stability.rounds} rounds, serial, isolated TMPDIR`,
  command: 'node scripts/ts/stability.ts',
  durationMs: stabilityRun.durationMs,
  detail: stabilityDetail,
  reportPath: 'reports/stability.json',
})

// ---------------------------------------------------------------- 7. 变异
const mutation = runGateScript(
  'mutation',
  '增量/受控变异',
  `node scripts/ts/mutation-incremental.ts --scope ${mutationScope}`,
  ['scripts/ts/mutation-incremental.ts', '--scope', mutationScope],
  {
    unit: 'effective mutants',
    scope: `scope=${mutationScope}, break=${contract.mutation.break}`,
    reportPath: 'reports/mutation-incremental.json',
  },
)

// ---------------------------------------------------------------- 8. 覆盖率（最近一次真实运行）
function coverageSection(): Section {
  const reportPath = 'packages/forgeloop/coverage/coverage-summary.json'
  const absolute = join(ROOT, reportPath)
  if (!existsSync(absolute)) {
    return section({
      id: 'coverage',
      title: '逐文件覆盖率',
      status: 'NOT_APPLICABLE',
      numerator: null,
      denominator: null,
      unit: 'source files',
      scope: 'make coverage（独立门禁）',
      command: 'make coverage',
      durationMs: null,
      detail:
        '本次未生成 coverage-summary.json；覆盖率由 make coverage 单独门禁，未运行不记为通过。',
      reportPath,
    })
  }
  const ageMs = Date.now() - statSync(absolute).mtimeMs
  if (ageMs > 24 * 60 * 60 * 1000) {
    return section({
      id: 'coverage',
      title: '逐文件覆盖率',
      status: 'NOT_APPLICABLE',
      numerator: null,
      denominator: null,
      unit: 'source files',
      scope: 'make coverage（独立门禁）',
      command: 'make coverage',
      durationMs: null,
      detail: '覆盖率报告超过 24 小时，未用于本次结论；请先运行 make coverage。',
      reportPath,
    })
  }
  const raw = readJson<Record<string, unknown>>(absolute)
  if (!raw) {
    return section({
      id: 'coverage',
      title: '逐文件覆盖率',
      status: 'ERROR',
      numerator: 0,
      denominator: 0,
      unit: 'source files',
      scope: 'make coverage',
      command: 'make coverage',
      durationMs: null,
      detail: '覆盖率报告无法解析',
      reportPath,
    })
  }
  const configured = (vitestConfig.test?.coverage?.thresholds ?? {}) as Record<string, unknown>
  const defaults = {
    lines: typeof configured.lines === 'number' ? configured.lines : 90,
    functions: typeof configured.functions === 'number' ? configured.functions : 95,
    branches: typeof configured.branches === 'number' ? configured.branches : 85,
  }
  const files: Array<{
    path: string
    lines: number | null
    functions: number | null
    branches: number | null
  }> = []
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'total') continue
    const absolutePath = key
    const rel = relative(ROOT, absolutePath).split('\\').join('/')
    if (!rel.startsWith('packages/forgeloop/src/')) continue
    const metrics = value as Record<string, { pct?: number } | undefined>
    const pct = (name: string): number | null =>
      typeof metrics[name]?.pct === 'number' ? (metrics[name]?.pct ?? null) : null
    files.push({
      path: rel,
      lines: pct('lines'),
      functions: pct('functions'),
      branches: pct('branches'),
    })
  }
  const passing = files.filter((file) => {
    const overrideKey = Object.keys(configured).find(
      (key) =>
        key !== 'lines' &&
        key !== 'functions' &&
        key !== 'branches' &&
        key !== 'statements' &&
        key !== 'perFile' &&
        file.path.endsWith(`/${key}`),
    )
    const override = (overrideKey ? configured[overrideKey] : undefined) as
      { lines?: number; functions?: number; branches?: number } | undefined
    const expected = { ...defaults, ...(override ?? {}) }
    return (
      file.lines !== null &&
      file.functions !== null &&
      file.branches !== null &&
      file.lines >= expected.lines &&
      file.functions >= expected.functions &&
      file.branches >= expected.branches
    )
  })
  const failing = files.filter((file) => !passing.includes(file))
  const generatedAt = new Date(statSync(absolute).mtimeMs).toISOString()
  return section({
    id: 'coverage',
    title: '逐文件覆盖率',
    status: files.length > 0 && failing.length === 0 ? 'PASS' : 'FAIL',
    numerator: passing.length,
    denominator: files.length,
    unit: 'source files',
    scope: `per-file lines>=${defaults.lines} functions>=${defaults.functions} branches>=${defaults.branches}`,
    command: 'make coverage',
    durationMs: null,
    detail:
      files.length === 0
        ? '报告中没有任何 src 文件'
        : `覆盖报告生成于 ${generatedAt}；未达标：${failing.map((file) => file.path).join('、') || '无'}`,
    reportPath,
  })
}
const coverage = coverageSection()

const sections = [
  registrySection,
  stability,
  properties,
  stateMachines,
  scenarios,
  regression,
  mutation,
  coverage,
]

const errorSections = sections.filter((item) => item.status === 'ERROR')
const failedSections = sections.filter((item) => item.status === 'FAIL')
const notApplicable = sections.filter((item) => item.status === 'NOT_APPLICABLE')
const overall: Status =
  errorSections.length > 0 ? 'ERROR' : failedSections.length > 0 ? 'FAIL' : 'PASS'

const base = resolveBase()
const head = gitText(['rev-parse', 'HEAD'])
const registrySha = createHash('sha256')
  .update(readFileSync(join(ROOT, 'contracts', 'reliability.json'), 'utf8'))
  .digest('hex')
const report = {
  schemaVersion: 1,
  project: 'ForgeLoop',
  generatedAt: new Date().toISOString(),
  base,
  head,
  branch: gitText(['branch', '--show-current']),
  registrySha256: registrySha,
  overall,
  startedAtMs: startedAt,
  sections,
  summary: {
    pass: sections.filter((item) => item.status === 'PASS').length,
    fail: failedSections.length,
    error: errorSections.length,
    notApplicable: notApplicable.length,
  },
}
const reportPath = join(REPORTS, 'reliability-advanced.json')
writeJson(reportPath, report)

const icon = (status: Status): string =>
  status === 'PASS'
    ? '✅ PASS'
    : status === 'FAIL'
      ? '❌ FAIL'
      : status === 'ERROR'
        ? '⛔ ERROR'
        : '➖ N/A'
console.log('')
console.log('## ForgeLoop 进阶可靠性门禁')
console.log('')
console.log(`- base: \`${base.slice(0, 12)}\`  head: \`${head.slice(0, 12)}\``)
console.log(`- registry sha256: \`${registrySha.slice(0, 16)}…\``)
console.log(
  `- 结论: **${overall}**（PASS ${report.summary.pass} / FAIL ${report.summary.fail} / ERROR ${report.summary.error} / N/A ${report.summary.notApplicable}）`,
)
console.log('')
console.log('| 门禁 | 状态 | 数值 | 范围 | 耗时 |')
console.log('| --- | --- | --- | --- | --- |')
for (const item of sections) {
  const value =
    item.denominator === null ? '—' : `${item.numerator ?? '—'}/${item.denominator} ${item.unit}`
  console.log(
    `| ${item.title} | ${icon(item.status)} | ${value} | ${item.scope} | ${
      item.durationMs === null ? '—' : `${(item.durationMs / 1000).toFixed(1)}s`
    } |`,
  )
}
console.log('')
for (const item of sections.filter((entry) => entry.status !== 'PASS')) {
  console.log(`### ${item.title}：${item.status}`)
  console.log('')
  console.log(item.detail || '（无细节）')
  console.log('')
}
console.log(`报告：${relative(ROOT, reportPath)}`)
if (overall !== 'PASS') process.exit(overall === 'ERROR' ? 2 : 1)
