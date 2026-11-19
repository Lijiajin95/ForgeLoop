import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sha256OfBytes } from '../domain/delivery.js'
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
      detail: '独立测试未产出命令清单或逐场景报告；需重新验证',
    }
  }
  const controlsPath = join(workspace, CONTROLS_FILE)
  try {
    return {
      ok: true,
      commands: parseVerificationCommands(readFileSync(commandsPath, 'utf8')),
      report: parseVerificationReport(readFileSync(reportPath, 'utf8')),
      controls: existsSync(controlsPath)
        ? parseVerificationControls(readFileSync(controlsPath, 'utf8'))
        : [],
    }
  } catch (error) {
    return { ok: false, detail: `独立测试材料畸形（fail-closed）：${errorMessage(error)}` }
  }
}

export function verificationMaterialDigest(workspace: string): string {
  const root = join(workspace, 'verification')
  if (!existsSync(root)) return ''
  const parts: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(relative ? join(root, relative) : root, {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (path === 'controls') continue
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.(?:js|mjs|cjs|ts|sh|py|ps1|rb)$/i.test(path)) continue
      parts.push(`${path}\0${sha256OfBytes(readFileSync(join(root, path)))}`)
    }
  }
  walk('')
  if (parts.length === 0) return ''
  return sha256OfBytes(Buffer.from(parts.sort().join('\n')))
}
