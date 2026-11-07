import { describe, expect, it } from 'vitest'
import { requiresCoverage, scopeOfStaged } from '../../../scripts/ts/commit-scope.js'

describe('commit coverage scope', () => {
  it('requires coverage for a single package source file', () => {
    expect(requiresCoverage(['packages/forgeloop/src/runtime/ops.ts'])).toBe(true)
  })

  it('requires coverage for tooling scripts', () => {
    expect(requiresCoverage(['scripts/ts/commit-scope.ts'])).toBe(true)
  })

  it('requires coverage for build entry files', () => {
    for (const path of [
      'Makefile',
      'package.json',
      'package-lock.json',
      'pnpm-workspace.yaml',
      'contracts/architecture.json',
      '.github/workflows/quality.yml',
      '.githooks/pre-commit',
    ]) {
      expect(requiresCoverage([path]), path).toBe(true)
    }
  })

  it('does not require coverage for docs-only changes', () => {
    for (const path of ['docs/status.md', 'AGENTS.md', 'CONTRIBUTING.md', 'README.md']) {
      expect(requiresCoverage([path]), path).toBe(false)
    }
  })

  it('detects code in a mixed changeset', () => {
    expect(requiresCoverage(['docs/status.md', 'packages/forgeloop/src/index.ts'])).toBe(true)
  })

  it('requires coverage when a code file is deleted', () => {
    expect(requiresCoverage(['packages/forgeloop/src/runtime/removed.ts'])).toBe(true)
  })

  it('treats an empty list as docs-only', () => {
    expect(requiresCoverage([])).toBe(false)
  })

  it('labels the staged scope for the hook', () => {
    expect(scopeOfStaged(['docs/status.md'])).toBe('docs')
    expect(scopeOfStaged(['docs/status.md', 'Makefile'])).toBe('code')
  })
})
