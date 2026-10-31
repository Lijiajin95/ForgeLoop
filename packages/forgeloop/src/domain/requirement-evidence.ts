/**
 * 需求详情中的只读证据：最近一次系统准入与最近一次受控提交。
 *
 * 这里只做确定性聚合与字段映射：按 createdAt / committedAt 取最近一条，
 * commit 携带记录中的 commitMessage 供详情只读展示，无记录时返回 null。
 * 系统准入不是人类批准，这里也不提供任何写入口。
 */

export interface AdmissionEvidence {
  readonly decision: 'admit' | 'block'
  readonly code: string
  readonly reason: string
  readonly createdAt: string
}

export interface CommitEvidence {
  readonly commitSha: string
  readonly commitMessage: string
  readonly files: readonly string[]
  readonly committedAt: string
}

export interface RequirementEvidence {
  readonly admission: AdmissionEvidence | null
  readonly commit: CommitEvidence | null
}

/** 聚合只依赖记录中的证据字段，领域层不反向依赖 records。 */
export interface AdmissionEvidenceRecord {
  readonly decision: 'admit' | 'block'
  readonly code: string
  readonly reason: string
  readonly createdAt: string
}

export interface CommitEvidenceRecord {
  readonly commitSha: string
  readonly commitMessage: string
  readonly files: readonly string[]
  readonly committedAt: string
}

/**
 * 从一组记录中取时间字段最大的一条；时间相同则保留数组中靠后的一条，
 * 与记录层“先写入的在先”的顺序一致。缺失或空字符串按最早处理，不抛错。
 */
function latestBy<T>(records: readonly T[], at: (record: T) => string): T | null {
  let latest: T | null = null
  let latestAt = ''
  for (const record of records) {
    const recordedAt = at(record)
    if (latest === null || recordedAt >= latestAt) {
      latest = record
      latestAt = recordedAt
    }
  }
  return latest
}

/**
 * 聚合需求详情证据：admission 取 createdAt 最近的一条，commit 取 committedAt
 * 最近的一条，两者都始终存在（对象或 null），调用方无需判空分支。
 */
export function requirementEvidence(input: {
  readonly admissions: readonly AdmissionEvidenceRecord[]
  readonly commits: readonly CommitEvidenceRecord[]
}): RequirementEvidence {
  const admission = latestBy(input.admissions, (record) => record.createdAt)
  const commit = latestBy(input.commits, (record) => record.committedAt)
  return {
    admission: admission
      ? {
          decision: admission.decision,
          code: admission.code,
          reason: admission.reason,
          createdAt: admission.createdAt,
        }
      : null,
    commit: commit
      ? {
          commitSha: commit.commitSha,
          commitMessage: commit.commitMessage ?? '',
          files: [...commit.files],
          committedAt: commit.committedAt,
        }
      : null,
  }
}
