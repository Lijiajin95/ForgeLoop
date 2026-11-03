#!/usr/bin/env node
/**
 * 增量变异门禁：只变异本次改动影响的源码及其直接依赖，受控范围内有效得分必须 >= break。
 *
 * 用法：
 *   node scripts/ts/mutation-incremental.ts                 # git diff BASE 影响的源码
 *   node scripts/ts/mutation-incremental.ts --scope controlled
 *   node scripts/ts/mutation-incremental.ts --base <ref> --scope incremental
 *
 * - 增量范围：git diff BASE 的 src 变更 + 各自直接 import 的本地源码（一跳）；
 *   没有受影响源码时如实记为 NOT_APPLICABLE，不伪造通过。
 * - 受控范围：清单 mutation.controlled_scope（不排除业务源码，不降低 break）。
 * - 等价变异豁免只在清单登记（文件+行+mutator+理由），报告列出存活与豁免清单。
 * - 每次运行把选中文件内容与 base/head 写入 incremental 文件名，避免复用过期结果。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { loadContract, PKG, REPORTS, ROOT, run, tail, writeJson } from './reliability-lib.ts'

const STRYKER_BIN = [
  join(ROOT, 'node_modules', '.bin', 'stryker'),
  join(PKG, 'node_modules', '.bin', 'stryker'),
].find((candidate) => existsSync(candidate))
if (!STRYKER_BIN) {
  console.error('[mutation-incremental] 找不到 Stryker 可执行文件；不能判定为通过。')
  process.exit(2)
}
const args = process.argv.slice(2)
function argValue(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const scopeArg = argValue('--scope') ?? 'incremental'
const baseArg = argValue('--base') ?? process.env.FORGELOOP_BASE ?? ''
const breakValue = Number(process.env.FORGELOOP_MUTATION_BREAK ?? '')

const contract = loadContract()
const breakThreshold = contract.mutation.break
if (breakValue && breakValue !== breakThreshold) {
  console.error(
    `[mutation-incremental] 不允许用环境变量改 break：清单/Stryker 为 ${breakThreshold}，收到 ${breakValue}`,
  )
  process.exit(2)
}

function git(argsList: readonly string[]): string {
  const result = run('git', argsList, { cwd: ROOT, timeoutMs: 30_000 })
  if (!result.ok) throw new Error(`git ${argsList.join(' ')} 失败：${tail(result.stderr)}`)
  return result.stdout.trim()
}

function resolveBase(): string {
  if (baseArg) return git(['rev-parse', baseArg])
  for (const candidate of ['origin/main', 'main', 'HEAD~1']) {
    const result = run('git', ['merge-base', candidate, 'HEAD'], { cwd: ROOT, timeoutMs: 30_000 })
    if (result.ok && result.stdout.trim()) return result.stdout.trim()
  }
  return git(['rev-parse', 'HEAD'])
}

function localImportsOf(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const imports = [...text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((match) => match[1] ?? '')
  const targets: string[] = []
  for (const specifier of imports) {
    const base = resolve(ROOT, dirname(file), specifier)
    const candidates = base.endsWith('.js')
      ? [`${base.slice(0, -3)}.ts`]
      : [`${base}.ts`, join(base, 'index.ts')]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const repoPath = relative(ROOT, candidate).split('\\').join('/')
        if (repoPath.startsWith('packages/forgeloop/src/')) targets.push(repoPath)
      }
    }
  }
  return targets
}

function incrementalFiles(base: string): string[] {
  const changed = git(['diff', '--name-only', base, '--', 'packages/forgeloop/src'])
    .split('\n')
    .filter(Boolean)
  const untracked = git(['ls-files', '--others', '--exclude-standard', 'packages/forgeloop/src'])
    .split('\n')
    .filter(Boolean)
  const direct = [...new Set([...changed, ...untracked])].filter(
    (file) => file.endsWith('.ts') && existsSync(join(ROOT, file)) && !file.endsWith('.d.ts'),
  )
  const expanded = new Set<string>(direct)
  for (const file of direct) {
    for (const dependency of localImportsOf(file)) expanded.add(dependency)
  }
  return [...expanded].sort()
}

const base = resolveBase()
const head = git(['rev-parse', 'HEAD'])
const filesArg = argValue('--files')
const selected = filesArg
  ? filesArg
      .split(',')
      .map((file) => file.trim())
      .filter(Boolean)
      .map((file) => (file.startsWith('packages/forgeloop/') ? file : `packages/forgeloop/${file}`))
      .sort()
  : scopeArg === 'controlled'
    ? [...contract.mutation.controlled_scope].sort()
    : incrementalFiles(base)

if (scopeArg !== 'controlled' && scopeArg !== 'incremental') {
  console.error(`[mutation-incremental] 未知 scope：${scopeArg}`)
  process.exit(2)
}

if (selected.length === 0) {
  const report = {
    generatedAt: new Date().toISOString(),
    scope: scopeArg,
    base,
    head,
    status: 'NOT_APPLICABLE',
    reason: 'git diff 未影响任何源码，增量变异不适用；全量变异仍由 nightly 分片执行。',
    files: [],
    break: breakThreshold,
  }
  writeJson(join(REPORTS, 'mutation-incremental.json'), report)
  console.log('[mutation-incremental] NOT_APPLICABLE：没有受影响的源码')
  process.exit(0)
}

const mutate = selected.map((file) => file.replace('packages/forgeloop/', ''))
if (args.includes('--list')) {
  console.log(mutate.join('\n'))
  process.exit(0)
}
const digest = createHash('sha256')
  .update(selected.map((file) => readFileSync(join(ROOT, file), 'utf8')).join('\u0000'))
  .update(`\u0000${base}\u0000${head}`)
  .digest('hex')
  .slice(0, 12)
const tag = `${scopeArg}-${digest}`
const reportRelative = `reports/mutation-${tag}.json`
const incrementalRelative = `reports/mutation-incremental-${tag}.json`
const configPath = join(PKG, 'reports', `stryker-${tag}.json`)
mkdirSync(join(PKG, 'reports'), { recursive: true })

const strykerBase = JSON.parse(readFileSync(join(PKG, 'stryker.config.json'), 'utf8')) as Record<
  string,
  unknown
>
const config = {
  ...strykerBase,
  mutate,
  incremental: true,
  incrementalFile: incrementalRelative,
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: { fileName: reportRelative },
  // break 保持仓库门槛；分片脚本之外的入口不得下调。
  thresholds: { ...(strykerBase.thresholds as Record<string, number>), break: breakThreshold },
}
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

console.log(
  `[mutation-incremental] scope=${scopeArg} files=${mutate.length} base=${base.slice(0, 7)} head=${head.slice(0, 7)}`,
)
console.log(`[mutation-incremental] mutate:\n  ${mutate.join('\n  ')}`)

const concurrency = process.env.STRYKER_CONCURRENCY
const strykerArgs = ['run', configPath]
if (concurrency && /^\d+$/.test(concurrency)) strykerArgs.push('--concurrency', concurrency)
const started = Date.now()
const result = run(STRYKER_BIN, strykerArgs, { cwd: PKG, timeoutMs: 30 * 60_000 })
const durationMs = Date.now() - started
const reportAbsolute = join(PKG, reportRelative)
rmSync(configPath, { force: true })

if (!existsSync(reportAbsolute)) {
  const report = {
    generatedAt: new Date().toISOString(),
    scope: scopeArg,
    base,
    head,
    status: 'ERROR',
    reason: 'Stryker 未生成变异报告；不能判定为通过。',
    files: selected,
    break: breakThreshold,
    durationMs,
    output: tail(`${result.stdout}\n${result.stderr}`, 30),
  }
  writeJson(join(REPORTS, 'mutation-incremental.json'), report)
  console.error(report.reason)
  console.error(report.output)
  process.exit(2)
}

interface Mutant {
  readonly mutatorName: string
  readonly status: string
  readonly replacement?: string
  readonly location?: { readonly start?: { readonly line?: number; readonly column?: number } }
  readonly id?: string
}
const raw = JSON.parse(readFileSync(reportAbsolute, 'utf8')) as {
  files?: Record<string, { mutants?: Mutant[] }>
}
const files = raw.files ?? {}
const statuses = new Map<string, number>()
const survivors: Array<{
  file: string
  line: number
  column: number
  mutator: string
  replacement: string
}> = []
let killed = 0
let timeout = 0
let survived = 0
let noCoverage = 0
let excluded = 0
for (const [file, entry] of Object.entries(files)) {
  for (const mutant of entry.mutants ?? []) {
    statuses.set(mutant.status, (statuses.get(mutant.status) ?? 0) + 1)
    if (mutant.status === 'Killed') killed += 1
    else if (mutant.status === 'Timeout') timeout += 1
    else if (mutant.status === 'Survived') survived += 1
    else if (mutant.status === 'NoCoverage') noCoverage += 1
    else excluded += 1
    if (mutant.status === 'Survived' || mutant.status === 'NoCoverage') {
      survivors.push({
        file: file.startsWith('packages/forgeloop/') ? file : `packages/forgeloop/${file}`,
        line: mutant.location?.start?.line ?? 0,
        column: mutant.location?.start?.column ?? 0,
        mutator: mutant.mutatorName,
        replacement: mutant.replacement ?? '',
      })
    }
  }
}
const denominator = killed + timeout + survived + noCoverage
const score =
  denominator === 0 ? null : Math.round(((killed + timeout) / denominator) * 10_000) / 100
const exempt = (mutant: { file: string; line: number; mutator: string }): boolean =>
  contract.mutation.equivalent_mutants.some(
    (item) =>
      item.file === mutant.file && item.line === mutant.line && item.mutator === mutant.mutator,
  )
const liveSurvivors = survivors.filter((mutant) => !exempt(mutant))
const exempted = survivors.filter((mutant) => exempt(mutant))
const critical = new Set(contract.mutation.critical_files)
const criticalSurvivors = liveSurvivors.filter((mutant) => critical.has(mutant.file))
const scorePasses = score !== null && score >= breakThreshold
const status =
  scorePasses && criticalSurvivors.length === 0 ? 'PASS' : denominator === 0 ? 'ERROR' : 'FAIL'
const report = {
  generatedAt: new Date().toISOString(),
  scope: scopeArg,
  base,
  head,
  break: breakThreshold,
  status,
  reason:
    status === 'PASS'
      ? '受控范围有效变异得分达到 break，关键不变量无存活变异。'
      : denominator === 0
        ? '没有可计分的变异体；不能判定为通过。'
        : criticalSurvivors.length > 0
          ? `关键不变量存在 ${criticalSurvivors.length} 个存活变异。`
          : `有效变异得分 ${score} < break ${breakThreshold}。`,
  score,
  denominator,
  totals: { killed, timeout, survived, noCoverage, excluded },
  statuses: Object.fromEntries([...statuses.entries()].sort()),
  files: selected,
  durationMs,
  criticalSurvivors,
  survivors: liveSurvivors,
  exemptedSurvivors: exempted.map((mutant) => ({
    ...mutant,
    reason:
      contract.mutation.equivalent_mutants.find(
        (item) =>
          item.file === mutant.file && item.line === mutant.line && item.mutator === mutant.mutator,
      )?.reason ?? '',
  })),
  output: result.ok ? '' : tail(`${result.stdout}\n${result.stderr}`, 20),
}
writeJson(join(REPORTS, 'mutation-incremental.json'), report)
rmSync(join(PKG, incrementalRelative), { force: true })

console.log(
  `[mutation-incremental] ${status}：score=${String(score)}% 分母=${denominator} ` +
    `(killed=${killed}, timeout=${timeout}, survived=${survived}, noCoverage=${noCoverage}, excluded=${excluded})；` +
    `存活 ${liveSurvivors.length}，关键存活 ${criticalSurvivors.length}，豁免 ${exempted.length}`,
)
if (status !== 'PASS') {
  for (const mutant of criticalSurvivors) {
    console.error(
      `  关键存活：${mutant.file}:${mutant.line} ${mutant.mutator} -> ${mutant.replacement}`,
    )
  }
  for (const mutant of liveSurvivors.slice(0, 30)) {
    console.error(
      `  存活：${mutant.file}:${mutant.line} ${mutant.mutator} -> ${mutant.replacement}`,
    )
  }
  process.exit(status === 'ERROR' ? 2 : 1)
}
