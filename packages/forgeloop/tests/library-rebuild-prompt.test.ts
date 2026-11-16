import { describe, expect, it } from 'vitest'
import { LIBRARY_REBUILD_PROMPT_VERSION, libraryRebuildPrompt } from '../src/runtime/prompts.js'

describe('library rebuild prompt', () => {
  it('renders materials, library index and the JSON contract', () => {
    const text = libraryRebuildPrompt({
      materials: [
        {
          kind: 'doc',
          ref: 'docs/order.md',
          locator: '取消规则',
          time: '2026-11-01',
          text: '已发货订单在签收前可以取消。',
        },
      ],
      libraryIndex: '- rules.existing｜已有规则｜confirmed',
      batch: 1,
      batches: 2,
    })

    expect(text).toContain('docs/order.md')
    expect(text).toContain('已发货订单在签收前可以取消。')
    expect(text).toContain('2026-11-01')
    expect(text).toContain('rules.existing')
    expect(text).toContain('"candidates"')
    expect(text).toContain('批次 1/2')
    expect(text).toContain('不要向用户提问')
    expect(text).toContain('evidence')
    expect(text).toContain('至少一条')
    expect(LIBRARY_REBUILD_PROMPT_VERSION).toBe('library-rebuild-v1')
  })

  it('renders placeholders when there are no materials or library entries', () => {
    const text = libraryRebuildPrompt({ materials: [], libraryIndex: '', batch: 2, batches: 2 })
    expect(text).toContain('（本批次没有可用证据）')
    expect(text).toContain('（库为空）')
  })

  it('marks unknown evidence time and keeps source kinds visible', () => {
    const text = libraryRebuildPrompt({
      materials: [
        { kind: 'git', ref: 'abc1234', locator: 'docs/order.md', time: '', text: '提交说明' },
      ],
      libraryIndex: '',
      batch: 1,
      batches: 1,
    })
    expect(text).toContain('时间未知')
    expect(text).toContain('[git] abc1234')
  })
})
