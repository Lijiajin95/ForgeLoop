/**
 * 进阶可靠性门禁的共享工具：读清单、跑 vitest、解析报告、记录错误。
 * 只用 Node 标准库；脚本本身不进入覆盖率统计（src 之外）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(import.meta.dirname, '../..')
export const PKG = join(ROOT, 'packages', 'forgeloop')
export const REPORTS = join(ROOT, 'reports')
export const CONTRACT_PATH = join(ROOT, 'contracts', 'reliability.json')
export const VITEST_BIN = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'))

export interface PropertyTest {
  readonly file: string
  readonly title: string
  readonly min_runs: number
}

export interface Invariant {
  readonly id: string
  readonly title: string
  readonly statement: string
  readonly modules: readonly string[]
  readonly tests: readonly string[]
  readonly gates: readonly string[]
  readonly property_test?: PropertyTest
  readonly na_reason?: string
}

export interface Transition {
  readonly from: string
  readonly to: string
  readonly via: string
  readonly tested?: boolean
}

export interface StateMachine {
  readonly id: string
  readonly title: string
  readonly module: string
  readonly states: readonly string[]
  readonly initial: string
  readonly terminal: readonly string[]
  readonly frozen?: readonly string[]
  readonly transitions: readonly Transition[]
  readonly transition_rule?: 'explicit' | 'complete'
  readonly tests: readonly string[]
}

export interface Scenario {
  readonly id: string
  readonly title: string
  readonly risk: string
  readonly tests: readonly string[]
  readonly test_titles?: readonly string[]
  readonly gates: readonly string[]
  readonly na_reason?: string
}

export interface Contract {
  readonly schema_version: number
  readonly gates: Record<string, { readonly command: string; readonly description: string }>
  readonly modules: ReadonlyArray<{ readonly id: string; readonly path: string }>
  readonly invariants: readonly Invariant[]
  readonly state_machines: readonly StateMachine[]
  readonly scenarios: readonly Scenario[]
  readonly stability: {
    readonly rounds: number
    readonly seed: number
    readonly tests: ReadonlyArray<{ readonly file: string; readonly reason: string }>
  }
  readonly mutation: {
    readonly break: number
    readonly controlled_scope: readonly string[]
    readonly critical_files: readonly string[]
    readonly equivalent_mutants: ReadonlyArray<{
      readonly file: string
      readonly line: number
      readonly mutator: string
      readonly reason: string
      /** 被变异源码行的原文；给出时按内容匹配，避免行号漂移让豁免失效。 */
      readonly snippet?: string
    }>
  }
}

export function loadContract(): Contract {
  return JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as Contract
}

export function ensureReports(): void {
  mkdirSync(REPORTS, { recursive: true })
}

export interface RunResult {
  readonly ok: boolean
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}

export function run(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: Record<string, string | undefined>
    timeoutMs?: number
  } = {},
): RunResult {
  const started = Date.now()
  const result = spawnSync(command, [...args], {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 900_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', ...(options.env ?? {}) },
  })
  const spawnError = result.error ? `spawn error: ${result.error.message}` : ''
  return {
    ok: result.status === 0,
    code: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: [result.stderr ?? '', spawnError].filter(Boolean).join('\n'),
    durationMs: Date.now() - started,
    timedOut: result.error?.name === 'Error' && /ETIMEDOUT|timed out/i.test(result.error.message),
  }
}

export type Status = 'PASS' | 'FAIL' | 'ERROR' | 'NOT_APPLICABLE'

export interface TestCounts {
  readonly files: number
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly skipped: number
}

export interface VitestOutcome {
  readonly status: Status
  readonly counts: TestCounts
  readonly files: readonly string[]
  readonly durationMs: number
  readonly command: string
  readonly detail: string
  readonly reportPath: string | null
}

