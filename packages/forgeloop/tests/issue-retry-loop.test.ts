import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import type { AgentOpenRequest, AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { COMMITTED } from '../src/domain/status.js'
import { Database } from '../src/records/db.js'
import { IssueStore } from '../src/records/issues.js'
import {
  buildRequirementIssue,
  nextIssueAttempt,
  ISSUE_FIXED,
  ISSUE_OPEN,
  ISSUE_RESOLVED,
  ISSUE_STAGE_VERIFICATION,
  type RequirementIssue,
  type RequirementIssueEvidence,
} from '../src/domain/issue.js'

const SCENARIO = '需求功能可用'
const CRITERION = '命令输出证明功能可用'
const SMOKE = 'verified ok'

let project = ''
let runtime: ForgeLoopRuntime

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-issue-loop-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, '.gitignore'), '.forgeloop/\n')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  return dir
}

function result(request: { role: string; transcriptPath: string }, text: string): AgentRunResult {
  mkdirSync(dirname(request.transcriptPath), { recursive: true })
  writeFileSync(request.transcriptPath, '{}\n', 'utf8')
  return {
    status: 'completed',
    text,
    sessionId: `session-fake-${request.role}`,
    reason: '',
    transcriptPath: request.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  }
}

const ANALYSIS = JSON.stringify({
  goal: '实现一个可验证的小功能',
  scenarios: [SCENARIO],
  acceptance_criteria: [CRITERION],
  clarifications: [],
})

const PLAN = JSON.stringify({
  tasks: [
    {
      task_id: 'a',
      goal: '实现功能 A',
      files: ['docs/a.md'],
      acceptance: CRITERION,
      test_command: ['node', '-e', 'process.exit(0)'],
    },
    {
      task_id: 'b',
      goal: '实现功能 B',
      files: ['docs/b.md'],
      depends_on: ['a'],
      acceptance: CRITERION,
      test_command: ['node', '-e', 'process.exit(0)'],
    },
  ],
})

const BUSINESS_REVIEW = JSON.stringify({
  verdict: 'pass',
  summary: '业务场景通过',
  findings: [],
  blocking: [],
  scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: SMOKE, commands: ['smoke'] }],
  acceptance: [{ criterion: CRITERION, status: 'pass', evidence: SMOKE, commands: ['smoke'] }],
})

/**
 * 前 N 次独立验证判阻断，之后通过；研发修复回合写真实文件改动。
 * 验证命令由运行时实际重跑：阻断时退出码 1，通过时输出 SMOKE。
 */
function fakeRunner(options: { failVerifications?: number; repairNoChange?: boolean } = {}): AgentLike {
  let verificationRuns = 0
  const session = (request: AgentOpenRequest) => ({
    sessionId: `session-fl-${request.role}-test`,
    async send(turn: { prompt: string; transcriptPath: string }): Promise<AgentRunResult> {
      if (request.role === 'dev' && turn.prompt.includes('技术方案与研发任务拆解')) {
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, PLAN)
      }
      if (request.role === 'dev' && turn.prompt.includes('当前任务：')) {
        const taskId = /当前任务：(.+)/.exec(turn.prompt)?.[1]?.trim() ?? 'a'
        mkdirSync(join(request.cwd, 'docs'), { recursive: true })
        writeFileSync(join(request.cwd, `docs/${taskId}.md`), `content ${Date.now()}\n`)
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, 'done')
      }
      if (request.role === 'dev' && turn.prompt.includes('发现缺陷')) {
        if (options.repairNoChange) {
          return result({ role: request.role, transcriptPath: turn.transcriptPath }, 'no change')
        }
        writeFileSync(join(request.cwd, 'docs/a.md'), `fixed ${verificationRuns} ${Date.now()}\n`)
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, 'fixed')
      }
      if (request.role === 'verify' && turn.prompt.includes('独立验证 Agent')) {
        verificationRuns += 1
        const fail = verificationRuns <= (options.failVerifications ?? 0)
        mkdirSync(join(request.cwd, 'verification'), { recursive: true })
        writeFileSync(
          join(request.cwd, 'verification/commands.json'),
          JSON.stringify({
            commands: [
              {
                label: 'smoke',
                argv: [
                  'node',
                  '-e',
                  fail ? "console.log('broken');process.exit(1)" : `console.log('${SMOKE}')`,
                ],
              },
            ],
          }),
        )
        const report = JSON.stringify({
          verdict: fail ? 'block' : 'pass',
          summary: fail ? '候选未满足需求' : '候选满足需求',
          findings: [],
          blocking: fail ? ['功能未实现', '验证命令退出码 1'] : [],
          scenarios: [
            {
              scenario: SCENARIO,
              status: fail ? 'fail' : 'pass',
              evidence: fail ? 'broken' : SMOKE,
              commands: ['smoke'],
            },
          ],
        })
        writeFileSync(join(request.cwd, 'verification/report.json'), report)
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, report)
      }
      if (request.role === 'verify' && turn.prompt.includes('业务验收')) {
        return result({ role: request.role, transcriptPath: turn.transcriptPath }, BUSINESS_REVIEW)
      }
      throw new Error(`unexpected role ${request.role}`)
    },
    async close() {},
  })
  return {
    async run(request: AgentRunRequest) {
      if (request.role === 'product') return result(request, ANALYSIS)
      if (request.role === 'dev' && request.prompt.includes('技术方案与研发任务拆解')) {
        return result(request, PLAN)
      }
      throw new Error(`unexpected single-turn role ${request.role}`)
    },
    async open(request: AgentOpenRequest) {
      return session(request)
    },
  }
}

