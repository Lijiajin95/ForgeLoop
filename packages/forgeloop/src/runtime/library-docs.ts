import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  LIBRARY_DOC_DIR,
  LIBRARY_HEADER,
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
  readonly content: string
}

export interface LoadedLibrary {
  readonly entries: readonly LoadedLibraryEntry[]
  readonly digest: LibraryDigest
  readonly warnings: readonly string[]
}

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
    entries.push({
      entry,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      bytes,
      content,
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
