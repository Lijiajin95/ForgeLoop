import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exportCandidate, integrateCandidate } from '../src/runtime/integration.js'
import { sha256OfText } from '../src/domain/delivery.js'

const dirs: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-integration-'))
  dirs.push(dir)
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  return dir
}

function evidence(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-integration-evidence-'))
  dirs.push(dir)
  return dir
}

function candidate(repoPath: string) {
  const workspace = mkdtempSync(join(tmpdir(), 'forgeloop-candidate-'))
  dirs.push(workspace)
  const baseline = git(repoPath, ['rev-parse', 'HEAD'])
  git(workspace, ['clone', '-q', repoPath, '.'])
  git(workspace, ['config', 'user.email', 'test@example.com'])
  git(workspace, ['config', 'user.name', 'Test'])
  const snapshot = git(workspace, ['rev-parse', 'HEAD'])
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  writeFileSync(join(workspace, 'docs/a.md'), 'change\n')
  git(workspace, ['add', '-A'])
  git(workspace, ['commit', '-qm', 'candidate'])
  const out = join(evidence(), 'candidate.diff')
  const record = exportCandidate({
    workspace,
    snapshotCommit: snapshot,
    baselineCommit: baseline,
    reqId: 'req-1',
    planVersion: 1,
    requirementVersion: 1,
    candidateVersion: 1,
    outputPath: out,
    now: 'now',
  })
  return { workspace, baseline, record }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('candidate export and controlled integration', () => {
  it('refuses to export a dirty workspace and exports a committed candidate', () => {
    const project = repo()
    const { workspace, record } = candidate(project)
    expect(record.diffSha256).toHaveLength(64)
    expect(readFileSync(record.diffPath, 'utf8')).toContain('docs/a.md')
    writeFileSync(join(workspace, 'dirty.txt'), 'dirty\n')
    expect(() =>
      exportCandidate({
        workspace,
        snapshotCommit: record.snapshotCommit,
        baselineCommit: record.baselineCommit,
        reqId: 'req-1',
        planVersion: 1,
        requirementVersion: 1,
        candidateVersion: 2,
        outputPath: join(workspace, 'candidate-2.diff'),
        now: 'now',
      }),
    ).toThrow('未提交改动')
  })

  it('rejects missing diffs, digest mismatches, dirty projects and a changed baseline', () => {
    const project = repo()
    const { record } = candidate(project)
    const base = {
      projectPath: project,
      candidateDiffPath: record.diffPath,
      candidateBaseline: record.baselineCommit,
      expectedDiffSha256: record.diffSha256,
      checkCommand: [] as string[],
      commitMessage: 'feat: test',
      evidenceDir: evidence(),
      timeoutMs: 30_000,
    }
    expect(integrateCandidate({ ...base, candidateDiffPath: join(project, 'missing.diff') }).detail).toContain('缺失')
    expect(integrateCandidate({ ...base, expectedDiffSha256: '0'.repeat(64) }).detail).toContain('摘要不一致')
    writeFileSync(join(project, 'README.md'), 'dirty\n')
    expect(integrateCandidate(base).detail).toContain('未提交改动')
    git(project, ['checkout', '--', 'README.md'])
    writeFileSync(join(project, 'extra.txt'), 'extra\n')
    git(project, ['add', 'extra.txt'])
    git(project, ['commit', '-qm', 'extra'])
    expect(integrateCandidate(base).detail).toContain('HEAD 已从候选基线')
  })

  it('refuses a failing commit check without committing anything', () => {
    const project = repo()
    const { record } = candidate(project)
    const before = git(project, ['rev-parse', 'HEAD'])
    const result = integrateCandidate({
      projectPath: project,
      candidateDiffPath: record.diffPath,
      candidateBaseline: record.baselineCommit,
      expectedDiffSha256: record.diffSha256,
      checkCommand: ['node', '-e', 'process.exit(1)'],
      commitMessage: 'feat: test',
      evidenceDir: evidence(),
      timeoutMs: 30_000,
    })
    expect(result.ok).toBe(false)
    expect(result.checkPassed).toBe(false)
    expect(result.detail).toContain('退出码 1')
    expect(git(project, ['rev-parse', 'HEAD'])).toBe(before)
    expect(git(project, ['status', '--porcelain'])).toBe('')
  })


  it('reports an empty candidate and a patch that cannot be applied', () => {
    const project = repo()
    const { record } = candidate(project)
    const base = {
      projectPath: project,
      candidateBaseline: record.baselineCommit,
      checkCommand: [] as string[],
      commitMessage: 'feat: test',
      evidenceDir: evidence(),
      timeoutMs: 30_000,
    }
    const empty = join(evidence(), 'empty.diff')
    writeFileSync(empty, '')
    expect(
      integrateCandidate({ ...base, candidateDiffPath: empty, expectedDiffSha256: sha256OfText('') }).detail,
    ).toContain('没有产生可提交的文件改动')
    const broken = join(evidence(), 'broken.diff')
    writeFileSync(broken, 'not a patch\n')
    expect(
      integrateCandidate({ ...base, candidateDiffPath: broken, expectedDiffSha256: sha256OfText('not a patch\n') }).detail,
    ).toContain('无法应用')
  })

  it('reports a commit hook failure and supports an empty check command', () => {
    const project = repo()
    const { record } = candidate(project)
    const hook = join(project, '.git/hooks/pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const failed = integrateCandidate({
      projectPath: project,
      candidateDiffPath: record.diffPath,
      candidateBaseline: record.baselineCommit,
      expectedDiffSha256: record.diffSha256,
      checkCommand: [],
      commitMessage: 'feat: test',
      evidenceDir: evidence(),
      timeoutMs: 30_000,
    })
    expect(failed.ok).toBe(false)
    expect(failed.detail).toContain('创建提交失败')
    rmSync(hook)
    git(project, ['reset', '--hard', 'HEAD'])
    git(project, ['clean', '-fd'])
    const passed = integrateCandidate({
      projectPath: project,
      candidateDiffPath: record.diffPath,
      candidateBaseline: record.baselineCommit,
      expectedDiffSha256: record.diffSha256,
      checkCommand: [],
      commitMessage: 'feat: test',
      evidenceDir: evidence(),
      timeoutMs: 30_000,
    })
    expect(passed.ok).toBe(true)
    expect(passed.files).toEqual(['docs/a.md'])
  })

  it('commits only the candidate diff after the check passes', () => {
    const project = repo()
    const { record } = candidate(project)
    const result = integrateCandidate({
      projectPath: project,
      candidateDiffPath: record.diffPath,
      candidateBaseline: record.baselineCommit,
      expectedDiffSha256: record.diffSha256,
      checkCommand: ['node', '-e', 'process.exit(0)'],
      commitMessage: 'feat: test',
      evidenceDir: evidence(),
      timeoutMs: 30_000,
    })
    expect(result.ok).toBe(true)
    expect(result.files).toEqual(['docs/a.md'])
    expect(result.commitSha).toHaveLength(40)
    expect(git(project, ['status', '--porcelain'])).toBe('')
    expect(git(project, ['show', '--name-only', '--pretty=format:', result.commitSha])).toBe('docs/a.md')
    expect(result.checkLogPath).toContain('commit-check.log')
    expect(result.checkSha256).toHaveLength(64)
  })
  it('reports a staging failure after the check passes', () => {
    const project = repo()
    const { record } = candidate(project)
    const result = integrateCandidate({
      projectPath: project,
      candidateDiffPath: record.diffPath,
      candidateBaseline: record.baselineCommit,
      expectedDiffSha256: record.diffSha256,
      checkCommand: [
        'node',
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(join(project, '.git/index.lock'))}, '')`,
      ],
      commitMessage: 'feat: test',
      evidenceDir: evidence(),
      timeoutMs: 30_000,
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('暂存候选失败')
    rmSync(join(project, '.git/index.lock'), { force: true })
  })

  it('reports a diff read failure instead of exporting a broken candidate', () => {
    const project = repo()
    const { workspace } = candidate(project)
    expect(() =>
      exportCandidate({
        workspace,
        snapshotCommit: 'deadbeef',
        baselineCommit: 'deadbeef',
        reqId: 'req-1',
        planVersion: 1,
        requirementVersion: 1,
        candidateVersion: 2,
        outputPath: join(workspace, 'bad.diff'),
        now: 'now',
      }),
    ).toThrow('读取候选 diff 失败')
  })

  it('fails closed when the check worktree cannot be created or patched', () => {
    const project = repo()
    const { record } = candidate(project)
    const conflict = evidence()
    writeFileSync(join(conflict, 'check-worktree'), 'file blocks worktree\n')
    expect(() =>
      integrateCandidate({
        projectPath: project,
        candidateDiffPath: record.diffPath,
        candidateBaseline: record.baselineCommit,
        expectedDiffSha256: record.diffSha256,
        checkCommand: [],
        commitMessage: 'feat: test',
        evidenceDir: conflict,
        timeoutMs: 30_000,
      }),
    ).toThrow('创建提交检查工作树失败')
    const broken = join(evidence(), 'broken.diff')
    writeFileSync(broken, 'this is not a patch\n')
    const failed = integrateCandidate({
      projectPath: project,
      candidateDiffPath: broken,
      candidateBaseline: record.baselineCommit,
      expectedDiffSha256: sha256OfText('this is not a patch\n'),
      checkCommand: [],
      commitMessage: 'feat: test',
      evidenceDir: evidence(),
      timeoutMs: 30_000,
    })
    expect(failed.ok).toBe(false)
    expect(failed.detail).toContain('无法应用到提交检查工作树')
  })

})
