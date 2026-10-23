#!/usr/bin/env node
/**
 * 架构与 CLI 契约校验（TypeScript）：检查模块清单、依赖方向、持久化表、
 * 人类命令/模型工具与契约文件是否一致，并确认活动代码不再引用 Python。
 *
 * 用法：node scripts/ts/contracts.ts [--architecture|--cli]
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const failures: string[] = []

function fail(message: string): void {
  failures.push(message)
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
}

function filesUnder(path: string): string[] {
  const absolute = join(ROOT, path)
  if (!existsSync(absolute)) return []
  const stat = statSync(absolute)
  if (stat.isFile()) return [path]
  const result: string[] = []
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${path}/${entry.name}`
    if (entry.isDirectory()) result.push(...filesUnder(child))
    else if (entry.name.endsWith('.ts')) result.push(child)
  }
  return result
}

interface Layer {
  name: string
  path: string
  may_import: string[]
}

function layerOf(file: string, layers: Layer[]): Layer | undefined {
  const candidates = layers.filter((layer) => file === layer.path || file.startsWith(`${layer.path}/`))
  candidates.sort((a, b) => b.path.length - a.path.length)
  return candidates[0]
}

function checkArchitecture(): void {
  const contract = readJson('contracts/architecture.json')
  if (contract.schema_version !== 2) fail('architecture.json schema_version 必须是 2')
  const layers: Layer[] = contract.layers

  for (const module of contract.modules as string[]) {
    if (!existsSync(join(ROOT, module))) fail(`契约列出的模块不存在：${module}`)
  }
  const sourceFiles = filesUnder('packages/forgeloop/src')
  for (const file of sourceFiles) {
    if (!(contract.modules as string[]).includes(file)) fail(`活动源码未登记在契约 modules：${file}`)
  }

  for (const file of sourceFiles) {
    const layer = layerOf(file, layers)
    if (!layer) {
      fail(`无法判定分层：${file}`)
      continue
    }
    const text = readFileSync(join(ROOT, file), 'utf8')
    const imports = [...text.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)].map((match) => match[1]!)
    for (const specifier of imports) {
      const target = resolve(dirname(join(ROOT, file)), specifier)
      const relative = target.slice(ROOT.length + 1).replace(/\.js$/, '.ts')
      const targetLayer = layerOf(relative, layers)
      if (!targetLayer) {
        fail(`${file} 导入了契约外模块 ${specifier}`)
        continue
      }
      if (targetLayer.name === layer.name) continue
      if (!layer.may_import.includes(targetLayer.name)) {
        fail(`${file}（${layer.name}）不得依赖 ${targetLayer.name}（${specifier}）`)
      }
    }
  }

  const dbSource = readFileSync(join(ROOT, 'packages/forgeloop/src/records/db.ts'), 'utf8')
  const tables = [...dbSource.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((match) => match[1]!)
  const expected = [...(contract.persistence.tables as string[])].sort()
  const actual = [...new Set(tables)].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`持久化表漂移：契约 ${expected.join(',')}；实现 ${actual.join(',')}`)
  }

  const commandsSource = readFileSync(join(ROOT, 'packages/forgeloop/src/commands.ts'), 'utf8')
  const subcommands = [...commandsSource.matchAll(/case '([a-z-]+)':/g)].map((match) => match[1]!)
  const expectedSubs = contract.human_surface.subcommands as string[]
  for (const sub of expectedSubs) {
    if (!subcommands.includes(sub)) fail(`契约声明了子命令 ${sub}，commands.ts 未实现`)
  }
  for (const sub of new Set(subcommands)) {
    if (!expectedSubs.includes(sub)) fail(`commands.ts 实现了未登记的子命令 ${sub}`)
  }

  const toolsSource = readFileSync(join(ROOT, 'packages/forgeloop/src/tools.ts'), 'utf8')
  const tools = [...toolsSource.matchAll(/name: '(forgeloop_\w+)'/g)].map((match) => match[1]!)
  const expectedTools = contract.model_surface.tools as string[]
  if (JSON.stringify([...tools].sort()) !== JSON.stringify([...expectedTools].sort())) {
    fail(`模型工具漂移：契约 ${expectedTools.join(',')}；实现 ${tools.join(',')}`)
  }

  const architectureDoc = readFileSync(join(ROOT, 'docs/architecture.md'), 'utf8')
  for (const needle of ['packages/forgeloop', 'DSH', 'node:sqlite']) {
    if (!architectureDoc.includes(needle)) fail(`docs/architecture.md 未描述 ${needle}`)
  }

  checkUiSurface()

  if (existsSync(join(ROOT, 'src/forgeloop')) && !existsSync(join(ROOT, 'legacy'))) {
    fail('旧 Python 实现仍在 src/forgeloop 且没有 legacy/ 隔离快照')
  }
}

/**
 * Web 看板契约：客户端入口、槽位身份、通道与展示资源必须与 architecture.json 一致。
 * 声明了 dsh.client 但没有可加载的入口属于静默失效，这里直接判为漂移。
 */
