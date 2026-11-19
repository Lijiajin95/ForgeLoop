export type DeliveryStatus = 'delivered' | 'incomplete' | 'mismatch'

export const DELIVERY_MATERIALS = [
  'commit',
  'package',
  'install-instructions',
  'test-evidence',
  'business-review',
  'trial-install',
] as const

export type DeliveryMaterialId = (typeof DELIVERY_MATERIALS)[number]

export interface DeliveryCommit {
  readonly commitSha: string
  readonly commitMessage: string
  readonly committedAt: string
}

export interface DeliveryPackage {
  readonly packageVersion: string
  readonly tarball: string
  readonly artifactSha256: string
  readonly builtAt: string
}

export interface DeliveryInstructions {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly writtenAt: string
}

export interface DeliveryEvidence {
  readonly verdict: string
  readonly sha256: string
  readonly at: string
}

export interface DeliveryTrial {
  readonly targetId: string
  readonly artifactSha256: string
  readonly runtimeVersion: string
  readonly state: string
  readonly verifiedAt: string
}

export interface InstallableDeliveryMaterials {
  readonly requirementVersion: number
  readonly currentRequirementVersion: number
  readonly commit: DeliveryCommit | null
  readonly package: DeliveryPackage | null
  readonly instructions: DeliveryInstructions | null
  readonly verification: DeliveryEvidence | null
  readonly businessReview: DeliveryEvidence | null
  readonly trial: DeliveryTrial | null
}

interface CompleteMaterials {
  readonly requirementVersion: number
  readonly currentRequirementVersion: number
  readonly commit: DeliveryCommit
  readonly package: DeliveryPackage
  readonly instructions: DeliveryInstructions
  readonly verification: DeliveryEvidence
  readonly businessReview: DeliveryEvidence
  readonly trial: DeliveryTrial
}

export interface InstallableDeliveryVerdict {
  readonly status: DeliveryStatus
  readonly missing: readonly DeliveryMaterialId[]
  readonly mismatches: readonly string[]
  readonly availableAt: string
}

function missingMaterials(input: InstallableDeliveryMaterials): DeliveryMaterialId[] {
  const missing: DeliveryMaterialId[] = []
  if (!input.commit || !input.commit.commitSha.trim()) missing.push('commit')
  if (!input.package || !input.package.artifactSha256.trim()) missing.push('package')
  if (!input.instructions || !input.instructions.sha256.trim()) {
    missing.push('install-instructions')
  }
  if (!input.verification) missing.push('test-evidence')
  if (!input.businessReview) missing.push('business-review')
  if (!input.trial) missing.push('trial-install')
  return missing
}

function isComplete(input: InstallableDeliveryMaterials): input is CompleteMaterials {
  return missingMaterials(input).length === 0
}

export function latestAvailableAt(times: readonly string[]): string {
  const usable = times.filter((time) => Number.isFinite(Date.parse(time)))
  if (usable.length !== times.length || usable.length === 0) return ''
  return usable.slice().sort().at(-1) ?? ''
}

function mismatchReasons(input: CompleteMaterials): string[] {
  const reasons: string[] = []
  if (input.verification.verdict !== 'pass') reasons.push('独立测试未通过')
  if (input.businessReview.verdict !== 'pass') reasons.push('业务验收未通过')
  if (input.trial.state !== 'verified') reasons.push('试装未核对通过')
  if (input.trial.artifactSha256 !== input.package.artifactSha256) {
    reasons.push('交付包与试装包摘要不一致')
  }
  if (input.requirementVersion !== input.currentRequirementVersion) {
    reasons.push('交付材料绑定的是旧需求版本')
  }
  const availableAt = latestAvailableAt([
    input.commit.committedAt,
    input.package.builtAt,
    input.instructions.writtenAt,
    input.verification.at,
    input.businessReview.at,
    input.trial.verifiedAt,
  ])
  if (!availableAt) reasons.push('材料时间不可核对')
  return reasons
}

export function evaluateInstallableDelivery(
  input: InstallableDeliveryMaterials,
): InstallableDeliveryVerdict {
  const missing = missingMaterials(input)
  if (missing.length > 0) {
    return { status: 'incomplete', missing, mismatches: [], availableAt: '' }
  }
  if (!isComplete(input)) {
    return { status: 'incomplete', missing, mismatches: [], availableAt: '' }
  }
  const mismatches = mismatchReasons(input)
  if (mismatches.length > 0) {
    return { status: 'mismatch', missing: [], mismatches, availableAt: '' }
  }
  return {
    status: 'delivered',
    missing: [],
    mismatches: [],
    availableAt: latestAvailableAt([
      input.commit.committedAt,
      input.package.builtAt,
      input.instructions.writtenAt,
      input.verification.at,
      input.businessReview.at,
      input.trial.verifiedAt,
    ]),
  }
}

export interface InstallInstructionsInput {
  readonly reqId: string
  readonly project: string
  readonly requirementVersion: number
  readonly commit: DeliveryCommit
  readonly package: DeliveryPackage
  readonly verification: DeliveryEvidence
  readonly businessReview: DeliveryEvidence
  readonly trial: DeliveryTrial
  readonly targetParams: Readonly<Record<string, string>>
}

function paramLine(params: Readonly<Record<string, string>>): string {
  const entries = Object.entries(params)
  if (entries.length === 0) return '（该目标未声明参数）'
  return entries.map(([key, value]) => `${key}=${value}`).join('，')
}

export function installInstructionsOf(input: InstallInstructionsInput): string {
  const { commit, package: pkg, trial } = input
  return [
    '# 安装说明',
    '',
    `- 项目：${input.project}`,
    `- 需求：${input.reqId}（需求版本 ${input.requirementVersion}）`,
    `- 受控提交：${commit.commitSha}`,
    `- 提交信息：${commit.commitMessage || '未记录'}`,
    `- 安装包：${pkg.packageVersion}（文件 ${pkg.tarball}）`,
    `- 包摘要（sha256）：${pkg.artifactSha256}`,
    `- 独立测试：${input.verification.verdict}（证据摘要 ${input.verification.sha256}，${input.verification.at}）`,
    `- 业务验收：${input.businessReview.verdict}（证据摘要 ${input.businessReview.sha256}，${input.businessReview.at}）`,
    `- 试装目标：${trial.targetId}`,
    `- 试装运行版本：${trial.runtimeVersion}`,
    `- 试装包摘要（sha256）：${trial.artifactSha256}`,
    `- 交付包与试装包摘要一致：${trial.artifactSha256 === pkg.artifactSha256 ? '是' : '否'}`,
    '',
    '## 安装',
    '',
    `按登记的部署目标 ${trial.targetId} 安装上述包文件；ForgeLoop 不内置安装器，安装由外部受控机制执行。`,
    `目标参数：${paramLine(input.targetParams)}`,
    '',
    '## 上线检查',
    '',
    `1. 实际运行版本为 ${pkg.packageVersion}。`,
    `2. 安装文件摘要与包摘要 ${pkg.artifactSha256} 一致。`,
    '3. 关键业务入口可用（记录查询、业务会话与看板）。',
    '',
    '## 回退',
    '',
    '回退到该目标上一已验证版本；回退前先核对实际运行版本与业务记录。',
    '本说明只描述已被验证的制品，不构成发布或回退授权。',
    '',
  ].join('\n')
}
