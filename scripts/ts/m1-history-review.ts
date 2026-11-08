#!/usr/bin/env node
/**
 * M1-7 历史回查：扫 docs 中引用的现场路径，逐条核对是否仍可取得。
 * 只做事实核对：存在/缺失，不补造历史材料。
 *
 * 用法：node scripts/ts/m1-history-review.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

interface Reference {
  readonly path: string
  readonly sources: string[]
  readonly state: 'present' | 'missing'
}

function docs(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md')) out.push(full)
    }
  }
  walk(join(ROOT, 'docs'))
  return out.sort()
}

const PATTERN = /(?:^|[\s(（"'`])((?:\/tmp\/|\/home\/)[\w./-]+|reports\/m1\/[\w./-]+)/g

function main(): void {
  const found = new Map<string, Set<string>>()
  for (const file of docs()) {
    for (const match of readFileSync(file, 'utf8').matchAll(PATTERN)) {
      const path = (match[1] ?? '').replace(/[.,;:）)]$/, '')
      if (path === '') continue
      const sources = found.get(path) ?? new Set<string>()
      sources.add(file.replace(`${ROOT}/`, ''))
      found.set(path, sources)
    }
  }
  const references: Reference[] = [...found.entries()]
    .map(([path, sources]) => {
      const target = path.startsWith('/') ? path : join(ROOT, path)
      return {
        path,
        sources: [...sources].sort(),
        state: existsSync(target) ? ('present' as const) : ('missing' as const),
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(ROOT, 'reports', 'm1', `history-${stamp}`)
  mkdirSync(dir, { recursive: true })
  const missing = references.filter((item) => item.state === 'missing')
  writeFileSync(
    join(dir, 'review.md'),
    [
      '# M1-7 历史回查（现场路径核对）',
      '',
      `- 时间：${new Date().toISOString()}`,
      `- 文档引用路径：${references.length} 条；可取得 ${references.length - missing.length}；缺失 ${missing.length}`,
      '',
      '## 缺失引用（不能作为已验证证据）',
      '',
      ...(missing.length === 0
        ? ['无']
        : missing.map((item) => `- \`${item.path}\`（引自 ${item.sources.join('、')}）`)),
      '',
      '## 可取得引用',
      '',
      ...references
        .filter((item) => item.state === 'present')
        .map((item) => `- \`${item.path}\`（引自 ${item.sources.join('、')}）`),
      '',
    ].join('\n'),
  )
  writeFileSync(join(dir, 'references.json'), `${JSON.stringify(references, null, 2)}\n`)
  process.stdout.write(`历史回查已写入 ${dir}\n引用 ${references.length}，缺失 ${missing.length}\n`)
}

main()
