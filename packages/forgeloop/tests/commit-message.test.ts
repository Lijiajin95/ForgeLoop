import { describe, expect, it } from 'vitest'
import {
  COMMIT_MESSAGE_FALLBACK,
  formatCommitMessage,
} from '../src/domain/commit-message.js'

/**
 * 受控提交信息的只读展示格式化：
 * - 非空消息保留原文；
 * - 空串、纯空白或缺失时回退为“无提交信息”；
 * - 没有提交记录时由详情组装保持 commit 为 null，不在本函数中伪造记录。
 */
describe('commit message display formatting', () => {
  it('keeps a non-empty commit message as the original text', () => {
    expect(formatCommitMessage('feat: 原始提交信息')).toBe('feat: 原始提交信息')
    expect(formatCommitMessage('  feat: 保留首尾空白  ')).toBe('  feat: 保留首尾空白  ')
  })

  it('falls back for an empty or whitespace-only commit message', () => {
    for (const value of ['', ' ', '\t', '\n', ' \r\n\t ']) {
      expect(formatCommitMessage(value)).toBe(COMMIT_MESSAGE_FALLBACK)
      expect(formatCommitMessage(value)).toBe('无提交信息')
    }
  })

  it('falls back when the message is missing instead of throwing', () => {
    expect(formatCommitMessage(null)).toBe('无提交信息')
    expect(formatCommitMessage(undefined)).toBe('无提交信息')
  })
})
