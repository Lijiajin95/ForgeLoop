#!/usr/bin/env node
/** 在独立的真实 DSH Web profile 验证安装包、命令、HTTP 载体及跨宿主重启回查。
 * 不调用模型，不修改用户 Desktop/Web profile；不把命令探针称为浏览器 UI 验收。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '../..')
const cache = join(root, '.cache/forgeloop')
mkdirSync(cache, { recursive: true })
const run = mkdtempSync(join(cache, 'verify-web-'))
const home = join(run, 'home')
const project = join(run, 'project')
const profile = 'forgeloop-web'
const dsh = process.env.FORGELOOP_DSH ?? 'dsh'
const manifest = JSON.parse(readFileSync(join(root, 'packages/forgeloop/package.json'), 'utf8'))
const artifact = resolve(process.env.FORGELOOP_ARTIFACT ?? join(root, `packages/forgeloop/dist/forgeloop-dsh-${manifest.version}.tgz`))
if (!existsSync(artifact)) throw new Error('先运行 make package，或指定 FORGELOOP_ARTIFACT')
mkdirSync(project, { recursive: true })
const env = { ...process.env, DSH_HOME: home }

function command(args: string[], label: string): void {
  const log = openSync(join(run, `${label}.log`), 'w', 0o600)
  try {
    execFileSync(dsh, args, { cwd: root, env, stdio: ['ignore', log, log], timeout: 120_000 })
  } finally {
    closeSync(log)
  }
}

command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'compose')
command(['plugin', '--profile', profile, 'add', artifact], 'install')
const receipt = join(run, 'submitted.json')
const patch = join(run, 'verify.patch.yml')
const modulePath = join(run, 'probe.mjs')
writeFileSync(modulePath, `
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
export const name = 'forgeloop-web-verification'
export const inject = ['agents', 'agentLoop', 'commands', 'tools', 'webServer']
export async function apply(ctx) {
  const report = { surface: 'web', phase: process.env.FORGELOOP_VERIFY_PHASE, commands: [], ok: false }
  let handle
  try {
    handle = await ctx.agents.create({sessionId: 'session-fl-web-' + randomUUID(), meta: {cwd: ${JSON.stringify(project)}}, agentOptions: {provider: 'verification-no-model', model: 'unused'}})
    for (let n=0; !ctx.commands.list(handle.agent).some(x=>x.name==='fl') && n<100; n++) await new Promise(r=>setTimeout(r, 20))
    async function execute(input) {
      const entry = await ctx.commands.execute(handle.agent, input, [], new AbortController().signal)
      const result = entry?.result
      if (result?.kind !== 'success') throw new Error(input + ': ' + JSON.stringify(result))
      report.commands.push({input, result})
      return result.text ?? ''
    }
    const config = await execute('/fl config')
    if (!config.includes(${JSON.stringify(join(project, '.forgeloop'))})) throw new Error('recordsRoot 未相对项目解析')
    let reqId
    if (report.phase === 'first') {
      const result = await execute('/fl submit Web 宿主验收：重启后保留原始需求与身份')
      const start = result.indexOf('\\n{')
      if (start < 0) throw new Error('提交结果缺少对象身份')
      reqId = JSON.parse(result.slice(start + 1)).reqId
      if (typeof reqId !== 'string') throw new Error('提交结果缺少 reqId')
      writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({reqId}))
    } else {
      if (!existsSync(${JSON.stringify(receipt)})) throw new Error('缺少首次真实提交回执')
      reqId = JSON.parse(readFileSync(${JSON.stringify(receipt)}, 'utf8')).reqId
    }
    const status = await execute('/fl status ' + reqId)
    if (!status.includes(reqId)) throw new Error('重启查询没有返回同一需求身份')
    report.reqId = reqId
    report.toolRegistered = ctx.tools.schemas().some(x=>x.name==='forgeloop_status')
    if (!report.toolRegistered) throw new Error('未注册 forgeloop_status')
    report.port = ctx.webServer.port
    if (!(report.port > 0)) throw new Error('真实 Web 监听器未启动')
    report.ok = true
  } catch (error) {
    report.error = String(error?.message ?? error)
  } finally {
    if (handle) await handle.dispose()
    writeFileSync(process.env.FORGELOOP_VERIFY_REPORT, JSON.stringify(report, null, 2))
  }
}
`, 'utf8')
writeFileSync(patch, `- id: forgeloop
  config:
    project: host-verification
    projectPath: ${JSON.stringify(project)}
    autoAdvance: false
- insert:
    - id: forgeloop-web-verification
      name: ${JSON.stringify(modulePath)}
`, 'utf8')

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null || child.signalCode !== null) return
    await delay(50)
  }
  child.kill('SIGKILL')
  throw new Error('Web 宿主没有在五秒内退出；不能视为正常停机')
}

const reports: unknown[] = []
try {
  for (const phase of ['first', 'restarted']) {
    const reportPath = join(run, `${phase}.json`)
    const log = openSync(join(run, `${phase}.log`), 'w', 0o600)
    const child = spawn(dsh, ['--profile', profile, '--patch', patch, '--no-open', '--port', '0'], {
      cwd: root,
      env: { ...env, FORGELOOP_VERIFY_PHASE: phase, FORGELOOP_VERIFY_REPORT: reportPath },
      stdio: ['ignore', log, log],
    })
    closeSync(log)
    let spawnError: Error | undefined
    child.on('error', (error) => { spawnError = error })
    try {
      const deadline = Date.now() + 60_000
      while (!existsSync(reportPath)) {
        if (spawnError) throw spawnError
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${phase}: Web 宿主提前退出`)
        if (Date.now() > deadline) throw new Error(`${phase}: Web 探针超时`)
        await delay(100)
      }
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      if (!report.ok) throw new Error(`${phase}: ${report.error}`)
      const response = await fetch(`http://127.0.0.1:${report.port}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      if (![200, 302, 401, 403].includes(response.status)) throw new Error(`Web HTTP 入口异常: ${response.status}`)
      report.httpStatus = response.status
      reports.push(report)
    } finally {
      await stop(child)
    }
  }
  writeFileSync(join(run, 'report.json'), JSON.stringify({ version: manifest.version, artifact, reports }, null, 2))
  console.log(`[verify-web] OK: Web 宿主安装、/fl 命令、真实提交与重启回查；报告 ${join(run, 'report.json')}`)
  console.log('[verify-web] 本检查不调用模型、不替代 Desktop 或浏览器界面验收。')
} catch (error) {
  console.error(`[verify-web] FAIL: ${(error as Error).message}；现场 ${run}`)
  process.exitCode = 1
}
