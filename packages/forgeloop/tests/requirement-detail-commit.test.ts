import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'

/**
 * 需求详情的受控提交证据包含只读 commitMessage：
 * - 有新链路提交时取最近一次记录的提交信息；
 * - 无提交记录时 commit 为 null，接口不抛错；
 * - 详情结构不新增批准、推进或验收动作。
 */

interface CommitEvidenceView {
  readonly commitSha: string
  readonly commitMessage: string
  readonly files: readonly string[]
  readonly committedAt: string
}

interface RequirementDetailView {
  readonly commit: CommitEvidenceView | null
  readonly latestPlan: unknown
  readonly artifacts: unknown[]
}

/** 详情不提供任何写动作；这些顶层字段名一旦出现即视为契约回归。 */
const ACTION_FIELDS = [
  'actions',
  'approve',
  'advance',
  'verify',
  'accept',
  'retry',
  'stop',
  'cancel',
  'build',
  'deploy',
  'requeue',
] as const

let dir = ''
let runtime: ForgeLoopRuntime

function makeRuntime(): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
    },
    dir,
  )
  return new ForgeLoopRuntime({ ctx: {}, config })
}

function submitRequirement(): string {
  const submitted = runtime.submit({ text: '需求详情提交信息', by: 'owner', source: 'test' })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

function detail(reqId: string): RequirementDetailView {
  const result = runtime.requirementDetail(reqId)
  expect(result.ok, result.message).toBe(true)
  return result.data as RequirementDetailView
}

function recordCommit(
  reqId: string,
  commitSha: string,
  commitMessage: string,
  committedAt: string,
): void {
  runtime.repo.recordCommit({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: `candidate-${commitSha}`,
    commitSha,
    commitMessage,
    checkCommand: ['npx', 'vitest', 'run'],
    checkLogPath: `/tmp/${commitSha}.log`,
    checkSha256: `check-${commitSha}`,
    files: [`packages/forgeloop/src/${commitSha}.ts`],
    committedAt,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-detail-commit-'))
  runtime = makeRuntime()
})

afterEach(() => {
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('requirement detail commit message', () => {
  it('returns the commit message of the most recent controlled commit', () => {
    const reqId = submitRequirement()
    recordCommit(reqId, 'oldest1', 'fix: 较早的提交', '2026-10-31T01:00:00.000Z')
    recordCommit(reqId, 'newest1', 'feat: 最近一次受控提交', '2026-10-31T03:00:00.000Z')
    recordCommit(reqId, 'middle1', 'docs: 中间一次提交', '2026-10-31T02:00:00.000Z')

    const view = detail(reqId)

    expect(view.commit).toEqual({
      commitSha: 'newest1',
      commitMessage: 'feat: 最近一次受控提交',
      files: ['packages/forgeloop/src/newest1.ts'],
      committedAt: '2026-10-31T03:00:00.000Z',
    })
  })

  it('returns commit null for an old requirement without records and does not throw', () => {
    const reqId = submitRequirement()

    const view = detail(reqId)

    expect(view.commit).toBeNull()
    expect(view.latestPlan).toBeNull()
    expect(view.artifacts).toEqual([])
  })

  it('exposes commitMessage as read-only evidence without approval, advance or acceptance actions', () => {
    const reqId = submitRequirement()
    recordCommit(reqId, 'abc1234', 'feat: 受控提交', '2026-10-31T02:00:00.000Z')

    const view = detail(reqId) as unknown as Record<string, unknown>

    for (const field of ACTION_FIELDS) expect(view).not.toHaveProperty(field)
    expect(view).not.toHaveProperty('actions')
    expect(Object.keys(view.commit as object).sort()).toEqual([
      'commitMessage',
      'commitSha',
      'committedAt',
      'files',
    ])
  })
})
