import { asRecord } from '../domain/json.js'
import { parseJsonObject } from '../domain/json.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RuleViolationError } from '../domain/errors.js'
import { parsePlanReview, parseVerificationReport } from '../domain/verification.js'
import { sha256OfBytes } from '../domain/delivery.js'
import { projectDir, recordsPath, type ForgeLoopConfig } from '../config.js'
import { AgentRunner } from './agent-runner.js'
import { git } from './workspace.js'

export function summarizeActivity(events: readonly Record<string, unknown>[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || typeof event.type !== 'string') continue
    const data = asRecord(event.data)
    if (event.type === 'tool/call') {
      const name = typeof data?.name === 'string' ? data.name : '工具'
      return `正在调用工具 ${name}`
    }
    if (event.type === 'tool/result') return '工具返回结果'
    if (event.type === 'step/start') {
      const step = typeof data?.step === 'number' ? String(data.step) : ''
      return `执行步骤 ${step}`.trim()
    }
    if (event.type === 'assistant/message') return '模型回复并继续'
    if (event.type === 'turn/start') return '回合开始'
    if (event.type === 'turn/end') return '回合结束'
  }
  return '等待 Agent 活动'
}

function summarizeEvent(type: string, data: Record<string, unknown>): string {
  if (type === 'tool/call') {
    const name = typeof data.name === 'string' ? data.name : '工具'
    const args =
      typeof data.arguments === 'string' ? data.arguments.replace(/\s+/g, ' ').slice(0, 240) : ''
    return `调用 ${name}${args ? `: ${args}` : ''}`
  }
  if (type === 'tool/result') return '工具返回结果'
  if (type === 'assistant/message') {
    const message = asRecord(data.message)
    const content = Array.isArray(message?.content) ? message.content : []
    const text = content
      .filter(
        (block): block is Record<string, unknown> => typeof block === 'object' && block !== null,
      )
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => String(block.text))
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 300)
    return text ? `模型回复: ${text}` : '模型回复'
  }
  if (type === 'step/start') return `步骤 ${typeof data.step === 'number' ? data.step : ''}`.trim()
  if (type === 'turn/start' || type === 'turn/end')
    return type === 'turn/start' ? '回合开始' : '回合结束'
  return type
}

function activityItem(line: string): { type: string; at: string; summary: string } | null {
  try {
    const event = parseJsonObject(line)
    const type = typeof event.type === 'string' ? event.type : 'event'
    const data = asRecord(event.data) ?? {}
    const at = typeof event.time === 'number' ? new Date(event.time).toISOString() : ''
    return { type, at, summary: summarizeEvent(type, data) }
  } catch {
    // 轨迹中损坏的单行不阻断详情页。
    return null
  }
}

export function readActivity(
  path: string,
  limit: number,
): {
  items: Array<{ type: string; at: string; summary: string }>
  total: number
  truncated: boolean
} {
  if (!existsSync(path)) return { items: [], total: 0, truncated: false }
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
  const items = lines
    .slice(-limit)
    .map(activityItem)
    .filter((item): item is { type: string; at: string; summary: string } => item !== null)
  return { items, total: lines.length, truncated: lines.length > limit }
}

export function readJson(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function planReviewBlocking(reportJson: string): string {
  try {
    const review = parsePlanReview(reportJson)
    return review.blocking.length > 0 ? review.blocking.join('；') : review.summary
  } catch {
    return reportJson.slice(0, 300)
  }
}

export function verificationBlocking(reportJson: string): string {
  try {
    const report = parseVerificationReport(reportJson)
    return report.blocking.length > 0 ? report.blocking.join('；') : report.summary
  } catch {
    return reportJson.slice(0, 300)
  }
}

/**
 * 业务验收的证据窗口：前置断言通常出现在输出开头，结论与退出信息在末尾。
 * 只截尾部会让开头打印的证据无法核对；这里保留开头与末尾，中间省略。
 */
export function businessReviewEvidenceWindow(output: string, window = 4000): string {
  if (output.length <= window * 2) return output
  return `${output.slice(0, window)}\n…（中间省略 ${output.length - window * 2} 字符）…\n${output.slice(-window)}`
}

/** 测试 Agent 的合法材料目录；候选受保护内容不含此目录。 */
export const VERIFICATION_MATERIAL_DIR = 'verification/'

/**
 * 列出 Git 可见的工作区变化（含未忽略的新文件）。Git 忽略的构建输出
 * （例如 `packages` 下的 `lib` 目录、`coverage` 目录）不属于候选，也不进入本列表。
 */
export function workspaceChanges(workspace: string): string[] {
  // 不能用 requireGit：它会给输出 trim，从而吃掉首条记录状态位前的空格。
  const result = git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (result.code !== 0) {
    throw new RuleViolationError(`git status 失败：${result.stderr.trim() || result.stdout.trim()}`)
  }
  const entries = result.stdout.split('\0')
  const paths: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (status.includes('R') || status.includes('C')) index += 1
    if (path) paths.push(path)
  }
  return [...new Set(paths)].sort()
}

/** 记录测试材料清单与摘要，使报告能绑定实际存在的材料。 */
export function verificationMaterials(
  dir: string,
): Array<{ path: string; sha256: string; bytes: number }> {
  const root = join(dir, 'workspace', 'verification')
  if (!existsSync(root)) return []
  const files: Array<{ path: string; sha256: string; bytes: number }> = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(relative ? join(root, relative) : root, {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const bytes = readFileSync(join(root, path))
      files.push({
        path: `verification/${path}`,
        sha256: sha256OfBytes(bytes),
        bytes: bytes.length,
      })
    }
  }
  walk('')
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

export function parseFormalTestHeader(text: string): {
  startedAt: string
  durationMs: number | null
  timedOut: boolean | null
  aborted: boolean | null
  exitCode: number | null
} {
  const value = (key: string): string => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)
    return match?.[1]?.trim() ?? ''
  }
  const numberOrNull = (key: string): number | null => {
    const raw = value(key)
    if (!raw) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  const boolOrNull = (key: string): boolean | null => {
    const raw = value(key)
    return raw === 'true' ? true : raw === 'false' ? false : null
  }
  return {
    startedAt: value('started'),
    durationMs: numberOrNull('duration_ms'),
    timedOut: boolOrNull('timed_out'),
    aborted: boolOrNull('aborted'),
    exitCode: numberOrNull('exit_code'),
  }
}

/** 目录摘要：暴露记录根、项目目录与当前 Agent 选择，供状态页与自检使用。 */
export function directorySummaryOf(config: ForgeLoopConfig, runner: unknown): unknown {
  return {
    recordsRoot: config.recordsRoot,
    projectDir: projectDir(config),
    database: recordsPath(config),
    projectPath: config.projectPath,
    agent:
      runner instanceof AgentRunner
        ? runner.resolveSelection()
        : { provider: config.agent.provider, model: config.agent.model },
    autoAdvance: config.autoAdvance,
  }
}
