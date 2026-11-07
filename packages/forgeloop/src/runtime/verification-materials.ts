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

/**
 * 正向命令执行时的验证材料身份。冻结脚本/辅助文件内容，避免正向成功后替换脚本
 * 再做对照，把“旧结果 + 新脚本”拼成通过证据。元数据与对照补丁不参与，因为它们在
 * 对照阶段本来就会新增；脚本、fixture 等执行材料必须保持同一份。
 */
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
      // 只冻结可执行脚本；JSON 元数据、对照补丁与日志由运行时管理。
      if (!/\.(?:js|mjs|cjs|ts|sh|py|ps1|rb)$/i.test(path)) continue
      parts.push(`${path}\0${sha256OfBytes(readFileSync(join(root, path)))}`)
    }
  }
  walk('')
  if (parts.length === 0) return ''
  return sha256OfBytes(Buffer.from(parts.sort().join('\n')))
}
