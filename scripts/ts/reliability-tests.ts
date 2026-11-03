#!/usr/bin/env node
/**
 * 运行清单登记的一组测试（properties / state-machine / scenarios / stability）。
 * 全部串行逐文件执行，避免并行负载把重型用例挤成 20s 超时。
 *
 * 用法：
 *   node scripts/ts/reliability-tests.ts properties
 *   node scripts/ts/reliability-tests.ts state-machine
 *   node scripts/ts/reliability-tests.ts scenarios
 */
import { loadContract, registeredByGroup, runVitestFiles } from './reliability-lib.ts'

const GROUPS = ['properties', 'state-machine', 'scenarios', 'stability'] as const
type Group = (typeof GROUPS)[number]

const group = process.argv[2] as Group | undefined
if (!group || !GROUPS.includes(group)) {
  console.error(`用法：node scripts/ts/reliability-tests.ts <${GROUPS.join('|')}>`)
  process.exit(2)
}

const contract = loadContract()
const files = registeredByGroup(contract, group)
if (files.length === 0) {
  console.error(`[reliability-tests] ${group} 没有登记任何测试文件`)
  process.exit(2)
}

const runs = Math.max(
  200,
  Number.isInteger(Number(process.env.FORGELOOP_PROPERTY_RUNS))
    ? Number(process.env.FORGELOOP_PROPERTY_RUNS)
    : 200,
)
const seed =
  group === 'properties'
    ? process.env.FORGELOOP_PROPERTY_SEED && process.env.FORGELOOP_PROPERTY_SEED !== ''
      ? process.env.FORGELOOP_PROPERTY_SEED
      : String(contract.stability.seed)
    : undefined

const outcome = runVitestFiles(files, {
  group: `${group}-tests`,
  env: {
    FORGELOOP_PROPERTY_RUNS: String(runs),
    ...(seed === undefined ? {} : { FORGELOOP_PROPERTY_SEED: seed }),
  },
})

console.log(
  `[reliability-tests] ${group}: ${outcome.status}，文件 ${outcome.counts.files}，` +
    `用例 ${outcome.counts.passed}/${outcome.counts.total} 通过，失败 ${outcome.counts.failed}，` +
    `跳过 ${outcome.counts.skipped}，耗时 ${(outcome.durationMs / 1000).toFixed(1)}s` +
    `${seed === undefined ? '' : `（seed ${seed}）`}`,
)
if (outcome.status !== 'PASS') {
  console.error(outcome.detail || '（无更多细节）')
  process.exit(outcome.status === 'ERROR' ? 2 : 1)
}
