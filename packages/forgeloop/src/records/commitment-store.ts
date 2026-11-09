/**
 * 客户决定与承诺冲突解除依据的持久化。
 *
 * 从 Repository 拆出单独一类：仓储文件已贴近行数上限，而这里的查询会继续增长。
 * 有效解除必须引用一条已记录的客户决定（`customer_decisions`），决定绑定
 * 可信客户身份、需求版本与具体已有承诺；`requirement_commitment_resolutions`
 * 只是同一决定的投影，便于按三维回查与历史留痕。
 */

import { randomUUID } from 'node:crypto'
import type { Database } from './db.js'
import type { CommitmentConflict } from '../domain/spec.js'
import { oneOf, num, text, type Row } from './rows.js'

export type CommitmentDecision = 'revise' | 'replace' | 'reject'

const DECISIONS: readonly CommitmentDecision[] = ['revise', 'replace', 'reject']

/** 一条已记录的客户决定；模型、协调器与自动推进都不能写入。 */
export interface CustomerDecisionRecord {
  readonly decisionId: string
  readonly reqId: string
  readonly requirementVersion: number
  readonly existingReqId: string
  readonly decision: CommitmentDecision
  readonly decidedBy: string
  readonly decisionSource: string
  readonly reason: string
  readonly decidedAt: string
}

/** 解除依据投影；`decisionId` 指回客户决定，历史行永不覆盖。 */
export interface CommitmentResolutionRecord {
  readonly reqId: string
  readonly requirementVersion: number
  readonly existingReqId: string
  readonly decisionId: string
  readonly decisionSource: string
  readonly decision: CommitmentDecision
  readonly reason: string
  readonly decidedAt: string
}

function decisionOf(value: string): CommitmentDecision {
  return oneOf(value, DECISIONS, '客户决定方式')
}

function decisionFromRow(row: Row): CustomerDecisionRecord {
  return {
    decisionId: text(row, 'decision_id'),
    reqId: text(row, 'req_id'),
    requirementVersion: num(row, 'requirement_version'),
    existingReqId: text(row, 'existing_req_id'),
    decision: decisionOf(text(row, 'decision')),
    decidedBy: text(row, 'decided_by'),
    decisionSource: text(row, 'decision_source'),
    reason: text(row, 'reason'),
    decidedAt: text(row, 'decided_at'),
  }
}

function resolutionFromRow(row: Row): CommitmentResolutionRecord {
  return {
    reqId: text(row, 'req_id'),
    requirementVersion: num(row, 'requirement_version'),
    existingReqId: text(row, 'existing_req_id'),
    decisionId: text(row, 'decision_id'),
    decisionSource: text(row, 'decision_source'),
    decision: decisionOf(text(row, 'decision')),
    reason: text(row, 'reason'),
    decidedAt: text(row, 'decided_at'),
  }
}

export class CommitmentStore {
  constructor(private readonly db: Database) {}

  /**
   * 记录一条客户决定，并在同一事务里写入解除依据投影。
   * 同一需求版本 + 已有承诺只保留第一次决定，重复提交返回既有记录。
   */
  recordCustomerDecision(input: {
    reqId: string
    requirementVersion: number
    existingReqId: string
    decision: CommitmentDecision
    decidedBy: string
    decisionSource: string
    reason: string
    decidedAt: string
    decisionId?: string
  }): CustomerDecisionRecord {
    const decisionId = input.decisionId ?? `cd-${randomUUID()}`
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO customer_decisions
             (decision_id, req_id, requirement_version, existing_req_id, decision, decided_by,
              decision_source, reason, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(req_id, requirement_version, existing_req_id) DO NOTHING`,
        )
        .run(
          decisionId,
          input.reqId,
          input.requirementVersion,
          input.existingReqId,
          input.decision,
          input.decidedBy,
          input.decisionSource,
          input.reason,
          input.decidedAt,
        )
      const stored = this.decisionForCommitment(
        input.reqId,
        input.requirementVersion,
        input.existingReqId,
      )
      if (!stored) throw new Error(`客户决定 ${decisionId} 写入后不可读`)
      this.db
        .prepare(
          `INSERT INTO requirement_commitment_resolutions
             (req_id, requirement_version, existing_req_id, decision_id, decision_source,
              decision, reason, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(req_id, requirement_version, existing_req_id) DO NOTHING`,
        )
        .run(
          stored.reqId,
          stored.requirementVersion,
          stored.existingReqId,
          stored.decisionId,
          stored.decisionSource,
          stored.decision,
          stored.reason,
          stored.decidedAt,
        )
      return stored
    })
  }

  /** 按决定编号回查；编号不属于本项目时调用方拿不到记录。 */
  customerDecision(decisionId: string): CustomerDecisionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM customer_decisions WHERE decision_id = ?')
      .get(decisionId)
    return row ? decisionFromRow(row) : null
  }

  customerDecisions(reqId: string): CustomerDecisionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM customer_decisions
          WHERE req_id = ? ORDER BY requirement_version, existing_req_id`,
      )
      .all(reqId)
    return rows.map(decisionFromRow)
  }

  /** 需求 + 版本 + 已有承诺三维回查当前决定；没有记录时返回 null。 */
  decisionForCommitment(
    reqId: string,
    requirementVersion: number,
    existingReqId: string,
  ): CustomerDecisionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM customer_decisions
          WHERE req_id = ? AND requirement_version = ? AND existing_req_id = ?`,
      )
      .get(reqId, requirementVersion, existingReqId)
    return row ? decisionFromRow(row) : null
  }

  commitmentResolutionFor(
    reqId: string,
    requirementVersion: number,
    existingReqId: string,
  ): CommitmentResolutionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM requirement_commitment_resolutions
          WHERE req_id = ? AND requirement_version = ? AND existing_req_id = ?`,
      )
      .get(reqId, requirementVersion, existingReqId)
    return row ? resolutionFromRow(row) : null
  }

  commitmentResolutions(reqId: string): CommitmentResolutionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM requirement_commitment_resolutions
          WHERE req_id = ? ORDER BY requirement_version, existing_req_id`,
      )
      .all(reqId)
    return rows.map(resolutionFromRow)
  }

  /** 准入所需的解除依据与客户决定；历史冲突由仓储按分析版本另行给出。 */
  admissionCommitmentHistory(
    reqId: string,
    previousConflicts: readonly CommitmentConflict[],
  ): {
    previousConflicts: CommitmentConflict[]
    commitmentResolutions: CommitmentResolutionRecord[]
    customerDecisions: CustomerDecisionRecord[]
  } {
    return {
      previousConflicts: [...previousConflicts],
      commitmentResolutions: this.commitmentResolutions(reqId),
      customerDecisions: this.customerDecisions(reqId),
    }
  }
}
