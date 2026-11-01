import { existsSync, readFileSync } from 'node:fs'
import { sha256OfText } from '../domain/delivery.js'
import { businessReviewEvidenceWindow } from './service-helpers.js'

function verificationFact(raw: unknown):
  | {
      ok: true
      fact: { label: string; argv: readonly string[]; exitCode: number | null; logTail: string }
    }
  | { ok: false; detail: string }
  | null {
  if (typeof raw !== 'object' || raw === null) return null
  const command = raw as Record<string, unknown>
  const label = typeof command.label === 'string' ? command.label : ''
  const logPath = typeof command.logPath === 'string' ? command.logPath : ''
  if (!label || !logPath) return null
  if (!existsSync(logPath)) {
    return { ok: false, detail: `验证命令 ${label} 的日志缺失；不能做业务终审` }
  }
  const text = readFileSync(logPath, 'utf8')
  if (typeof command.logSha256 === 'string' && sha256OfText(text) !== command.logSha256) {
    return { ok: false, detail: `验证命令 ${label} 的日志摘要不一致；不能做业务终审` }
  }
  return {
    ok: true,
    fact: {
      label,
      argv: Array.isArray(command.argv) ? command.argv.map((part) => String(part)) : [],
      exitCode: typeof command.exitCode === 'number' ? command.exitCode : null,
      logTail: businessReviewEvidenceWindow(text),
    },
  }
}

export function reviewFacts(reportPath: string):
  | {
      ok: true
      facts: Array<{
        label: string
        argv: readonly string[]
        exitCode: number | null
        logTail: string
      }>
    }
  | { ok: false; detail: string } {
  let canonical: Record<string, unknown> = {}
  try {
    canonical = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
  } catch {
    return { ok: false, detail: '独立验证报告无法解析；不能做业务终审' }
  }
  const commands = Array.isArray(canonical.commands) ? canonical.commands : []
  const facts: Array<{
    label: string
    argv: readonly string[]
    exitCode: number | null
    logTail: string
  }> = []
  for (const raw of commands) {
    const parsed = verificationFact(raw)
    if (parsed === null) continue
    if (!parsed.ok) return parsed
    facts.push(parsed.fact)
  }
  if (facts.length === 0) {
    return { ok: false, detail: '独立验证没有可核对的命令输出；不能做业务终审' }
  }
  return { ok: true, facts }
}
