/**
 * 把候选 diff 应用到工作副本。上游任务已交付的改动可能已经随基线进入副本
 * （例如修复已合并回主分支），此时重复应用应视为成功而不是冲突。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCommand } from './workspace.js'

export interface ApplyDiffResult {
  readonly ok: boolean
  readonly detail: string
}

export function applyDiffFile(
  dir: string,
  diffPath: string,
  label: string,
  suffix: string,
): ApplyDiffResult {
  const rawDiff = readFileSync(diffPath, 'utf8')
  if (rawDiff.trim() === '') return { ok: true, detail: '' }
  const normalized = rawDiff.endsWith('\n') ? rawDiff : `${rawDiff}\n`
  const applyPath = join(dir, `.apply-${suffix}-${label}.diff`)
  writeFileSync(applyPath, normalized, 'utf8')
  const cleanup = (): void => {
    rmSync(applyPath, { force: true })
  }

  const check = runCommand('git', ['apply', '--check', applyPath], dir, 120_000)
  if (check.code !== 0) {
    const reversed = runCommand('git', ['apply', '--reverse', '--check', applyPath], dir, 120_000)
    if (reversed.code === 0) {
      cleanup()
      return { ok: true, detail: '变更已存在，跳过重复应用' }
    }
  }
  const applied =
    check.code === 0
      ? runCommand('git', ['apply', '--whitespace=nowarn', applyPath], dir, 120_000)
      : runCommand(
          'patch',
          ['-p1', '--forward', '--fuzz=3', '--no-backup-if-mismatch', '-i', applyPath],
          dir,
          120_000,
        )
  if (applied.code === 0) cleanup()
  return {
    ok: applied.code === 0,
    detail: applied.stderr.trim() || applied.stdout.trim(),
  }
}