function makeRuntime(runner: AgentLike = fakeRunner()): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: project,
      recordsRoot: join(project, '.forgeloop'),
      owner: 'owner',
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
      autonomy: {
        enabled: true,
        allowCodeCommit: true,
        commitCheckCommand: ['node', '-e', 'process.exit(0)'],
      },
    },
    project,
  )
  return new ForgeLoopRuntime({ ctx: {}, config, runner })
}

async function runNext(reqId: string, action: 'analyze' | 'advance') {
  const claimed = runtime.repo.claimNextRequest('test-owner', new Date().toISOString())
  expect(claimed).not.toBeNull()
  expect(claimed!.reqId).toBe(reqId)
  expect(claimed!.action).toBe(action)
  const outcome = await runtime.executeRequest(claimed!, new AbortController().signal)
  runtime.repo.resolveRequest(claimed!.requestId, outcome.state, outcome.detail, new Date().toISOString())
  return outcome
}

async function analyzeRequirement(): Promise<string> {
  const submitted = runtime.submit({
    text: '实现一个可验证的小功能',
    by: 'owner',
    source: 'dsh-session:sess-issue:msg-1',
  })
  expect(submitted.ok, submitted.message).toBe(true)
  const reqId = (submitted.data as { reqId: string }).reqId
  expect((await runNext(reqId, 'analyze')).state).toBe('done')
  runtime.autoAdvanceRequests()
  return reqId
}

beforeEach(() => {
  project = makeProject()
  runtime = makeRuntime()
})

afterEach(() => {
  runtime.close()
  rmSync(project, { recursive: true, force: true })
})

