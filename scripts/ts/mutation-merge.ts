/**
 * 合并分片变异报告：把各 shard 的 Stryker JSON 合成一份
 * packages/forgeloop/reports/mutation.json，并校验全部源码都被实际变异过。
 *
 * 用法：
 *   node scripts/ts/mutation-merge.ts [shardReportDir]
 *
 * 默认读取 packages/forgeloop/reports/shards/*.json。缺少任一源码文件、
 * 报告结构异常或聚合分数低于 break 门槛都直接失败，避免分片漏跑被当成通过。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const PKG = join(ROOT, 'packages', 'forgeloop')
const SRC = join(PKG, 'src')
const SHARDS = resolve(process.argv[2] ?? join(PKG, 'reports', 'shards'))
const OUTPUT = join(PKG, 'reports', 'mutation.json')
const CONFIG = join(PKG, 'stryker.config.json')

type AnyRecord = Record<string, unknown>

function record(value: unknown): AnyRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : null
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const absolute = join(dir, name)
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute]
  })
}

const expected = new Set(
  filesUnder(SRC)
    .filter((file) => file.endsWith('.ts'))
    .map((file) =>
      file
        .slice(PKG.length + 1)
        .split('\\')
        .join('/'),
    ),
)

// 纯类型文件没有变异点，Stryker 不会在 JSON 报告里写出空文件；
// 显式登记后按 0 个变异处理，其余缺失仍视为分片漏跑（新增空文件会失败并提示登记）。
const EMPTY_SOURCE_FILES = new Set(['src/domain/work.ts'])

if (!existsSync(SHARDS)) {
  console.error(`[mutation-merge] 找不到分片报告目录：${SHARDS}`)
  process.exit(1)
}

const reports = readdirSync(SHARDS)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({ name, path: join(SHARDS, name) }))

if (reports.length === 0) {
  console.error(`[mutation-merge] ${SHARDS} 中没有分片报告`)
  process.exit(1)
}

// 分片报告里的 thresholds 不可信（分片按 break=0 运行），唯一门槛来自仓库配置。
let config: AnyRecord | null = null
try {
  config = record(JSON.parse(readFileSync(CONFIG, 'utf8')))
} catch (error) {
  console.error(`[mutation-merge] 无法读取 ${CONFIG}：${String(error)}`)
  process.exit(1)
}
const thresholds = record(config?.thresholds)
if (!thresholds || typeof thresholds.break !== 'number') {
  console.error('[mutation-merge] stryker.config.json 缺少 thresholds.break')
  process.exit(1)
}

const mergedFiles: Record<string, unknown> = {}
let schemaVersion = ''

for (const report of reports) {
  let parsed: AnyRecord | null = null
  try {
    parsed = record(JSON.parse(readFileSync(report.path, 'utf8')))
  } catch (error) {
    console.error(`[mutation-merge] ${report.name} 不是合法 JSON：${String(error)}`)
    process.exit(1)
  }
  const files = record(parsed?.files)
  if (!parsed || !files) {
    console.error(`[mutation-merge] ${report.name} 缺少 files 结构`)
    process.exit(1)
  }
  schemaVersion = typeof parsed.schemaVersion === 'string' ? parsed.schemaVersion : schemaVersion
  for (const [path, value] of Object.entries(files)) {
    if (mergedFiles[path]) {
      console.error(`[mutation-merge] 源码 ${path} 在多个分片报告中重复出现`)
      process.exit(1)
    }
    mergedFiles[path] = value
  }
}

const staleEmpty = [...EMPTY_SOURCE_FILES].filter((path) => !expected.has(path))
if (staleEmpty.length > 0) {
  console.error(`[mutation-merge] 空变异文件已不存在，请更新 list：\n${staleEmpty.join('\n')}`)
  process.exit(1)
}
const missing = [...expected].filter((path) => !mergedFiles[path] && !EMPTY_SOURCE_FILES.has(path))
if (missing.length > 0) {
  console.error(`[mutation-merge] 以下源码没有出现在变异报告中：\n${missing.join('\n')}`)
  process.exit(1)
}
for (const path of EMPTY_SOURCE_FILES) {
  if (!mergedFiles[path]) mergedFiles[path] = { mutants: [] }
}

let killed = 0
let survived = 0
let timeout = 0
let noCoverage = 0
for (const value of Object.values(mergedFiles)) {
  const mutants = record(value)?.mutants
  if (!Array.isArray(mutants)) continue
  for (const mutant of mutants) {
    const status = record(mutant)?.status
    if (status === 'Killed') killed += 1
    else if (status === 'Survived') survived += 1
    else if (status === 'Timeout') timeout += 1
    else if (status === 'NoCoverage') noCoverage += 1
  }
}

const denominator = killed + survived + timeout + noCoverage
const score = denominator === 0 ? 0 : Math.round(((killed + timeout) / denominator) * 10000) / 100
const breakThreshold = thresholds.break

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(
  OUTPUT,
  `${JSON.stringify({ schemaVersion, thresholds, files: mergedFiles }, null, 2)}\n`,
)
console.log(
  `[mutation-merge] files=${Object.keys(mergedFiles).length} mutants=${denominator} ` +
    `killed=${killed} survived=${survived} timeout=${timeout} noCoverage=${noCoverage} score=${score}%`,
)
if (score < breakThreshold) {
  console.error(`[mutation-merge] 变异分数 ${score}% 低于门槛 ${breakThreshold}%`)
  process.exit(1)
}
