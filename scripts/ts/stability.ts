#!/usr/bin/env node
/**
 * 稳定性门禁：对清单登记的关键测试串行独立运行 N 次（默认 3，最少 3）。
 *
 * - 每次用独立 TMPDIR，避免临时目录互相污染；
 * - 固定属性测试 seed，失败可复现；
 * - 区分“测试失败（FAIL）”与“运行环境错误（ERROR）”，两者都不放行；
 * - 不做无限重试，所有轮次与失败原因写入 reports/stability.json。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadContract,
  parseVitestReport,
  PKG,
  REPORTS,
  ROOT,
  run,
  runVitestFiles,
  VITEST_BIN,
  writeJson,
  tail,
} from './reliability-lib.ts'

const contract = loadContract()
const configuredRounds = Number(process.env.FORGELOOP_STABILITY_ROUNDS ?? '')
const rounds =
  Number.isInteger(configuredRounds) && configuredRounds >= 3
    ? configuredRounds
    : Math.max(3, contract.stability.rounds)
const seed =
  process.env.FORGELOOP_PROPERTY_SEED && process.env.FORGELOOP_PROPERTY_SEED !== ''
    ? process.env.FORGELOOP_PROPERTY_SEED
    : String(contract.stability.seed)
const runs = Math.max(200, Number(process.env.FORGELOOP_PROPERTY_RUNS ?? 200) || 200)
const tmpRoot = join(REPORTS, 'stability-tmp')
mkdirSync(tmpRoot, { recursive: true })

interface Attempt {
  readonly round: number
  readonly status: 'pass' | 'fail' | 'error'
  readonly durationMs: number
  readonly total: number | null
  readonly failed: number | null
  readonly detail: string
}

interface TestStability {
  readonly file: string
  readonly reason: string
  readonly attempts: Attempt[]
  status: 'PASS' | 'FAIL' | 'ERROR'
  failures: number
  environmentErrors: number
}

const tests: TestStability[] = []

for (const test of contract.stability.tests) {
  const file = test.file
  const attempts: Attempt[] = []
  let failures = 0
  let environmentErrors = 0
  for (let round = 1; round <= rounds; round += 1) {
    const slug = file.split('/').pop()?.replaceAll('.test.ts', '') ?? 'test'
    const tmpDir = join(tmpRoot, `${slug}-r${round}`)
    mkdirSync(tmpDir, { recursive: true })
    const outFile = join(REPORTS, `stability-${slug}-r${round}.json`)
    const result = run(
      process.execPath,
      [
        VITEST_BIN,
        'run',
        join(ROOT, file),
        '--no-file-parallelism',
        '--reporter=json',
        `--outputFile=${outFile}`,
      ],
      {
        cwd: PKG,
        env: {
          TMPDIR: tmpDir,
          FORGELOOP_PROPERTY_RUNS: String(runs),
          FORGELOOP_PROPERTY_SEED: seed,
        },
        timeoutMs: 600_000,
      },
    )
    const parsed = parseVitestReport(outFile)
    let status: Attempt['status']
    let detail = ''
    if (parsed && parsed.failed > 0) {
      status = 'fail'
      failures += 1
      detail = `${parsed.failed}/${parsed.total} 个用例失败`
    } else if (parsed) {
      status = result.ok ? 'pass' : 'fail'
      if (!result.ok) {
        failures += 1
        detail = `测试报告成功但进程退出码 ${String(result.code)}`
      }
    } else {
      status = 'error'
      environmentErrors += 1
      detail = `未生成测试报告（exit ${String(result.code)}，signal ${String(result.signal)}）`
      if (result.stderr.trim()) detail += `\n${tail(result.stderr)}`
    }
    attempts.push({
      round,
      status,
      durationMs: result.durationMs,
      total: parsed?.total ?? null,
      failed: parsed?.failed ?? null,
      detail,
    })
    console.log(
      `[stability] ${file} 第 ${round}/${rounds} 次：${status}${detail ? `（${detail.split('\n')[0]}）` : ''}`,
    )
    rmSync(tmpDir, { recursive: true, force: true })
  }
  const status: TestStability['status'] =
    failures > 0 ? 'FAIL' : environmentErrors > 0 ? 'ERROR' : 'PASS'
  tests.push({ file, reason: test.reason, attempts, status, failures, environmentErrors })
}

// 另外用同一 seed 跑一次已知 flaky 的属性文件，作为回归证据（不重复计入稳定性轮次）。
const regressionFiles = runVitestFiles(
  [
    'packages/forgeloop/tests/property-invariants.test.ts',
    'packages/forgeloop/tests/property-invariants-advanced.test.ts',
  ],
  {
    group: 'stability-regression',
    env: { FORGELOOP_PROPERTY_RUNS: String(runs), FORGELOOP_PROPERTY_SEED: '61697261' },
  },
)

const failing = tests.filter((test) => test.status !== 'PASS')
const summary = {
  generatedAt: new Date().toISOString(),
  rounds,
  seed,
  propertyRuns: runs,
  status:
    failing.length > 0 || regressionFiles.status !== 'PASS'
      ? failing.some((test) => test.status === 'FAIL') || regressionFiles.status === 'FAIL'
        ? 'FAIL'
        : 'ERROR'
      : 'PASS',
  tests,
  regression: {
    seed: 61697261,
    files: regressionFiles.files,
    status: regressionFiles.status,
    counts: regressionFiles.counts,
    detail: regressionFiles.detail,
  },
}
writeJson(join(REPORTS, 'stability.json'), summary)
rmSync(tmpRoot, { recursive: true, force: true })
console.log(
  `[stability] 总体：${summary.status}；${tests.length} 个文件 × ${rounds} 轮；` +
    `失败 ${failing.length}，环境错误 ${failing.filter((test) => test.status === 'ERROR').length}；` +
    `已知 flaky seed 61697261 回归：${regressionFiles.status}`,
)
if (summary.status !== 'PASS') {
  for (const test of failing) {
    console.error(
      `  - ${test.file}: ${test.status}（failures=${test.failures}, envErrors=${test.environmentErrors}）`,
    )
    for (const attempt of test.attempts.filter((item) => item.status !== 'pass')) {
      console.error(`    第 ${attempt.round} 轮：${attempt.detail}`)
    }
  }
  process.exit(summary.status === 'ERROR' ? 2 : 1)
}