describe('verification failure issue loop', () => {
  it('creates an internal issue with logs, environment and requirement link, then re-verifies after repair', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ failVerifications: 1 }))
    const reqId = await analyzeRequirement()

    const advance = await runNext(reqId, 'advance')
    expect(advance.state, advance.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(COMMITTED)

    const issues = runtime.issues.issuesFor(reqId)
    expect(issues).toHaveLength(1)
    const issue = issues[0]!
    expect(issue).toMatchObject({
      requirementId: reqId,
      project: 'demo',
      attempt: 1,
      stage: 'verification',
      status: 'resolved',
    })
    expect(issue.resolvedAt).not.toBe('')
    expect(issue.verificationSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(issue.candidateSha256).toMatch(/^[0-9a-f]{64}$/)

    // 证据包含验证命令、退出码、日志路径、环境与状态。
    expect(issue.evidence.blocking).toContain('验证命令退出码 1')
    expect(issue.evidence.commands).toHaveLength(1)
    expect(issue.evidence.commands[0]).toMatchObject({ label: 'smoke', exitCode: 1, timedOut: false })
    expect(issue.evidence.commands[0]?.logPath).not.toBe('')
    expect(existsSync(issue.evidence.commands[0]!.logPath)).toBe(true)
    expect(issue.evidence.logs).toContain(issue.evidence.commands[0]!.logPath)
    expect(issue.evidence.logs).toContain(issue.evidence.environment.verificationReportPath)
    expect(existsSync(issue.evidence.environment.verificationReportPath)).toBe(true)
    expect(issue.evidence.environment).toMatchObject({
      project: 'demo',
      projectPath: project,
      platform: process.platform,
      nodeVersion: process.version,
      pid: process.pid,
      requirementVersion: 1,
      planVersion: 1,
      candidateSha256: issue.candidateSha256,
    })
    expect(issue.evidence.environment.devWorkspace).toContain(reqId)
    expect(issue.evidence.state).toMatchObject({ attempt: 1, stage: 'verification', verificationVerdict: 'block' })

    // 验证历史累积；问题单与验证结果都能反查需求。
    const verifications = runtime.repo.verificationsFor(reqId)
    expect(verifications.map((verification) => verification.verdict)).toEqual(['block', 'pass'])
    expect(runtime.issues.get(issue.issueId)?.requirementId).toBe(reqId)
    expect(runtime.repo.verificationForCandidate(reqId, 1, issue.candidateSha256)?.requirementId).toBe(reqId)
    expect(runtime.repo.failureRounds(reqId).some((round) => round.stage === 'verification')).toBe(true)
  })

  it('keeps retrying beyond the failure quota and accumulates attempts and verification history', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ failVerifications: 4 }))
    const reqId = await analyzeRequirement()

    const first = await runNext(reqId, 'advance')
    expect(first.state).toBe('failed')
    expect(runtime.repo.failureRounds(reqId)).toHaveLength(3)
    expect(runtime.repo.verificationsFor(reqId)).toHaveLength(3)
    let issues = runtime.issues.issuesFor(reqId)
    expect(issues.map((issue) => issue.attempt)).toEqual([1, 2, 3])
    expect(issues[2]?.status).toBe('open')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
    // 失败额度已用尽，但未收口问题单让需求继续排队，而不是停在 blocked。
    expect(runtime.autoAdvanceRequests()).toContain(reqId)
    expect(
      runtime.repo.pendingRequests('demo').some((request) => request.reqId === reqId && request.action === 'advance'),
    ).toBe(true)

    const second = await runNext(reqId, 'advance')
    expect(second.state, second.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(COMMITTED)

    issues = runtime.issues.issuesFor(reqId)
    expect(issues.map((issue) => issue.attempt)).toEqual([1, 2, 3, 4])
    expect(issues.every((issue) => issue.status === 'resolved')).toBe(true)
    expect(runtime.repo.failureRounds(reqId)).toHaveLength(4)
    const verifications = runtime.repo.verificationsFor(reqId)
    expect(verifications).toHaveLength(5)
    expect(verifications.filter((verification) => verification.verdict === 'block')).toHaveLength(4)
    expect(verifications.filter((verification) => verification.verdict === 'pass')).toHaveLength(1)
    for (const issue of issues) {
      expect(issue.verificationSha256).not.toBe('')
      expect(issue.candidateSha256).not.toBe('')
      expect(
        runtime.repo.verificationsFor(reqId).some((verification) => verification.reportSha256 === issue.verificationSha256),
      ).toBe(true)
    }
  })

  it('keeps creating issues and requeueing the same requirement across repeated failures', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ failVerifications: 99 }))
    const reqId = await analyzeRequirement()

    expect((await runNext(reqId, 'advance')).state).toBe('failed')
    expect(runtime.issues.issuesFor(reqId)).toHaveLength(3)
    expect(runtime.autoAdvanceRequests()).toContain(reqId)

    expect((await runNext(reqId, 'advance')).state).toBe('failed')
    const issues = runtime.issues.issuesFor(reqId)
    expect(issues.map((issue) => issue.attempt)).toEqual([1, 2, 3, 4, 5, 6])
    expect(issues[5]?.status).toBe('open')
    expect(runtime.repo.failureRounds(reqId)).toHaveLength(6)
    expect(runtime.issues.latestOpen(reqId)?.attempt).toBe(6)
    // 仍未设置轮次上限：问题单未收口时继续自动排队下一次修复与验证。
    expect(runtime.autoAdvanceRequests()).toContain(reqId)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
  })

  it('keeps the issue open when the repair round produces no change and retries automatically', async () => {
    runtime.close()
    runtime = makeRuntime(fakeRunner({ failVerifications: 1, repairNoChange: true }))
    const reqId = await analyzeRequirement()

    const advance = await runNext(reqId, 'advance')
    expect(advance.state).toBe('failed')
    expect(advance.detail).toContain('定向修复未完成')

    const issues = runtime.issues.issuesFor(reqId)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.status).toBe('open')
    expect(issues[0]?.evidence.blocking).toContain('验证命令退出码 1')
    expect(runtime.autoAdvanceRequests()).toContain(reqId)
    expect(runtime.issues.latestOpen(reqId)?.issueId).toBe(issues[0]?.issueId)
  })
})

