/**
 * 类型断言预算：`as` 是绕过类型检查的入口，按 ratchet 只减不增。
 * 目标是把边界之外的断言收敛到 schema 解析（见 docs/status.md §45–§46）。
 * 统计排除 `as const`（不改变类型安全性）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import ts from 'typescript'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SOURCE = join(ROOT, 'packages/forgeloop/src')
const BASELINE = 19

/**
 * 接口边界白名单：宿主 API、SQLite、配置文件、npm/子进程输出、HTTP/工具入参。
 * 只有这些文件允许出现 `as`；业务代码必须为 0。
 */
const BOUNDARY_FILES = new Set([
  'packages/forgeloop/src/domain/json.ts',
  'packages/forgeloop/src/records/db.ts',
  'packages/forgeloop/src/records/repository.ts',
  'packages/forgeloop/src/records/ops-store.ts',
  'packages/forgeloop/src/records/issues.ts',
  'packages/forgeloop/src/config.ts',
  'packages/forgeloop/src/index.ts',
  'packages/forgeloop/src/tools.ts',
  'packages/forgeloop/src/cli/pack.ts',
  'packages/forgeloop/src/runtime/agent-runner.ts',
  'packages/forgeloop/src/runtime/formal-test.ts',
  'packages/forgeloop/src/runtime/board-route.ts',
  'packages/forgeloop/src/session/events.ts',
  'packages/forgeloop/src/session/index.ts',
  'packages/forgeloop/src/session/preset.ts',
])
function countAs(file: string): number {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) && node.type.getText(source) !== 'const') count += 1
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const absolute = join(dir, name)
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute]
  })
}

const rows = filesUnder(SOURCE)
  .filter((file) => file.endsWith('.ts'))
  .map((absolute) => {
    return {
      path: relative(ROOT, absolute).split(sep).join('/'),
      count: countAs(absolute),
    }
  })
  .filter((row) => row.count > 0)
  .sort((left, right) => right.count - left.count)

const total = rows.reduce((sum, row) => sum + row.count, 0)
const businessRows = rows.filter((row) => !BOUNDARY_FILES.has(row.path))
const business = businessRows.reduce((sum, row) => sum + row.count, 0)
const boundary = total - business
const top = rows.slice(0, 5).map((row) => `${row.path} ${row.count}`)
console.log(
  `[assertions] 业务 ${business} 处；边界 ${boundary} 处（白名单 ${BOUNDARY_FILES.size} 文件）；合计 ${total}（baseline ${BASELINE}）；最多：${top.join('，')}`,
)
if (business > 0) {
  console.error(
    `[assertions] 业务代码不允许 as：${businessRows.map((row) => `${row.path} ${row.count}`).join('，')}`,
  )
  process.exit(1)
}
if (total > BASELINE) {
  console.error(`[assertions] 断言数超过 baseline：新增断言请改为 schema 解析或显式收窄`)
  process.exit(1)
}
if (total < BASELINE) {
  console.log(`[assertions] 低于 baseline，请把 BASELINE 更新为 ${total}`)
}
