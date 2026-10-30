import { describe, expect, it } from 'vitest'
import {
  DIAGNOSIS_TEXT_MAX_BYTES,
  byteLength,
  parseUnknownDiagnosis,
  renderUnknownFacts,
  replaySafe,
  type UnknownFacts,
} from '../src/domain/diagnosis.js'

/**
 * 未知请求诊断：根因与方案各限 100 字节；重放安全性由程序按工作副本事实判定，
 * 不采信模型自述。
 */

const FACTS: UnknownFacts = {
  requests: [
    {
      requestId: 'rq-1',
      action: 'advance',
      planVersion: 9,
      createdAt: '2026-10-30T01:19:00.000Z',
    },
  ],
  workspaces: [
    {
      taskId: 'domain',
      workspacePath: '/tmp/ws/domain',
      exists: true,
      headIsBaseline: true,
      changedFiles: [],
      untrackedFiles: ['requirement-queue.ts', 'requirement-queue-domain.test.ts'],
    },
  ],
  blockedReason: '开发回合被停止：工作副本可能有未收口改动，需核对；不会盲目重放',
  taskRuns: [{ taskId: 'domain', state: 'blocked', reason: '宿主中断' }],
}

describe('unknown diagnosis material', () => {
  it('parses root cause and solution within the byte limit', () => {
    const text = JSON.stringify({
      root_cause: '宿主重启中断开发回合，工作副本留下未跟踪文件',
      solution: '丢弃一次性快照后重跑推进，不重放已关闭请求',
    })
    const parsed = parseUnknownDiagnosis(text)
    expect(byteLength(parsed.rootCause)).toBeLessThanOrEqual(DIAGNOSIS_TEXT_MAX_BYTES)
    expect(byteLength(parsed.solution)).toBeLessThanOrEqual(DIAGNOSIS_TEXT_MAX_BYTES)
  })

  it('accepts camelCase keys and fenced JSON', () => {
    const parsed = parseUnknownDiagnosis(
      '```json\n{"rootCause":"中断","solution":"重跑"}\n```',
    )
    expect(parsed).toEqual({ rootCause: '中断', solution: '重跑' })
  })

  it('rejects non-objects, missing fields and empty text', () => {
    expect(() => parseUnknownDiagnosis('[]')).toThrow('必须是 JSON 对象')
    expect(() => parseUnknownDiagnosis(JSON.stringify({ solution: '重跑' }))).toThrow('root_cause')
    expect(() => parseUnknownDiagnosis(JSON.stringify({ root_cause: '中断' }))).toThrow('solution')
    expect(() => parseUnknownDiagnosis(JSON.stringify({ root_cause: ' ', solution: '重跑' }))).toThrow(
      '非空字符串',
    )
  })

  it('rejects text longer than 100 bytes in either field', () => {
    const long = '中'.repeat(34) // 102 bytes in UTF-8
    expect(() => parseUnknownDiagnosis(JSON.stringify({ root_cause: long, solution: '重跑' }))).toThrow(
      `超过 ${DIAGNOSIS_TEXT_MAX_BYTES} 字节`,
    )
    expect(() => parseUnknownDiagnosis(JSON.stringify({ root_cause: '中断', solution: long }))).toThrow(
      `超过 ${DIAGNOSIS_TEXT_MAX_BYTES} 字节`,
    )
    // 恰好 100 字节可以通过：33 个汉字 = 99 字节，再加一个 ASCII 字符。
    const exactly = `${'中'.repeat(33)}x`
    expect(byteLength(exactly)).toBe(100)
    expect(parseUnknownDiagnosis(JSON.stringify({ root_cause: exactly, solution: '重跑' })).rootCause).toBe(
      exactly,
    )
  })
})

describe('replay safety decision', () => {
  it('treats an uncommitted snapshot as safe to rerun', () => {
    expect(replaySafe(FACTS).safe).toBe(true)
    expect(replaySafe(FACTS).reason).toContain('一次性快照')
  })

  it('refuses to rerun when the executor committed inside the snapshot', () => {
    const unsafe = replaySafe({
      ...FACTS,
      workspaces: [{ ...FACTS.workspaces[0]!, headIsBaseline: false }],
    })
    expect(unsafe.safe).toBe(false)
    expect(unsafe.reason).toContain('非基线提交')
  })

  it('ignores workspaces that no longer exist', () => {
    expect(
      replaySafe({ ...FACTS, workspaces: [{ ...FACTS.workspaces[0]!, exists: false, headIsBaseline: false }] })
        .safe,
    ).toBe(true)
  })
})

describe('facts rendering for the diagnosis agent', () => {
  it('lists requests, task runs and workspace traces without inviting confirmation', () => {
    const text = renderUnknownFacts(FACTS)
    expect(text).toContain('rq-1（advance，任务包 v9')
    expect(text).toContain('domain：blocked；宿主中断')
    expect(text).toContain('未跟踪 2 个')
    expect(text).toContain('requirement-queue.ts')
    expect(text).not.toContain('请确认安全')
  })

  it('renders empty and missing sections explicitly', () => {
    const text = renderUnknownFacts({
      requests: [],
      workspaces: [{ ...FACTS.workspaces[0]!, exists: false }],
      blockedReason: '',
      taskRuns: [],
    })
    expect(text).toContain('（未记录）')
    expect(text).toContain('（无运行记录）')
    expect(text).toContain('domain：不存在')
  })
})