function issueEvidenceFor(attempt: number): RequirementIssueEvidence {
  return {
    blocking: ['验证命令退出码 1'],
    summary: '候选未满足需求',
    commands: [
      {
        label: 'smoke',
        argv: ['node', '-e', 'process.exit(1)'],
        exitCode: 1,
        timedOut: false,
        aborted: false,
        logPath: '/tmp/verification-1-smoke.log',
        logSha256: 'c'.repeat(64),
        durationMs: 5,
      },
    ],
    logs: ['/tmp/verification-1-smoke.log', '/tmp/verification.json'],
    environment: {
      project: 'demo',
      projectPath: '/tmp/demo',
      platform: 'linux',
      nodeVersion: 'v22',
      pid: 1,
      hostname: 'host',
      pluginVersion: '0.0.2',
      requirementStatus: 'verifying',
      requirementVersion: 1,
      planVersion: 1,
      candidateSha256: 'a'.repeat(64),
      candidateVersion: 1,
      candidateDiffPath: '/tmp/candidate.diff',
      verificationReportPath: '/tmp/verification.json',
      verificationReportSha256: 'e'.repeat(64),
      verificationEvidenceDir: '/tmp/verification',
      devWorkspace: '/tmp/dev',
    },
    state: { attempt, stage: ISSUE_STAGE_VERIFICATION, verificationVerdict: 'block' },
  }
}

function validIssue(overrides: Partial<RequirementIssue> = {}): RequirementIssue {
  return {
    issueId: 'issue-1',
    requirementId: 'req-1',
    project: 'demo',
    attempt: 1,
    stage: ISSUE_STAGE_VERIFICATION,
    status: ISSUE_OPEN,
    summary: '独立验证阻断',
    evidence: issueEvidenceFor(1),
    verificationSha256: 'e'.repeat(64),
    candidateSha256: 'a'.repeat(64),
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
    resolvedAt: '',
    ...overrides,
  }
}

