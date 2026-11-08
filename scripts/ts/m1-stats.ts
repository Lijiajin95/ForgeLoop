/**
 * M1 基线统计：从权威记录复算研发与运维的 N/H/A，并列出每个样本。
 *
 * 口径见 docs/product.md §12：判定逻辑在 packages/forgeloop/src/domain/m1-stats.ts；
 * 本脚本只负责读取归档库、去重、渲染。空分母显示“无样本”，未知介入单列。
 *
 * 用法：node scripts/ts/m1-stats.ts [--db <records.sqlite> ...] [--out <dir>]
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dedupeByKey,
  formatRatio,
  groupIncidents,
  interventionsOf,
  isAutonomousSuccess,
  type OpsEventFacts,
  type RequirementFacts,
} from '../../packages/forgeloop/src/domain/m1-stats.ts'

const ROOT = process.cwd()

/** 兼容外部调用：空分母带出分子分母，便于看清样本量。 */
export function formatRate(numerator: number, denominator: number): string {
  if (denominator === 0) return `${numerator}/${denominator} = 无样本`
  return formatRatio(numerator, denominator)
}

interface RequirementSample extends RequirementFacts {
  readonly project: string
  readonly source: string
  readonly interventions: readonly string[]
  readonly success: boolean
  /** 记录不足以核对介入历史（缺准入/版本），单独计入未知。 */
  readonly unknown: boolean
}

interface DatabaseReport {
  readonly db: string
  readonly label: string
  readonly window: { readonly from: string; readonly to: string }
  readonly requirements: readonly RequirementSample[]
  readonly events: readonly (OpsEventFacts & { readonly project: string })[]
  readonly incidents: ReturnType<typeof groupIncidents>
  readonly duplicates: { readonly requirements: string[]; readonly events: string[] }
}

function args(): { dbs: string[]; out: string } {
  const argv = process.argv.slice(2)
  const dbs: string[] = []
  let out = ''
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--db' && argv[index + 1]) {
      dbs.push(argv[index + 1] ?? '')
      index += 1
    } else if (argv[index] === '--out' && argv[index + 1]) {
      out = argv[index + 1] ?? ''
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

function labelOf(dbPath: string, project: string): string {
  const rel = relative(ROOT, dbPath)
  if (/reports\/m1\/ops-/.test(rel)) return '受控演练（运维 E2E 注入故障）'
  if (/reports\/m1\/(model|self)-/.test(rel)) return '真实需求（闭环 A 样本）'
  return project
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
    const facts: RequirementFacts = {
      reqId,
      status: String(row.status),
      versions: count(db, 'SELECT COUNT(*) AS n FROM requirement_versions WHERE req_id = ?', reqId),
      grants: count(db, 'SELECT COUNT(*) AS n FROM requirement_grants WHERE req_id = ?', reqId),
      budgetExtensions: count(
        db,
        'SELECT COUNT(*) AS n FROM requirement_budget_extensions WHERE req_id = ?',
        reqId,
      ),
      stops: count(db, 'SELECT COUNT(*) AS n FROM requirement_stops WHERE req_id = ?', reqId),
      cancellations: count(
        db,
        'SELECT COUNT(*) AS n FROM requirement_cancellations WHERE req_id = ?',
        reqId,
      ),
      clarificationQuestions: count(
        db,
        'SELECT COUNT(*) AS n FROM requirement_clarification_questions WHERE req_id = ?',
        reqId,
      ),
      committed:
        count(db, 'SELECT COUNT(*) AS n FROM requirement_commits WHERE req_id = ?', reqId) > 0,
      verification: String(
        (
          db
            .prepare(
              'SELECT verdict FROM requirement_verifications WHERE req_id = ? ORDER BY rowid DESC LIMIT 1',
            )
            .get(reqId) as { verdict?: string } | undefined
        )?.verdict ?? '',
      ),
      deployed:
        count(
          db,
          "SELECT COUNT(*) AS n FROM requirement_deployments WHERE req_id = ? AND state = 'verified'",
          reqId,
        ) > 0 ||
        count(
          db,
          "SELECT COUNT(*) AS n FROM deployment_intents WHERE requirement_id = ? AND state = 'verified'",
          reqId,
        ) > 0,
    }
    return {
      ...facts,
      project: String(row.project),
      source: String(row.source),
      interventions: interventionsOf(facts),
      success: isAutonomousSuccess(facts),
      unknown: facts.versions <= 1 && !facts.committed && facts.status === 'draft',
    }
  })
}

