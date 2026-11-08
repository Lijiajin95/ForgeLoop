/**
 * 证据归档：把记录库复制成一致快照。
 *
 * 直接用文件复制会漏掉 WAL 中已提交但尚未 checkpoint 的数据，也可能拿到半页状态。
 * 这里用 SQLite 的 `VACUUM INTO`：单条语句、读事务内完成，结果是可独立打开的一致数据库，
 * 不依赖 -wal/-shm 文件。先写临时文件再原子改名，中断不会留下“看起来成功”的半成品。
 */
import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export interface ArchiveResult {
  readonly target: string
  readonly bytes: number
}

/** 把 `source` 的记录库快照到 `target`；目标目录不存在时创建。 */
export function archiveDatabase(source: string, target: string): ArchiveResult {
  if (!existsSync(source)) throw new Error(`记录库不存在：${source}`)
  mkdirSync(dirname(target), { recursive: true })
  const staging = join(
    dirname(target),
    `.${Date.now()}-${Math.random().toString(16).slice(2)}.partial`,
  )
  const db = new DatabaseSync(source)
  try {
    db.exec(`VACUUM INTO '${staging.split("'").join("''")}'`)
  } finally {
    db.close()
  }
  try {
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { force: true })
    throw error
  }
  return { target, bytes: statSync(target).size }
}

function runCli(): void {
  const [source, target] = process.argv.slice(2)
  if (!source || !target) {
    console.error('用法：node scripts/ts/evidence-archive.ts <source.sqlite> <target.sqlite>')
    process.exit(1)
  }
  const result = archiveDatabase(source, target)
  process.stdout.write(`[evidence-archive] ${result.target}\n`)
}

if (process.argv[1]?.endsWith('evidence-archive.ts')) {
  try {
    runCli()
  } catch (error) {
    console.error(`[evidence-archive] ${(error as Error).message}`)
    process.exit(1)
  }
}
