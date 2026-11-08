/**
 * M1 基线统计：从权威记录复算研发与运维的 N/H/A，并列出每个样本。
 *
 * 口径见 docs/product.md §12：研发以独立需求为分母，运维以独立事件为分母；
 * 保留失败、卡住与未完成项；人工介入按记录事实判定，未知单独列出，不当作无人介入。
 *
 * 用法：node scripts/ts/m1-stats.ts [--db <records.sqlite> ...] [--out <dir>]
 * 不带 --db 时读取 reports/m1 下每次真实运行的归档库。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

interface RequirementSample {
  readonly reqId: string
  readonly project: string
  readonly status: string
  readonly source: string
  readonly versions: number
  readonly interventions: readonly string[]
  readonly verification: string
  readonly committed: boolean
  readonly autonomousSuccess: boolean
}

interface OpsSample {
  readonly eventId: string
  readonly project: string
  readonly state: string
  readonly humanInvolved: boolean
  readonly closedAt: string
  readonly fixRequirementId: string
  readonly recoveredAt: string
}

interface DatabaseReport {
  readonly db: string
  readonly label: string
  readonly window: { readonly from: string; readonly to: string }
  readonly requirements: readonly RequirementSample[]
  readonly events: readonly OpsSample[]
}

function args(): { dbs: string[]; out: string } {
  const argv = process.argv.slice(2)
  const dbs: string[] = []
  let out = ''
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--db' && argv[index + 1]) {
      dbs.push(argv[index + 1]!)
      index += 1
    } else if (argv[index] === '--out' && argv[index + 1]) {
      out = argv[index + 1]!
      index += 1
    }
  }
  if (dbs.length > 0) return { dbs, out }
  const base = join(ROOT, 'reports', 'm1')
  if (!existsSync(base)) return { dbs: [], out }
  for (const entry of readdirSync(base).sort()) {
    const candidate = join(base, entry, 'records.sqlite')
    if (existsSync(candidate)) dbs.push(candidate)
  }
  return { dbs, out }
}

/** 目录名/项目名给出样本类型；受控演练必须与真实业务分开报告。 */
function labelOf(dbPath: string): string {
  const rel = relative(ROOT, dbPath)
  if (/reports\/m1\/ops-/.test(rel)) return '受控演练（运维 E2E 注入故障）'
  if (/reports\/m1\/model-/.test(rel)) return '真实需求（M1 闭环 A 样本）'
  return '未标注'
}

function count(db: DatabaseSync, sql: string, ...params: string[]): number {
  const row = db.prepare(sql).get(...params) as { n?: number } | undefined
  return Number(row?.n ?? 0)
}

function requirementsOf(db: DatabaseSync): RequirementSample[] {
  const rows = db
    .prepare('SELECT req_id, project, status, source FROM requirements ORDER BY created_at')
    .all() as Array<Record<string, unknown>>
  return rows.map((row) => {
    const reqId = String(row.req_id)
    const versions = count(
      db,
      'SELECT COUNT(*) AS n FROM requirement_versions WHERE req_id = ?',
      reqId,
    )
    const grants = count(db, 'SELECT COUNT(*) AS n FROM requirement_grants WHERE req_id = ?', reqId)
    const extensions = count(
      db,
      'SELECT COUNT(*) AS n FROM requirement_budget_extensions WHERE req_id = ?',
      reqId,
    )
    const stops = count(db, 'SELECT COUNT(*) AS n FROM requirement_stops WHERE req_id = ?', reqId)
    const cancels = count(
      db,
      'SELECT COUNT(*) AS n FROM requirement_cancellations WHERE req_id = ?',
      reqId,
    )
    const questions = count(
      db,
      'SELECT COUNT(*) AS n FROM requirement_clarification_questions WHERE req_id = ?',
      reqId,
    )
    const answered = count(
      db,
      "SELECT COUNT(*) AS n FROM requirement_clarification_questions WHERE req_id = ? AND status <> 'open'",
      reqId,
    )
    const verifications = db
      .prepare(
        'SELECT verdict FROM requirement_verifications WHERE req_id = ? ORDER BY rowid DESC LIMIT 1',
      )
      .get(reqId) as { verdict?: string } | undefined
    const interventions: string[] = []
    if (versions > 1) interventions.push(`需求修订 ${versions - 1} 次`)
    if (grants > 1) interventions.push(`授权 ${grants} 次`)
    if (extensions > 0) interventions.push(`工时延长 ${extensions} 次`)
    if (stops > 0) interventions.push(`停止 ${stops} 次`)
    if (cancels > 0) interventions.push(`取消 ${cancels} 次`)
    if (questions > answered) interventions.push(`待答澄清 ${questions - answered} 条`)
    const verification = String(verifications?.verdict ?? '')
    const committed =
      count(db, 'SELECT COUNT(*) AS n FROM requirement_commits WHERE req_id = ?', reqId) > 0
    const status = String(row.status)
    return {
      reqId,
      project: String(row.project),
      status,
      source: String(row.source),
      versions,
      interventions,
      verification,
      committed,
      autonomousSuccess:
        interventions.length === 0 &&
        committed &&
        verification === 'pass' &&
        (status === 'committed' || status === 'accepted'),
    }
  })
}

