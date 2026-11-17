import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildCiSnapshot,
  coverageSummaryOf,
  findArtifactFile,
} from '../../../scripts/ts/reliability-ci.ts'

/**
 * CI 工件 → 可靠性快照的映射：只读文件、不执行命令；缺失的数据标 not_run/skipped，
 * 不能伪造成通过。页面 schema 与本地快照一致（gates/tests/coverage/mutation）。
 */

let root = ''

const ADVANCED = {
  schemaVersion: 1,
  project: 'ForgeLoop',
  generatedAt: '2026-11-12T01:15:12.542Z',
  base: '7825135',
  head: 'abc1234def5678',
  overall: 'PASS',
  sections: [
    {
      id: 'coverage',
      title: '覆盖率',
      status: 'PASS',
      durationMs: 241_000,
      at: '2026-11-12T01:15:10.000Z',
      detail: '覆盖报告生成；未达标：无',
    },
    { id: 'properties', title: '属性测试', status: 'PASS', durationMs: 1300 },
  ],
}

const COVERAGE = {
  total: {
    lines: { total: 100, covered: 98.5, skipped: 0, pct: 98.5 },
    statements: { total: 100, covered: 98.5, skipped: 0, pct: 98.5 },
    functions: { total: 100, covered: 99.6, skipped: 0, pct: 99.6 },
    branches: { total: 100, covered: 93.2, skipped: 0, pct: 93.2 },
  },
  '/home/runner/work/ForgeLoop/ForgeLoop/packages/forgeloop/src/domain/work.ts': {
    lines: { total: 10, covered: 9, skipped: 0, pct: 90 },
    statements: { total: 10, covered: 9, skipped: 0, pct: 90 },
    functions: { total: 2, covered: 2, skipped: 0, pct: 100 },
    branches: { total: 4, covered: 3, skipped: 0, pct: 75 },
  },
  '/home/runner/work/ForgeLoop/ForgeLoop/packages/forgeloop/tests/x.ts': {
    lines: { total: 1, covered: 1, skipped: 0, pct: 100 },
  },
}

const MUTATION = {
  generatedAt: '2026-11-12T01:15:12.000Z',
  scope: 'controlled',
  base: '7825135',
  head: 'abc1234def5678',
  break: 80,
  status: 'PASS',
  score: 95.1,
  denominator: 837,
  totals: { killed: 790, timeout: 6, survived: 39, noCoverage: 2, excluded: 0 },
  durationMs: 1_142_976,
}

