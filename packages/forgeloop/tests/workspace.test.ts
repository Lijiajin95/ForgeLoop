import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  captureCandidate,
  git,
  headCommit,
  prepareSnapshotWorkspace,
  requireGit,
  runCommand,
} from '../src/runtime/workspace.js'

let dir = ''
let project = ''

function gitInit(path: string): void {
  execFileSync('git', ['init', '-q'], { cwd: path })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: path })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: path })
}

function commitAll(path: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: path })
  execFileSync('git', ['commit', '-qm', message], { cwd: path })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-workspace-'))
  project = join(dir, 'project')
  mkdirSync(project)
  gitInit(project)
  writeFileSync(join(project, 'README.md'), 'fixture\n')
  mkdirSync(join(project, 'docs'))
  writeFileSync(join(project, 'docs/a.md'), 'a\n')
  commitAll(project, 'base')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('command helpers', () => {
  it('returns stdout for a successful command', async () => {
    const result = await runCommand('node', ['-e', 'console.log("ok")'], dir)
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(result.stdout.trim()).toBe('ok')
  })

  it('treats a non-positive timeout as no timeout instead of rejecting the command', async () => {
    // 执行限额 -1 表示不限；负超时值不能把「不限」变成失败。
    for (const timeoutMs of [-1_000, 0]) {
      const result = await runCommand(
        'node',
        ['-e', 'setTimeout(() => process.exit(0), 150)'],
        dir,
        timeoutMs,
      )
      expect(result).toMatchObject({ code: 0, stderr: '' })
    }
  })

  it('keeps the event loop turning while a child command runs', async () => {
    let turns = 0
    const timer = setInterval(() => {
      turns += 1
    }, 20)
    try {
      const result = await runCommand('node', ['-e', 'setTimeout(() => process.exit(0), 300)'], dir)
      expect(result.code).toBe(0)
    } finally {
      clearInterval(timer)
    }
    expect(turns).toBeGreaterThan(2)
  })

  it('kills a command that exceeds its timeout', async () => {
    const result = await runCommand(
      'node',
      ['-e', 'setTimeout(() => process.exit(0), 5000)'],
      dir,
      150,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('超时')
  })

  it('returns the exit code and stderr for a failing command', async () => {
    const result = await runCommand(
      'node',
      ['-e', 'process.stderr.write("bad"); process.exit(2)'],
      dir,
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('bad')
  })

  it('reports a missing executable as a failure instead of throwing', async () => {
    const result = await runCommand('fl-command-that-does-not-exist', [], dir)
    expect(result.code).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('wraps git and throws a readable error when git refuses', async () => {
    expect(await headCommit(project)).toMatch(/^[0-9a-f]{40}$/)
    expect((await git(project, ['rev-parse', '--is-inside-work-tree'])).stdout.trim()).toBe('true')
    await expect(requireGit(project, ['definitely-not-a-subcommand'])).rejects.toThrow(
      'git definitely-not-a-subcommand 失败',
    )
  })
})

describe('snapshot workspaces', () => {
  it('copies tracked and untracked progress without excluding a directory by its name', async () => {
    mkdirSync(join(project, 'legacy'))
    writeFileSync(join(project, 'legacy/notes.md'), 'project notes\n')
    writeFileSync(join(project, 'docs/a.md'), 'uncommitted progress\n')
    writeFileSync(join(project, '.gitignore'), '.cache/\n')
    mkdirSync(join(project, '.cache'))
    writeFileSync(join(project, '.cache/ignored.txt'), 'local cache\n')
    const workspace = join(dir, 'snapshot')
    const snapshot = await prepareSnapshotWorkspace({
      projectPath: project,
      workspacePath: workspace,
      baselineCommit: await headCommit(project),
    })
    expect(snapshot.fileCount).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(workspace, 'README.md'))).toBe(true)
    expect(readFileSync(join(workspace, 'docs/a.md'), 'utf8')).toBe('uncommitted progress\n')
    expect(existsSync(join(workspace, 'legacy/notes.md'))).toBe(true)
    expect(existsSync(join(workspace, '.cache/ignored.txt'))).toBe(false)
    expect(await headCommit(workspace)).toMatch(/^[0-9a-f]{40}$/)
    expect(await headCommit(workspace)).not.toBe(await headCommit(project))
  })

  it('captures the staged diff, changed files and out-of-scope violations', async () => {
    const baseline = await headCommit(project)
    const worktree = join(dir, 'capture')
    await prepareSnapshotWorkspace({
      projectPath: project,
      workspacePath: worktree,
      baselineCommit: baseline,
    })

    writeFileSync(join(worktree, 'docs/a.md'), 'a changed\n')
    writeFileSync(join(worktree, 'secret.md'), 'not allowed\n')

    const capture = await captureCandidate({
      worktreePath: worktree,
      allowedFiles: ['docs/a.md'],
      diffPath: join(dir, 'candidate.diff'),
    })
    expect(capture.changedFiles).toEqual(expect.arrayContaining(['docs/a.md', 'secret.md']))
    expect(capture.violations).toEqual(['secret.md'])
    expect(capture.diff).toContain('diff --git')
    expect(capture.diffSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(capture.diffPath, 'utf8')).toBe(capture.diff)
  })
})

describe('workspace edge cases', () => {
  it('accepts a timeout/env options object and the default form', async () => {
    const withOptions = await runCommand(
      'node',
      ['-e', 'process.stdout.write(process.env.FORGELOOP_TEST_ENV ?? "")'],
      dir,
      {
        timeoutMs: 5000,
        env: { FORGELOOP_TEST_ENV: 'ok' },
      },
    )
    expect(withOptions).toMatchObject({ code: 0, stdout: 'ok', stderr: '' })
    const defaultTimeout = await runCommand('node', ['-e', 'process.exit(0)'], dir, {})
    expect(defaultTimeout.code).toBe(0)
  })

  it('skips tracked links that are broken or point at directories', async () => {
    symlinkSync('missing-target', join(project, 'broken-link'))
    symlinkSync('docs', join(project, 'dir-link'))
    commitAll(project, 'links')
    const workspace = join(dir, 'snapshot-links')
    const result = await prepareSnapshotWorkspace({
      projectPath: project,
      workspacePath: workspace,
      baselineCommit: await headCommit(project),
    })
    expect(result.fileCount).toBeGreaterThan(0)
    expect(existsSync(join(workspace, 'README.md'))).toBe(true)
    expect(existsSync(join(workspace, 'broken-link'))).toBe(false)
    expect(existsSync(join(workspace, 'dir-link'))).toBe(false)
  })

  it('enables Windows long paths for every git invocation', async () => {
    expect((await git(project, ['config', '--get', 'core.longpaths'])).stdout.trim()).toBe('true')
    expect((await git(project, ['config', '--get', 'core.longpaths'])).code).toBe(0)
    expect((await runCommand('node', ['-e', 'process.exit(0)'], dir)).code).toBe(0)
  })
})
