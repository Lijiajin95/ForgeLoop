/**
 * 需求库重建的多源取证：项目文档、验收用例、Git 记录与源码。
 *
 * - 只读当前项目；跳过符号链接、依赖目录与凭证；所有路径限定在 projectPath 内。
 * - 输出有界材料：来源、原始位置、证据时间与内容摘要，供模型提炼候选。
 * - 材料只是证据，不是结论；候选的校验与发布决策在 domain/library-rebuild.ts。
 * 产品范围见 docs/product/library-rebuild.md。
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import type { RebuildSourceKind } from '../domain/library-rebuild.js'
import { git } from './workspace.js'

/** 一条取证材料：来源类型、位置、时间与有界内容。 */
export interface RebuildMaterial {
  readonly kind: RebuildSourceKind
  /** 项目内相对路径；git 材料是提交 sha。 */
  readonly ref: string
  /** 章节标题、行号、提交路径等原始位置。 */
  readonly locator: string
  /** 证据时间（YYYY-MM-DD 或 ISO）；无法确定时为空串。 */
  readonly time: string
  /** 内容的 sha256，用于回查与人工改动核对。 */
  readonly digest: string
  /** 交给模型的有界内容；已过滤凭据。 */
  readonly text: string
}

export interface RebuildMaterials {
  readonly materials: readonly RebuildMaterial[]
  readonly counts: Readonly<Record<RebuildSourceKind, number>>
  /** 跳过或降级的原因，进入运行报告。 */
  readonly skipped: readonly string[]
}

export interface CollectOptions {
  readonly docFiles?: number
  readonly docBytes?: number
  readonly acceptanceFiles?: number
  readonly acceptanceTitles?: number
  readonly commits?: number
  readonly sourceFiles?: number
  readonly sourceBytes?: number
}

