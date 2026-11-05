/**
 * 产品分析结论与分析尝试的持久化。
 *
 * 结论、分诊类型、澄清问题与旧问题处置在同一事务写入；失败尝试同样保留模型、
 * 提示词版本、轨迹与工具调用。读取时按分析版本排序，最新一条由仓储层转发。
 */

import type { Database } from './db.js'
import type { RequirementAnalysis } from '../domain/requirement.js'
import { DEFAULT_INPUT_KIND, INPUT_KINDS, inputKindOf } from '../domain/requirement.js'
import type { AnalysisAttempt, AnalysisMode, AnalysisOutcome } from '../domain/analysis.js'
import type { AnalysisSpec } from '../domain/spec.js'
import { parseSpecFields } from '../domain/spec.js'
import { asRecord } from '../domain/json.js'
import { ClarificationStore } from './clarification-store.js'
import { RuleViolationError } from '../domain/errors.js'
import { num, oneOf, text, type Row } from './rows.js'

const ANALYSIS_KINDS: readonly AnalysisMode[] = ['initial', 'auto', 'manual']
const ANALYSIS_OUTCOMES: readonly AnalysisOutcome[] = ['done', 'failed']

export class AnalysisStore {
  readonly clarifications: ClarificationStore

  constructor(readonly db: Database) {
    this.clarifications = new ClarificationStore(db)
  }

  nextVersion(reqId: string): number {
    const row = this.db
      .prepare('SELECT MAX(analysis_version) AS version FROM requirement_analyses WHERE req_id = ?')
      .get(reqId)
    return (row ? num(row, 'version') : 0) + 1
  }

