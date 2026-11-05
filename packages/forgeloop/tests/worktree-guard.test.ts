import { describe, expect, it } from 'vitest'
import { checkWorktree, isCodePath } from '../../../scripts/ts/worktree-guard.js'

describe('worktree guard', () => {
  it('allows code changes in a linked worktree', () => {
    expect(
      checkWorktree({
        root: '/repo/.cache/worktrees/task',
        mainRoot: '/repo',
        staged: ['packages/forgeloop/src/index.ts'],
      }).ok,
    ).toBe(true)
  })

  it('allows docs-only commits in the main worktree', () => {
    expect(
      checkWorktree({ root: '/repo', mainRoot: '/repo', staged: ['docs/status.md', 'AGENTS.md'] })
        .ok,
    ).toBe(true)
  })

  it('rejects code changes in the main worktree', () => {
    const result = checkWorktree({
      root: '/repo',
      mainRoot: '/repo',
      staged: ['docs/status.md', 'packages/forgeloop/src/index.ts'],
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('主工作树禁止直接提交代码')
  })

  it('treats tooling and contract files as code', () => {
    for (const path of [
      'scripts/ts/worktree-start.ts',
      'contracts/architecture.json',
      '.github/workflows/quality.yml',
      '.githooks/pre-commit',
      'Makefile',
      'package.json',
    ]) {
      expect(isCodePath(path)).toBe(true)
    }
    expect(isCodePath('docs/status.md')).toBe(false)
  })
})
