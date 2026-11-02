#!/usr/bin/env node
/**
 * 宿主装载 E2E（不依赖模型）：
 * 1) 构建插件产物；2) 在隔离 DSH_HOME/独立 profile 中安装当前源码包；
 * 3) `--dump-config` 校验 forgeloop-dsh 层与工具/会话面已装载。
 *
 * 真实模型链路仍由 make verify-plugin 覆盖；本脚本只证明“安装→装载→组合”闭环。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = resolve(import.meta.dirname, '../..')
const PROFILE = process.env.FORGELOOP_E2E_PROFILE ?? 'forgeloop-e2e'
const DSH = process.env.FORGELOOP_DSH ?? 'dsh'
const home = mkdtempSync(join(tmpdir(), 'forgeloop-e2e-'))
const failures: string[] = []

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(DSH, args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home },
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

try {
  execFileSync('npm', ['run', 'build', '--workspace', 'forgeloop-dsh'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  })

  const installed = run(['plugin', '--profile', PROFILE, 'add', join(ROOT, 'packages/forgeloop')])
  if (installed.code !== 0)
    failures.push(`plugin add 失败：${installed.stderr || installed.stdout}`)
  else console.log(`[e2e] 已安装 forgeloop-dsh 到 profile=${PROFILE}（DSH_HOME=${home}）`)

  const dump = run(['--profile', PROFILE, '--dump-config'])
  if (dump.code !== 0) failures.push(`--dump-config 失败：${dump.stderr || dump.stdout}`)
  else {
    if (!dump.stdout.includes('forgeloop-dsh'))
      failures.push('--dump-config 未出现 forgeloop-dsh 层')
    if (!dump.stdout.includes('id: forgeloop'))
      failures.push('--dump-config 未出现 forgeloop 会话 preset')
  }

  const listed = run(['plugin', '--profile', PROFILE, 'list'])
  if (listed.code !== 0) failures.push(`plugin list 失败：${listed.stderr || listed.stdout}`)
  else if (!listed.stdout.includes('forgeloop-dsh@'))
    failures.push('plugin list 未包含 forgeloop-dsh')

  if (failures.length > 0) {
    console.error(`[e2e] 失败：\n- ${failures.join('\n- ')}`)
    process.exitCode = 1
  } else {
    console.log('[e2e] OK：隔离 profile 安装、DSH 装载与组合校验通过')
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
