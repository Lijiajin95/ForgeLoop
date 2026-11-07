import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeVerificationControls } from '../src/runtime/verification-controls.js'
import type { ControlCommandRun } from '../src/runtime/verification-controls.js'
import type { VerificationControlSpec } from '../src/domain/verification-controls.js'

const PATCH = [
  'diff --git a/business.txt b/business.txt',
  '--- a/business.txt',
  '+++ b/business.txt',
  '@@ -1 +1 @@',
  '-ok',
  '+broken',
  '',
].join('\n')

const CONTROL: VerificationControlSpec = {
  label: 'check',
  patch: 'verification/controls/fault.patch',
  expectedFailureOutput: 'target rule broken',
}

const roots: string[] = []

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' })
}

/** 候选仓库：`recordsRoot` 默认落在项目内的 `.forgeloop/`，对照目录也就在候选里。 */
function candidate(): { root: string; ws: string } {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-controls-inrepo-'))
  roots.push(root)
  const ws = join(root, 'workspace')
  mkdirSync(join(ws, 'verification', 'controls'), { recursive: true })
  writeFileSync(join(ws, 'business.txt'), 'ok\n', 'utf8')
  writeFileSync(join(ws, 'verification', 'controls', 'fault.patch'), PATCH, 'utf8')
  git(ws, ['init', '-q'])
  git(ws, ['add', '-A'])
  git(ws, ['-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-qm', 'base'])
  return { root, ws }
}

async function runControl(input: {
  root: string
  ws: string
  dir: string
  run?: (cwd: string) => ControlCommandRun
  controls?: readonly VerificationControlSpec[]
}): Promise<Awaited<ReturnType<typeof executeVerificationControls>>> {
  return executeVerificationControls({
    workspace: input.ws,
    dir: input.dir,
    commands: [{ label: 'check', argv: ['node', 'check.js'] }],
    controls: input.controls ?? [CONTROL],
    run: async ({ cwd }) =>
      input.run?.(cwd) ?? {
        exitCode: readFileSync(join(cwd, 'business.txt'), 'utf8').trim() === 'broken' ? 1 : 0,
        timedOut: false,
        aborted: false,
        durationMs: 1,
        output:
          readFileSync(join(cwd, 'business.txt'), 'utf8').trim() === 'broken'
            ? 'target rule broken'
            : 'still ok',
        logPath: join(input.root, 'control.log'),
        logSha256: 'sha',
      },
  })
}

describe('sensitivity controls inside the candidate repository', () => {
  it('applies the patch in an isolated copy when recordsRoot sits inside the candidate', async () => {
    const { root, ws } = candidate()
    try {
      const outcome = await runControl({ root, ws, dir: join(ws, '.forgeloop') })
      expect(outcome.issues).toEqual([])
      expect(outcome.results[0]).toMatchObject({ applied: true, exitCode: 1 })
      const controlDir = outcome.results[0]?.controlDir ?? ''
      // 对照副本不能落在候选里，否则复制会递归、补丁也会落回候选仓库。
      expect(controlDir.startsWith(ws + '/')).toBe(false)
      expect(existsSync(join(controlDir, '.git'))).toBe(true)
      expect(existsSync(join(controlDir, '.forgeloop'))).toBe(false)
      // 原候选必须保持原样。
      expect(readFileSync(join(ws, 'business.txt'), 'utf8')).toBe('ok\n')
      expect(git(ws, ['status', '--porcelain'])).toBe('')
    } finally {
      for (const item of roots.splice(0)) rmSync(item, { recursive: true, force: true })
    }
  })

  it('still works outside the candidate and leaves the candidate untouched', async () => {
    const { root, ws } = candidate()
    try {
      const before = git(ws, ['status', '--porcelain'])
      const outcome = await runControl({ root, ws, dir: join(root, 'attempt') })
      expect(outcome.issues).toEqual([])
      expect(outcome.results[0]).toMatchObject({ applied: true })
      expect(readFileSync(join(ws, 'business.txt'), 'utf8')).toBe('ok\n')
      expect(git(ws, ['status', '--porcelain'])).toBe(before)
    } finally {
      for (const item of roots.splice(0)) rmSync(item, { recursive: true, force: true })
    }
  })

  it('rejects a patch git accepts without changing the target content', async () => {
    const { root, ws } = candidate()
    try {
      // 只改文件权限：git apply 返回 0、status 也显示改动，但业务内容没变，不能算敏感性对照。
      const modeOnly = [
        'diff --git a/business.txt b/business.txt',
        'old mode 100644',
        'new mode 100755',
        '',
      ].join('\n')
      writeFileSync(join(ws, 'verification', 'controls', 'mode.patch'), modeOnly, 'utf8')
      const outcome = await runControl({
        root,
        ws,
        dir: join(root, 'attempt-mode'),
        controls: [{ ...CONTROL, patch: 'verification/controls/mode.patch' }],
      })
      expect(outcome.issues).toEqual(['敏感性对照补丁应用后目标文件内容没有变化：business.txt'])
      expect(outcome.results[0]).toMatchObject({ applied: false })
      expect(readFileSync(join(ws, 'business.txt'), 'utf8')).toBe('ok\n')
    } finally {
      for (const item of roots.splice(0)) rmSync(item, { recursive: true, force: true })
    }
  })
})