function eventsOf(db: DatabaseSync, project: string): Array<OpsEventFacts & { project: string }> {
  const rows = db
    .prepare(
      `SELECT event_id, resource_id, check_id, state, human_involved, closed_at, recovered_at,
              fix_requirement_id
         FROM ops_events ORDER BY opened_at`,
    )
    .all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    project,
    eventId: String(row.event_id),
    resourceId: String(row.resource_id ?? ''),
    checkId: String(row.check_id ?? ''),
    fixRequirementId: String(row.fix_requirement_id ?? ''),
    state: String(row.state),
    humanInvolved: Number(row.human_involved ?? 0) === 1,
    closedAt: String(row.closed_at ?? ''),
    recoveredAt: String(row.recovered_at ?? ''),
  }))
}

function report(dbPath: string): DatabaseReport {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const window = db
      .prepare(
        'SELECT MIN(opened_at) AS from_at, MAX(COALESCE(closed_at, updated_at)) AS to_at FROM ops_events',
      )
      .get() as { from_at?: string; to_at?: string } | undefined
    const project =
      (db.prepare('SELECT project FROM requirements LIMIT 1').get() as { project?: string })
        ?.project ?? ''
    const requirements = requirementsOf(db)
    const events = eventsOf(db, project)
    const shown = relative(ROOT, dbPath)
    return {
      db: shown.startsWith('..') ? dbPath : shown,
      label: labelOf(dbPath, project),
      window: { from: String(window?.from_at ?? ''), to: String(window?.to_at ?? '') },
      requirements,
      events,
      incidents: groupIncidents(events),
      duplicates: { requirements: [], events: [] },
    }
  } finally {
    db.close()
  }
}

