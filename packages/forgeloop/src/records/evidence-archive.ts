/**
 * 证据归档：把记录库复制成一致快照。
 *
 * 直接用文件复制会漏掉 WAL 中已提交但尚未 checkpoint 的数据，也可能拿到半页状态。
 * 这里用 SQLite 的 `VACUUM INTO`：单条语句、读事务内完成，结果是可独立打开的一致数据库，
 * 不依赖 -wal/-shm 文件。先写临时文件再原子改名，中断不会留下“看起来成功”的半成品。
 *
 * 放在 records 层而不是脚本里：实现要随包发布，测试才能在沙箱里导入，不必引用仓库根脚本。
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { errorMessage } from '../domain/errors.js'

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

/** 一次运行现场归档的输入：源现场、目标目录、项目名与摘要。 */
export interface RunEvidenceArchiveInput {
  readonly sourceRoot: string
  readonly targetDir: string
  readonly project: string
  readonly summary: unknown
  /** 需要从源现场根目录复制的文件；缺省为摘要、宿主日志与配置快照。 */
  readonly files?: readonly string[]
  readonly now?: string
}

export interface RunEvidenceArchiveResult {
  readonly ok: boolean
  readonly dir: string
  readonly error: string
}

/**
 * 把一次运行的现场归档到持久目录：摘要/日志/配置、记录库一致快照、原始记录目录与
 * 可独立复核的索引。归档快照必须能单独打开，否则整次归档按失败处理。
 */
export function archiveRunEvidence(input: RunEvidenceArchiveInput): RunEvidenceArchiveResult {
  const files: string[] = []
  try {
    mkdirSync(input.targetDir, { recursive: true })
    for (const name of input.files ?? ['summary.json', 'host.log', 'config.json']) {
      const from = join(input.sourceRoot, name)
      if (!existsSync(from)) continue
      copyFileSync(from, join(input.targetDir, name))
      files.push(name)
    }
    const projectRecords = join(input.sourceRoot, 'records', 'projects', input.project)
    const database = join(projectRecords, 'records.sqlite')
    if (existsSync(database)) {
      archiveDatabase(database, join(input.targetDir, 'records.sqlite'))
      files.push('records.sqlite')
      // 独立可查自检：归档快照必须能单独打开，且不依赖源目录。
      const snapshot = new DatabaseSync(join(input.targetDir, 'records.sqlite'), { readOnly: true })
      try {
        snapshot.prepare('SELECT COUNT(*) AS n FROM requirements').get()
        snapshot.prepare('SELECT COUNT(*) AS n FROM ops_events').get()
      } finally {
        snapshot.close()
      }
    }
    // 运维诊断、验证材料等原始文件：只复制项目记录目录，跳过数据库与 WAL 附属文件。
    if (existsSync(projectRecords)) {
      cpSync(projectRecords, join(input.targetDir, 'records'), {
        recursive: true,
        filter: (source) => !/records\.sqlite(-shm|-wal)?$/.test(source),
      })
      files.push('records/')
    }
    writeFileSync(
      join(input.targetDir, 'index.md'),
      renderArchiveIndex({
        sourceRoot: input.sourceRoot,
        files,
        summary: input.summary,
        now: input.now ?? new Date().toISOString(),
      }),
    )
    files.push('index.md')
    return { ok: true, dir: input.targetDir, error: '' }
  } catch (error) {
    return { ok: false, dir: input.targetDir, error: errorMessage(error) }
  }
}

function renderArchiveIndex(input: {
  readonly sourceRoot: string
  readonly files: readonly string[]
  readonly summary: unknown
  readonly now: string
}): string {
  return [
    '# M1 运维闭环证据归档',
    '',
    `- 生成时间：${input.now}`,
    `- 源现场：${input.sourceRoot}（可能已被清理，本目录应可独立复核）`,
    `- 文件：${input.files.join('、')}`,
    '',
    '## 复核查询',
    '',
    '```sql',
    '-- 事件与关闭状态',
    'SELECT event_id, state, closed_at, fix_requirement_id FROM ops_events ORDER BY opened_at;',
    '-- 修复需求与提交',
    'SELECT req_id, status, source FROM requirements;',
    'SELECT req_id, commit_sha, candidate_sha256 FROM requirement_commits;',
    '-- 部署意图与决定',
    'SELECT intent_id, state, artifact_sha256 FROM deployment_intents;',
    'SELECT intent_id, decision, decided_by FROM deployment_decisions;',
    '```',
    '',
    '## 摘要',
    '',
    '```json',
    JSON.stringify(input.summary, null, 2),
    '```',
    '',
  ].join('\n')
}

/**
 * 验收判定：任何失败项（含“证据归档失败”）都让本轮未通过。
 * 归档失败单独追加一条，避免只改 summary 字段却仍被当成成功。
 */
export function acceptanceVerdict(input: {
  readonly failures: readonly string[]
  readonly archive: { readonly ok: boolean; readonly error: string }
}): { failures: string[]; accepted: boolean } {
  const failures = [...input.failures]
  if (!input.archive.ok) failures.push(`证据归档失败：${input.archive.error}`)
  return { failures, accepted: failures.length === 0 }
}
