/**
 * 澄清问答持久化：问题身份、解决状态与所有者回答。
 *
 * 问题与回答只追加；解决时写结论与解决版本，不删除历史。旁置表避免给已有
 * `requirement_analyses` 补列，也不承担旧库迁移。事务边界由调用方（Repository）
 * 决定，这样分析结论、问题状态与回答可以在同一事务落库。
 */

import type { Database } from './db.js'
import type { ClarificationAnswer, ClarificationQuestion } from '../domain/analysis.js'
import { clarificationQuestionId } from '../domain/analysis.js'
import { nullableNum, num, text, type Row } from './rows.js'

export class ClarificationStore {
  constructor(readonly db: Database) {}

  clarificationQuestions(reqId: string): ClarificationQuestion[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM requirement_clarification_questions
         WHERE req_id = ? ORDER BY analysis_version, question_index`,
      )
      .all(reqId)
    return rows.map((row: Row) => {
      const analysisVersion = num(row, 'analysis_version')
      const questionIndex = num(row, 'question_index')
      return {
        reqId: text(row, 'req_id'),
        analysisVersion,
        questionIndex,
        questionId: clarificationQuestionId(analysisVersion, questionIndex - 1),
        text: text(row, 'question_text'),
        status: text(row, 'status') === 'resolved' ? 'resolved' : 'open',
        resolution: text(row, 'resolution'),
        resolvedAnalysisVersion: nullableNum(row, 'resolved_analysis_version'),
        resolvedRequirementVersion: nullableNum(row, 'resolved_requirement_version'),
        createdAt: text(row, 'created_at'),
      }
    })
  }

  /** 写入一次分析新提出的问题；必须由调用方包在分析结论的同一事务里。 */
  insertQuestions(input: {
    reqId: string
    analysisVersion: number
    questions: readonly string[]
    createdAt: string
  }): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO requirement_clarification_questions
        (req_id, analysis_version, question_index, question_text, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
    )
    input.questions.forEach((question, index) => {
      insert.run(input.reqId, input.analysisVersion, index + 1, question, input.createdAt)
    })
  }

  /** 按新分析逐项处置旧问题；必须由调用方包在分析结论的同一事务里。 */
  resolveQuestions(input: {
    reqId: string
    analysisVersion: number
    requirementVersion: number
    updates: ReadonlyArray<{
      questionId: string
      status: 'resolved' | 'open'
      resolution: string
    }>
  }): void {
    const resolve = this.db.prepare(
      `UPDATE requirement_clarification_questions
       SET status = 'resolved', resolution = ?, resolved_analysis_version = ?,
           resolved_requirement_version = ?
       WHERE req_id = ? AND analysis_version = ? AND question_index = ?`,
    )
    for (const update of input.updates) {
      const parsed = /^Q(\d+)-(\d+)$/.exec(update.questionId)
      if (!parsed || update.status !== 'resolved') continue
      resolve.run(
        update.resolution,
        input.analysisVersion,
        input.requirementVersion,
        input.reqId,
        Number(parsed[1]),
        Number(parsed[2]),
      )
    }
  }

  recordAnswer(answer: ClarificationAnswer): void {
    this.db
      .prepare(
        `INSERT INTO requirement_clarification_answers
          (req_id, analysis_version, requirement_version, answered_version, question_ids,
           answer, source, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, analysis_version) DO UPDATE SET
           requirement_version = excluded.requirement_version,
           answered_version = excluded.answered_version,
           question_ids = excluded.question_ids,
           answer = excluded.answer,
           source = excluded.source,
           answered_at = excluded.answered_at`,
      )
      .run(
        answer.reqId,
        answer.analysisVersion,
        answer.requirementVersion,
        answer.answeredVersion,
        JSON.stringify(answer.questionIds),
        answer.answer,
        answer.source,
        answer.answeredAt,
      )
  }

  answers(reqId: string): ClarificationAnswer[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM requirement_clarification_answers WHERE req_id = ? ORDER BY analysis_version',
      )
      .all(reqId)
    return rows.map((row: Row) => ({
      reqId: text(row, 'req_id'),
      analysisVersion: num(row, 'analysis_version'),
      requirementVersion: num(row, 'requirement_version'),
      answeredVersion: num(row, 'answered_version'),
      questionIds: parseStringList(text(row, 'question_ids')),
      answer: text(row, 'answer'),
      source: text(row, 'source'),
      answeredAt: text(row, 'answered_at'),
    }))
  }
}

function parseStringList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}