  record(
    analysis: RequirementAnalysis & { reqId: string },
    clarification?: {
      questions: readonly string[]
      updates: ReadonlyArray<{
        questionId: string
        status: 'resolved' | 'open'
        resolution: string
      }>
    },
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO requirement_analyses
          (req_id, analysis_version, requirement_version, goal, scenarios, acceptance_criteria,
           clarifications, business_rules, exceptions, non_goals, model, prompt_version,
           transcript_path, tool_calls, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          analysis.reqId,
          analysis.analysisVersion,
          analysis.requirementVersion,
          analysis.goal,
          JSON.stringify(analysis.scenarios),
          JSON.stringify(analysis.acceptanceCriteria),
          JSON.stringify(analysis.clarifications),
          JSON.stringify(analysis.businessRules ?? []),
          JSON.stringify(analysis.exceptions ?? []),
          JSON.stringify(analysis.nonGoals ?? []),
          analysis.model ?? '',
          analysis.promptVersion ?? '',
          analysis.transcriptPath ?? '',
          JSON.stringify(analysis.toolCalls ?? []),
          analysis.createdAt,
        )
      // 分诊结果与分析记录同一事务写入；重复写入同一版本时以最新结论为准。
      this.db
        .prepare(
          `INSERT INTO requirement_analysis_input_kinds (req_id, analysis_version, kind)
           VALUES (?, ?, ?)
           ON CONFLICT(req_id, analysis_version) DO UPDATE SET kind = excluded.kind`,
        )
        .run(analysis.reqId, analysis.analysisVersion, inputKindOf(analysis))
      this.recordSpec(analysis)
      if (!clarification) return
      this.clarifications.resolveQuestions({
        reqId: analysis.reqId,
        analysisVersion: analysis.analysisVersion,
        requirementVersion: analysis.requirementVersion,
        updates: clarification.updates,
      })
      this.clarifications.insertQuestions({
        reqId: analysis.reqId,
        analysisVersion: analysis.analysisVersion,
        questions: clarification.questions,
        createdAt: analysis.createdAt,
      })
    })
  }

  /** 结构化规格与结论同一事务落库；没有业务要点时不写空行。 */
  private recordSpec(analysis: RequirementAnalysis & { reqId: string }): void {
    const spec: AnalysisSpec = {
      points: analysis.businessPoints ?? [],
      acceptance: analysis.acceptanceItems ?? [],
      assumptions: analysis.assumptions ?? [],
    }
    if (spec.points.length === 0 && spec.acceptance.length === 0 && spec.assumptions.length === 0) {
      return
    }
    this.db
      .prepare(
        `INSERT INTO requirement_analysis_specs (req_id, analysis_version, spec_json)
         VALUES (?, ?, ?)
         ON CONFLICT(req_id, analysis_version) DO UPDATE SET spec_json = excluded.spec_json`,
      )
      .run(
        analysis.reqId,
        analysis.analysisVersion,
        JSON.stringify({
          business_points: spec.points,
          acceptance_criteria: spec.acceptance.map((item) => ({
            id: item.id,
            point_ids: item.pointIds,
            given: item.given,
            when: item.when,
            then: item.then,
          })),
          assumptions: spec.assumptions.map((item) => ({
            id: item.id,
            statement: item.statement,
            basis: item.basis,
            source: item.source,
            impact: item.impact,
            needs_confirmation: item.needsConfirmation,
          })),
        }),
      )
  }

  private specs(reqId: string): Map<number, AnalysisSpec> {
    const rows = this.db
      .prepare('SELECT * FROM requirement_analysis_specs WHERE req_id = ?')
      .all(reqId)
    return new Map(
      rows.map((row: Row) => {
        const data: unknown = JSON.parse(text(row, 'spec_json'))
        const parsed = parseSpecFields(asRecord(data) ?? {})
        const spec: AnalysisSpec = {
          points: parsed.points,
          acceptance: parsed.acceptance,
          assumptions: parsed.assumptions,
        }
        return [num(row, 'analysis_version'), spec]
      }),
    )
  }

  analyses(reqId: string): RequirementAnalysis[] {
    const rows = this.db
      .prepare('SELECT * FROM requirement_analyses WHERE req_id = ? ORDER BY analysis_version')
      .all(reqId)
    const specs = this.specs(reqId)
    const kinds = new Map(
      this.db
        .prepare(
          'SELECT analysis_version, kind FROM requirement_analysis_input_kinds WHERE req_id = ?',
        )
        .all(reqId)
        .map((row: Row) => [num(row, 'analysis_version'), text(row, 'kind')]),
    )
    return rows.map((row: Row) => {
      const analysisVersion = num(row, 'analysis_version')
      const spec = specs.get(analysisVersion)
      return {
        analysisVersion,
        requirementVersion: num(row, 'requirement_version'),
        inputKind: oneOf(
          kinds.get(analysisVersion) ?? DEFAULT_INPUT_KIND,
          INPUT_KINDS,
          '分析输入类型',
        ),
        goal: text(row, 'goal'),
        scenarios: parseStringList(text(row, 'scenarios')),
        businessRules: parseStringList(text(row, 'business_rules')),
        exceptions: parseStringList(text(row, 'exceptions')),
        nonGoals: parseStringList(text(row, 'non_goals')),
        acceptanceCriteria: parseStringList(text(row, 'acceptance_criteria')),
        ...(spec
          ? {
              businessPoints: spec.points,
              acceptanceItems: spec.acceptance,
              assumptions: spec.assumptions,
            }
          : {}),
        clarifications: parseStringList(text(row, 'clarifications')),
        model: text(row, 'model'),
        promptVersion: text(row, 'prompt_version'),
        transcriptPath: text(row, 'transcript_path'),
        toolCalls: parseStringList(text(row, 'tool_calls')),
        createdAt: text(row, 'created_at'),
      }
    })
  }

  recordAttempt(attempt: AnalysisAttempt): void {
    this.db
      .prepare(
        `INSERT INTO requirement_analysis_attempts
          (req_id, requirement_version, attempt, kind, outcome, detail, model, prompt_version,
           transcript_path, tool_calls, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.reqId,
        attempt.requirementVersion,
        attempt.attempt,
        attempt.kind,
        attempt.outcome,
        attempt.detail,
        attempt.model,
        attempt.promptVersion,
        attempt.transcriptPath,
        JSON.stringify(attempt.toolCalls),
        attempt.createdAt,
      )
  }

  attempts(reqId: string, requirementVersion?: number): AnalysisAttempt[] {
    const rows =
      requirementVersion === undefined
        ? this.db
            .prepare(
              'SELECT * FROM requirement_analysis_attempts WHERE req_id = ? ORDER BY requirement_version, attempt',
            )
            .all(reqId)
        : this.db
            .prepare(
              'SELECT * FROM requirement_analysis_attempts WHERE req_id = ? AND requirement_version = ? ORDER BY attempt',
            )
            .all(reqId, requirementVersion)
    return rows.map((row: Row) => ({
      reqId: text(row, 'req_id'),
      requirementVersion: num(row, 'requirement_version'),
      attempt: num(row, 'attempt'),
      kind: oneOf(text(row, 'kind'), ANALYSIS_KINDS, '分析尝试 kind'),
      outcome: oneOf(text(row, 'outcome'), ANALYSIS_OUTCOMES, '分析尝试 outcome'),
      detail: text(row, 'detail'),
      model: text(row, 'model'),
      promptVersion: text(row, 'prompt_version'),
      transcriptPath: text(row, 'transcript_path'),
      toolCalls: parseStringList(text(row, 'tool_calls')),
      createdAt: text(row, 'created_at'),
    }))
  }
}

function parseStringList(raw: string): string[] {
  if (raw.trim() === '') return []
  const data: unknown = JSON.parse(raw)
  if (!Array.isArray(data) || !data.every((item): item is string => typeof item === 'string')) {
    throw new RuleViolationError('记录损坏：期望字符串数组')
  }
  return data
}
