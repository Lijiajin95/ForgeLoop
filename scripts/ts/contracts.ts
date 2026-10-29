#!/usr/bin/env node
/**
 * 架构契约校验（TypeScript）。
 *
 * 契约只描述稳定规则：分层、允许的依赖方向、外部表面、退役路径。
 * 源码文件、工具名和 Web 端点从实现自动发现，避免“新增文件先登记”的重复维护。
 * 用法：node scripts/ts/contracts.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

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
  if (statSync(absolute).isFile()) return [path]
  const result: string[] = []
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${path}/${entry.name}`
    if (entry.isDirectory()) result.push(...filesUnder(child))
    else if (entry.name.endsWith('.ts')) result.push(child)
  }
  return result
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

interface Layer {
  readonly name: string
  readonly path: string
  readonly may_import: readonly string[]
}

function layerOf(file: string, layers: readonly Layer[]): Layer | undefined {
  const candidates = layers.filter((layer) => file === layer.path || file.startsWith(`${layer.path}/`))
  candidates.sort((left, right) => right.path.length - left.path.length)
  return candidates[0]
}

function localImport(fromFile: string, specifier: string): string | null {
  let target = resolve(dirname(join(ROOT, fromFile)), specifier)
  if (target.endsWith('.js')) target = `${target.slice(0, -3)}.ts`
  else if (!target.endsWith('.ts')) {
    if (existsSync(`${target}.ts`)) target = `${target}.ts`
    else if (existsSync(join(target, 'index.ts'))) target = join(target, 'index.ts')
  }
  const rel = relative(ROOT, target)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return existsSync(join(ROOT, rel)) ? rel : null
}

function importSpecifiers(source: string): string[] {
  const staticImports = [...source.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)].map((match) => match[1]!)
  const dynamicImports = [...source.matchAll(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((match) => match[1]!)
  const reExports = [...source.matchAll(/export\s+(?:\*|\{[^}]*\})\s+from\s+['"](\.[^'"]+)['"]/g)].map((match) => match[1]!)
  return [...new Set([...staticImports, ...dynamicImports, ...reExports])]
}

function checkLayers(contract: any): { sourceRoot: string; layers: Layer[]; sourceFiles: string[] } | null {
  const packagePath = contract?.runtime?.package
  if (typeof packagePath !== 'string' || !packagePath) {
    fail('runtime.package 缺失')
    return null
  }
  const sourceRoot = `${packagePath}/src`
  if (!existsSync(join(ROOT, sourceRoot))) {
    fail(`活动源码目录不存在：${sourceRoot}`)
    return null
  }
  if (!Array.isArray(contract.layers) || contract.layers.length === 0) {
    fail('layers 不能为空')
    return null
  }
  const layers: Layer[] = []
  const names = new Set<string>()
  const paths = new Set<string>()
  for (const raw of contract.layers as any[]) {
    if (typeof raw?.name !== 'string' || !raw.name.trim()) {
      fail('layers.name 必须是非空字符串')
      continue
    }
    if (typeof raw?.path !== 'string' || !raw.path.trim()) {
      fail(`分层 ${raw.name} 缺少 path`)
      continue
    }
    if (names.has(raw.name)) fail(`分层名称重复：${raw.name}`)
    if (paths.has(raw.path)) fail(`分层路径重复：${raw.path}`)
    names.add(raw.name)
    paths.add(raw.path)
    if (!Array.isArray(raw.may_import) || raw.may_import.some((item: unknown) => typeof item !== 'string')) {
      fail(`分层 ${raw.name} 的 may_import 必须是字符串数组`)
      continue
    }
    const absolute = join(ROOT, raw.path)
    if (!existsSync(absolute)) fail(`分层路径不存在：${raw.path}`)
    if (!inside(join(ROOT, sourceRoot), absolute)) fail(`分层路径必须位于 ${sourceRoot} 内：${raw.path}`)
    layers.push({ name: raw.name, path: raw.path, may_import: raw.may_import })
  }
  for (const layer of layers) {
    for (const dependency of layer.may_import) {
      if (!names.has(dependency)) fail(`分层 ${layer.name} 引用了不存在的依赖层 ${dependency}`)
    }
  }
  const sourceFiles = filesUnder(sourceRoot).sort()
  if (sourceFiles.length === 0) fail(`没有扫描到源码：${sourceRoot}`)
  return { sourceRoot, layers, sourceFiles }
}

function checkDependencies(contract: any, sourceRoot: string, layers: Layer[], sourceFiles: string[]): void {
  const graph = new Map<string, string[]>()
  const used = new Set<string>()
  for (const file of sourceFiles) {
    const layer = layerOf(file, layers)
    if (!layer) {
      fail(`无法判定分层：${file}`)
      continue
    }
    used.add(layer.name)
    const text = readFileSync(join(ROOT, file), 'utf8')
    const dependencies: string[] = []
    for (const specifier of importSpecifiers(text)) {
      const target = localImport(file, specifier)
      if (!target) {
        fail(`${file} 的相对导入无法解析：${specifier}`)
        continue
      }
      if (!inside(join(ROOT, sourceRoot), join(ROOT, target))) {
        fail(`${file} 导入了活动源码外模块：${specifier}`)
        continue
      }
      dependencies.push(target)
      if (target === file) continue
      const targetLayer = layerOf(target, layers)
      if (!targetLayer) {
        fail(`${file} 导入了契约外模块 ${target}`)
        continue
      }
      if (targetLayer.name !== layer.name && !layer.may_import.includes(targetLayer.name)) {
        fail(`${file}（${layer.name}）不得依赖 ${targetLayer.name}（${specifier}）`)
      }
    }
    graph.set(file, dependencies)
  }
  for (const layer of layers) {
    if (!used.has(layer.name)) fail(`分层 ${layer.name} 没有覆盖任何源码文件`)
  }
  detectCycles(graph)
}

function detectCycles(graph: Map<string, string[]>): void {
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const reported = new Set<string>()
  const visit = (file: string): void => {
    state.set(file, 1)
    stack.push(file)
    for (const dependency of graph.get(file) ?? []) {
      const status = state.get(dependency)
      if (status === 1) {
        const start = stack.indexOf(dependency)
        const cycle = [...stack.slice(start), dependency].join(' -> ')
        if (!reported.has(cycle)) {
          reported.add(cycle)
          fail(`循环依赖：${cycle}`)
        }
      } else if (status !== 2) {
        visit(dependency)
      }
    }
    stack.pop()
    state.set(file, 2)
  }
  for (const file of graph.keys()) {
    if (!state.has(file)) visit(file)
  }
}

function checkPersistence(contract: any): void {
  const persistence = contract?.persistence
  if (typeof persistence !== 'object' || persistence === null) {
    fail('persistence 缺失')
    return
  }
  for (const key of ['engine', 'driver', 'database'] as const) {
    if (typeof persistence[key] !== 'string' || !persistence[key]) fail(`persistence.${key} 必须是非空字符串`)
  }
  const dbSource = readFileSync(join(ROOT, 'packages/forgeloop/src/records/db.ts'), 'utf8')
  if (typeof persistence.driver === 'string' && !dbSource.includes(`'${persistence.driver}'`)) {
    fail(`db.ts 未使用 persistence.driver：${persistence.driver}`)
  }
  if (typeof persistence.database === 'string' && !persistence.database.includes('records.sqlite')) {
    fail('persistence.database 必须指向 records.sqlite')
  }
  const configSource = readFileSync(join(ROOT, 'packages/forgeloop/src/config.ts'), 'utf8')
  if (!configSource.includes('records.sqlite') || !configSource.includes('projects')) {
    fail('config.ts 未实现 recordsRoot/projects/records.sqlite 路径')
  }
}

function checkModelSurface(contract: any): void {
  const prefix = contract?.model_surface?.prefix
  if (typeof prefix !== 'string' || !prefix) {
    fail('model_surface.prefix 缺失')
    return
  }
  const source = readFileSync(join(ROOT, 'packages/forgeloop/src/tools.ts'), 'utf8')
  const names = [...source.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1]!)
  if (names.length === 0) fail('tools.ts 没有发现工具注册')
  if (new Set(names).size !== names.length) fail('tools.ts 存在重复工具名')
  for (const name of names) {
    if (!name.startsWith(prefix)) fail(`模型工具 ${name} 未使用命名前缀 ${prefix}`)
  }
  if (!source.includes('tools.register')) fail('tools.ts 未调用 tools.register')
  const mutation = /\.(approvePlan|accept|requestOperation|retryTask|replanTask|cancel|stop)\s*\(/.exec(source)
  if (mutation) fail(`模型工具不得调用决定入口：${mutation[1]}`)
}

function checkUiSurface(contract: any): void {
  const ui = contract?.ui_surface
  if (typeof ui !== 'object' || ui === null) {
    fail('ui_surface 缺失')
    return
  }
  for (const key of ['slot', 'view_id', 'data_path'] as const) {
    if (typeof ui[key] !== 'string' || !ui[key]) fail(`ui_surface.${key} 必须是非空字符串`)
  }
  if (!Number.isInteger(ui.order)) fail('ui_surface.order 必须是整数')

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
  const client = readFileSync(clientPath, 'utf8')
  const expected: Array<[string, string]> = [
    ['槽位', `name: '${ui.slot}'`],
    ['视图身份', `id: '${ui.view_id}'`],
    ['排序', `order: ${ui.order}`],
    ['客户端数据路径', `BOARD_PATH = '${ui.data_path}'`],
  ]
  for (const [label, needle] of expected) {
    if (!client.includes(needle)) fail(`client.js 与 ui_surface 不一致：缺少${label} ${needle}`)
  }
  for (const surface of ['conversation.view', 'conversation.chat.node', 'conversation.chat.turnTail']) {
    if (!client.includes(`'${surface}'`)) fail(`client.js 未注册会话表面 ${surface}`)
  }

  const files = (pkg.files as string[] | undefined) ?? []
  const clientFile = clientRel.replace(/^\.\//, '')
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
  const arrayMatch = /const BOARD_ENDPOINTS\s*=\s*\[([\s\S]*?)\]/.exec(entry)
  if (!arrayMatch) {
    fail('index.ts 未声明 BOARD_ENDPOINTS')
    return
  }
  const endpoints = [...arrayMatch[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
  if (endpoints.length === 0) fail('BOARD_ENDPOINTS 不能为空')
  if (new Set(endpoints).size !== endpoints.length) fail('BOARD_ENDPOINTS 存在重复项')
  if (!endpoints.includes('board')) fail('BOARD_ENDPOINTS 必须包含 board 默认端点')
  for (const endpoint of endpoints) {
    if (!/^[a-z][a-z0-9_-]*$/.test(endpoint)) fail(`BOARD_ENDPOINTS 端点名不合法：${endpoint}`)
  }
  const branches = [...entry.matchAll(/endpoint === '([^']+)'/g)].map((match) => match[1]!)
  for (const branch of branches) {
    if (!endpoints.includes(branch)) fail(`index.ts 处理了未声明的端点：${branch}`)
  }
  for (const endpoint of endpoints) {
    if (endpoint !== 'board' && !branches.includes(endpoint)) {
      fail(`BOARD_ENDPOINTS 声明了 ${endpoint}，但 index.ts 没有对应分支（board 为默认分支）`)
    }
  }
}

function checkSessionSurface(contract: any): void {
  const session = contract?.session_surface
  if (typeof session !== 'object' || session === null) {
    fail('session_surface 缺失')
    return
  }
  if (typeof session.preset_id !== 'string' || !session.preset_id) fail('session_surface.preset_id 缺失')
  if (typeof session.interception !== 'string' || !session.interception) fail('session_surface.interception 缺失')

  const intake = readFileSync(join(ROOT, 'packages/forgeloop/src/session/intake.ts'), 'utf8')
  const surface = readFileSync(join(ROOT, 'packages/forgeloop/src/session/index.ts'), 'utf8')
  const eventsSource = readFileSync(join(ROOT, 'packages/forgeloop/src/session/events.ts'), 'utf8')
  const client = readFileSync(join(ROOT, 'packages/forgeloop/client.js'), 'utf8')
  if (typeof session.preset_id === 'string' && !intake.includes(`FORGELOOP_PRESET_ID = '${session.preset_id}'`)) {
    fail(`session_surface.preset_id 与 intake.ts 不一致：${session.preset_id}`)
  }
  if (typeof session.interception === 'string' && !surface.includes(`'${session.interception}'`)) {
    fail(`session_surface.interception 与 session/index.ts 不一致：${session.interception}`)
  }
  if (!intake.includes(`role === 'user'`)) fail("intake.ts 必须只处理 role === 'user' 的人类输入")

  const events = [...new Set([...eventsSource.matchAll(/'(plugin:forgeloop\/[^']+)'/g)].map((match) => match[1]!))]
  if (events.length === 0) fail('session/events.ts 没有发现会话事件')
  for (const event of events) {
    if (!client.includes(`'${event}'`)) fail(`client.js 未注册会话事件 ${event}`)
  }
  const clientEvents = [...new Set([...client.matchAll(/'(plugin:forgeloop\/[^']+)'/g)].map((match) => match[1]!))]
  for (const event of clientEvents) {
    if (!events.includes(event)) fail(`client.js 注册了 events.ts 未声明的事件 ${event}`)
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

function checkArchitecture(): void {
  const contract = readJson('contracts/architecture.json')
  if (contract.schema_version !== 3) fail('architecture.json schema_version 必须是 3')
  const layout = checkLayers(contract)
  if (!layout) return
  checkDependencies(contract, layout.sourceRoot, layout.layers, layout.sourceFiles)
  checkPersistence(contract)
  checkModelSurface(contract)
  checkUiSurface(contract)
  checkSessionSurface(contract)

  if (!Array.isArray(contract.retired_paths) || contract.retired_paths.length === 0) {
    fail('retired_paths 不能为空')
  } else {
    for (const path of contract.retired_paths as string[]) {
      if (typeof path !== 'string' || !path) fail('retired_paths 只能包含非空字符串')
      else if (existsSync(join(ROOT, path))) fail(`已退役路径不得重新进入工作树：${path}`)
    }
  }
}

try {
  checkArchitecture()
  checkNoPython()
} catch (error) {
  fail(`契约校验异常：${(error as Error).message}`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[contracts] FAIL ${failure}`)
  process.exitCode = 1
} else {
  console.log('[contracts] OK：分层、依赖、循环、退役路径、工具、UI 与会话边界一致；活动代码未引用 Python')
}
