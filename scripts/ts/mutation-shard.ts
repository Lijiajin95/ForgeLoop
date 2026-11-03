/**
 * 变异测试分片：把全部活动源码按模块切成可独立运行的 shard。
 *
 * 用法：
 *   node scripts/ts/mutation-shard.ts --list
 *   node scripts/ts/mutation-shard.ts domain
 *   node scripts/ts/mutation-shard.ts all
 *
 * 分片只决定本次要变异哪些文件；测试仍使用 vitest.fast.config.ts。
 * 先校验所有源码都恰好属于一个 shard，避免新增文件悄悄漏出变异范围。
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '../..')
const PKG = join(ROOT, 'packages', 'forgeloop')
const SRC = join(PKG, 'src')
const STRYKER_BIN = join(PKG, 'node_modules', '.bin', 'stryker')
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

const shards: Record<string, string[]> = {
  domain: all.filter((file) => file.startsWith('src/domain/')),
  records: all.filter((file) => file.startsWith('src/records/')),
  'runtime-execution': runtimeExecution,
  'runtime-verification': runtimeVerification,
  'runtime-ops': runtimeOps,
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
const args = [
  'run',
  '--mutate',
  files.join(','),
  '--incremental',
  '--incrementalFile',
  `reports/mutation-incremental-${requested}.json`,
  '--reporters',
  'clear-text,progress,json',
]
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