/** 逐个文件串行运行，避免并行负载把重型用例挤成超时。 */
export function runVitestFiles(
  files: readonly string[],
  options: {
    group: string
    env?: Record<string, string | undefined>
    timeoutMsPerFile?: number
  },
): VitestOutcome {
  ensureReports()
  const reportPath = join(REPORTS, `reliability-${options.group}.json`)
  let filesRun = 0
  let total = 0
  let passed = 0
  let failed = 0
  let skipped = 0
  let durationMs = 0
  let status: Status = 'PASS'
  const details: string[] = []
  const executed: string[] = []
  for (const file of files) {
    const absolute = resolve(ROOT, file)
    if (!existsSync(absolute)) {
      status = 'ERROR'
      details.push(`测试文件不存在：${file}`)
      continue
    }
    const outFile = join(REPORTS, `vitest-${options.group}-${file.replaceAll('/', '_')}.json`)
    const result = run(
      process.execPath,
      [
        VITEST_BIN,
        'run',
        absolute,
        '--no-file-parallelism',
        '--reporter=json',
        `--outputFile=${outFile}`,
      ],
      {
        cwd: PKG,
        env: options.env,
        timeoutMs: options.timeoutMsPerFile ?? 600_000,
      },
    )
    durationMs += result.durationMs
    filesRun += 1
    executed.push(file)
    const parsed = parseVitestJson(outFile)
    if (parsed) {
      total += parsed.total
      passed += parsed.passed
      failed += parsed.failed
      skipped += parsed.skipped
      if (parsed.failed > 0 || !result.ok) {
        status = 'FAIL'
        details.push(`${file}: ${parsed.failed} 个失败 / ${parsed.total} 个用例`)
        if (result.stderr.trim()) details.push(tail(result.stderr))
      }
    } else if (!result.ok) {
      // 没有可信 JSON：无法区分测试失败与运行环境问题，一律按 ERROR，不按 PASS。
      status = 'ERROR'
      details.push(`${file}: 未能生成测试报告（exit ${String(result.code)}）`)
      if (result.stderr.trim()) details.push(tail(result.stderr))
    } else {
      details.push(`${file}: 报告缺失，但进程成功（按 ERROR 处理）`)
      status = status === 'FAIL' ? 'FAIL' : 'ERROR'
    }
  }
  if (filesRun === 0 && status === 'PASS') status = 'NOT_APPLICABLE'
  const outcome: VitestOutcome = {
    status,
    counts: { files: filesRun, total, passed, failed, skipped },
    files: executed,
    durationMs,
    command: 'vitest run <registered files> --no-file-parallelism --reporter=json',
    detail: details.join('\n'),
    reportPath,
  }
  writeJson(reportPath, outcome)
  return outcome
}

export function parseVitestReport(path: string): TestCounts | null {
  return parseVitestJson(path)
}

function parseVitestJson(path: string): TestCounts | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
    return {
      files: Array.isArray(raw.testResults) ? raw.testResults.length : 0,
      total: num(raw.numTotalTests),
      passed: num(raw.numPassedTests),
      failed: num(raw.numFailedTests),
      skipped: num(raw.numPendingTests),
    }
  } catch {
    return null
  }
}

export function tail(text: string, lines = 12): string {
  return text.trim().split('\n').slice(-lines).join('\n')
}

export function registeredByGroup(contract: Contract, group: string): string[] {
  const files = new Set<string>()
  if (group === 'properties') {
    for (const invariant of contract.invariants) {
      if (invariant.property_test) files.add(invariant.property_test.file)
      for (const file of invariant.tests) files.add(file)
    }
  } else if (group === 'state-machine') {
    for (const machine of contract.state_machines) {
      for (const file of machine.tests) files.add(file)
    }
  } else if (group === 'scenarios') {
    for (const scenario of contract.scenarios) {
      for (const file of scenario.tests) files.add(file)
    }
  } else if (group === 'stability') {
    for (const test of contract.stability.tests) files.add(test.file)
  }
  return [...files].sort()
}

export function writeJson(path: string, value: unknown): void {
  ensureReports()
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
