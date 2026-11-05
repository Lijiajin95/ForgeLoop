import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseVerificationCommands,
  parseVerificationReport,
  type VerificationCommand,
  type VerificationReport,
} from '../domain/verification.js'
import {
  CONTROLS_FILE,
  parseVerificationControls,
  type VerificationControlSpec,
} from '../domain/verification-controls.js'
import { errorMessage } from '../domain/errors.js'

export function parseVerificationMaterials(workspace: string):
  | {
      ok: true
      commands: VerificationCommand[]
      report: VerificationReport
      controls: VerificationControlSpec[]
    }
  | { ok: false; detail: string } {
  const commandsPath = join(workspace, 'verification/commands.json')
  const reportPath = join(workspace, 'verification/report.json')
  if (!existsSync(commandsPath) || !existsSync(reportPath)) {
    return {
      ok: false,
      detail: '独立验证未产出命令清单或逐场景报告；需重新验证',
    }
  }
  const controlsPath = join(workspace, CONTROLS_FILE)
  try {
    return {
      ok: true,
      commands: parseVerificationCommands(readFileSync(commandsPath, 'utf8')),
      report: parseVerificationReport(readFileSync(reportPath, 'utf8')),
      // 缺少对照文件按空数组处理，由覆盖校验给出“必过场景缺少敏感性对照”的阻断。
      controls: existsSync(controlsPath)
        ? parseVerificationControls(readFileSync(controlsPath, 'utf8'))
        : [],
    }
  } catch (error) {
    return { ok: false, detail: `独立验证材料畸形（fail-closed）：${errorMessage(error)}` }
  }
}
