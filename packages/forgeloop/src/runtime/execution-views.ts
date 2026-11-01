import { readFileSync } from 'node:fs'
import type { Repository } from '../records/repository.js'
import type { TaskPlan } from '../domain/task-plan.js'
import { TASK_RUN_DELIVERED } from '../domain/status.js'
import { parseTaskExecution } from './task-execution.js'
import { parseFormalTestHeader } from './service-helpers.js'

export function loadExecutionPage(
  input: { offset?: number | undefined; limit?: number | undefined },
  devPath: string,
  hasDev: boolean,
): ReturnType<typeof parseTaskExecution> {
  if (!hasDev) {
    return {
      events: [],
      total: 0,
      offset: input.offset ?? 0,
      limit: input.limit ?? 100,
      truncated: false,
      stepCount: 0,
      startedAt: '',
      lastActivity: '',
      sessionIds: [],
    }
  }
  return parseTaskExecution(readFileSync(devPath, 'utf8'), {
    offset: input.offset,
    limit: input.limit,
  })
}

export function buildExecutionAttempts(input: {
  plan: TaskPlan
  task: { taskId: string }
  run: ReturnType<Repository['taskRuns']>[number] | null
  artifact: ReturnType<Repository['taskArtifact']>
  page: ReturnType<typeof parseTaskExecution>
  hasDev: boolean
  sessionId: string
  rounds: ReturnType<Repository['failureRounds']>
}): Array<Record<string, unknown>> {
  const { run, artifact, page, hasDev, sessionId, rounds } = input
  return [
    {
      attemptId: sessionId ? `session:${sessionId}` : 'recent-recording',
      label: '最近一次执行记录',
      state: run?.state ?? (artifact ? TASK_RUN_DELIVERED : 'pending'),
      sessionId,
      startedAt: page.startedAt,
      lastActivity: page.lastActivity || run?.updatedAt || '',
      eventTotal: page.total,
      available: hasDev && page.total > 0,
      reason: hasDev
        ? page.total > 0
          ? ''
          : '执行记录文件存在，但没有可公开事件'
        : '没有找到该任务的执行记录文件 dev.jsonl',
    },
    ...rounds.map((round) => ({
      attemptId: `round:${round.roundId}`,
      label: `失败轮次 ${round.roundId}`,
      state: 'failed',
      sessionId: '',
      startedAt: '',
      lastActivity: round.occurredAt,
      eventTotal: 0,
      available: false,
      reason: '历史失败轮次只保留摘要；该次独立执行记录未单独保留，不能伪造会话事件',
      stage: round.stage,
      summary: round.summary,
    })),
  ]
}

export function buildExecutionTest(input: {
  task: { testCommand: readonly string[] }
  testLog: string
  testLogPath: string
  testHeader: ReturnType<typeof parseFormalTestHeader>
  testLogTail: string
}): Record<string, unknown> {
  const { task, testLog, testLogPath, testHeader, testLogTail } = input
  return {
    command: task.testCommand,
    path: testLogPath,
    available: testLog.length > 0,
    bytes: Buffer.byteLength(testLog, 'utf8'),
    startedAt: testHeader.startedAt,
    durationMs: testHeader.durationMs,
    timedOut: testHeader.timedOut,
    aborted: testHeader.aborted,
    exitCode: testHeader.exitCode,
    tail: testLogTail,
    truncated: testLog.length > testLogTail.length,
  }
}

export function buildExecutionStages(input: {
  run: ReturnType<Repository['taskRuns']>[number] | null
  artifact: ReturnType<Repository['taskArtifact']>
  page: ReturnType<typeof parseTaskExecution>
  sessionId: string
  review: unknown
  reviewSession: string
  evidence: ReturnType<Repository['evidence']>
  reviewPath: string
  testLog: string
  testLogPath: string
  testHeader: ReturnType<typeof parseFormalTestHeader>
}): Array<Record<string, unknown>> {
  const { run, artifact, page, sessionId, review, reviewSession, evidence } = input
  const { reviewPath, testLog, testLogPath, testHeader } = input
  const reviewRecord = review as Record<string, unknown> | null
  return [
    {
      id: 'dev',
      label: '开发执行',
      state: run?.state ?? (artifact ? TASK_RUN_DELIVERED : 'pending'),
      sessionId,
      startedAt: page.startedAt,
      lastActivity: page.lastActivity || run?.updatedAt || '',
      total: page.total,
      stepCount: page.stepCount,
    },
    {
      id: 'review',
      label: '独立审查',
      available: review !== null,
      sessionId: reviewSession,
      recordedAt: evidence?.recordedAt ?? '',
      verdict: reviewRecord && typeof reviewRecord.verdict === 'string' ? reviewRecord.verdict : '',
      path: reviewPath,
    },
    {
      id: 'formal_test',
      label: '正式测试',
      available: testLog.length > 0,
      startedAt: testHeader.startedAt,
      durationMs: testHeader.durationMs,
      exitCode: testHeader.exitCode,
      path: testLogPath,
      bytes: Buffer.byteLength(testLog, 'utf8'),
    },
    {
      id: 'delivery',
      label: '交付',
      delivered: artifact !== null,
      recordedAt: artifact?.recordedAt ?? '',
      candidateSha256: artifact?.candidateSha256 ?? '',
    },
  ]
}
