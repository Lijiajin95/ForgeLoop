/**
 * 系统准入的判定入口：客户决定、历史冲突与需求版本在这里汇合。
 *
 * 单独成文件让 service.ts 保持在行数上限内；判定仍只有一处，
 * 协调器领取、客户决定入口与看板读的都调用这里，避免各自复制规则。
 */

import type { ForgeLoopConfig } from '../config.js'
import {
  buildAdmissionFacts,
  decideAdmission,
  type AdmissionDecision,
} from '../domain/admission.js'
import type { Requirement } from '../domain/requirement.js'
import type { Repository } from '../records/repository.js'

export interface AdmissionDecisionDeps {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
}

/** 按需求身份重新判定准入；没有需求时返回 null。 */
export function admissionDecisionFor(
  deps: AdmissionDecisionDeps,
  reqId: string,
): AdmissionDecision | null {
  const requirement = deps.repo.getRequirement(reqId)
  return requirement ? admissionDecisionOf(deps, requirement) : null
}

/** 按当前记录重新判定准入（不写记录）。 */
export function admissionDecisionOf(
  deps: AdmissionDecisionDeps,
  requirement: Requirement,
): AdmissionDecision {
  const analysis = deps.repo.latestAnalysis(requirement.reqId)
  return decideAdmission(
    buildAdmissionFacts({
      requirementStatus: requirement.status,
      requirementVersion: requirement.versions.length,
      project: deps.config.project,
      projectPath: deps.config.projectPath,
      source: requirement.source,
      submittedBy: requirement.submittedBy,
      owner: deps.config.owner,
      analysis,
      // 历史未解除冲突、解除依据与客户决定都来自记录库；模型空列表不能清除。
      ...deps.repo.commitments.admissionCommitmentHistory(
        requirement.reqId,
        analysis
          ? deps.repo.priorCommitmentConflicts(requirement.reqId, analysis.analysisVersion)
          : [],
      ),
    }),
    deps.config.autonomy,
  )
}