function checkUiSurface(): void {
  const contract = readJson('contracts/architecture.json')
  const ui = contract.ui_surface
  if (typeof ui !== 'object' || ui === null) {
    fail('architecture.json 未声明 ui_surface')
    return
  }
  const pkg = readJson('packages/forgeloop/package.json')
  if (pkg.dsh?.client?.platform !== 'web') fail('package.json 的 dsh.client.platform 必须是 web')
  const clientRel = pkg.exports?.['./client']
  if (typeof clientRel !== 'string') {
    fail('package.json 未导出 ./client')
    return
  }
  const clientPath = join(ROOT, 'packages/forgeloop', clientRel)
  if (!existsSync(clientPath)) {
    fail(`客户端入口不存在：${clientRel}`)
    return
  }
  const clientFile = clientRel.replace(/^\.\//, '')
  const client = readFileSync(clientPath, 'utf8')
  const expected: Array<[string, string]> = [
    ['槽位', `name: '${ui.slot}'`],
    ['视图身份', `id: '${ui.view_id}'`],
    ['排序', `order: ${ui.order}`],
    ['数据路径', `BOARD_PATH = '${ui.data_path}'`],
    ['工作流槽位', `name: '${ui.composer_slot}'`],
    ['工作流控件', `id: '${ui.composer_id}'`],
  ]
  for (const [label, needle] of expected) {
    if (!client.includes(needle)) fail(`client.js 与 ui_surface 不一致：缺少${label} ${needle}`)
  }
  const files = (pkg.files as string[] | undefined) ?? []
  for (const required of [clientFile, 'icon.svg', 'locale/*.json']) {
    if (!files.includes(required)) fail(`package.json files 未包含 ${required}`)
  }
  const iconPath = join(ROOT, 'packages/forgeloop/icon.svg')
  if (!existsSync(iconPath)) fail('缺少插件图标 icon.svg')
  else if (!readFileSync(iconPath, 'utf8').trimStart().startsWith('<svg')) fail('icon.svg 不是 SVG 文档')
  for (const locale of ['zh', 'en']) {
    const localePath = join(ROOT, 'packages/forgeloop', `locale/${locale}.json`)
    if (!existsSync(localePath)) {
      fail(`缺少 locale/${locale}.json`)
      continue
    }
    try {
      const parsed = JSON.parse(readFileSync(localePath, 'utf8'))
      if (typeof parsed?.meta?.title !== 'string' || typeof parsed?.meta?.description !== 'string') {
        fail(`locale/${locale}.json 缺少 meta.title/description`)
      }
    } catch (error) {
      fail(`locale/${locale}.json 不是合法 JSON：${(error as Error).message}`)
    }
  }
  const entry = readFileSync(join(ROOT, 'packages/forgeloop/src/index.ts'), 'utf8')
  if (!entry.includes(`BOARD_HTTP_PATH = '${ui.data_path}'`)) {
    fail('index.ts 的看板路径与 ui_surface.data_path 不一致')
  }
  if (!entry.includes('BOARD_ENDPOINTS')) {
    fail('index.ts 未声明 BOARD_ENDPOINTS')
  }
  for (const endpoint of ui.data_endpoints as string[]) {
    if (!entry.includes(`'${endpoint}'`)) {
      fail(`index.ts 未实现 ui_surface 端点 ${endpoint}`)
    }
  }
}

function checkCli(): void {
  const contract = readJson('contracts/cli-contract.json')
  if (contract.schema_version !== 2) fail('cli-contract.json schema_version 必须是 2')
  const architecture = readJson('contracts/architecture.json')
  const declared = (contract.command.subcommands as Array<{ name: string }>).map((item) => item.name)
  const architectureSubs = architecture.human_surface.subcommands as string[]
  if (JSON.stringify([...declared].sort()) !== JSON.stringify([...architectureSubs].sort())) {
    fail('cli-contract 与 architecture-contract 的子命令清单不一致')
  }
  const tools = (contract.tools as Array<{ name: string }>).map((item) => item.name)
  if (JSON.stringify([...tools].sort()) !== JSON.stringify([...(architecture.model_surface.tools as string[])].sort())) {
    fail('cli-contract 与 architecture-contract 的工具清单不一致')
  }
  for (const name of contract.decision_trust ? Object.keys(contract.decision_trust) : []) {
    if (name === 'note') continue
    if (!declared.includes(name)) fail(`决定信任表引用了未声明的子命令 ${name}`)
    if (tools.includes(`forgeloop_${name}`)) fail(`决定 ${name} 不得作为模型工具暴露`)
  }
}

function checkNoPython(): void {
  const files = [
    ...filesUnder('packages/forgeloop/src'),
    ...filesUnder('scripts/ts'),
    'package.json',
    'Makefile',
  ].filter((file) => existsSync(join(ROOT, file)))
  const pattern = /['"`]python[0-9.]*['"`]|\bpython3?\s+-m\b|\buv\s+run\b|\.venv\/bin\/python|forgeloop\.cli/i
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    if (pattern.test(text)) fail(`活动文件仍引用 Python/旧虚拟环境：${file}`)
  }
}

function generatedSubcommands(): string[] {
  const source = readFileSync(join(ROOT, 'packages/forgeloop/src/commands.ts'), 'utf8')
  return [...new Set([...source.matchAll(/case '([a-z-]+)':/g)].map((match) => match[1]!))]
}

function generatedTools(): string[] {
  const source = readFileSync(join(ROOT, 'packages/forgeloop/src/tools.ts'), 'utf8')
  return [...new Set([...source.matchAll(/name: '(forgeloop_\w+)'/g)].map((match) => match[1]!))]
}

function generatedTables(): string[] {
  const source = readFileSync(join(ROOT, 'packages/forgeloop/src/records/db.ts'), 'utf8')
  return [...new Set([...source.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((match) => match[1]!))].sort()
}

function updateArchitecture(): void {
  const path = join(ROOT, 'contracts/architecture.json')
  const contract = JSON.parse(readFileSync(path, 'utf8'))
  contract.modules = filesUnder('packages/forgeloop/src').sort()
  contract.persistence.tables = generatedTables()
  contract.human_surface.subcommands = generatedSubcommands()
  contract.model_surface.tools = generatedTools()
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
  console.log('[contracts] 已从实现更新 architecture.json')
}

function updateCli(): void {
  const path = join(ROOT, 'contracts/cli-contract.json')
  const contract = JSON.parse(readFileSync(path, 'utf8'))
  const existing = new Map(
    (contract.command.subcommands as Array<{ name: string; effect: string; arguments: string[] }>).map(
      (item) => [item.name, item],
    ),
  )
  contract.command.subcommands = generatedSubcommands().map(
    (name) => existing.get(name) ?? { name, effect: 'read', arguments: [] },
  )
  contract.tools = generatedTools().map((name) => ({
    name,
    effect: name === 'forgeloop_submit_requirement' ? 'write-intake' : 'read',
    trust: 'model',
  }))
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
  console.log('[contracts] 已从实现更新 cli-contract.json')
}

const args = new Set(process.argv.slice(2))
try {
  if (args.has('--update-architecture')) {
    updateArchitecture()
    process.exit(0)
  }
  if (args.has('--update-cli')) {
    updateCli()
    process.exit(0)
  }
} catch (error) {
  console.error(`[contracts] 生成失败：${(error as Error).message}`)
  process.exit(1)
}
if (args.has('--update-architecture') || args.has('--update-cli')) {
  process.exit(0)
}
try {
  if (!args.has('--cli')) checkArchitecture()
  if (!args.has('--architecture')) checkCli()
  checkNoPython()
} catch (error) {
  fail(`契约校验异常：${(error as Error).message}`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[contracts] FAIL ${failure}`)
  process.exitCode = 1
} else {
  console.log('[contracts] OK：模块、依赖方向、表、命令/工具与文档一致；活动代码未引用 Python')
}
