import { join } from 'node:path'
import type { VerificationCommand } from '../domain/verification.js'

export interface VerificationCommandRun {
  label: string
  argv: readonly string[]
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  logPath: string
  logSha256: string
  durationMs: number
  output: string
}

export interface VerificationCommandTestResult {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  logPath: string
  logSha256: string
  durationMs: number
  output: string
}

export async function runVerificationCommands(input: {
  reqId: string
  dir: string
  commands: readonly VerificationCommand[]
  run: (argv: readonly string[], logPath: string) => Promise<VerificationCommandTestResult>
  setBlocked: (message: string) => void
}): Promise<
  | { ok: true; commandRuns: VerificationCommandRun[]; failedCommands: string[] }
  | { ok: false; detail: string }
> {
  const { dir, commands, run, setBlocked } = input
  const commandRuns: VerificationCommandRun[] = []
  const failedCommands: string[] = []
  for (const [index, command] of commands.entries()) {
    const label =
      command.label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || `command-${index + 1}`
    const test = await run(command.argv, join(dir, `verification-${index + 1}-${label}.log`))
    commandRuns.push({
      label: command.label,
      argv: command.argv,
      exitCode: test.exitCode,
      timedOut: test.timedOut,
      aborted: test.aborted,
      logPath: test.logPath,
      logSha256: test.logSha256,
      durationMs: test.durationMs,
      output: test.output,
    })
    if (test.aborted) {
      setBlocked('独立测试命令被停止；测试工作区可丢弃，可重新验证')
      return {
        ok: false,
        detail: '独立测试命令被停止：测试工作区可丢弃，候选未被判定失败；可重新验证',
      }
    }
    if (test.timedOut) {
      failedCommands.push(`${command.label} 超时`)
    } else if (test.exitCode !== 0) {
      failedCommands.push(
        `${command.label} 退出码 ${test.exitCode === null ? 'null' : test.exitCode}`,
      )
    }
  }
  return { ok: true, commandRuns, failedCommands }
}
