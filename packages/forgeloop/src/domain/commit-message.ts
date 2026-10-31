/**
 * 受控提交信息在需求详情中的只读展示文本。
 *
 * 只负责把一条已存在的提交记录中的消息转成可展示文本：
 * 非空消息保留原文（不裁剪首尾空白），空串、纯空白或缺失时回退为固定文案。
 * “没有提交记录”不属于本函数范围，调用方应让 commit 保持 null 空态，
 * 这里不提供任何写入或动作能力。
 */

export const COMMIT_MESSAGE_FALLBACK = '无提交信息'

export function formatCommitMessage(commitMessage: string | null | undefined): string {
  if (commitMessage !== null && commitMessage !== undefined && commitMessage.trim() !== '') {
    return commitMessage
  }
  return COMMIT_MESSAGE_FALLBACK
}