function eventsOf(db: DatabaseSync): OpsSample[] {
  const rows = db
    .prepare(
      `SELECT event_id, project, state, human_involved, closed_at, recovered_at, fix_requirement_id
         FROM ops_events ORDER BY opened_at`,
    )
    .all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    eventId: String(row.event_id),
    project: String(row.project),
    state: String(row.state),
    humanInvolved: Number(row.human_involved ?? 0) === 1,
    closedAt: String(row.closed_at ?? ''),
    recoveredAt: String(row.recovered_at ?? ''),
    fixRequirementId: String(row.fix_requirement_id ?? ''),
  }))
}

function report(dbPath: string): DatabaseReport {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const path = relative(ROOT, dbPath)
    const shown = path.startsWith('..') ? dbPath : path
    const windows = db
      .prepare(
        'SELECT MIN(opened_at) AS from_at, MAX(COALESCE(closed_at, updated_at)) AS to_at FROM ops_events',
      )
      .get() as { from_at?: string; to_at?: string } | undefined
    return {
      db: shown,
      label: labelOf(dbPath),
      window: { from: String(windows?.from_at ?? ''), to: String(windows?.to_at ?? '') },
      requirements: requirementsOf(db),
      events: eventsOf(db),
    }
  } finally {
    db.close()
  }
}

function ratio(numerator: number, denominator: number): string {
  if (denominator === 0) return '无样本'
  return `${numerator}/${denominator} = ${(numerator / denominator).toFixed(1)}%`
}

function render(reports: readonly DatabaseReport[]): string {
  const lines: string[] = []
  lines.push('# M1 基线统计（从权威记录复算）', '')
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push('- 口径：docs/product.md §12；研发以独立需求为分母，运维以独立事件为分母')
  lines.push('- 未知介入不当作无人介入；未完成不计为自主成功', '')
  for (const item of reports) {
    const reqs = item.requirements
    const results = reqs.filter((sample) => sample.autonomousSuccess)
    const involved = reqs.filter((sample) => sample.interventions.length > 0)
    const unfinished = reqs.filter(
      (sample) => !sample.autonomousSuccess && sample.interventions.length === 0,
    )
    lines.push(`## ${item.db}（${item.label}）`, '')
    lines.push('')
    lines.push(`- 观察窗口：${item.window.from || '无'} → ${item.window.to || '无'}`)
    lines.push('### 研发', '')
    lines.push(`- N研 = ${reqs.length}`)
    lines.push(`- H研 = ${involved.length}（人工介入率 ${ratio(involved.length, reqs.length)}）`)
    lines.push(`- A研 = ${results.length}（自主成功比例 ${ratio(results.length, reqs.length)}）`)
    lines.push(`- 无介入但未完成：${unfinished.length}`)
    for (const sample of reqs) {
      const facts = sample.interventions.length > 0 ? sample.interventions.join('；') : '无记录介入'
      lines.push(
        `  - ${sample.reqId}｜${sample.status}｜验证 ${sample.verification || '无'}｜` +
          `提交 ${sample.committed ? '有' : '无'}｜${facts}`,
      )
    }
    lines.push('', '### 运维', '')
    const events = item.events
    const human = events.filter((event) => event.humanInvolved)
    const recovered = events.filter(
      (event) => !event.humanInvolved && (event.state === 'recovered' || event.state === 'closed'),
    )
    lines.push(`- N运 = ${events.length}`)
    lines.push(`- H运 = ${human.length}（人工介入率 ${ratio(human.length, events.length)}）`)
    lines.push(
      `- 自主恢复 = ${recovered.length}（恢复比例 ${ratio(recovered.length, events.length)}）`,
    )
    for (const event of events) {
      lines.push(
        `  - ${event.eventId}｜${event.state}｜人工介入 ${event.humanInvolved ? '是' : '否'}｜` +
          `关闭 ${event.closedAt || '未关闭'}｜修复需求 ${event.fixRequirementId || '无'}`,
      )
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

const options = args()
if (options.dbs.length === 0) {
  process.stdout.write(
    '没有可统计的记录库；先用 --db 指定或先运行真实 E2E 生成 reports/m1 归档。\n',
  )
  process.exit(0)
}
const reports = options.dbs.map(report)
const markdown = render(reports)
if (options.out) {
  mkdirSync(options.out, { recursive: true })
  writeFileSync(join(options.out, 'stats.md'), markdown)
  writeFileSync(join(options.out, 'stats.json'), `${JSON.stringify(reports, null, 2)}\n`)
  process.stdout.write(`统计已写入 ${options.out}\n`)
} else {
  process.stdout.write(markdown)
}
