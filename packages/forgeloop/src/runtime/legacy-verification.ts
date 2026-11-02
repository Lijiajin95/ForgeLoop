import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { verificationDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import type { TaskPlan } from '../domain/task-plan.js'
import type { PlanReview, VerificationCommand, VerificationReport } from '../domain/verification.js'
import {
  parseVerificationCommands,
  parseVerificationReport,
  validateScenarioEvidence,
  validateVerificationCoverage,
} from '../domain/verification.js'
import {
  parseBusinessReview,
  validateBusinessReview,
  type BusinessReview,
} from '../domain/business-review.js'
import { sha256OfText } from '../domain/delivery.js'
import { errorMessage } from '../domain/errors.js'
import { FAILURE_BUSINESS_REVIEW, FAILURE_VERIFICATION } from '../domain/counting.js'
import { AGENT_VERIFY } from '../domain/agents.js'
import type { Repository, VerificationRecord } from '../records/repository.js'
import type { AgentOpenRequest, AgentSession } from './agent-runner.js'
import type { CandidateFile } from './integration.js'
import type { VerificationCommandRun } from './execution-commands.js'
import type { runFormalTest } from './formal-test.js'
import { businessReviewPrompt, verificationPrompt } from './prompts.js'
import {
  VERIFICATION_MATERIAL_DIR,
  businessReviewEvidenceWindow,
  workspaceChanges,
} from './service-helpers.js'
import { requireGit, runCommand } from './workspace.js'

export interface LegacyVerificationDeps {
  config: ForgeLoopConfig
  repo: Repository
  ctx: NonNullable<Parameters<typeof runFormalTest>[0]['ctx']>
  now: () => string
  charge: (reqId: string, started: number) => void
  formalTest: typeof runFormalTest
  openAgent: (request: AgentOpenRequest) => Promise<AgentSession>
  verificationBaseline: (analysis: RequirementAnalysis) => PlanReview
}

export interface LegacyVerifyInput {
  reqId: string
  requirement: Requirement
  analysis: RequirementAnalysis
  plan: TaskPlan
  candidate: CandidateFile
  devWorkspace: string
  signal: AbortSignal
}

export class LegacyVerification {
  constructor(private readonly deps: LegacyVerificationDeps) {}

  async runLegacyBusinessReview(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    candidate: CandidateFile
    session: AgentSession
    dir: string
    signal: AbortSignal
    runs: readonly {
      label: string
      argv: readonly string[]
      exitCode: number | null
      logPath: string
      logSha256: string
      durationMs: number
      output: string
      timedOut: boolean
      aborted: boolean
    }[]
    verification: VerificationRecord
  }): Promise<
    | {
        ok: true
        facts: Array<{
          label: string
          argv: readonly string[]
          exitCode: number | null
          logTail: string
        }>
        review: BusinessReview
        businessRun: Awaited<ReturnType<AgentSession['send']>>
        issues: readonly string[]
      }
    | {
        ok: false
        result: {
          state: 'block'
          detail: string
          blocking: string[]
          verification: VerificationRecord
        }
      }
  > {
    // 同一验证会话继续做业务验收；证据只取程序实际重跑的命令输出。
    const { runs, session, dir, verification } = input
    const facts = runs.map((item) => ({
      label: item.label,
      argv: item.argv,
      exitCode: item.exitCode,
      logTail: businessReviewEvidenceWindow(item.output),
    }))
    const businessStarted = Date.now()
    const businessRun = await session.send({
      prompt: businessReviewPrompt({
        requirement: input.requirement,
        analysis: input.analysis,
        plan: input.plan,
        candidateSha256: input.candidate.candidateSha256,
        commands: facts,
      }),
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
      transcriptPath: join(dir, 'business-review.jsonl'),
      signal: input.signal,
    })
    this.deps.charge(input.reqId, businessStarted)
    if (businessRun.status !== 'completed') {
      this.deps.repo.recordFailureRound(input.reqId, {
        roundId: `business-review-${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}-${randomUUID()}`,
        stage: FAILURE_BUSINESS_REVIEW,
        summary: `业务验收未取得结论：${businessRun.reason}`.slice(0, 1000),
        occurredAt: this.deps.now(),
      })
      return {
        ok: false,
        result: {
          state: 'block',
          detail: `业务验收未取得结论：${businessRun.reason}`,
          blocking: [businessRun.reason],
          verification,
        },
      }
    }
    let review: BusinessReview
    try {
      review = parseBusinessReview(businessRun.text)
    } catch (error) {
      this.deps.repo.recordFailureRound(input.reqId, {
        roundId: `business-review-${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}-${randomUUID()}`,
        stage: FAILURE_BUSINESS_REVIEW,
        summary: `业务验收材料畸形：${errorMessage(error)}`.slice(0, 1000),
        occurredAt: this.deps.now(),
      })
      return {
        ok: false,
        result: {
          state: 'block',
          detail: `业务验收材料畸形：${errorMessage(error)}`,
          blocking: [`业务验收材料畸形：${errorMessage(error)}`],
          verification,
        },
      }
    }
    const issues = validateBusinessReview({
      scenarios: input.analysis.scenarios,
      acceptanceCriteria: input.analysis.acceptanceCriteria,
      review,
      runs: facts.map((fact) => ({ label: fact.label, output: fact.logTail })),
    })
    return { ok: true, facts, review, businessRun, issues }
  }

  private recordLegacyBusinessReview(input: {
    reqId: string
    plan: TaskPlan
    candidate: CandidateFile
    analysis: RequirementAnalysis
    dir: string
    verification: VerificationRecord
    review: BusinessReview
    facts: Array<{
      label: string
      argv: readonly string[]
      exitCode: number | null
      logTail: string
    }>
    businessRun: Awaited<ReturnType<AgentSession['send']>>
    issues: readonly string[]
    runs: readonly unknown[]
  }): {
    state: 'pass' | 'block'
    detail: string
    blocking: string[]
    verification: VerificationRecord
  } {
    const { issues, verification, review, businessRun, dir, runs } = input
    const businessVerdict: 'pass' | 'block' =
      review.verdict === 'pass' && issues.length === 0 ? 'pass' : 'block'
    const businessBlocking =
      businessVerdict === 'block' ? (issues.length > 0 ? issues : review.blocking) : []
    const businessReport = {
      kind: 'business-review',
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      requirementVersion: input.plan.requirementVersion,
      candidateSha256: input.candidate.candidateSha256,
      verificationSha256: verification.reportSha256,
      verdict: businessVerdict,
      summary: review.summary,
      findings: review.findings,
      blocking: [...businessBlocking],
      scenarios: review.scenarios,
      acceptance: review.acceptance,
      sessionId: businessRun.sessionId,
      at: this.deps.now(),
    }
    const businessJson = `${JSON.stringify(businessReport, null, 2)}\n`
    const businessPath = join(dir, 'business-review.json')
    writeFileSync(businessPath, businessJson, 'utf8')
    this.deps.repo.recordBusinessReview({
      requirementId: input.reqId,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidate.candidateSha256,
      requirementVersion: input.plan.requirementVersion,
      verificationSha256: verification.reportSha256,
      verdict: businessVerdict,
      reportJson: businessJson,
      reportPath: businessPath,
      reportSha256: sha256OfText(businessJson),
      sessionId: businessRun.sessionId,
      reviewedAt: this.deps.now(),
    })
    if (businessVerdict === 'block') {
      this.deps.repo.recordFailureRound(input.reqId, {
        roundId: `business-review-${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}`,
        stage: FAILURE_BUSINESS_REVIEW,
        summary: `业务验收阻断：${businessBlocking.join('；') || review.summary}`.slice(0, 1000),
        occurredAt: this.deps.now(),
      })
      return {
        state: 'block',
        detail: `业务验收阻断：${businessBlocking.join('；') || review.summary}；证据 ${businessPath}`,
        blocking: [...businessBlocking],
        verification,
      }
    }
    return {
      state: 'pass',
      detail: `候选 ${input.candidate.candidateSha256.slice(0, 16)}… 通过独立验证与业务验收（${runs.length} 条命令）`,
      blocking: [],
      verification,
    }
  }

  private async runLegacyVerificationCommands(input: {
    reqId: string
    dir: string
    workspace: string
    workspaceHead: string
    commands: readonly VerificationCommand[]
    signal: AbortSignal
  }): Promise<
    | {
        ok: true
        runs: VerificationCommandRun[]
        failedCommands: string[]
        integrity: string[]
        afterHead: string
        afterChanges: string[]
      }
    | {
        ok: false
        result: { state: 'block'; detail: string; blocking: string[]; verification: null }
      }
  > {
    const { dir, workspace, workspaceHead, commands } = input
    const runs: Array<{
      label: string
      argv: readonly string[]
      exitCode: number | null
      timedOut: boolean
      aborted: boolean
      logPath: string
      logSha256: string
      durationMs: number
      output: string
    }> = []
    const failedCommands: string[] = []
    for (const [index, command] of commands.entries()) {
      const label =
        command.label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || `command-${index + 1}`
      const test = await this.deps.formalTest({
        ctx: this.deps.ctx,
        cwd: workspace,
        argv: command.argv,
        timeoutMs: this.deps.config.formalTestTimeoutSeconds * 1000,
        logPath: join(dir, `verification-${index + 1}-${label}.log`),
        signal: input.signal,
      })
      runs.push({
        label: command.label,
        argv: command.argv,
        exitCode: test.exitCode,
        timedOut: test.timedOut,
        aborted: test.aborted,
        logPath: test.logPath,
        logSha256: test.logSha256,
        durationMs: test.durationMs,
        output: test.output,
      })
      if (test.aborted) {
        return {
          ok: false,
          result: {
            state: 'block',
            detail: '独立验证命令被停止；验证工作区可丢弃，可重新验证',
            blocking: ['独立验证命令被停止'],
            verification: null,
          },
        }
      }
      if (test.timedOut) failedCommands.push(`${command.label} 超时`)
      else if (test.exitCode !== 0) failedCommands.push(`${command.label} 退出码 ${test.exitCode}`)
    }
    const integrity: string[] = []
    const afterHead = requireGit(workspace, ['rev-parse', 'HEAD']).trim()
    if (afterHead !== workspaceHead) integrity.push('验证命令改变了候选提交')
    const afterChanges = workspaceChanges(workspace).filter(
      (path) => !path.startsWith(VERIFICATION_MATERIAL_DIR),
    )
    if (afterChanges.length > 0)
      integrity.push(`验证命令修改了候选文件：${afterChanges.join('、')}`)
    return { ok: true, runs, failedCommands, integrity, afterHead, afterChanges }
  }

  private recordLegacyVerification(input: {
    reqId: string
    plan: TaskPlan
    candidate: CandidateFile
    dir: string
    workspaceSha256: string
    baseline: PlanReview
    reportPath: string
    report: VerificationReport
    runs: VerificationCommandRun[]
    failedCommands: readonly string[]
    integrity: readonly string[]
    afterHead: string
    afterChanges: readonly string[]
    run: Awaited<ReturnType<AgentSession['send']>>
  }):
    | { ok: true; verification: VerificationRecord }
    | {
        ok: false
        result: {
          state: 'block'
          detail: string
          blocking: string[]
          verification: VerificationRecord
        }
      } {
    const { dir, workspaceSha256, baseline } = input
    const { reportPath, report, runs, failedCommands, integrity, afterHead, afterChanges, run } =
      input
    const coverage = validateVerificationCoverage(baseline.verificationPlan, report)
    const evidence = validateScenarioEvidence(baseline.verificationPlan, report, runs)
    const anyFailed = report.scenarios.some((scenario) => scenario.status === 'fail')
    const verdict: 'pass' | 'block' =
      report.verdict === 'pass' &&
      failedCommands.length === 0 &&
      coverage.length === 0 &&
      evidence.length === 0 &&
      integrity.length === 0 &&
      !anyFailed
        ? 'pass'
        : 'block'
    const blocking = [
      ...report.blocking,
      ...integrity,
      ...evidence,
      ...(anyFailed ? ['报告存在未通过的验证场景'] : []),
      ...failedCommands.map((failure) => `验证命令失败：${failure}`),
      ...coverage,
    ]
    const canonical = {
      kind: 'verification',
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      requirementVersion: input.plan.requirementVersion,
      candidateSha256: input.candidate.candidateSha256,
      candidateVersion: input.candidate.candidateVersion,
      snapshotCommit: input.candidate.snapshotCommit,
      workspaceSha256,
      verdict,
      summary: report.summary,
      findings: report.findings,
      blocking,
      scenarios: report.scenarios,
      commands: runs.map(({ output: _output, ...rest }) => rest),
      candidateIntegrity: {
        head: afterHead,
        changes: afterChanges,
        allowedPaths: [VERIFICATION_MATERIAL_DIR],
      },
      sessionId: run.sessionId,
      at: this.deps.now(),
    }
    const reportJson = `${JSON.stringify(canonical, null, 2)}\n`
    const verificationPath = join(dir, 'verification.json')
    writeFileSync(verificationPath, reportJson, 'utf8')
    const verification: VerificationRecord = {
      requirementId: input.reqId,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidate.candidateSha256,
      requirementVersion: input.plan.requirementVersion,
      workspaceSha256,
      verdict,
      reportJson,
      reportPath: verificationPath,
      reportSha256: sha256OfText(reportJson),
      evidenceDir: dir,
      sessionId: run.sessionId,
      verifiedAt: this.deps.now(),
    }
    this.deps.repo.recordVerification(verification)
    if (verdict === 'block') {
      this.deps.repo.recordFailureRound(input.reqId, {
        roundId: `verification-${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}`,
        stage: FAILURE_VERIFICATION,
        summary: `独立验证阻断：${blocking.join('；') || report.summary}`.slice(0, 1000),
        occurredAt: this.deps.now(),
      })
      return {
        ok: false,
        result: {
          state: 'block',
          detail: `独立验证阻断：${blocking.join('；') || report.summary}；证据 ${reportPath}`,
          blocking,
          verification,
        },
      }
    }
    return { ok: true, verification }
  }

  private prepareLegacyVerificationWorkspace(input: {
    reqId: string
    plan: TaskPlan
    candidate: CandidateFile
    devWorkspace: string
  }):
    | {
        ok: true
        dir: string
        workspace: string
        workspaceSha256: string
        workspaceHead: string
        diffForPrompt: string
      }
    | {
        ok: false
        result: { state: 'block'; detail: string; blocking: string[]; verification: null }
      } {
    const dir = verificationDir(
      this.deps.config,
      input.reqId,
      input.plan.planVersion,
      input.candidate.candidateSha256,
    )
    const workspace = join(dir, 'workspace')
    mkdirSync(dir, { recursive: true })
    rmSync(workspace, { recursive: true, force: true })
    // 旧候选的验证 worktree 可能已登记但目录被清理；先移除登记再创建，
    // 否则重试验证会永久卡在“丢失但已注册的工作区”。
    runCommand('git', ['worktree', 'remove', '--force', workspace], input.devWorkspace, 30_000)
    runCommand('git', ['worktree', 'prune'], input.devWorkspace, 30_000)
    const added = runCommand(
      'git',
      ['worktree', 'add', '--detach', workspace, input.candidate.snapshotCommit],
      input.devWorkspace,
      60_000,
    )
    if (added.code !== 0) {
      return {
        ok: false,
        result: {
          state: 'block',
          detail: `无法从研发现场创建独立验证工作区：${added.stderr.trim() || added.stdout.trim()}`,
          blocking: ['独立验证工作区创建失败'],
          verification: null,
        },
      }
    }
    const applied = runCommand(
      'git',
      ['apply', '--binary', input.candidate.diffPath],
      workspace,
      60_000,
    )
    if (applied.code !== 0) {
      return {
        ok: false,
        result: {
          state: 'block',
          detail: `候选 diff 无法应用到独立验证工作区：${applied.stderr.trim() || applied.stdout.trim()}`,
          blocking: ['候选 diff 无法应用'],
          verification: null,
        },
      }
    }
    runCommand('git', ['add', '-A'], workspace)
    runCommand('git', ['commit', '-qm', 'forgeloop: verification candidate'], workspace)
    if (this.deps.config.worktreePrepareCommand.length > 0) {
      const prepare = runCommand(
        this.deps.config.worktreePrepareCommand[0] ?? '',
        this.deps.config.worktreePrepareCommand.slice(1),
        workspace,
        this.deps.config.formalTestTimeoutSeconds * 1000,
      )
      if (prepare.code !== 0) {
        return {
          ok: false,
          result: {
            state: 'block',
            detail: `验证工作区准备命令失败（退出码 ${prepare.code}）`,
            blocking: [`验证工作区准备命令失败（退出码 ${prepare.code}）`],
            verification: null,
          },
        }
      }
      runCommand('git', ['reset', '--hard', 'HEAD'], workspace)
      runCommand('git', ['clean', '-fd'], workspace)
    }
    const workspaceSha256 = requireGit(workspace, ['rev-parse', 'HEAD^{tree}']).trim()
    const workspaceHead = requireGit(workspace, ['rev-parse', 'HEAD']).trim()
    const diff = readFileSync(input.candidate.diffPath, 'utf8')
    // 候选 diff 可能很大，且测试数据中的 `dsh-session:` 字样会被 DSH 当作会话引用
    // 解析并拒绝整轮。提示词只给摘要和工作区位置，验证 Agent 直接读取已应用的候选。
    const diffForPrompt = `候选 diff 共 ${diff.length} 字节，已固定到工作区；请在 ${workspace} 内读取实际文件与 diff，不在提示词中展开。`
    writeFileSync(join(dir, 'candidate.diff'), diff, 'utf8')
    writeFileSync(
      join(dir, 'candidate.json'),
      `${JSON.stringify(
        {
          reqId: input.reqId,
          planVersion: input.plan.planVersion,
          requirementVersion: input.plan.requirementVersion,
          candidateSha256: input.candidate.candidateSha256,
          candidateVersion: input.candidate.candidateVersion,
          baselineCommit: input.candidate.baselineCommit,
          snapshotCommit: input.candidate.snapshotCommit,
          workspaceSha256,
          at: this.deps.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return { ok: true, dir, workspace, workspaceSha256, workspaceHead, diffForPrompt }
  }

  async verifyCandidate(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    candidate: CandidateFile
    devWorkspace: string
    signal: AbortSignal
  }): Promise<{
    state: 'pass' | 'block'
    detail: string
    blocking: string[]
    verification: VerificationRecord | null
  }> {
    const prepared = this.prepareLegacyVerificationWorkspace(input)
    if (!prepared.ok) return prepared.result
    const { dir, workspace, workspaceSha256, workspaceHead, diffForPrompt } = prepared
    const baseline = this.deps.verificationBaseline(input.analysis)
    const session = await this.deps.openAgent({
      role: AGENT_VERIFY,
      cwd: workspace,
      permission: 'workspace-write',
      tools: 'default',
    })
    try {
      const started = Date.now()
      const run = await session.send({
        prompt: verificationPrompt({
          requirement: input.requirement,
          analysis: input.analysis,
          plan: input.plan,
          planReview: baseline,
          candidateSha256: input.candidate.candidateSha256,
          workspaceSha256,
          workspacePath: workspace,
          diff: diffForPrompt,
        }),
        timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
        transcriptPath: join(dir, 'verify.jsonl'),
        signal: input.signal,
      })
      this.deps.charge(input.reqId, started)
      if (run.status !== 'completed') {
        return {
          state: 'block',
          detail: `验证 Agent ${run.status === 'aborted' ? '被停止' : run.status === 'timeout' ? '超时' : '未完成'}：${run.reason}`,
          blocking: [run.reason],
          verification: null,
        }
      }
      const commandsPath = join(workspace, 'verification/commands.json')
      const reportPath = join(workspace, 'verification/report.json')
      if (!existsSync(commandsPath) || !existsSync(reportPath)) {
        return {
          state: 'block',
          detail: '验证 Agent 未产出 commands.json 与 report.json',
          blocking: ['验证材料缺失'],
          verification: null,
        }
      }
      let commands: VerificationCommand[]
      let report: VerificationReport
      try {
        commands = parseVerificationCommands(readFileSync(commandsPath, 'utf8'))
        report = parseVerificationReport(readFileSync(reportPath, 'utf8'))
      } catch (error) {
        return {
          state: 'block',
          detail: `验证材料畸形：${errorMessage(error)}`,
          blocking: [`验证材料畸形：${errorMessage(error)}`],
          verification: null,
        }
      }
      const changed = workspaceChanges(workspace)
      const currentHead = requireGit(workspace, ['rev-parse', 'HEAD']).trim()
      if (currentHead !== workspaceHead) {
        return {
          state: 'block',
          detail: '验证期间候选提交发生变化',
          blocking: ['验证期间候选提交发生变化'],
          verification: null,
        }
      }
      const outside = changed.filter((path) => !path.startsWith(VERIFICATION_MATERIAL_DIR))
      if (outside.length > 0) {
        return {
          state: 'block',
          detail: `验证修改了 verification/ 之外的文件：${outside.join('、')}`,
          blocking: [`验证修改了候选文件：${outside.join('、')}`],
          verification: null,
        }
      }
      const executed = await this.runLegacyVerificationCommands({
        reqId: input.reqId,
        dir,
        workspace,
        workspaceHead,
        commands,
        signal: input.signal,
      })
      if (!executed.ok) return executed.result
      const { runs, failedCommands, integrity, afterHead, afterChanges } = executed
      const recorded = this.recordLegacyVerification({
        reqId: input.reqId,
        plan: input.plan,
        candidate: input.candidate,
        dir,
        workspaceSha256,
        baseline,
        reportPath,
        report,
        runs,
        failedCommands,
        integrity,
        afterHead,
        afterChanges,
        run,
      })
      if (!recorded.ok) return recorded.result
      const verification = recorded.verification
      const business = await this.runLegacyBusinessReview({
        reqId: input.reqId,
        requirement: input.requirement,
        analysis: input.analysis,
        plan: input.plan,
        candidate: input.candidate,
        session,
        dir,
        signal: input.signal,
        runs,
        verification,
      })
      if (!business.ok) return business.result
      const { facts, review, businessRun, issues } = business
      return this.recordLegacyBusinessReview({
        reqId: input.reqId,
        plan: input.plan,
        candidate: input.candidate,
        analysis: input.analysis,
        dir,
        verification,
        review,
        facts,
        businessRun,
        issues,
        runs,
      })
    } finally {
      await session.close()
    }
  }
}
