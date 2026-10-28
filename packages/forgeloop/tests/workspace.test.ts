import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  it('returns stdout for a successful command', () => {
    const result = runCommand('node', ['-e', 'console.log("ok")'], dir)
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(result.stdout.trim()).toBe('ok')
  })

  it('returns the exit code and stderr for a failing command', () => {
    const result = runCommand('node', ['-e', 'process.stderr.write("bad"); process.exit(2)'], dir)
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('bad')
  })

  it('reports a missing executable as a failure instead of throwing', () => {
    const result = runCommand('fl-command-that-does-not-exist', [], dir)
    expect(result.code).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('wraps git and throws a readable error when git refuses', () => {
    expect(headCommit(project)).toMatch(/^[0-9a-f]{40}$/)
    expect(git(project, ['rev-parse', '--is-inside-work-tree']).stdout.trim()).toBe('true')
    expect(() => requireGit(project, ['definitely-not-a-subcommand'])).toThrow('git definitely-not-a-subcommand 失败')
  })
})

describe('snapshot workspaces', () => {
  it('copies tracked and untracked progress without excluding a directory by its name', () => {
    mkdirSync(join(project, 'legacy'))
    writeFileSync(join(project, 'legacy/notes.md'), 'project notes\n')
    writeFileSync(join(project, 'docs/a.md'), 'uncommitted progress\n')
    writeFileSync(join(project, '.gitignore'), '.cache/\n')
    mkdirSync(join(project, '.cache'))
    writeFileSync(join(project, '.cache/ignored.txt'), 'local cache\n')
    const workspace = join(dir, 'snapshot')
    const snapshot = prepareSnapshotWorkspace({
      projectPath: project,
      workspacePath: workspace,
      baselineCommit: headCommit(project),
    })
    expect(snapshot.fileCount).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(workspace, 'README.md'))).toBe(true)
    expect(readFileSync(join(workspace, 'docs/a.md'), 'utf8')).toBe('uncommitted progress\n')
    expect(existsSync(join(workspace, 'legacy/notes.md'))).toBe(true)
    expect(existsSync(join(workspace, '.cache/ignored.txt'))).toBe(false)
    expect(headCommit(workspace)).toMatch(/^[0-9a-f]{40}$/)
    expect(headCommit(workspace)).not.toBe(headCommit(project))
  })

  it('captures the staged diff, changed files and out-of-scope violations', () => {
    const baseline = headCommit(project)
    const worktree = join(dir, 'capture')
    prepareSnapshotWorkspace({ projectPath: project, workspacePath: worktree, baselineCommit: baseline })

    writeFileSync(join(worktree, 'docs/a.md'), 'a changed\n')
    writeFileSync(join(worktree, 'secret.md'), 'not allowed\n')

    const capture = captureCandidate({
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
