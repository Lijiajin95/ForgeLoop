/**
 * 系统准入：把“真实需求来源 + 有效授权 + 质量依据”转成可执行的系统决定。
 *
 * 系统准入不是人类批准，也不写入 by=owner / approved=true；它由程序按策略判定、
 * 绑定需求版本与分析版本并单独记录。人类批准仍只用于策略明确列出的例外。
 */

export const ADMISSION_POLICY_VERSION = 'system-admission-v1'

export interface AdmissionPolicy {
  /** 总开关；关闭后所有需求都停在待处理，不自动进入研发。 */
  readonly enabled: boolean
  /** 是否允许系统准入后由主控整合并提交代码；发布/部署仍需独立授权。 */
  readonly allowCodeCommit: boolean
  /** 可信人类入口的来源前缀；只有这些来源可以触发系统准入。 */
  readonly trustedSources: readonly string[]
}

export interface AdmissionFacts {
  readonly requirementStatus: string
  readonly requirementVersion: number
  readonly project: string
  readonly projectPath: string
  readonly source: string
  readonly submittedBy: string
  readonly owner: string
  readonly analysisVersion: number | null
  readonly analysisRequirementVersion: number | null
  readonly clarifications: number
}

export interface AdmissionBasis {
  readonly policyVersion: string
  readonly source: string
  readonly submittedBy: string
  readonly owner: string
  readonly project: string
  readonly projectPath: string
  readonly requirementVersion: number
  readonly analysisVersion: number | null
  readonly trustedSource: boolean
  readonly codeCommitAllowed: boolean
}

export interface AdmissionDecision {
  readonly admit: boolean
  readonly code: string
  readonly reason: string
  readonly basis: AdmissionBasis
}

const TERMINAL = new Set(['accepted', 'rejected', 'cancelled', 'committed'])

function trusted(source: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => prefix.length > 0 && source.startsWith(prefix))
}

export function decideAdmission(facts: AdmissionFacts, policy: AdmissionPolicy): AdmissionDecision {
  const trustedSource = trusted(facts.source, policy.trustedSources)
  const basis: AdmissionBasis = {
    policyVersion: ADMISSION_POLICY_VERSION,
    source: facts.source,
    submittedBy: facts.submittedBy,
    owner: facts.owner,
    project: facts.project,
    projectPath: facts.projectPath,
    requirementVersion: facts.requirementVersion,
    analysisVersion: facts.analysisVersion,
    trustedSource,
    codeCommitAllowed: policy.enabled && policy.allowCodeCommit && trustedSource,
  }
  const block = (code: string, reason: string): AdmissionDecision => ({ admit: false, code, reason, basis })

  if (TERMINAL.has(facts.requirementStatus)) {
    return block('terminal', `需求已处于终态 ${facts.requirementStatus}`)
  }
  if (!policy.enabled) return block('autonomy_disabled', '系统准入未启用；需要所有者显式授权')
  if (!facts.project.trim() || !facts.projectPath.trim()) {
    return block('project_missing', '项目或项目路径未配置；不能确定执行边界')
  }
  if (!trustedSource) {
    return block(
      'untrusted_source',
      `需求来源 ${facts.source || '（空）'} 不在可信人类入口内；不能由系统准入`,
    )
  }
  if (facts.submittedBy !== facts.owner) {
    return block(
      'owner_mismatch',
      `需求提交者 ${facts.submittedBy || '（空）'} 与配置所有者不一致；不能由系统准入`,
    )
  }
  if (facts.analysisVersion === null) {
    return block('analysis_required', '尚无与当前需求版本对应的需求说明；不能进入研发')
  }
  if (facts.analysisRequirementVersion !== facts.requirementVersion) {
    return block(
      'analysis_stale',
      `需求说明依据版本 v${facts.analysisRequirementVersion ?? '?'}，当前是 v${facts.requirementVersion}；需要由产品 Agent 重新澄清`,
    )
  }
  if (facts.clarifications > 0) {
    return block('clarification_required', `仍有 ${facts.clarifications} 条业务歧义需要澄清`)
  }
  return {
    admit: true,
    code: 'admitted',
    reason: basis.codeCommitAllowed
      ? '可信需求来源、有效授权与需求说明齐备；允许研发、验证并提交代码'
      : '可信需求来源与需求说明齐备；允许研发与验证，代码提交仍需单独授权',
    basis,
  }
}
