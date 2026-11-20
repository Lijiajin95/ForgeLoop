import type { Repository } from '../records/repository.js'
import type { Requirement } from '../domain/requirement.js'
import {
  computeAutonomyStats,
  type AutonomyStats,
  type OpsAutonomyFacts,
  type RequirementAutonomyFacts,
} from '../domain/autonomy.js'
import { COMMITTED } from '../domain/status.js'

export function matchesCandidateArtifact(
  intents: readonly { readonly state: string; readonly artifactSha256: string }[],
  build: { readonly artifactSha256: string } | null,
): boolean {
  if (build === null) return false
  return intents.some(
    (intent) => intent.state === 'verified' && intent.artifactSha256 === build.artifactSha256,
  )
}

const HUMAN_SOURCE_PREFIX = 'web-decision:'

function requirementFacts(
  repo: Repository,
  requirement: Requirement,
  owner: string,
): RequirementAutonomyFacts {
  const plan = repo.latestTaskPlan(requirement.reqId)
  const verification = plan ? repo.verification(requirement.reqId, plan.planVersion) : null
  const build = repo.latestCandidateBuild(requirement.reqId)
  const intents = repo.deploymentStore.deploymentIntentsForRequirement(requirement.reqId, 50)
  const deployed = matchesCandidateArtifact(intents, build)
  const deploymentFailed = intents.some(
    (intent) => intent.state === 'failed' || intent.state === 'verify_failed',
  )
  const rolledBack = intents.some((intent) => intent.state === 'rolled_back')
  const humanDeploymentInvolved = intents.some((intent) =>
    repo.deploymentStore
      .deploymentDecisions(intent.intentId)
      .some((decision) => !decision.by.startsWith('system:')),
  )
  const humanRequests = repo
    .requestsFor(requirement.reqId)
    .filter(
      (request) =>
        request.source.startsWith(HUMAN_SOURCE_PREFIX) ||
        (owner !== '' && request.requestedBy === owner),
    ).length
  return {
    status: requirement.status,
    versionCount: requirement.versions.length,
    grants: repo.grantCount(requirement.reqId),
    budgetExtensions: repo.budgetExtensions(requirement.reqId).length,
    stopped: repo.stop(requirement.reqId) !== null,
    cancelled: repo.cancellation(requirement.reqId) !== null,
    humanRequests,
    committed: requirement.status === COMMITTED && repo.latestCommit(requirement.reqId) !== null,
    verificationPassed: verification?.verdict === 'pass',
    deployed,
    humanDeploymentInvolved,
    deploymentFailed,
    rolledBack,
  }
}

export function buildAutonomyStats(
  repo: Repository,
  project: string,
  owner: string,
): AutonomyStats {
  const requirements = repo
    .listRequirements(project)
    .map((requirement) => requirementFacts(repo, requirement, owner))
  const opsEvents: OpsAutonomyFacts[] = repo
    .listOpsEvents(project)
    .map((event) => ({ state: event.state, humanInvolved: event.humanInvolved }))
  return computeAutonomyStats(requirements, opsEvents)
}
