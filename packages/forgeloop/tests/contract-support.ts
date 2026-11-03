/**
 * 在普通运行与 Stryker 沙箱中都找到仓库根的可靠性清单。
 *
 * Stryker 会把 packages/forgeloop 下的文件复制进 .stryker-tmp/sandbox-*，
 * 从 import.meta.url 固定上跳三级在沙箱里会落到 packages/forgeloop。
 * 这里从当前文件向上逐级查找 contracts/reliability.json，找不到就明确失败。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function loadReliabilityContract<T>(): T {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'contracts', 'reliability.json')
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf8')) as T
    }
    dir = resolve(dir, '..')
  }
  throw new Error('找不到 contracts/reliability.json（普通运行或 Stryker 沙箱）')
}
