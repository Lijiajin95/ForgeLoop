/**
 * 需求库文档扫描：把 docs/product/library 下的 Markdown 条目读成可注入的索引与摘要。
 * 只读取、不写文件；内容权威仍是项目文档，索引由 SQLite 保存。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  LIBRARY_DOC_DIR,
  LIBRARY_HEADER,
  LIBRARY_MAX_BODY_BYTES,
  LibraryError,
  parseLibraryEntry,
  validateLibrary,
  type LibraryDigest,
  type LibraryEntry,
} from '../domain/library.js'
import { readProjectDoc } from './project-docs.js'

export interface LoadedLibraryEntry {
  readonly entry: LibraryEntry
  readonly sha256: string
  readonly bytes: number
}

export interface LoadedLibrary {
  readonly entries: readonly LoadedLibraryEntry[]
  readonly digest: LibraryDigest
  /** 被跳过或需要提示的项目文档；分析记录会保留，便于发现配错的条目。 */
  readonly warnings: readonly string[]
}

/** 扫描并解析整个需求库；格式错误、引用缺失或超限时抛错（fail-closed）。 */
export function loadLibrary(projectPath: string): LoadedLibrary {
  const entries: LoadedLibraryEntry[] = []
  const warnings: string[] = []
  for (const path of markdownFiles(projectPath)) {
    const read = readProjectDoc(projectPath, path)
    if (!read.ok) throw new LibraryError(`需求库条目不可读：${path}（${read.reason}）`)
    if (read.truncated) throw new LibraryError(`需求库条目超过读取上限：${path}`)
    if (!read.content.replace(/^\uFEFF/, '').startsWith(LIBRARY_HEADER)) {
      warnings.push(`跳过非条目文档：${path}`)
      continue
    }
    const entry = parseLibraryEntry(read.content, path)
    const content = entry.ref ? refContent(projectPath, entry) : entry.body
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > LIBRARY_MAX_BODY_BYTES) {
      throw new LibraryError(`需求库条目内容超过 ${LIBRARY_MAX_BODY_BYTES} 字节：${path}`)
    }
    entries.push({
      entry,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      bytes,
    })
  }
  validateLibrary(entries.map((item) => item.entry))
  return {
    entries,
    digest: {
      entries: entries.map((item) => ({
        id: item.entry.id,
        status: item.entry.status,
        sha256: item.sha256,
        bytes: item.bytes,
        path: item.entry.path,
        ref: item.entry.ref,
      })),
    },
    warnings,
  }
}

function refContent(projectPath: string, entry: LibraryEntry): string {
  const read = readProjectDoc(projectPath, entry.ref)
  if (!read.ok) {
    throw new LibraryError(`引用条目 ${entry.path} 的文档不可读：${entry.ref}（${read.reason}）`)
  }
  if (read.truncated) {
    throw new LibraryError(`引用条目 ${entry.path} 的文档超过读取上限：${entry.ref}`)
  }
  return read.content
}

/** 库目录下全部 Markdown（递归、项目内相对路径、排序稳定）；目录不存在时为空。 */
export function markdownFiles(projectPath: string): string[] {
  const root = join(projectPath, LIBRARY_DOC_DIR)
  if (!existsSync(root)) return []
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name)
      if (item.isSymbolicLink()) continue
      if (item.isDirectory()) {
        walk(full)
        continue
      }
      if (!item.isFile() || !item.name.toLowerCase().endsWith('.md')) continue
      files.push(relative(projectPath, full).split(sep).join('/'))
    }
  }
  walk(root)
  return files.sort()
}
