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
          commitMessage: commit.commitMessage,
          files: [...commit.files],
          committedAt: commit.committedAt,
        }
      : null,
  }
}
