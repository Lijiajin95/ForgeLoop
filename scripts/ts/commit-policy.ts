#!/usr/bin/env node
/**
 * 提交策略校验（TypeScript 版）：本地时间窗、授权批次与提交消息头。
 *
 * 生效配置只有一份来源：仓库 `.cache/forgeloop/commit-policy.toml` 或用户级
 * `~/.config/forgeloop/commit-policy.toml`（二选一）。没有生效配置时不执行时间禁止，
 * 输出显式标注 policy_absent / NOT enforced；配置损坏、年历缺失仍拒绝（fail-closed）。
 * 这些限制是客户端本地的，不构成服务端强制。
 *
 * 用法：
 *   node scripts/ts/commit-policy.ts --validate-config
 *   node scripts/ts/commit-policy.ts --check-now
 *   node scripts/ts/commit-policy.ts --message-file .git/COMMIT_EDITMSG
 *   node scripts/ts/commit-policy.ts --audit <base>..<head>
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const REPO_CONFIG = '.cache/forgeloop/commit-policy.toml'
const USER_CONFIG = '.config/forgeloop/commit-policy.toml'
const MAX_AUTHORIZED_END = '10:00'
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert|release)(\([^)]+\))?!?: \S/

interface Window {
  start: string
  end: string
}

interface Batch {
  date: string
  authorization_source: string
}

interface PolicyDocument {
  timezone?: unknown
  calendar_directory?: unknown
  blocked_windows?: unknown
  authorized_window?: unknown
  authorized_batches?: unknown
  machine_label?: unknown
}

interface Policy {
  timezone: string
  calendarDirectory: string
  blocked: Window[]
  authorized: Window | null
  batches: Map<string, Batch>
  machineLabel: string
  source: string
}

interface Calendar {
  holidays: Set<string>
  extraWorkdays: Set<string>
}

class PolicyError extends Error {}

function parseTime(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
    throw new PolicyError(`${field} 必须是 HH:MM，实际 ${JSON.stringify(value)}`)
  }
  const [hour, minute] = value.split(':').map(Number) as [number, number]
  if (hour > 23 || minute > 59) throw new PolicyError(`${field} 不是合法时间：${value}`)
  return hour * 60 + minute
}

function windowOf(value: unknown, field: string): Window {
  const record = value as Record<string, unknown>
  const start = record?.start
  const end = record?.end
  const startMinutes = parseTime(start, `${field}.start`)
  const endMinutes = parseTime(end, `${field}.end`)
  if (endMinutes <= startMinutes) throw new PolicyError(`${field} 终点必须晚于起点`)
  return { start: String(start), end: String(end) }
}

function minutesOf(window: Window): [number, number] {
  return [parseTime(window.start, 'start'), parseTime(window.end, 'end')]
}

function loadDocument(): PolicyDocument | null {
  const repoPath = join(REPO_ROOT, REPO_CONFIG)
  const userPath = join(homedir(), USER_CONFIG)
  const path = existsSync(repoPath) ? repoPath : existsSync(userPath) ? userPath : ''
  if (!path) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new PolicyError(`生效配置不可读 ${path}：${(error as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = parseToml(text)
  } catch (error) {
    throw new PolicyError(`生效配置损坏 ${path}：${(error as Error).message}`)
  }
  return { ...(parsed as PolicyDocument), __path: path } as PolicyDocument
}

function compilePolicy(document: PolicyDocument): Policy {
  const blockedRaw = document.blocked_windows
  if (!Array.isArray(blockedRaw) || blockedRaw.length === 0) {
    throw new PolicyError('blocked_windows 必须是非空数组')
  }
  const blocked = blockedRaw.map((item, index) => windowOf(item, `blocked_windows[${index}]`))
  for (let index = 1; index < blocked.length; index += 1) {
    const [previousEnd] = minutesOf(blocked[index - 1]!)
    const [currentStart] = minutesOf(blocked[index]!)
    if (currentStart < previousEnd) throw new PolicyError('blocked_windows 必须按起点有序且不重叠')
  }
  let authorized: Window | null = null
  if (document.authorized_window !== undefined) {
    authorized = windowOf(document.authorized_window, 'authorized_window')
    const [start, end] = minutesOf(authorized)
    if (end > parseTime(MAX_AUTHORIZED_END, 'authorized_window.end')) {
      throw new PolicyError(`authorized_window 不得晚于 ${MAX_AUTHORIZED_END}`)
    }
    const inside = blocked.some((window) => {
      const [blockedStart, blockedEnd] = minutesOf(window)
      return start >= blockedStart && end <= blockedEnd
    })
    if (!inside) throw new PolicyError('authorized_window 必须完全落在某段 blocked_windows 内')
  }
  const batches = new Map<string, Batch>()
  const rawBatches = document.authorized_batches
  if (rawBatches !== undefined) {
    if (!Array.isArray(rawBatches)) throw new PolicyError('authorized_batches 必须是数组')
    for (const [index, item] of rawBatches.entries()) {
      const record = item as Record<string, unknown>
      if (typeof record?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
        throw new PolicyError(`authorized_batches[${index}].date 必须是 YYYY-MM-DD`)
      }
      if (typeof record.authorization_source !== 'string' || !record.authorization_source.trim()) {
        throw new PolicyError(`authorized_batches[${index}].authorization_source 不能为空`)
      }
      batches.set(record.date, {
        date: record.date,
        authorization_source: record.authorization_source,
      })
    }
  }
  const timezone = typeof document.timezone === 'string' && document.timezone ? document.timezone : ''
  if (!timezone) throw new PolicyError('timezone 不能为空')
  const calendarDirectory =
    typeof document.calendar_directory === 'string' ? document.calendar_directory : ''
  if (!calendarDirectory) throw new PolicyError('calendar_directory 不能为空')
  const calendarPath = join(REPO_ROOT, calendarDirectory)
  if (!existsSync(calendarPath)) throw new PolicyError(`年历目录缺失：${calendarPath}`)
  return {
    timezone,
    calendarDirectory: calendarPath,
    blocked,
    authorized,
    batches,
    machineLabel: typeof document.machine_label === 'string' ? document.machine_label : '',
    source: String((document as unknown as { __path?: string }).__path ?? ''),
  }
}

function loadPolicy(): Policy | null {
  const document = loadDocument()
  return document ? compilePolicy(document) : null
}

function localParts(policy: Policy, now: Date): { date: string; minutes: number; text: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: policy.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]))
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return { date, minutes, text: `${date} ${parts.hour}:${parts.minute} (${policy.timezone})` }
}

function loadCalendar(policy: Policy, year: number): Calendar {
  const path = join(policy.calendarDirectory, `${year}.json`)
  if (!existsSync(path)) throw new PolicyError(`缺少 ${year} 年工作日历：${path}`)
  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new PolicyError(`工作日历损坏 ${path}：${(error as Error).message}`)
  }
  const record = data as { holidays?: unknown; extra_workdays?: unknown }
  const asSet = (value: unknown, field: string): Set<string> => {
    if (value === undefined) return new Set()
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new PolicyError(`${field} 必须是日期字符串数组`)
    }
    return new Set(value as string[])
  }
  return {
    holidays: asSet(record.holidays, 'holidays'),
    extraWorkdays: asSet(record.extra_workdays, 'extra_workdays'),
  }
}

function isWorkday(calendar: Calendar, date: string): boolean {
  if (calendar.extraWorkdays.has(date)) return true
  if (calendar.holidays.has(date)) return false
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return weekday !== 0 && weekday !== 6
}

type DecisionReason =
  | 'policy_absent'
  | 'outside_work_hours'
  | 'non_workday'
  | 'authorized'
  | 'blocked'
  | 'invalid_config'
  | 'message_ok'
  | 'message_invalid'

interface Decision {
  allowed: boolean
  reason: DecisionReason
  detail: string
}

function decide(policy: Policy | null, now: Date): Decision {
  if (policy === null) {
    return {
      allowed: true,
      reason: 'policy_absent',
      detail: 'no local commit policy configured; commit time restriction NOT enforced (not server-enforced)',
    }
  }
  const local = localParts(policy, now)
  const calendar = loadCalendar(policy, Number(local.date.slice(0, 4)))
  if (!isWorkday(calendar, local.date)) {
    return { allowed: true, reason: 'non_workday', detail: `${local.text} 是非工作日；时间限制不适用` }
  }
  const hit = policy.blocked.find((window) => {
    const [start, end] = minutesOf(window)
    return local.minutes >= start && local.minutes < end
  })
  if (!hit) {
    return { allowed: true, reason: 'outside_work_hours', detail: `${local.text} 不在任何禁止窗口内` }
  }
  if (policy.authorized) {
    const [start, end] = minutesOf(policy.authorized)
    const inNarrow = local.minutes >= start && local.minutes < end
    const batch = policy.batches.get(local.date)
    if (inNarrow && batch) {
      return {
        allowed: true,
        reason: 'authorized',
        detail: `${local.text} 命中授权窄口 ${policy.authorized.start}-${policy.authorized.end}；来源：${batch.authorization_source}`,
      }
    }
  }
  return {
    allowed: false,
    reason: 'blocked',
    detail: `${local.text} 命中禁止窗口 ${hit.start}-${hit.end}`,
  }
}

function messageHeader(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#')) ?? ''
}

function report(decision: Decision, policy: Policy | null): void {
  const source = policy?.source ?? 'absent'
  console.log(
    `[commit-policy] effective ${source}; machine ${policy?.machineLabel || '(none)'}; ` +
      `client-side local policy; not server-enforced`,
  )
  console.log(`[commit-policy] decision ${decision.reason}: ${decision.detail}`)
}

function main(argv: string[]): number {
  const args = new Set(argv)
  let policy: Policy | null = null
  try {
    policy = loadPolicy()
  } catch (error) {
    console.error(`[commit-policy] invalid_config: ${(error as Error).message}`)
    return 1
  }
  if (args.has('--validate-config')) {
    if (policy === null) {
      console.log('[commit-policy] policy_absent: 没有生效配置；时间限制 NOT enforced')
      return 0
    }
    console.log(`[commit-policy] 配置有效：${policy.source}`)
    return 0
  }
  const auditIndex = argv.indexOf('--audit')
  if (auditIndex >= 0) {
    const range = argv[auditIndex + 1]
    if (!range) {
      console.error('[commit-policy] --audit 需要 base..head 范围')
      return 1
    }
    const log = execFileSync('git', ['log', '--format=%H%x00%s%x00%aI', range], {
      encoding: 'utf8',
    })
    let bad = 0
    for (const line of log.split('\n').filter(Boolean)) {
      const [sha, subject, date] = line.split('\u0000')
      if (!sha || !subject) continue
      if (!CONVENTIONAL.test(subject)) {
        console.error(`[commit-policy] message_invalid ${sha.slice(0, 12)} ${subject}`)
        bad += 1
      }
      if (!date) {
        console.error(`[commit-policy] timestamp_missing ${sha.slice(0, 12)}`)
        bad += 1
      }
    }
    console.log(
      `[commit-policy] audit ${range}: ${bad === 0 ? 'OK' : `${bad} 项不合格`}（消息头与时间戳；历史时间窗不追溯判定）`,
    )
    return bad === 0 ? 0 : 1
  }
  const messageIndex = argv.indexOf('--message-file')
  if (messageIndex >= 0) {
    const path = argv[messageIndex + 1]
    if (!path) {
      console.error('[commit-policy] --message-file 需要文件路径')
      return 1
    }
    const header = messageHeader(readFileSync(path, 'utf8'))
    if (!CONVENTIONAL.test(header)) {
      console.error(`[commit-policy] message_invalid: 提交消息头不符合 Conventional Commits：${header}`)
      return 1
    }
    console.log(`[commit-policy] message_ok: ${header}`)
    return 0
  }
  try {
    const decision = decide(policy, new Date())
    report(decision, policy)
    return decision.allowed ? 0 : 1
  } catch (error) {
    console.error(`[commit-policy] invalid_config: ${(error as Error).message}`)
    return 1
  }
}

process.exitCode = main(process.argv.slice(2))