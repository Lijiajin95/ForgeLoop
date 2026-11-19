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

export function admissionDecisionFor(
  deps: AdmissionDecisionDeps,
  reqId: string,
): AdmissionDecision | null {
  const requirement = deps.repo.getRequirement(reqId)
  return requirement ? admissionDecisionOf(deps, requirement) : null
}

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
