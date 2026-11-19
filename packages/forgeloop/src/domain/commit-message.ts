export const COMMIT_MESSAGE_FALLBACK = '无提交信息'

export function formatCommitMessage(commitMessage: string | null | undefined): string {
  if (commitMessage !== null && commitMessage !== undefined && commitMessage.trim() !== '') {
    return commitMessage
  }
  return COMMIT_MESSAGE_FALLBACK
}
