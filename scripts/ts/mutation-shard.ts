/**
 * 变异测试分片：把全部活动源码按模块切成可独立运行的 shard。
 *
 * 用法：
 *   node scripts/ts/mutation-shard.ts --list
 *   node scripts/ts/mutation-shard.ts domain
 *   node scripts/ts/mutation-shard.ts all
 *
 * 分片只决定本次要变异哪些文件；默认用快速测试配置（均排除 monitor），
 * FORGELOOP_MUTATION_FULL=1 时 runtime 分片改用全量测试配置（本地测量/显式 opt-in；
 * nightly 默认不用，避免 2–4 小时/分片超出 240 分钟作业预算）。
 * 先校验所有源码都恰好属于一个 shard，避免新增文件悄悄漏出变异范围。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '../..')
const PKG = join(ROOT, 'packages', 'forgeloop')
const SRC = join(PKG, 'src')
// @stryker-mutator/core 是根 devDependency，npm 工作区会把它提升到仓库根；
// 只有不提升的安装才落在包内。先找根，再回退包内。
const STRYKER_BIN =
  [
    join(ROOT, 'node_modules', '.bin', 'stryker'),
    join(PKG, 'node_modules', '.bin', 'stryker'),
  ].find((path) => existsSync(path)) ?? join(ROOT, 'node_modules', '.bin', 'stryker')
const CONCURRENCY = process.env.STRYKER_CONCURRENCY

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const absolute = join(dir, name)
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute]
  })
}

const all = filesUnder(SRC)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => relative(PKG, file).split(sep).join('/'))
  .sort()

const runtime = all.filter((file) => file.startsWith('src/runtime/'))
const runtimeVerification = runtime.filter((file) =>
  /(verification|candidate|build-materials|deployment|integration|acceptance|formal-test|legacy-verification)/.test(
    basename(file),
  ),
)
const runtimeOps = runtime.filter(
  (file) =>
    !runtimeVerification.includes(file) &&
    /(ops|monitor|alerts|heartbeat|reliability|web-tools|board|project-docs|prompts|requirement-views|service|session-routing|analysis-queue|orchestrator|budget|identity|version)/.test(
      basename(file),
    ),
)
const runtimeExecution = runtime.filter(
  (file) => !runtimeVerification.includes(file) && !runtimeOps.includes(file),
)

/**
 * 变异要跑全量测试；runtime 流水线的慢用例会让单个分片耗时过长。
 * 按源码字节数做确定性均分，保证每个 CI 作业都能在超时内跑完；
 * 分支名带序号，合并脚本仍按源码去重校验。
 */
function splitShard(files: string[], parts: number, prefix: string): Record<string, string[]> {
  const buckets: string[][] = Array.from({ length: parts }, () => [])
  const weights = buckets.map(() => 0)
  const ordered = [...files].sort(
    (left, right) =>
      statSync(join(PKG, right)).size - statSync(join(PKG, left)).size || left.localeCompare(right),
  )
  for (const file of ordered) {
    let target = 0
    for (let index = 1; index < parts; index += 1) {
      if (weights[index]! < weights[target]!) target = index
    }
    buckets[target]!.push(file)
    weights[target]! += statSync(join(PKG, file)).size
  }
  const result: Record<string, string[]> = {}
  buckets.forEach((bucket, index) => {
    result[`${prefix}-${index + 1}`] = bucket.sort()
  })
  return result
}

const shards: Record<string, string[]> = {
  ...splitShard(
    all.filter((file) => file.startsWith('src/domain/')),
    2,
    'domain',
  ),
  records: all.filter((file) => file.startsWith('src/records/')),
  ...splitShard(runtimeExecution, 2, 'runtime-execution'),
  ...splitShard(runtimeVerification, 2, 'runtime-verification'),
  ...splitShard(runtimeOps, 4, 'runtime-ops'),
  session: all.filter((file) => file.startsWith('src/session/') || file === 'src/tools.ts'),
  'config-agents': all.filter((file) => file === 'src/config.ts' || file.startsWith('src/agents/')),
  entry: all.filter((file) => file === 'src/index.ts' || file.startsWith('src/cli/')),
  all,
}

const counts = new Map<string, number>()
for (const [name, files] of Object.entries(shards)) {
  if (name === 'all') continue
  for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1)
}
const missing = all.filter((file) => !counts.has(file))
const duplicated = [...counts.entries()].filter(([, count]) => count > 1).map(([file]) => file)
if (missing.length > 0) {
  console.error(`[mutation-shard] 以下源码没有被任何 shard 覆盖：\n${missing.join('\n')}`)
  process.exit(1)
}
if (duplicated.length > 0) {
  console.error(`[mutation-shard] 以下源码同时属于多个 shard：\n${duplicated.join('\n')}`)
  process.exit(1)
}
for (const [name, files] of Object.entries(shards)) {
  if (name !== 'all' && files.length === 0) {
    console.error(`[mutation-shard] shard ${name} 为空`)
    process.exit(1)
  }
}

const requested = process.argv[2]
if (!requested || requested === '--help') {
  console.error('用法：node scripts/ts/mutation-shard.ts <shard|all|--list>')
  process.exit(requested ? 0 : 1)
}
if (requested === '--list') {
  for (const [name, files] of Object.entries(shards)) {
    console.log(`${name}\t${files.length}`)
  }
  process.exit(0)
}

const files = shards[requested]
if (!files) {
  console.error(`[mutation-shard] 未知 shard：${requested}`)
  process.exit(1)
}

if (files.length === 0) {
  console.error(`[mutation-shard] shard ${requested} 没有文件`)
  process.exit(1)
}

console.log(`[mutation-shard] shard=${requested} files=${files.length}`)
// 分片只负责产出报告，不按分数阻断：单个分片低分不应让 nightly 矩阵先红。
// 全局门槛由 mutation-merge 读取 stryker.config.json 的 thresholds 统一判定。
const reportsDir = join(PKG, 'reports')
mkdirSync(reportsDir, { recursive: true })
const base = JSON.parse(readFileSync(join(PKG, 'stryker.config.json'), 'utf8')) as {
  thresholds?: Record<string, number>
  [key: string]: unknown
}
// 全量测试配置能显著提高 runtime 杀伤，但单分片 2–4 小时；nightly 默认仍用快速配置，
// 需要完整测量时显式设置 FORGELOOP_MUTATION_FULL=1。
const fullMutation = process.env.FORGELOOP_MUTATION_FULL === '1'
const vitestConfig =
  fullMutation && requested.startsWith('runtime-')
    ? 'vitest.mutation.config.ts'
    : 'vitest.mutation-fast.config.ts'
const configPath = join(reportsDir, `stryker-shard-${requested}.json`)
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      ...base,
      vitest: { configFile: vitestConfig },
      jsonReporter: { fileName: `reports/mutation-${requested}.json` },
      mutate: files,
      incrementalFile: `reports/mutation-incremental-${requested}.json`,
      thresholds: { ...base.thresholds, break: 0 },
    },
    null,
    2,
  )}\n`,
)
const args = ['run', configPath]
// CI 用 STRYKER_CONCURRENCY 覆盖配置里的本地并发数；非法值直接忽略，交给配置。
if (CONCURRENCY && /^\d+$/.test(CONCURRENCY)) args.push('--concurrency', CONCURRENCY)
const result = spawnSync(STRYKER_BIN, args, {
  cwd: PKG,
  stdio: 'inherit',
  env: { ...process.env },
})
if (result.error) {
  console.error(`[mutation-shard] 启动 Stryker 失败：${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
