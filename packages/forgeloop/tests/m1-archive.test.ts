import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { acceptanceVerdict, archiveRunEvidence } from '../src/records/evidence-archive.js'

/**
 * 运行现场归档：持久目录里的记录库必须是可独立打开的一致快照，
 * 且“归档失败”必须让本轮验收判定为未通过（不能只改 summary 字段）。
 */

let dir = ''
let sourceRoot = ''
let targetDir = ''

function seedRun(): void {
  sourceRoot = join(dir, 'run')
  targetDir = join(dir, 'archive')
  mkdirSync(join(sourceRoot, 'records', 'projects', 'demo', 'evidence'), { recursive: true })
  writeFileSync(join(sourceRoot, 'summary.json'), '{"ok":true}\n', 'utf8')
  writeFileSync(join(sourceRoot, 'config.json'), '{"project":"demo"}\n', 'utf8')
  const database = Database.open(join(sourceRoot, 'records', 'projects', 'demo', 'records.sqlite'))
  const repository = new Repository(database)
  try {
    repository.submit({
      reqId: 'req-archived',
      project: 'demo',
      text: '归档样本',
      submittedBy: 'owner',
      source: 'test',
      now: '2026-11-09T00:00:00.000Z',
    })
    repository.createOpsEvent({
      eventId: 'ops-archived',
      project: 'demo',
      resourceId: 'web',
      checkId: 'health',
      signature: 'sig',
      severity: 'major',
      state: 'closed',
      title: '已关闭事件',
      openedAt: '2026-11-09T00:00:00.000Z',
      updatedAt: '2026-11-09T00:00:00.000Z',
    })
  } finally {
    repository.close()
  }
  writeFileSync(
    join(sourceRoot, 'records', 'projects', 'demo', 'evidence', 'report.txt'),
    'evidence\n',
    'utf8',
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-m1-archive-'))
  seedRun()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('run evidence archive', () => {
  it('copies the run files, snapshots the database and writes a reviewable index', () => {
    const result = archiveRunEvidence({
      sourceRoot,
      targetDir,
      project: 'demo',
      summary: { ok: true, failures: [] },
      now: '2026-11-09T01:00:00.000Z',
    })
    expect(result).toEqual({ ok: true, dir: targetDir, error: '' })
    expect(existsSync(join(targetDir, 'summary.json'))).toBe(true)
    expect(existsSync(join(targetDir, 'config.json'))).toBe(true)
    expect(existsSync(join(targetDir, 'records', 'evidence', 'report.txt'))).toBe(true)
    expect(existsSync(join(targetDir, 'records', 'projects', 'demo', 'records.sqlite'))).toBe(false)

    const index = readFileSync(join(targetDir, 'index.md'), 'utf8')
    expect(index).toContain('SELECT event_id, state, closed_at, fix_requirement_id FROM ops_events')
    expect(index).toContain('- 生成时间：2026-11-09T01:00:00.000Z')
    expect(index).toContain('"failures": []')

    // 源现场被清理后，归档快照仍能独立打开并读到原始记录。
    rmSync(sourceRoot, { recursive: true, force: true })
    const snapshot = Database.open(join(targetDir, 'records.sqlite'), { readOnly: true })
    try {
      const requirement = new Repository(snapshot).getRequirement('req-archived')
      expect(requirement?.reqId).toBe('req-archived')
    } finally {
      snapshot.close()
    }
  })

  it('defaults the timestamp and the copied file list when omitted', () => {
    const result = archiveRunEvidence({
      sourceRoot,
      targetDir: join(dir, 'archive-defaults'),
      project: 'demo',
      summary: { ok: true },
    })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(result.dir, 'index.md'), 'utf8')).toContain('- 文件：summary.json')
  })

  it('copies only the requested files when a file list is given', () => {
    const result = archiveRunEvidence({
      sourceRoot,
      targetDir: join(dir, 'archive-files'),
      project: 'demo',
      summary: { ok: true },
      files: ['summary.json'],
    })
    expect(result.ok).toBe(true)
    expect(existsSync(join(result.dir, 'summary.json'))).toBe(true)
    expect(existsSync(join(result.dir, 'config.json'))).toBe(false)
  })

  it('reports a failure instead of claiming a partial archive', () => {
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'not a directory\n', 'utf8')
    const result = archiveRunEvidence({
      sourceRoot,
      targetDir: join(blocked, 'archive'),
      project: 'demo',
      summary: { ok: true },
    })
    expect(result.ok).toBe(false)
    expect(result.error).not.toBe('')
  })

  it('blocks acceptance when the archive failed', () => {
    expect(acceptanceVerdict({ failures: [], archive: { ok: true, error: '' } })).toEqual({
      failures: [],
      accepted: true,
    })
    const failed = acceptanceVerdict({
      failures: ['运行进程与制品不一致'],
      archive: { ok: false, error: '磁盘不可写' },
    })
    expect(failed.accepted).toBe(false)
    expect(failed.failures).toEqual(['运行进程与制品不一致', '证据归档失败：磁盘不可写'])
  })
})
