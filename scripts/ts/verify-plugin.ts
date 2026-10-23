#!/usr/bin/env node
/**
 * 真实 DSH 宿主装载验证：检查 profile 是否安装插件、可组合，并在真实模型下调用插件工具。
 * `--full` 还会通过 commands registry 执行只读的 `/fl status`。
 *
 * 需要：FORGELOOP_DSH_HOME（或 .cache/forgeloop/dsh-home）、FORGELOOP_PROFILE（或 forgeloop）、
 * 以及宿主可用的模型凭据（由启动环境提供，本脚本不读取或打印密钥）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(import.meta.dirname, '../..')
const DSH_HOME = resolve(process.env.FORGELOOP_DSH_HOME ?? join(ROOT, '.cache/forgeloop/dsh-home'))
const PROFILE = process.env.FORGELOOP_PROFILE ?? 'forgeloop'
const DSH = process.env.FORGELOOP_DSH ?? 'dsh'
const full = process.argv.includes('--full')
const failures: string[] = []

function dsh(args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(DSH, args, {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      env: { ...process.env, DSH_HOME },
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string }
    return {
      code: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? '',
    }
  }
}

function checkProfile(): void {
  const profileDir = join(DSH_HOME, 'profiles', PROFILE)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    failures.push(`profile ${PROFILE} 不存在：${manifestPath}`)
    return
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh?: { profile?: { bundles?: string[] } }
    dependencies?: Record<string, string>
  }
  if (!manifest.dsh?.profile?.bundles?.includes('forgeloop-dsh')) {
    failures.push('profile 的 dsh.profile.bundles 未包含 forgeloop-dsh')
  }
  const installed = join(profileDir, 'node_modules/forgeloop-dsh')
  if (!existsSync(installed)) {
    failures.push(`profile 未安装 forgeloop-dsh：${installed}`)
    return
  }
  let kind = 'installed-copy'
  try {
    kind = `link:${readlinkSync(installed)}`
  } catch {
    // 真实安装目录，不是链接。
  }
  const packageJson = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
    version?: string
  }
  console.log(
    `[verify-plugin] profile=${profileDir} package=forgeloop-dsh@${packageJson.version ?? '?'} kind=${kind}`,
  )

  const dump = dsh(['--profile', PROFILE, '--dump-config'])
  if (dump.code !== 0) failures.push(`--dump-config 失败：${dump.stderr.trim()}`)
  else if (!dump.stdout.includes('forgeloop-dsh')) failures.push('--dump-config 未出现 forgeloop-dsh 层')
}

function checkToolLoop(): void {
  const result = dsh([
    '--profile',
    PROFILE,
    '--json',
    'Call the forgeloop_status tool with empty arguments, then answer with the tool ok flag.',
  ])
  if (result.code !== 0) {
    failures.push(`真实模型工具调用失败（退出码 ${result.code}）：${result.stderr.trim().slice(0, 500)}`)
    return
  }
  if (!result.stdout.includes('"tool":"forgeloop_status"')) {
    failures.push('模型没有调用 forgeloop_status 工具')
  }
  if (!result.stdout.includes('"kind":"completed"')) {
    failures.push('模型回合没有正常结束')
  }
  const final = /"type":"final","text":(.*)$/m.exec(result.stdout)
  console.log(`[verify-plugin] tool-loop final=${final ? final[1]!.slice(0, 120) : '(none)'}`)
}

function checkCommands(): void {
  const probeDir = join(ROOT, '.cache/forgeloop/verify')
  mkdirSync(probeDir, { recursive: true })
  const patch = join(probeDir, 'commands.patch.yml')
  const module = join(probeDir, 'commands-probe.mjs')
  writeFileSync(
    module,
    `import { randomUUID } from 'node:crypto'
export const name = 'forgeloop-verify-commands'
export const inject = ['commands', 'agents', 'agentLoop', 'agentDefaultModel']
export async function apply(ctx) {
  const selection = ctx.agentDefaultModel.currentSelection()
  const handle = await ctx.agents.create({
    sessionId: 'session-verify-' + randomUUID(),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
  })
  try {
    const execution = await ctx.commands.execute(handle.agent, '/fl status', [], new AbortController().signal)
    console.log('VERIFY_COMMAND_RESULT', JSON.stringify(execution?.result ?? null))
  } finally {
    await handle.dispose()
  }
}
`,
    'utf8',
  )
  writeFileSync(patch, `- insert:\n    - id: forgeloop-verify-commands\n      name: ./commands-probe.mjs\n`, 'utf8')
  const result = dsh(['--profile', PROFILE, '--patch', patch, 'Reply with OK.'])
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith('VERIFY_COMMAND_RESULT'))
  if (!line) {
    failures.push(`命令注册表探针没有输出：${result.stderr.trim().slice(0, 500)}`)
    return
  }
  const parsed = JSON.parse(line.slice('VERIFY_COMMAND_RESULT '.length)) as { kind?: string }
  if (parsed.kind !== 'success') failures.push(`/fl status 返回 ${parsed.kind ?? 'unknown'} 而不是 success`)
  console.log(`[verify-plugin] command=/fl status kind=${parsed.kind ?? 'unknown'}`)
}

checkProfile()
if (failures.length === 0) {
  checkToolLoop()
  if (full) checkCommands()
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[verify-plugin] FAIL ${failure}`)
  process.exitCode = 1
} else {
  console.log('[verify-plugin] OK：profile 安装、组合层、真实模型工具链与命令入口均可用')
}