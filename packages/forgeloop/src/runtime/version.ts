/**
 * 正在运行的本插件版本：取自加载模块旁的 package.json。
 * 部署核对用它比较“实际运行版本”，而不是候选清单里的版本号。
 */

import { readFileSync } from 'node:fs'

interface PackageJson {
  readonly version?: unknown
}

function readVersion(): string {
  try {
    const path = new URL('../../package.json', import.meta.url)
    const data = JSON.parse(readFileSync(path, 'utf8')) as PackageJson
    return typeof data.version === 'string' ? data.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export const PLUGIN_VERSION = readVersion()
