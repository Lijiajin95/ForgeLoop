/**
 * 产品 Agent 的项目文档读写边界：只允许项目内 Markdown，路径不得越界或进入依赖目录。
 * 这是“禁止修改代码”的确定性实现：产品 Agent 没有其他写入工具。
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative as relativePath,
  resolve,
  sep,
} from 'node:path'

export const MAX_DOC_READ_BYTES = 64 * 1024
export const MAX_DOC_WRITE_BYTES = 128 * 1024

export type DocTargetResult =
  | { readonly ok: true; readonly path: string; readonly relative: string }
  | { readonly ok: false; readonly reason: string }

function blockedSegment(relative: string): boolean {
  return relative
    .split(/[\\/]/)
    .some((segment) => segment === '.git' || segment === 'node_modules' || segment === '')
}

function insideRoot(realRoot: string, target: string): boolean {
  const inside = relativePath(realRoot, target)
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
}

function markdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md')
}

/**
 * 把词法路径解析成真实路径，并确认真实目标仍在项目内、是 Markdown 普通文件。
 * 已存在的目标按 realpath 检查；不存在时只跟随已存在的祖先，剩余段不可能再是链接。
 */
function realTarget(root: string, target: string): DocTargetResult {
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return { ok: false, reason: '项目目录不存在或不可解析' }
  }
  if (existsSync(target)) {
    let realPath: string
    try {
      realPath = realpathSync(target)
    } catch {
      return { ok: false, reason: '文档路径不可解析' }
    }
    if (!insideRoot(realRoot, realPath)) return { ok: false, reason: '文档路径超出项目目录' }
    if (!markdown(realPath)) return { ok: false, reason: '只允许读写 Markdown 文档（.md）' }
    try {
      if (!statSync(realPath).isFile()) return { ok: false, reason: '只允许读写普通文件' }
    } catch {
      return { ok: false, reason: '文档不存在或不可读' }
    }
    return {
      ok: true,
      path: realPath,
      relative: relativePath(realRoot, realPath).split(sep).join('/'),
    }
  }
  const segments: string[] = []
  let ancestor = target
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return { ok: false, reason: '文档路径无法解析' }
    segments.unshift(basename(ancestor))
    ancestor = parent
  }
  let realAncestor: string
  try {
    realAncestor = realpathSync(ancestor)
  } catch {
    return { ok: false, reason: '文档路径不可解析' }
  }
  if (!insideRoot(realRoot, realAncestor)) return { ok: false, reason: '文档路径超出项目目录' }
  const realPath = join(realAncestor, ...segments)
  if (!markdown(realPath)) return { ok: false, reason: '只允许读写 Markdown 文档（.md）' }
  const relative = relativePath(realRoot, realPath).split(sep).join('/')
  if (!relative || relative.startsWith('..')) return { ok: false, reason: '文档路径超出项目目录' }
  return { ok: true, path: realPath, relative }
}

/** 解析并校验一个项目内 Markdown 路径；越界、绝对路径、非 Markdown、符号链接逃逸都拒绝。 */
export function resolveProjectDoc(projectPath: string, input: string): DocTargetResult {
  const candidate = input.trim()
  if (!candidate) return { ok: false, reason: '文档路径不能为空' }
  if (isAbsolute(candidate)) return { ok: false, reason: '文档路径必须是项目内相对路径' }
  if (!markdown(candidate)) {
    return { ok: false, reason: '只允许读写 Markdown 文档（.md）' }
  }
  const root = resolve(projectPath)
  const target = resolve(root, candidate)
  const inside = relativePath(root, target)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
    return { ok: false, reason: '文档路径超出项目目录' }
  }
  if (blockedSegment(inside)) {
    return { ok: false, reason: '文档路径不能位于 .git 或 node_modules 下' }
  }
  return realTarget(root, target)
}

/** 项目内 Markdown 文档是否真实存在（供需求依据核验使用）。 */
export function projectDocExists(projectPath: string, input: string): boolean {
  const target = resolveProjectDoc(projectPath, input)
  if (!target.ok) return false
  try {
    return statSync(target.path).isFile()
  } catch {
    return false
  }
}

export type DocReadResult =
  | {
      readonly ok: true
      readonly path: string
      readonly content: string
      readonly truncated: boolean
    }
  | { readonly ok: false; readonly reason: string }

export function readProjectDoc(projectPath: string, input: string): DocReadResult {
  const target = resolveProjectDoc(projectPath, input)
  if (!target.ok) return target
  try {
    const size = statSync(target.path).size
    const content = readFileSync(target.path, 'utf8')
    if (size <= MAX_DOC_READ_BYTES)
      return { ok: true, path: target.relative, content, truncated: false }
    const slice = content.slice(0, MAX_DOC_READ_BYTES)
    return {
      ok: true,
      path: target.relative,
      content: slice,
      truncated: true,
    }
  } catch {
    return { ok: false, reason: `文档不存在或不可读：${target.relative}` }
  }
}

export type DocWriteResult =
  | { readonly ok: true; readonly path: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: string }

export function writeProjectDoc(
  projectPath: string,
  input: string,
  content: string,
): DocWriteResult {
  const target = resolveProjectDoc(projectPath, input)
  if (!target.ok) return target
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_DOC_WRITE_BYTES) {
    return { ok: false, reason: `文档超过 ${MAX_DOC_WRITE_BYTES} 字节上限` }
  }
  try {
    mkdirSync(dirname(target.path), { recursive: true })
    writeFileSync(target.path, content, 'utf8')
    return { ok: true, path: target.relative, bytes }
  } catch {
    return { ok: false, reason: `文档写入失败：${target.relative}` }
  }
}
