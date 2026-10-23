#!/usr/bin/env node
/**
 * 本地候选打包：构建产物 → npm pack → 计算摘要与内容清单。
 * 输出 JSON 到 stdout，并写 `<packageDir>/dist/artifact.json`，供安装与回查。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Artifact {
  readonly name: string
  readonly version: string
  readonly tarball: string
  readonly sha256: string
  readonly bytes: number
  readonly files: readonly string[]
  readonly gitHead: string
  readonly gitStatus: string
  readonly builtAt: string
}

function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function listFiles(root: string, relative = ''): string[] {
  const entries = readdirSync(join(root, relative), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...listFiles(root, path))
    else files.push(path)
  }
  return files.sort()
}

function main(): number {
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const cache = resolve(packageDir, '../../.cache/npm-cache')
  mkdirSync(join(packageDir, 'dist'), { recursive: true })
  const output = execFileSync(
    'npm',
    ['pack', '--json', '--cache', cache, '--pack-destination', join(packageDir, 'dist')],
    { cwd: packageDir, encoding: 'utf8' },
  )
  const parsed = JSON.parse(output) as Array<{ filename: string; files: Array<{ path: string; size: number }> }>
  const packed = parsed[0]
  if (!packed) throw new Error('npm pack 没有返回产物信息')
  const tarball = join(packageDir, 'dist', packed.filename)
  const bytes = statSync(tarball).size
  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    name: string
    version: string
  }
  const artifact: Artifact = {
    name: packageJson.name,
    version: packageJson.version,
    tarball,
    sha256,
    bytes,
    files: listFiles(packageDir, 'lib'),
    gitHead: git(packageDir, ['rev-parse', 'HEAD']),
    gitStatus: git(packageDir, ['status', '--porcelain']),
    builtAt: new Date().toISOString(),
  }
  writeFileSync(join(packageDir, 'dist', 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  if (!existsSync(tarball)) throw new Error(`打包产物不存在：${tarball}`)
  console.log(JSON.stringify(artifact, null, 2))
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(`[forgeloop-pack] ${(error as Error).message}`)
  process.exitCode = 1
}