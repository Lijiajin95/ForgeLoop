import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256OfBytes } from '../domain/delivery.js'

export function readInstalledVersion(installedRoot: string): string {
  try {
    const installed = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof installed.version === 'string' ? installed.version : ''
  } catch {
    return ''
  }
}

export function verifyInstalledFiles(
  build: { readonly files: readonly string[]; readonly tarball: string },
  installedRoot: string,
): { ok: boolean; detail: string } {
  const issues: string[] = []
  for (const file of build.files) {
    const installedPath = join(installedRoot, file)
    if (!existsSync(installedPath)) {
      issues.push(`缺少 ${file}`)
      continue
    }
    let packed: Buffer | null = null
    // npm pack 的成员带 `package/` 前缀；测试或本地 tar 可能没有，两种都核对。
    for (const member of [`package/${file}`, file]) {
      try {
        packed = execFileSync('tar', ['-xzf', build.tarball, '-O', member], {
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        break
      } catch {
        packed = null
      }
    }
    if (!packed) {
      issues.push(`无法读取包内 ${file}`)
      continue
    }
    if (sha256OfBytes(packed) !== sha256OfBytes(readFileSync(installedPath))) {
      issues.push(`内容不一致 ${file}`)
    }
  }
  return issues.length === 0
    ? { ok: true, detail: `${build.files.length} 个文件与包内容一致` }
    : { ok: false, detail: issues.join('；') }
}
