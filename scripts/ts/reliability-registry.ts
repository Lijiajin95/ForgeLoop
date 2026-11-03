#!/usr/bin/env node
/**
 * 可靠性清单校验：contracts/reliability.json 是机器可读的可靠性范围声明。
 *
 * 只校验“声明是否完整、可执行、与实现一致”，不执行测试也不改分数：
 * - 结构、唯一 id、必填字段；
 * - 模块与测试文件真实存在，测试标题能在文件里找到（防止登记了不存在的用例）；
 * - 每条不变量有属性测试且 >=200 次运行，或有 N/A 理由；
 * - 状态机：初始/终态/冻结态合法，迁移边合法，终态无出边（冻结态只允许声明例外）；
 * - 场景：有测试或 N/A 理由；
 * - 稳定性：每轮 >=3，测试文件存在；
 * - 变异：break 与 stryker.config.json 一致、受控范围文件存在、豁免项有理由；
 * - 不重复 architecture.json 的分层/依赖规则。
 *
 * 用法：
 *   node scripts/ts/reliability-registry.ts
 *   node scripts/ts/reliability-registry.ts --registry <path>   # 用于门禁自测/注入缺陷
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const DEFAULT_REGISTRY = 'contracts/reliability.json'
const STRYBER_CONFIG = 'packages/forgeloop/stryker.config.json'
const TEST_INCLUDE = 'packages/forgeloop/tests/'

interface Failure {
  readonly where: string
  readonly message: string
}

const failures: Failure[] = []
let checkCount = 0

function fail(where: string, message: string): void {
  failures.push({ where, message })
}

function check(_name: string, condition: boolean, where: string, message: string): void {
  checkCount += 1
  if (!condition) fail(where, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(where, '必须是对象')
    return {}
  }
  return value
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(where, '必须是数组')
    return []
  }
  return value
}

function strings(value: unknown, where: string): string[] {
  return list(value, where).map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      fail(`${where}[${index}]`, '必须是非空字符串')
      return ''
    }
    return item
  })
}

function nonEmpty(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    fail(where, '必须是非空字符串')
    return ''
  }
  return value
}

function repoFile(path: string): string {
  return resolve(ROOT, path)
}

function requireFile(path: string, where: string): boolean {
  const exists = existsSync(repoFile(path))
  if (!exists) fail(where, `文件不存在：${path}`)
  return exists
}

function fileText(path: string): string {
  try {
    return readFileSync(repoFile(path), 'utf8')
  } catch {
    return ''
  }
}

function requireTestTitle(file: string, title: string, where: string): void {
  if (!requireFile(file, where)) return
  if (!fileText(file).includes(title)) {
    fail(where, `测试文件中找不到标题：${title}（${file}）`)
  }
}

function findArchitectureKeys(value: unknown, path: string, hits: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findArchitectureKeys(item, `${path}[${index}]`, hits))
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'layers' || key === 'may_import' || key === 'dependency_rules') {
      hits.push(`${path}.${key}`)
    }
    findArchitectureKeys(child, `${path}.${key}`, hits)
  }
}

const args = process.argv.slice(2)
const registryFlag = args.indexOf('--registry')
const registryPath =
  registryFlag >= 0 && args[registryFlag + 1] ? args[registryFlag + 1] : DEFAULT_REGISTRY
const registryAbsolute = resolve(ROOT, registryPath)

if (!existsSync(registryAbsolute)) {
  console.error(`[reliability-registry] 清单不存在：${registryPath}`)
  process.exit(1)
}

let raw: unknown
try {
  raw = JSON.parse(readFileSync(registryAbsolute, 'utf8'))
} catch (error) {
  console.error(
    `[reliability-registry] 清单不是可解析的 JSON：${error instanceof Error ? error.message : ''}`,
  )
  process.exit(1)
}

const root = record(raw, 'registry')
const schemaVersion = root.schema_version
check('schema', schemaVersion === 1, 'registry.schema_version', '必须是 1')

const architectureHits: string[] = []
findArchitectureKeys(root, 'registry', architectureHits)
check(
  'no-architecture-duplication',
  architectureHits.length === 0,
  'registry',
  `不得重复 architecture.json 的分层/依赖规则；发现：${architectureHits.join('、')}`,
)

// ---------------------------------------------------------------- 门禁目录
const gates = record(root.gates, 'registry.gates')
const gateIds = new Set(Object.keys(gates))
check('gates-present', gateIds.size > 0, 'registry.gates', '至少要登记一个门禁')
for (const id of gateIds) {
  const gate = record(gates[id], `registry.gates.${id}`)
  nonEmpty(gate.command, `registry.gates.${id}.command`)
  nonEmpty(gate.description, `registry.gates.${id}.description`)
}
const requireGates = (value: unknown, where: string): string[] => {
  const ids = strings(value, where)
  for (const id of ids) {
    if (id && !gateIds.has(id)) fail(where, `未登记的门禁：${id}`)
  }
  return ids.filter(Boolean)
}
const gateOrNa = (entry: Record<string, unknown>, where: string, ids: string[]): void => {
  const na = typeof entry.na_reason === 'string' ? entry.na_reason.trim() : ''
  if (ids.length === 0 && !na) {
    fail(where, '必须至少登记一个门禁，或给出非空 na_reason')
  }
}

// ---------------------------------------------------------------- 模块
const modules = list(root.modules, 'registry.modules')
const moduleIds = new Set<string>()
modules.forEach((item, index) => {
  const where = `registry.modules[${index}]`
  const entry = record(item, where)
  const id = nonEmpty(entry.id, `${where}.id`)
  if (id && moduleIds.has(id)) fail(`${where}.id`, `模块 id 重复：${id}`)
  moduleIds.add(id)
  const path = nonEmpty(entry.path, `${where}.path`)
  if (path) requireFile(path, `${where}.path`)
  strings(entry.tests, `${where}.tests`).forEach((file, testIndex) => {
    if (file) requireFile(file, `${where}.tests[${testIndex}]`)
  })
  if (entry.critical !== undefined && typeof entry.critical !== 'boolean') {
    fail(`${where}.critical`, '必须是布尔值')
  }
})
check('modules-present', modules.length > 0, 'registry.modules', '至少要登记一个核心模块')

const requireModuleIds = (value: unknown, where: string): void => {
  for (const id of strings(value, where)) {
    if (id && !moduleIds.has(id)) fail(where, `未登记的模块：${id}`)
  }
}

// ---------------------------------------------------------------- 不变量
const invariants = list(root.invariants, 'registry.invariants')
const invariantIds = new Set<string>()
invariants.forEach((item, index) => {
  const where = `registry.invariants[${index}]`
  const entry = record(item, where)
  const id = nonEmpty(entry.id, `${where}.id`)
  if (id && invariantIds.has(id)) fail(`${where}.id`, `不变量 id 重复：${id}`)
  invariantIds.add(id)
  nonEmpty(entry.title, `${where}.title`)
  nonEmpty(entry.statement, `${where}.statement`)
  requireModuleIds(entry.modules, `${where}.modules`)
  const tests = strings(entry.tests, `${where}.tests`)
  tests.forEach((file, testIndex) => {
    if (file) requireFile(file, `${where}.tests[${testIndex}]`)
  })
  const gateOrChecks = requireGates(entry.gates, `${where}.gates`)
  gateOrNa(entry, where, gateOrChecks)

  const property = entry.property_test
  if (property === undefined) {
    const na = typeof entry.na_reason === 'string' ? entry.na_reason.trim() : ''
    if (!na) fail(where, '不变量必须登记 property_test；没有属性测试时给出 na_reason')
    return
  }
  const propertyWhere = `${where}.property_test`
  const propertyEntry = record(property, propertyWhere)
  const file = nonEmpty(propertyEntry.file, `${propertyWhere}.file`)
  const title = nonEmpty(propertyEntry.title, `${propertyWhere}.title`)
  const minRuns = propertyEntry.min_runs
  check(
    `${id || index}-property-runs`,
    typeof minRuns === 'number' && Number.isInteger(minRuns) && minRuns >= 200,
    `${propertyWhere}.min_runs`,
    '每项属性测试每次 PR 至少运行 200 次',
  )
  if (file && !tests.includes(file)) {
    fail(propertyWhere, `属性测试文件必须同时登记在 tests 中：${file}`)
  }
  if (file && !file.startsWith(TEST_INCLUDE)) {
    fail(propertyWhere, `属性测试必须在 ${TEST_INCLUDE} 下：${file}`)
  }
  if (file && title) requireTestTitle(file, title, propertyWhere)
})
check('invariants-present', invariants.length > 0, 'registry.invariants', '至少要登记一个不变量')

// ---------------------------------------------------------------- 状态机
const machines = list(root.state_machines, 'registry.state_machines')
const machineIds = new Set<string>()
machines.forEach((item, index) => {
  const where = `registry.state_machines[${index}]`
  const entry = record(item, where)
  const id = nonEmpty(entry.id, `${where}.id`)
  if (id && machineIds.has(id)) fail(`${where}.id`, `状态机 id 重复：${id}`)
  machineIds.add(id)
  nonEmpty(entry.title, `${where}.title`)
  nonEmpty(entry.module, `${where}.module`)
  if (typeof entry.module === 'string' && entry.module) {
    requireFile(entry.module, `${where}.module`)
  }
  nonEmpty(entry.enforcement, `${where}.enforcement`)
  const states = strings(entry.states, `${where}.states`)
  const stateSet = new Set(states.filter(Boolean))
  if (stateSet.size !== states.filter(Boolean).length) {
    fail(`${where}.states`, '状态不能重复')
  }
  const initial = nonEmpty(entry.initial, `${where}.initial`)
  if (initial && !stateSet.has(initial))
    fail(`${where}.initial`, `初始状态不在 states 中：${initial}`)
  const terminal = strings(entry.terminal, `${where}.terminal`)
  const frozen = strings(entry.frozen, `${where}.frozen`)
  for (const state of [...terminal, ...frozen]) {
    if (state && !stateSet.has(state)) fail(where, `终态/冻结态不在 states 中：${state}`)
  }
  for (const state of terminal.filter(Boolean)) {
    if (frozen.includes(state)) fail(where, `状态 ${state} 不能同时是终态与冻结态`)
  }

  const rule = entry.transition_rule ?? 'explicit'
  check(
    `${id || index}-transition-rule`,
    rule === 'explicit' || rule === 'complete',
    `${where}.transition_rule`,
    'transition_rule 只能是 explicit 或 complete',
  )

  const transitions = list(entry.transitions, `${where}.transitions`)
  const edges = new Set<string>()
  for (const [edgeIndex, edgeValue] of transitions.entries()) {
    const edgeWhere = `${where}.transitions[${edgeIndex}]`
    const edge = record(edgeValue, edgeWhere)
    const from = nonEmpty(edge.from, `${edgeWhere}.from`)
    const to = nonEmpty(edge.to, `${edgeWhere}.to`)
    if (from && !stateSet.has(from)) fail(edgeWhere, `起点不在 states 中：${from}`)
    if (to && !stateSet.has(to)) fail(edgeWhere, `终点不在 states 中：${to}`)
    nonEmpty(edge.via, `${edgeWhere}.via`)
    if (from && to) {
      const key = `${from}->${to}`
      if (edges.has(key)) fail(edgeWhere, `迁移边重复：${key}`)
      edges.add(key)
    }
    if (terminal.includes(from)) {
      fail(edgeWhere, `终态 ${from} 不允许有出边（终态不回退）`)
    }
    if (frozen.includes(from) && !(rule === 'complete')) {
      const exceptions = strings(entry.frozen_exceptions ?? [], `${where}.frozen_exceptions`)
      if (!exceptions.includes(to)) {
        fail(edgeWhere, `冻结态 ${from} 只允许登记在 frozen_exceptions 中的例外边：${to}`)
      }
    }
  }
  if (rule === 'complete' && transitions.length > 0) {
    fail(`${where}.transitions`, 'complete 规则不应再逐条列边')
  }
  if (rule === 'explicit' && states.length > 0 && transitions.length === 0) {
    fail(`${where}.transitions`, 'explicit 规则至少要有一条迁移边')
  }

  // 可达性：从 initial 出发；声明在 unreachable 中的状态必须写理由。
  const unreachable = list(entry.unreachable ?? [], `${where}.unreachable`)
  const unreachableStates = new Set<string>()
  for (const [unreachableIndex, value] of unreachable.entries()) {
    const unreachableWhere = `${where}.unreachable[${unreachableIndex}]`
    const item = record(value, unreachableWhere)
    const state = nonEmpty(item.state, `${unreachableWhere}.state`)
    nonEmpty(item.reason, `${unreachableWhere}.reason`)
    if (state) unreachableStates.add(state)
  }
  if (rule === 'explicit' && initial) {
    const reachable = new Set<string>([initial])
    let changed = true
    while (changed) {
      changed = false
      for (const key of edges) {
        const [from, to] = key.split('->')
        if (from && to && reachable.has(from) && !reachable.has(to)) {
          reachable.add(to)
          changed = true
        }
      }
    }
    for (const state of stateSet) {
      if (!reachable.has(state) && !unreachableStates.has(state)) {
        fail(`${where}.states`, `状态 ${state} 从初始状态不可达，且未登记 unreachable 理由`)
      }
    }
  }
  for (const state of unreachableStates) {
    if (!stateSet.has(state)) fail(`${where}.unreachable`, `未登记的状态：${state}`)
    if (state === initial) fail(`${where}.unreachable`, '初始状态不能标记为不可达')
  }

  const tests = strings(entry.tests, `${where}.tests`)
  tests.forEach((file, testIndex) => {
    if (file) requireFile(file, `${where}.tests[${testIndex}]`)
  })
  gateOrNa(entry, where, requireGates(entry.gates, `${where}.gates`))
})
check(
  'state-machines-present',
  machines.length > 0,
  'registry.state_machines',
  '至少要登记一个状态机',
)

// ---------------------------------------------------------------- 场景
const scenarios = list(root.scenarios, 'registry.scenarios')
const scenarioIds = new Set<string>()
scenarios.forEach((item, index) => {
  const where = `registry.scenarios[${index}]`
  const entry = record(item, where)
  const id = nonEmpty(entry.id, `${where}.id`)
  if (id && scenarioIds.has(id)) fail(`${where}.id`, `场景 id 重复：${id}`)
  scenarioIds.add(id)
  nonEmpty(entry.title, `${where}.title`)
  const na = typeof entry.na_reason === 'string' ? entry.na_reason.trim() : ''
  const tests = strings(entry.tests, `${where}.tests`)
  if (tests.length === 0 && !na) {
    fail(where, '场景必须有自动化测试，或给出非空 na_reason')
  }
  const titles = strings(entry.test_titles ?? [], `${where}.test_titles`)
  if (tests.length > 0 && titles.length !== tests.length) {
    fail(`${where}.test_titles`, 'test_titles 必须与 tests 一一对应')
  }
  tests.forEach((file, testIndex) => {
    if (!file) return
    requireFile(file, `${where}.tests[${testIndex}]`)
    const title = titles[testIndex]
    if (title) requireTestTitle(file, title, `${where}.tests[${testIndex}]`)
  })
  gateOrNa(entry, where, requireGates(entry.gates, `${where}.gates`))
})
check('scenarios-present', scenarios.length > 0, 'registry.scenarios', '至少要登记一个 P0 场景')

// ---------------------------------------------------------------- 稳定性
const stability = record(root.stability, 'registry.stability')
const rounds = stability.rounds
check(
  'stability-rounds',
  typeof rounds === 'number' && Number.isInteger(rounds) && rounds >= 3,
  'registry.stability.rounds',
  '关键测试每项至少独立运行 3 次',
)
const stabilityTests = list(stability.tests, 'registry.stability.tests')
check(
  'stability-tests',
  stabilityTests.length > 0,
  'registry.stability.tests',
  '至少要登记一个关键测试',
)
stabilityTests.forEach((item, index) => {
  const where = `registry.stability.tests[${index}]`
  const entry = record(item, where)
  const file = nonEmpty(entry.file, `${where}.file`)
  nonEmpty(entry.reason, `${where}.reason`)
  if (file) requireFile(file, `${where}.file`)
  if (entry.env !== undefined && !isRecord(entry.env)) fail(`${where}.env`, '必须是对象')
})

// ---------------------------------------------------------------- 变异
const mutation = record(root.mutation, 'registry.mutation')
const stryker = JSON.parse(readFileSync(repoFile(STRYBER_CONFIG), 'utf8')) as {
  thresholds?: { break?: number }
}
const strykerBreak = stryker.thresholds?.break
check(
  'mutation-break-matches-stryker',
  typeof mutation.break === 'number' && mutation.break === strykerBreak,
  'registry.mutation.break',
  `必须与 stryker.config.json 的 thresholds.break 一致（${String(strykerBreak)}）；不得自行下调`,
)
const scope = strings(mutation.controlled_scope, 'registry.mutation.controlled_scope')
check('mutation-scope', scope.length > 0, 'registry.mutation.controlled_scope', '受控范围不能为空')
scope.forEach((file, index) => {
  if (file) requireFile(file, `registry.mutation.controlled_scope[${index}]`)
})
const criticalFiles = strings(mutation.critical_files, 'registry.mutation.critical_files')
criticalFiles.forEach((file, index) => {
  if (file && !scope.includes(file)) {
    fail(`registry.mutation.critical_files[${index}]`, `关键文件必须在受控范围内：${file}`)
  }
})
const exemptions = list(mutation.equivalent_mutants, 'registry.mutation.equivalent_mutants')
exemptions.forEach((item, index) => {
  const where = `registry.mutation.equivalent_mutants[${index}]`
  const entry = record(item, where)
  const file = nonEmpty(entry.file, `${where}.file`)
  const mutator = nonEmpty(entry.mutator, `${where}.mutator`)
  nonEmpty(entry.reason, `${where}.reason`)
  const line = entry.line
  if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) {
    fail(`${where}.line`, '必须是正整数行号')
  }
  if (file) requireFile(file, `${where}.file`)
  if (mutator) void 0
})

// ---------------------------------------------------------------- 静态状态字面量校验
// 需求状态写入只允许出现在登记的状态集合中；实现里的字面量直接从源码抽取。
const requirementMachine = machines.find(
  (item) => isRecord(item) && item.id === 'requirement-status',
)
if (requirementMachine && isRecord(requirementMachine)) {
  const known = new Set(strings(requirementMachine.states, 'requirement-status.states'))
  const sources = ['packages/forgeloop/src/runtime', 'packages/forgeloop/src/records']
  const literalPattern = /setStatus\(\s*[^,]+,\s*(?:'([^']+)'|"([^"]+)")/g
  const constantPattern = /setStatus\(\s*[^,]+,\s*([A-Z][A-Z0-9_]*)\b/g
  const constantMap = new Map<string, string>()
  for (const file of listFiles(sources)) {
    const text = fileText(file)
    for (const match of text.matchAll(literalPattern)) {
      const status = match[1] ?? match[2] ?? ''
      if (status && !known.has(status)) {
        fail('requirement-status', `源码 ${file} 写入了未登记的需求状态：${status}`)
      }
    }
    for (const match of text.matchAll(constantPattern)) {
      const name = match[1] ?? ''
      if (name && !constantMap.has(name)) constantMap.set(name, file)
    }
  }
  // 常量名通过 domain/status.ts 的导出解析；未解析到的常量名不猜测，直接报错要求核对。
  const statusSource = fileText('packages/forgeloop/src/domain/status.ts')
  for (const [name, file] of constantMap) {
    const match = new RegExp(`export const ${name} = '([^']+)'`).exec(statusSource)
    if (!match?.[1]) {
      fail(
        'requirement-status',
        `源码 ${file} 的 setStatus 常量 ${name} 未在 domain/status.ts 导出`,
      )
    } else if (!known.has(match[1])) {
      fail('requirement-status', `源码 ${file} 写入了未登记的需求状态：${match[1]}（${name}）`)
    }
  }
  checkCount += 1
}

const registrySha256 = createHash('sha256')
  .update(readFileSync(registryAbsolute, 'utf8'), 'utf8')
  .digest('hex')

if (failures.length > 0) {
  console.error(`[reliability-registry] 校验失败 ${failures.length} 项（${registryPath}）：`)
  for (const failure of failures) console.error(`  - ${failure.where}: ${failure.message}`)
  process.exit(1)
}

console.log(
  `[reliability-registry] OK：门禁 ${gateIds.size}、模块 ${modules.length}、不变量 ${invariants.length}、` +
    `状态机 ${machines.length}、场景 ${scenarios.length}、稳定性测试 ${stabilityTests.length}、` +
    `受控变异文件 ${scope.length}、检查 ${checkCount} 项（sha256 ${registrySha256.slice(0, 16)}…）`,
)

function listFiles(dirs: readonly string[]): string[] {
  const result: string[] = []
  const walk = (dir: string): void => {
    const absolute = resolve(ROOT, dir)
    if (!existsSync(absolute)) return
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.ts')) result.push(child)
    }
  }
  for (const dir of dirs) walk(dir)
  return result
}
