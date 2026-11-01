/**
 * Agent 上下文预算：按 1M 上下文推导的文件 token 上限。
 *
 * 行数是代理指标；中文注释约 1 token/字，不能跳过。这里用
 * “ASCII/3.6 + 非 ASCII/1” 估算，阈值 25,000 tokens/文件。
 * 存量超限文件列入 baseline（只能变小），新文件超限直接失败。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SOURCE = join(ROOT, 'packages/forgeloop/src')
const BASELINE = join(ROOT, 'scripts/token-budget-baseline.json')
const FILE_LIMIT = 25_000

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const absolute = join(dir, name)
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute]
  })
}

function tokensOf(text: string): number {
  let ascii = 0
  let other = 0
  for (const char of text) {
    if (char.codePointAt(0)! < 128) ascii += 1
    else other += 1
  }
  return Math.round(ascii / 3.6 + other)
}

const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE, 'utf8'))
const files = filesUnder(SOURCE).filter((file) => file.endsWith('.ts'))
const rows = files
  .map((absolute) => {
    const path = relative(ROOT, absolute).split(sep).join('/')
    return { path, tokens: tokensOf(readFileSync(absolute, 'utf8')) }
  })
  .sort((left, right) => right.tokens - left.tokens)

let failed = false
for (const row of rows) {
  const allowed = baseline[row.path] ?? FILE_LIMIT
  if (row.tokens > allowed) {
    failed = true
    console.error(
      `[token-budget] ${row.path}: ${row.tokens} tokens > ${allowed}（文件上限 ${FILE_LIMIT}）`,
    )
  }
}

const top = rows.slice(0, 5).map((row) => `${row.path} ${row.tokens}`)
console.log(`[token-budget] ${rows.length} 个文件；最大：${top.join('，')}`)
if (failed) process.exit(1)
console.log('[token-budget] OK：全部文件在 token 预算内')
