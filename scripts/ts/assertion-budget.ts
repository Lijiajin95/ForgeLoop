/**
 * 类型断言预算：`as` 是绕过类型检查的入口，按 ratchet 只减不增。
 * 目标是把边界之外的断言收敛到 schema 解析（见 docs/status.md §45–§46）。
 * 统计排除 `as const`（不改变类型安全性）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SOURCE = join(ROOT, 'packages/forgeloop/src')
const BASELINE = 159
const PATTERN = /\bas\s+(?!const\b)[A-Za-z_(]/g

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const absolute = join(dir, name)
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute]
  })
}

const rows = filesUnder(SOURCE)
  .filter((file) => file.endsWith('.ts'))
  .map((absolute) => {
    const text = readFileSync(absolute, 'utf8')
    return {
      path: relative(ROOT, absolute).split(sep).join('/'),
      count: (text.match(PATTERN) ?? []).length,
    }
  })
  .filter((row) => row.count > 0)
  .sort((left, right) => right.count - left.count)

const total = rows.reduce((sum, row) => sum + row.count, 0)
const top = rows.slice(0, 5).map((row) => `${row.path} ${row.count}`)
console.log(`[assertions] ${total} 处（baseline ${BASELINE}）；最多：${top.join('，')}`)
if (total > BASELINE) {
  console.error(`[assertions] 断言数超过 baseline：新增断言请改为 schema 解析或显式收窄`)
  process.exit(1)
}
if (total < BASELINE) {
  console.log(`[assertions] 低于 baseline，请把 BASELINE 更新为 ${total}`)
}
