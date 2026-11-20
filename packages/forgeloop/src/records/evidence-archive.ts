/**
 * 直接用文件复制会漏掉 WAL 中已提交但尚未 checkpoint 的数据，也可能拿到半页状态。
 * 这里用 SQLite 的 `VACUUM INTO`：单条语句、读事务内完成，结果是可独立打开的一致数据库，
 * 不依赖 -wal/-shm 文件。先写临时文件再原子改名，中断不会留下“看起来成功”的半成品。
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

export interface RunEvidenceArchiveInput {
  readonly sourceRoot: string
  readonly targetDir: string
  readonly project: string
  readonly summary: unknown
  readonly requirementId?: string
  readonly files?: readonly string[]
  readonly now?: string
}

export interface RunEvidenceArchiveResult {
  readonly ok: boolean
  readonly dir: string
  readonly error: string
}

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
      const snapshot = new DatabaseSync(join(input.targetDir, 'records.sqlite'), { readOnly: true })
      try {
        snapshot.prepare('SELECT COUNT(*) AS n FROM requirements').get()
        snapshot.prepare('SELECT COUNT(*) AS n FROM ops_events').get()
        if (input.requirementId) {
          snapshot
            .prepare('SELECT COUNT(*) AS n FROM requirement_verifications WHERE req_id = ?')
            .get(input.requirementId)
          snapshot
            .prepare('SELECT COUNT(*) AS n FROM deployment_intents WHERE requirement_id = ?')
            .get(input.requirementId)
          snapshot
            .prepare('SELECT COUNT(*) AS n FROM ops_events WHERE fix_requirement_id = ?')
            .get(input.requirementId)
        }
      } finally {
        snapshot.close()
      }
    }
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

export function acceptanceVerdict(input: {
  readonly failures: readonly string[]
  readonly archive: { readonly ok: boolean; readonly error: string }
}): { failures: string[]; accepted: boolean } {
  const failures = [...input.failures]
  if (!input.archive.ok) failures.push(`证据归档失败：${input.archive.error}`)
  return { failures, accepted: failures.length === 0 }
}
