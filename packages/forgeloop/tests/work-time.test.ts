import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkTimeLedger, chargeWindow } from '../src/domain/work-time.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'

describe('work time charging', () => {
  it('counts the whole span when nothing was charged before', () => {
    expect(chargeWindow({ chargedUntilMs: 0, startedAtMs: 1_000, nowMs: 4_000 })).toEqual({
      seconds: 3,
      chargedUntilMs: 4_000,
    })
  })

  it('counts only the part of a nested span that was not charged yet', () => {
    // 外层 0–10s 已计费，内层补充执行从 2s 到 8s 不得重复累计。
    expect(chargeWindow({ chargedUntilMs: 10_000, startedAtMs: 2_000, nowMs: 8_000 })).toEqual({
      seconds: 0,
      chargedUntilMs: 10_000,
    })
    expect(chargeWindow({ chargedUntilMs: 10_000, startedAtMs: 2_000, nowMs: 12_000 })).toEqual({
      seconds: 2,
      chargedUntilMs: 12_000,
    })
  })

  it('never counts negative time when the clock is behind the start', () => {
    expect(chargeWindow({ chargedUntilMs: 0, startedAtMs: 5_000, nowMs: 4_000 })).toEqual({
      seconds: 0,
      chargedUntilMs: 5_000,
    })
  })

  it('charges overlapping windows once across normal, retry and abort paths', () => {
    let now = 1_000
    const ledger = new WorkTimeLedger(() => now)
    // 正常路径：0–3s 计 3 秒。
    now = 4_000
    expect(ledger.take('req-1', 1_000)).toBe(3)
    // 补充轮复用首轮起点：重叠部分不再计费，只计新增的 1 秒。
    now = 5_000
    expect(ledger.take('req-1', 1_000)).toBe(1)
    // 失败/中止：时钟未前进，计 0。
    expect(ledger.take('req-1', 1_000)).toBe(0)
    // 不同需求各自计量。
    now = 6_000
    expect(ledger.take('req-2', 5_000)).toBe(1)
  })
})

describe('default clock', () => {
  it('uses the wall clock when no clock is injected', () => {
    const ledger = new WorkTimeLedger()
    const seconds = ledger.take('req-real-clock', Date.now() - 2_000)
    expect(seconds).toBeGreaterThan(1)
    expect(seconds).toBeLessThan(5)
  })
})

describe('repository work time', () => {
  let dir = ''
  let repo: Repository

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forgeloop-worktime-'))
    repo = new Repository(Database.open(join(dir, '.forgeloop', 'records.sqlite')))
    repo.submit({
      reqId: 'req-wt',
      project: 'p',
      text: '工时测试',
      submittedBy: 'owner',
      source: 'test',
      now: '2026-11-08T00:00:00.000Z',
    })
    repo.ensureBudget('req-wt', 3_600)
  })

  afterEach(() => {
    repo.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not charge the same wall-clock window twice', () => {
    repo.chargeBudgetOnce('req-wt', 1_000, 4_000)
    repo.chargeBudgetOnce('req-wt', 1_000, 4_000)
    expect(repo.budget('req-wt').consumedSeconds).toBe(3)
  })
})