export const REBUILD_EXTRACT_LIMITS = {
  docFiles: 40,
  docBytes: 8_000,
  acceptanceFiles: 30,
  acceptanceTitles: 120,
  commits: 200,
  sourceFiles: 40,
  sourceBytes: 8_000,
  /** 单个文件最大读取量，避免把构建产物或日志读进内存。 */
  maxFileBytes: 1024 * 1024,
} as const

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.forgeloop',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  'out',
  'target',
  'vendor',
])

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.rs',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.scala',
])

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i
const TEST_DIR = /^(tests?|__tests__)$/i
const TEST_TITLE = /^\s*(?:it|test)(?:\.\w+)?\(\s*(['"`])(.{1,200}?)\1/

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /((?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*)['"]?[A-Za-z0-9_.-]{8,}['"]?/gi,
    '$1****',
  ],
  [/sk-[A-Za-z0-9]{10,}/g, '[已过滤凭据]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已过滤私钥]'],
  [/Bearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer ****'],
]

/** 去掉常见凭据形态；材料与报告都必须先过这一层。 */
export function redactSecrets(text: string): string {
  let result = text
  for (const [pattern, replacement] of SECRET_PATTERNS)
    result = result.replace(pattern, replacement)
  return result
}

/** 项目内相对路径，统一 POSIX 分隔符。 */
export function projectRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function digestOf(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)}`
}

function readText(path: string): string | undefined {
  try {
    if (statSync(path).size > REBUILD_EXTRACT_LIMITS.maxFileBytes) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

interface WalkOptions {
  readonly root: string
  readonly match: (relativePath: string, name: string) => boolean
  readonly limit: number
}

/** 有界遍历：跳过符号链接、依赖目录与忽略目录；超过上限即停止。 */
function walkFiles(options: WalkOptions): { files: string[]; exceeded: boolean } {
  const files: string[] = []
  let exceeded = false
  const visit = (dir: string): void => {
    if (exceeded) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        visit(full)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = projectRelative(options.root, full)
      if (!options.match(relativePath, entry.name)) continue
      if (files.length >= options.limit) {
        exceeded = true
        return
      }
      files.push(relativePath)
    }
  }
  visit(options.root)
  return { files, exceeded }
}

function isGitRepository(projectPath: string): boolean {
  const result = git(projectPath, ['rev-parse', '--is-inside-work-tree'])
  return result.code === 0 && result.stdout.trim() === 'true'
}

/** 路径 → 最近一次提交日期；用于给文档、用例与源码补证据时间。 */
function gitPathTimes(projectPath: string, limit: number): Map<string, string> {
  const times = new Map<string, string>()
  if (!isGitRepository(projectPath)) return times
  const result = git(projectPath, [
    'log',
    '--no-merges',
    '-n',
    String(limit),
    '--format=%x01%cs',
    '--name-only',
  ])
  if (result.code !== 0) return times
  for (const chunk of result.stdout.split('\x01').slice(1)) {
    const lines = chunk.split(/\r?\n/).map((line) => line.trim())
    const time = lines[0] ?? ''
    if (!time) continue
    for (const path of lines.slice(1)) {
      if (path && !times.has(path)) times.set(path, time)
    }
  }
  return times
}

function collectDocuments(input: {
  projectPath: string
  times: Map<string, string>
  limit: number
  bytes: number
  skipped: string[]
}): RebuildMaterial[] {
  const { files, exceeded } = walkFiles({
    root: input.projectPath,
    limit: input.limit,
    match: (relativePath, name) =>
      name.toLowerCase().endsWith('.md') &&
      !relativePath.startsWith('docs/product/library/') &&
      !relativePath.split('/').some((segment) => IGNORED_DIRS.has(segment)),
  })
  if (exceeded) input.skipped.push(`项目文档超过 ${input.limit} 个，只取前 ${input.limit} 个`)
  const materials: RebuildMaterial[] = []
  for (const relativePath of files) {
    const text = readText(join(input.projectPath, relativePath))
    if (text === undefined) {
      input.skipped.push(`跳过无法读取或过大的文档：${relativePath}`)
      continue
    }
    const heading = text.split(/\r?\n/).find((line) => line.startsWith('#'))
    materials.push({
      kind: 'doc',
      ref: relativePath,
      locator: heading
        ? heading
            .replace(/^#+\s*/, '')
            .trim()
            .slice(0, 120)
        : '全文',
      time: input.times.get(relativePath) ?? '',
      digest: digestOf(text),
      text: redactSecrets(text.slice(0, input.bytes)),
    })
  }
  return materials
}

function collectAcceptance(input: {
  projectPath: string
  times: Map<string, string>
  limitFiles: number
  limitTitles: number
  skipped: string[]
}): RebuildMaterial[] {
  const { files, exceeded } = walkFiles({
    root: input.projectPath,
    limit: input.limitFiles,
    match: (relativePath, name) =>
      TEST_FILE.test(name) || relativePath.split('/').some((segment) => TEST_DIR.test(segment)),
  })
  if (exceeded)
    input.skipped.push(`验收用例文件超过 ${input.limitFiles} 个，只取前 ${input.limitFiles} 个`)
  const materials: RebuildMaterial[] = []
  for (const relativePath of files) {
    const text = readText(join(input.projectPath, relativePath))
    if (text === undefined) {
      input.skipped.push(`跳过无法读取或过大的用例文件：${relativePath}`)
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const match = TEST_TITLE.exec(lines[index] ?? '')
      if (!match) continue
      if (materials.length >= input.limitTitles) {
        input.skipped.push(`验收用例超过 ${input.limitTitles} 条，只取前 ${input.limitTitles} 条`)
        return materials
      }
      const title = redactSecrets((match[2] ?? '').trim())
      materials.push({
        kind: 'acceptance',
        ref: relativePath,
        locator: `L${index + 1}`,
        time: input.times.get(relativePath) ?? '',
        digest: digestOf(title),
        text: title,
      })
    }
  }
  return materials
}

interface GitChunk {
  readonly sha: string
  readonly time: string
  readonly text: string
  readonly paths: readonly string[]
}

/** 解析一条 Git 材料：sha、日期、标题+正文、涉及路径。 */
function parseGitChunk(chunk: string): GitChunk | undefined {
  const fields = chunk.split('\x02')
  if (fields.length < 4) return undefined
  const sha = (fields[0] ?? '').trim()
  if (!sha) return undefined
  const time = (fields[1] ?? '').trim()
  const subject = (fields[2] ?? '').trim()
  // 格式串固定以 %x03 结尾（body 之后），所以按它切分即可：前半是正文、后半是文件名。
  // 没有标记时 split 只给一段，paths 自然为空，不需要额外分支。
  const [bodyPart = '', pathsPart = ''] = (fields[3] ?? '').split('\x03')
  const body = bodyPart.trim()
  const paths = pathsPart
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean)
  return { sha, time, text: `${subject}${body ? `\n\n${body}` : ''}`, paths }
}

function collectGit(input: {
  projectPath: string
  limit: number
  bytes: number
  skipped: string[]
}): RebuildMaterial[] {
  if (!isGitRepository(input.projectPath)) {
    input.skipped.push('项目不是 Git 仓库，跳过 Git 证据')
    return []
  }
  const result = git(input.projectPath, [
    'log',
    '--no-merges',
    '-n',
    String(input.limit),
    '--format=%x01%H%x02%cs%x02%s%x02%b%x03',
    '--name-only',
  ])
  if (result.code !== 0) {
    input.skipped.push(`Git 记录读取失败：${result.stderr.trim() || result.stdout.trim()}`)
    return []
  }
  const materials: RebuildMaterial[] = []
  for (const chunk of result.stdout.split('\x01').slice(1)) {
    const parsed = parseGitChunk(chunk)
    if (!parsed) continue
    materials.push({
      kind: 'git',
      ref: parsed.sha,
      locator: parsed.paths.slice(0, 5).join(', ').slice(0, 300) || '（无文件变更）',
      time: parsed.time,
      digest: digestOf(`${parsed.sha}\n${parsed.text}`),
      text: redactSecrets(parsed.text).slice(0, input.bytes),
    })
    if (materials.length >= input.limit) {
      input.skipped.push(`Git 提交超过 ${input.limit} 条，只取前 ${input.limit} 条`)
      break
    }
  }
  return materials
}

function collectSource(input: {
  projectPath: string
  times: Map<string, string>
  limit: number
  bytes: number
  skipped: string[]
}): RebuildMaterial[] {
  const { files, exceeded } = walkFiles({
    root: input.projectPath,
    limit: input.limit,
    match: (relativePath, name) =>
      SOURCE_EXTENSIONS.has(extname(name).toLowerCase()) &&
      !TEST_FILE.test(name) &&
      !relativePath.split('/').some((segment) => TEST_DIR.test(segment)) &&
      !relativePath.startsWith('docs/'),
  })
  if (exceeded) input.skipped.push(`源码文件超过 ${input.limit} 个，只取前 ${input.limit} 个`)
  const materials: RebuildMaterial[] = []
  for (const relativePath of files) {
    const text = readText(join(input.projectPath, relativePath))
    if (text === undefined) {
      input.skipped.push(`跳过无法读取或过大的源码：${relativePath}`)
      continue
    }
    const lines = text.split(/\r?\n/).length
    materials.push({
      kind: 'source',
      ref: relativePath,
      locator: `L1-L${lines}`,
      time: input.times.get(relativePath) ?? '',
      digest: digestOf(text),
      text: redactSecrets(text.slice(0, input.bytes)),
    })
  }
  return materials
}

const KIND_ORDER: Record<RebuildSourceKind, number> = {
  doc: 0,
  acceptance: 1,
  git: 2,
  source: 3,
  library: 4,
}

/** 材料排序：有时间的从新到旧、无时间的排最后；同一时间按来源、位置稳定排序。 */
export function orderMaterials(materials: readonly RebuildMaterial[]): RebuildMaterial[] {
  return [...materials].sort((left, right) => {
    if (left.time && right.time && left.time !== right.time) {
      return right.time.localeCompare(left.time)
    }
    if (left.time && !right.time) return -1
    if (!left.time && right.time) return 1
    return (
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      left.ref.localeCompare(right.ref) ||
      left.locator.localeCompare(right.locator)
    )
  })
}

const EMPTY_COUNTS: Record<RebuildSourceKind, number> = {
  doc: 0,
  acceptance: 0,
  git: 0,
  source: 0,
  library: 0,
}

/**
 * 收集一个项目的全部可用材料。
 *
 * 源码是兜底来源：文档与验收用例合计不足 3 条时才读取，避免有资料的项目无谓放大输入。
 */
export function collectRebuildMaterials(
  projectPath: string,
  options: CollectOptions = {},
): RebuildMaterials {
  const limits = {
    docFiles: options.docFiles ?? REBUILD_EXTRACT_LIMITS.docFiles,
    docBytes: options.docBytes ?? REBUILD_EXTRACT_LIMITS.docBytes,
    acceptanceFiles: options.acceptanceFiles ?? REBUILD_EXTRACT_LIMITS.acceptanceFiles,
    acceptanceTitles: options.acceptanceTitles ?? REBUILD_EXTRACT_LIMITS.acceptanceTitles,
    commits: options.commits ?? REBUILD_EXTRACT_LIMITS.commits,
    sourceFiles: options.sourceFiles ?? REBUILD_EXTRACT_LIMITS.sourceFiles,
    sourceBytes: options.sourceBytes ?? REBUILD_EXTRACT_LIMITS.sourceBytes,
  }
  const skipped: string[] = []
  const times = gitPathTimes(projectPath, limits.commits)
  const documents = collectDocuments({
    projectPath,
    times,
    limit: limits.docFiles,
    bytes: limits.docBytes,
    skipped,
  })
  const acceptance = collectAcceptance({
    projectPath,
    times,
    limitFiles: limits.acceptanceFiles,
    limitTitles: limits.acceptanceTitles,
    skipped,
  })
  const commits = collectGit({
    projectPath,
    limit: limits.commits,
    bytes: limits.docBytes,
    skipped,
  })
  const materials = [...documents, ...acceptance, ...commits]
  if (documents.length + acceptance.length < 3) {
    const source = collectSource({
      projectPath,
      times,
      limit: limits.sourceFiles,
      bytes: limits.sourceBytes,
      skipped,
    })
    materials.push(...source)
  } else {
    skipped.push('项目文档与验收用例已足够，跳过源码取证')
  }
  const counts = { ...EMPTY_COUNTS }
  for (const material of materials) counts[material.kind] += 1
  return { materials: orderMaterials(materials), counts, skipped }
}
