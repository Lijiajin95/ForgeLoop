/**
 * 正在运行的本插件版本：取自加载模块旁的 package.json。
 * 部署核对用它比较“实际运行版本”，而不是候选清单里的版本号。
 */

import { parseJsonObject } from '../domain/json.js'
import { readFileSync } from 'node:fs'

function readVersion(): string {
  try {
    const path = new URL('../../package.json', import.meta.url)
    const data = parseJsonObject(readFileSync(path, 'utf8'))
    return typeof data.version === 'string' ? data.version : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export const PLUGIN_VERSION = readVersion()
