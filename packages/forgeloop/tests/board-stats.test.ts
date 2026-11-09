import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { buildStatusBoard } from '../src/runtime/board.js'
import { buildAutonomyStats } from '../src/runtime/autonomy-stats.js'

let dir = ''
let repo: Repository

const now = '2026-11-09T05:00:00.000Z'

function submit(reqId: string): void {
  repo.submit({
    reqId,
    project: 'demo',
    text: `需求 ${reqId}`,
    submittedBy: 'owner',
    source: 'dsh-session:s1',
    now,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-board-stats-'))
  repo = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('board statistics', () => {
  it('reports the same autonomy totals as the domain computation', () => {
    submit('req-a')
    submit('req-b')
    const board = buildStatusBoard({ repository: repo, project: 'demo', now, owner: 'owner' })
    const stats = buildAutonomyStats(repo, 'demo', 'owner')
    expect(board.autonomy.requirements.total).toBe(stats.requirements.total)
    expect(board.autonomy.requirements.total).toBe(2)
    expect(board.autonomy.requirements.autonomousSuccess).toBe(stats.requirements.autonomousSuccess)
    // 没有任何提交/验证/部署记录时不计自主成功。
    expect(board.autonomy.requirements.autonomousSuccess).toBe(0)
    expect(board.autonomy.requirements.humanInvolved).toBe(0)
  })

  it('keeps board totals consistent with the projected requirement list', () => {
    submit('req-c')
    const board = buildStatusBoard({ repository: repo, project: 'demo', now, owner: 'owner' })
    expect(board.requirements).toHaveLength(board.autonomy.requirements.total)
    expect(board.requirements.map((item) => item.reqId)).toEqual(['req-c'])
  })
})
