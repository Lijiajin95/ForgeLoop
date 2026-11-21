import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCommand } from './workspace.js'

export interface ApplyDiffResult {
  readonly ok: boolean
  readonly detail: string
}

export async function applyDiffFile(
  dir: string,
  diffPath: string,
  label: string,
  suffix: string,
): Promise<ApplyDiffResult> {
  const rawDiff = readFileSync(diffPath, 'utf8')
  if (rawDiff.trim() === '') return { ok: true, detail: '' }
  const normalized = rawDiff.endsWith('\n') ? rawDiff : `${rawDiff}\n`
  const applyPath = join(dir, `.apply-${suffix}-${label}.diff`)
  writeFileSync(applyPath, normalized, 'utf8')
  const cleanup = (): void => {
    rmSync(applyPath, { force: true })
  }

  const check = await runCommand('git', ['apply', '--check', applyPath], dir, 120_000)
  if (check.code !== 0) {
    const reversed = await runCommand(
      'git',
      ['apply', '--reverse', '--check', applyPath],
      dir,
      120_000,
    )
    if (reversed.code === 0) {
      cleanup()
      return { ok: true, detail: '变更已存在，跳过重复应用' }
    }
  }
  const applied =
    check.code === 0
      ? await runCommand('git', ['apply', '--whitespace=nowarn', applyPath], dir, 120_000)
      : await runCommand(
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