function render(reports: readonly DatabaseReport[], totals: Totals): string {
  const lines: string[] = ['# M1 基线统计（从权威记录复算）', '']
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push('- 口径：docs/product.md §12；判定实现在 `packages/forgeloop/src/domain/m1-stats.ts`')
  lines.push('- 空分母显示“无样本”；未知介入单列；未完成不计成功；跨归档同一对象只计一次', '')
  for (const item of reports) {
    const success = item.requirements.filter((sample) => sample.success)
    const involved = item.requirements.filter((sample) => sample.interventions.length > 0)
    const unknown = item.requirements.filter((sample) => sample.unknown)
    lines.push(`## ${item.db}（${item.label}）`, '')
    lines.push(`- 观察窗口：${item.window.from || '无'} → ${item.window.to || '无'}`)
    lines.push('', '### 研发', '')
    lines.push(`- N研 = ${item.requirements.length}`)
    lines.push(
      `- H研 = ${involved.length}（人工介入率 ${formatRatio(involved.length, item.requirements.length)}）`,
    )
    lines.push(
      `- A研 = ${success.length}（自主成功比例 ${formatRatio(success.length, item.requirements.length)}）`,
    )
    lines.push(`- 未知介入（记录不足）：${unknown.length}`)
    for (const sample of item.requirements) {
      const facts = sample.interventions.length > 0 ? sample.interventions.join('；') : '无记录介入'
      lines.push(
        `  - ${sample.reqId}｜${sample.status}｜验证 ${sample.verification || '无'}｜` +
          `部署 ${sample.deployed ? 'verified' : '无'}｜提交 ${sample.committed ? '有' : '无'}｜${facts}`,
      )
    }
    lines.push('', '### 运维', '')
    const human = item.incidents.filter((incident) => incident.humanInvolved)
    const recovered = item.incidents.filter(
      (incident) => !incident.humanInvolved && incident.recovered,
    )
    lines.push(`- 原始告警行 = ${item.events.length}；同一故障合并后计入分母`)
    lines.push(`- N运 = ${item.incidents.length}`)
    lines.push(
      `- H运 = ${human.length}（人工介入率 ${formatRatio(human.length, item.incidents.length)}）`,
    )
    lines.push(
      `- 自主恢复 = ${recovered.length}（恢复比例 ${formatRatio(recovered.length, item.incidents.length)}）`,
    )
    for (const incident of item.incidents) {
      lines.push(
        `  - ${incident.key}｜人工介入 ${incident.humanInvolved ? '是' : '否'}｜` +
          `关闭 ${incident.closed ? '是' : '否'}｜事件 ${incident.eventIds.length} 条：${incident.eventIds.join('、')}`,
      )
    }
    if (item.duplicates.requirements.length > 0 || item.duplicates.events.length > 0) {
      lines.push(
        '',
        `- 本归档内重复对象：需求 ${item.duplicates.requirements.length}、事件 ${item.duplicates.events.length}`,
      )
    }
    lines.push('')
  }
  lines.push('## 汇总（跨归档去重）', '')
  lines.push(
    `- N研 = ${totals.requirements.length}；H研 = ${totals.human}；A研 = ${totals.success}`,
  )
  lines.push(`- 人工介入率 ${formatRatio(totals.human, totals.requirements.length)}`)
  lines.push(`- 自主成功比例 ${formatRatio(totals.success, totals.requirements.length)}`)
  lines.push(`- 未知介入：${totals.unknown}`)
  lines.push(
    `- 重复样本（未计入）：需求 ${totals.duplicateRequirements.length}、事件 ${totals.duplicateEvents.length}`,
  )
  lines.push(`- N运 = ${totals.incidents.length}；H运 = ${totals.incidentHuman}`)
  lines.push(`- 运维人工介入率 ${formatRatio(totals.incidentHuman, totals.incidents.length)}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

interface Totals {
  readonly requirements: RequirementSample[]
  readonly human: number
  readonly success: number
  readonly unknown: number
  readonly duplicateRequirements: string[]
  readonly duplicateEvents: string[]
  readonly incidents: ReturnType<typeof groupIncidents>
  readonly incidentHuman: number
}

function totalsOf(reports: readonly DatabaseReport[]): Totals {
  const allRequirements = reports.flatMap((item) => item.requirements)
  const dedupedRequirements = dedupeByKey(
    allRequirements,
    (sample) => `${sample.project}:${sample.reqId}`,
  )
  const allEvents = reports.flatMap((item) =>
    item.events.map((event) => ({ ...event, key: `${event.project}:${event.eventId}` })),
  )
  const dedupedEvents = dedupeByKey(allEvents, (event) => event.key)
  const incidents = groupIncidents(dedupedEvents.unique)
  return {
    requirements: dedupedRequirements.unique,
    human: dedupedRequirements.unique.filter((sample) => sample.interventions.length > 0).length,
    success: dedupedRequirements.unique.filter((sample) => sample.success).length,
    unknown: dedupedRequirements.unique.filter((sample) => sample.unknown).length,
    duplicateRequirements: dedupedRequirements.duplicates,
    duplicateEvents: dedupedEvents.duplicates,
    incidents,
    incidentHuman: incidents.filter((incident) => incident.humanInvolved).length,
  }
}

function main(): void {
  const options = args()
  if (options.dbs.length === 0) {
    process.stdout.write(
      '没有可统计的记录库；先用 --db 指定或先运行真实 E2E 生成 reports/m1 归档。\n',
    )
    process.exit(0)
  }
  const reports = options.dbs.filter((db) => existsSync(db)).map(report)
  const markdown = render(reports, totalsOf(reports))
  if (options.out) {
    mkdirSync(options.out, { recursive: true })
    writeFileSync(join(options.out, 'stats.md'), markdown)
    writeFileSync(
      join(options.out, 'stats.json'),
      `${JSON.stringify({ reports, totals: totalsOf(reports) }, null, 2)}\n`,
    )
    process.stdout.write(`统计已写入 ${options.out}\n`)
  } else {
    process.stdout.write(markdown)
  }
}

// 只在直接执行时跑 CLI；被测试 import 时不能退出进程。
const invokedDirectly =
  typeof process.argv[1] === 'string' && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
