import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseVerificationCommands,
  parseVerificationReport,
  type VerificationCommand,
  type VerificationReport,
} from '../domain/verification.js'
import { errorMessage } from '../domain/errors.js'

export function parseVerificationMaterials(
  workspace: string,
):
  | { ok: true; commands: VerificationCommand[]; report: VerificationReport }
  | { ok: false; detail: string } {
  const commandsPath = join(workspace, 'verification/commands.json')
  const reportPath = join(workspace, 'verification/report.json')
  if (!existsSync(commandsPath) || !existsSync(reportPath)) {
    return {
      ok: false,
      detail: '独立验证未产出命令清单或逐场景报告；需重新验证',
    }
  }
  try {
    return {
      ok: true,
      commands: parseVerificationCommands(readFileSync(commandsPath, 'utf8')),
      report: parseVerificationReport(readFileSync(reportPath, 'utf8')),
    }
  } catch (error) {
    return { ok: false, detail: `独立验证材料畸形（fail-closed）：${errorMessage(error)}` }
  }
}