describe('internal issue model and store', () => {
  it('validates issue fields and computes the next attempt without resetting history', () => {
    const built = buildRequirementIssue(validIssue())
    expect(built).toMatchObject({ issueId: 'issue-1', attempt: 1, status: ISSUE_OPEN })
    expect(buildRequirementIssue(validIssue({ issueId: ' issue-trimmed ' })).issueId).toBe('issue-trimmed')

    expect(() => buildRequirementIssue(validIssue({ attempt: 0 }))).toThrow('attempt 必须是正整数')
    expect(() => buildRequirementIssue(validIssue({ attempt: 1.5 }))).toThrow('attempt 必须是正整数')
    expect(() => buildRequirementIssue(validIssue({ status: 'bad' as never }))).toThrow('问题单状态未知')
    expect(() => buildRequirementIssue(validIssue({ stage: 'bad' as never }))).toThrow('问题单阶段未知')
    expect(() => buildRequirementIssue(validIssue({ issueId: '  ' }))).toThrow('issueId 不能为空')
    expect(() =>
      buildRequirementIssue(
        validIssue({ evidence: { ...issueEvidenceFor(1), blocking: ['  '] } }),
      ),
    ).toThrow('阻断项必须是非空字符串数组')

    expect(nextIssueAttempt([])).toBe(1)
    expect(nextIssueAttempt([validIssue(), validIssue({ issueId: 'issue-3', attempt: 3 })])).toBe(4)
  })

  it('stores issues idempotently and updates the lifecycle without losing history', () => {
    const db = Database.open(join(project, 'issues.sqlite'))
    try {
      const store = new IssueStore(db)
      expect(store.get('missing')).toBeNull()
      expect(store.latestOpen('req-1')).toBeNull()
      expect(store.resolveOpen('req-1', '2026-10-31T00:00:00.000Z')).toBe(0)

      const first = validIssue()
      const second = validIssue({ issueId: 'issue-2', attempt: 2 })
      store.record(first)
      store.record(first)
      store.record(second)
      expect(store.get(first.issueId)).toMatchObject({ attempt: 1, status: ISSUE_OPEN })
      expect(store.issuesFor('req-1').map((issue) => issue.attempt)).toEqual([1, 2])
      expect(store.latestOpen('req-1')?.issueId).toBe('issue-2')

      expect(store.updateStatus(first.issueId, ISSUE_FIXED, '2026-10-31T00:01:00.000Z', '已修复')).toBe(true)
      expect(store.get(first.issueId)).toMatchObject({
        status: ISSUE_FIXED,
        summary: '已修复',
        updatedAt: '2026-10-31T00:01:00.000Z',
      })
      expect(store.updateStatus(first.issueId, ISSUE_OPEN, '2026-10-31T00:02:00.000Z')).toBe(true)
      expect(store.get(first.issueId)).toMatchObject({ status: ISSUE_OPEN, summary: '已修复' })
      expect(store.updateStatus('missing', ISSUE_FIXED, '2026-10-31T00:02:00.000Z')).toBe(false)

      expect(store.resolveOpen('req-1', '2026-10-31T00:03:00.000Z')).toBe(2)
      expect(store.issuesFor('req-1')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: ISSUE_RESOLVED, resolvedAt: '2026-10-31T00:03:00.000Z' }),
        ]),
      )
      expect(store.latestOpen('req-1')).toBeNull()
    } finally {
      db.close()
    }
  })

  it('tolerates SQLite text/number affinity when reading stored rows', () => {
    const db = Database.open(join(project, 'issues-raw.sqlite'))
    try {
      db.handle
        .prepare(
          `INSERT INTO requirement_issues
            (issue_id, req_id, project, attempt, stage, status, summary, evidence_json,
             verification_sha256, candidate_sha256, created_at, updated_at, resolved_at)
           VALUES (?, ?, CAST(? AS BLOB), ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
        )
        .run('issue-raw', 'req-1', 'demo', '2', 'verification', 'open', 'raw', '{}', '', '', 'now', 'now')
      const store = new IssueStore(db)
      const issue = store.get('issue-raw')
      expect(issue?.attempt).toBe(2)
      expect(issue?.project).toBe('')
    } finally {
      db.close()
    }
  })

  it('rejects a stored issue whose evidence is not valid JSON', () => {
    const db = Database.open(join(project, 'issues-bad.sqlite'))
    try {
      db.handle
        .prepare(
          `INSERT INTO requirement_issues
            (issue_id, req_id, project, attempt, stage, status, summary, evidence_json,
             verification_sha256, candidate_sha256, created_at, updated_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
        )
        .run('issue-bad', 'req-1', 'demo', 1, 'verification', 'open', 'summary', 'not-json', '', '', 'now', 'now')
      const store = new IssueStore(db)
      expect(() => store.get('issue-bad')).toThrow('证据不是可解析 JSON')
    } finally {
      db.close()
    }
  })
})
