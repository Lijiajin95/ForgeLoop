import { execFileSync } from 'node:child_process'
import { basename, dirname, relative, sep } from 'node:path'

/**
 * 打包/解包夹具在两种 tar 下都要能用。
 *
 * Git for Windows 自带的是 GNU tar，它把 `-f C:\...` 和 `-C C:\...` 里的盘符当成远程主机
 * （`tar: Cannot connect to C: resolve failed`）；只有当参数是相对路径时才按本地文件处理。
 * 因此归档与目录一律用“cwd + 相对路径”表达，不把 Windows 绝对路径交给 tar。
 */
function posixRelative(from: string, to: string): string {
  const value = relative(from, to)
  return (value === '' ? '.' : value).split(sep).join('/')
}

export function extractTarball(tarball: string, into: string): void {
  execFileSync('tar', ['-xzf', basename(tarball), '-C', posixRelative(dirname(tarball), into)], {
    cwd: dirname(tarball),
  })
}

export function createTarball(tarball: string, dir: string, entries: readonly string[]): void {
  execFileSync(
    'tar',
    ['-czf', basename(tarball), '-C', posixRelative(dirname(tarball), dir), ...entries],
    { cwd: dirname(tarball) },
  )
}