function writeArtifact(relativePath: string, value: unknown): void {
  const path = join(root, relativePath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function nightlyDir(): string {
  return join(root, 'ci', '43132824985')
}

function seedNightly(): string {
  const dir = nightlyDir()
  writeArtifact('ci/43132824985/nightly-reliability-advanced/reliability-advanced.json', ADVANCED)
  writeArtifact('ci/43132824985/nightly-mutation-controlled/mutation-incremental.json', MUTATION)
  writeArtifact('ci/43132824985/nightly-coverage/coverage-summary.json', COVERAGE)
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-ci-report-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('CI artifact ingestion', () => {
  it('maps a nightly artifact directory into the snapshot schema', () => {
    const built = buildCiSnapshot({ dir: seedNightly() })
    const snapshot = built.snapshot
    expect(snapshot.source).toBe('ci')
    expect((snapshot.git as { head: string }).head).toBe('abc1234def5678')
    expect((snapshot.ci as { runId: string }).runId).toBe('43132824985')
    expect((snapshot.ci as { workflow: string }).workflow).toBe('Nightly quality')

    const gates = snapshot.gates as { id: string; status: string; measured: number | null }[]
    const byId = new Map(gates.map((item) => [item.id, item]))
    // 静态门禁不在 artifact 里：标 skipped，不计入通过率，也不伪造为 pass。
    for (const id of [
      'typecheck',
      'lint',
      'format',
      'contracts',
      'token-budget',
      'assertion-budget',
    ]) {
      expect(byId.get(id)?.status).toBe('skipped')
    }
    // 没有 vitest.json 时，行为测试由 coverage 段推断（job 的 make coverage 包含全量测试）。
    expect(byId.get('tests')).toMatchObject({ status: 'pass', measured: 0 })
    expect(byId.get('coverage')).toMatchObject({ status: 'pass', measured: 98.5 })
    expect(byId.get('mutation')).toMatchObject({ status: 'pass', measured: 95.1 })

    const coverage = snapshot.coverage as {
      lines: number
      files: { path: string }[]
    }
    expect(coverage.lines).toBe(98.5)
    // CI 绝对路径归一成仓库相对路径，测试目录被排除。
    expect(coverage.files.map((file) => file.path)).toEqual([
      'packages/forgeloop/src/domain/work.ts',
    ])
    const mutation = snapshot.mutation as { killed: number; survived: number }
    expect(mutation.killed).toBe(790)
    expect(mutation.survived).toBe(39)
    expect(built.warnings.join('；')).toContain('coverage 段推断')
  })

  it('uses vitest.json counts when the workflow uploads them', () => {
    const dir = seedNightly()
    writeArtifact('ci/43132824985/test-report/vitest.json', {
      numTotalTests: 100,
      numPassedTests: 98,
      numFailedTests: 2,
      numPendingTests: 0,
      durationMs: 120_000,
      testResults: [{}, {}],
    })
    const built = buildCiSnapshot({ dir })
    const gates = built.snapshot.gates as { id: string; status: string; measured: number | null }[]
    expect(gates.find((item) => item.id === 'tests')).toMatchObject({
      status: 'fail',
      measured: 2,
    })
    expect(built.snapshot.tests).toMatchObject({ files: 2, failed: 2, total: 100 })
  })

  it('marks missing reports as not_run and rejects an empty directory', () => {
    const dir = join(root, 'ci', '999')
    mkdirSync(dir, { recursive: true })
    expect(() => buildCiSnapshot({ dir })).toThrow(/没有可识别的报告/)
  })

  it('fails the mutation gate when the controlled run did not pass', () => {
    const dir = seedNightly()
    writeArtifact('ci/43132824985/nightly-mutation-controlled/mutation-incremental.json', {
      ...MUTATION,
      status: 'ERROR',
      score: 0,
      reason: 'Stryker 未生成变异报告',
    })
    const built = buildCiSnapshot({ dir })
    const gates = built.snapshot.gates as { id: string; status: string }[]
    expect(gates.find((item) => item.id === 'mutation')?.status).toBe('fail')
  })

  it('writes the snapshot and its history through the CLI', () => {
    const dir = seedNightly()
    const out = join(root, 'project', 'reports', 'reliability', 'latest.json')
    const script = resolve(import.meta.dirname, '../../../scripts/ts/reliability-report.ts')
    execFileSync(process.execPath, [script, '--from-ci', dir, '--out', out], {
      cwd: resolve(import.meta.dirname, '../../..'),
      encoding: 'utf8',
    })
    const snapshot = JSON.parse(readFileSync(out, 'utf8')) as {
      source: string
      gates: { id: string; status: string }[]
    }
    expect(snapshot.source).toBe('ci')
    expect(snapshot.gates.find((item) => item.id === 'mutation')?.status).toBe('pass')
    expect(readdirSync(join(root, 'project', 'reports', 'reliability', 'history'))).toHaveLength(1)
  })

  it('finds nested artifact files and normalizes coverage paths', () => {
    const dir = seedNightly()
    expect(findArtifactFile(dir, 'coverage-summary.json')).toContain('nightly-coverage')
    const summary = coverageSummaryOf(COVERAGE)
    expect(summary).not.toBeNull()
    expect((summary?.files as { path: string }[]).length).toBe(1)
  })
})
