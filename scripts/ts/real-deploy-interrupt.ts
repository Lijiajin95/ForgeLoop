#!/usr/bin/env node
/**
 * M1-5 真实中断恢复演练（opt-in）：部署已开始、结果尚未持久化时真实杀掉宿主进程，
 * 再由新宿主读取权威记录、观测外部副作用并收口；证明不会重复安装。
 *
 * 覆盖两种结果：
 * - 副作用可确认（制品已落地、status 可读）→ 收口 applied_pending_verify，不重装；
 * - 副作用无法确认（安装结果丢失）→ 记 recovery_unknown，保持待人工决定，不重放。
 *
 * 用法：node scripts/ts/real-deploy-interrupt.ts
 * 证据写入 reports/m1/interrupt-<stamp>/。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Database } from '../../packages/forgeloop/lib/records/db.js'
import { Repository } from '../../packages/forgeloop/lib/records/repository.js'
import { Deployments } from '../../packages/forgeloop/lib/runtime/deployments.js'
import { resolveConfig } from '../../packages/forgeloop/lib/config.js'

const ROOT = resolve(import.meta.dirname, '../..')
const PROJECT = 'm1-interrupt'

const TOOL_SH = `#!/bin/sh
# 部署工具：包装成 shell 入口，实际逻辑在同目录 tool.mjs；不引用任何解释器私有路径。
exec node "$(dirname "$0")/tool.mjs" "$@"
`

const TOOL_MJS = String.raw`import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const op = argv[argv.indexOf('--op') + 1]
const plan = JSON.parse(readFileSync(argv[argv.indexOf('--plan') + 1], 'utf8'))
const site = plan.params.site
const target = join(site, 'target')
mkdirSync(target, { recursive: true })
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n')

if (op === 'preflight') {
  out({ ok: true, state: 'ready', detail: 'preflight ok', version: '1.0.0' })
} else if (op === 'apply') {
  appendFileSync(join(site, 'install-count.log'), plan.intentId + ' ' + plan.artifact.sha256 + '\n')
  mkdirSync(join(target, 'current'), { recursive: true })
  copyFileSync(plan.artifact.path, join(target, 'current', 'artifact.tgz'))
  const installed = {
    artifactSha256: plan.artifact.sha256,
    version: plan.artifact.version,
    installedAt: new Date().toISOString(),
    runningPid: process.pid,
    startedAt: new Date().toISOString(),
  }
  writeFileSync(join(target, 'installed.json'), JSON.stringify(installed, null, 2))
  const sleepMs = Number(process.env.M1_INSTALL_SLEEP_SECONDS ?? '10') * 1000
  await new Promise((done) => setTimeout(done, sleepMs))
  out({ ok: true, state: 'applied', detail: 'apply ok', version: installed.version })
} else if (op === 'status') {
  const path = join(target, 'installed.json')
  if (!existsSync(path)) {
    out({ ok: false, state: 'failed', detail: 'installed unknown' })
  } else {
    const installed = JSON.parse(readFileSync(path, 'utf8'))
    out({
      ok: true,
      state: 'running',
      detail: 'status ok',
      version: installed.version,
      artifactSha256: installed.artifactSha256,
      runningArtifactSha256: installed.artifactSha256,
      runningStartedAt: installed.startedAt,
      runningPid: installed.runningPid,
    })
  }
} else if (op === 'rollback') {
  out({ ok: true, state: 'rolled_back', detail: 'rollback ok' })
} else {
  process.exitCode = 2
}
`

interface Site {
  readonly root: string
  readonly project: string
  readonly records: string
  readonly configPath: string
  readonly artifactPath: string
  readonly artifactSha256: string
}

function makeSite(): Site {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-interrupt-'))
  const project = join(root, 'project')
  const records = join(root, 'records')
  mkdirSync(project, { recursive: true })
  mkdirSync(records, { recursive: true })
  const toolDir = join(records, 'projects', PROJECT, 'deployments', 'tools')
  mkdirSync(toolDir, { recursive: true })
  writeFileSync(join(toolDir, 'tool.mjs'), TOOL_MJS)
  const toolPath = join(toolDir, 'tool.sh')
  writeFileSync(toolPath, TOOL_SH, { mode: 0o755 })
  const artifactPath = join(root, 'candidate.tgz')
  const content = `candidate-${Date.now()}`
  writeFileSync(artifactPath, content)
  const configPath = join(root, 'config.json')
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        project: PROJECT,
        projectPath: project,
        recordsRoot: records,
        deployments: {
          enabled: true,
          verifyTimeoutSeconds: 30,
          alerts: { webhook: 'http://127.0.0.1:9/m1-interrupt' },
          tools: [
            {
              id: 'installer',
              kind: 'shell',
              path: toolPath,
              capabilities: ['preflight', 'apply', 'status', 'rollback'],
              timeoutSeconds: 120,
            },
          ],
          targets: [
            {
              id: 'auto-target',
              toolId: 'installer',
              requirementId: 'req-m1-interrupt',
              approval: 'auto',
              params: { site: root },
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  )
  return {
    root,
    project,
    records,
    configPath,
    artifactPath,
    artifactSha256: createHash('sha256').update(content).digest('hex'),
  }
}

function dbPathOf(site: Site): string {
  return join(site.records, 'projects', PROJECT, 'records.sqlite')
}

function openDeployments(site: Site): { deployments: Deployments; close: () => void } {
  const config = resolveConfig(JSON.parse(readFileSync(site.configPath, 'utf8')), site.project)
  mkdirSync(join(site.records, 'projects', PROJECT), { recursive: true })
  const repo = new Repository(Database.open(dbPathOf(site)))
  const deployments = new Deployments({
    config,
    store: repo.deploymentStore,
    // 本演练只验证中断恢复；部署门禁已有独立测试覆盖。
    gate: () => ({ ok: true, reason: '' }),
    now: () => new Date().toISOString(),
    alert: async () => ({ ok: true, error: '' }),
  })
  return { deployments, close: () => repo.close() }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function readState(site: Site): { state: string; intentId: string; decisions: string[] } {
  if (!existsSync(dbPathOf(site))) return { state: '', intentId: '', decisions: [] }
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPathOf(site), { readOnly: true })
  } catch {
    // 子进程可能正在初始化数据库；下一轮轮询再读。
    return { state: '', intentId: '', decisions: [] }
  }
  try {
    const intent = db
      .prepare('SELECT intent_id, state FROM deployment_intents ORDER BY created_at DESC LIMIT 1')
      .get() as { intent_id?: string; state?: string } | undefined
    const decisions = intent
      ? (
          db
            .prepare('SELECT decision FROM deployment_decisions WHERE intent_id = ? ORDER BY rowid')
            .all(String(intent.intent_id)) as Array<{ decision?: string }>
        ).map((row) => String(row.decision ?? ''))
      : []
    return {
      state: String(intent?.state ?? ''),
      intentId: String(intent?.intent_id ?? ''),
      decisions,
    }
  } finally {
    db.close()
  }
}

function installCount(site: Site): number {
  const path = join(site.root, 'install-count.log')
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(200)
  }
  return predicate()
}

/** 子进程：真实宿主，发起部署后被父进程杀掉。 */
async function childApply(site: Site): Promise<void> {
  const { deployments, close } = openDeployments(site)
  try {
    const outcome = await deployments.request({
      targetId: 'auto-target',
      requirementId: 'req-m1-interrupt',
      artifact: { path: site.artifactPath, sha256: site.artifactSha256, version: '1.0.0' },
      source: 'system:m1-interrupt',
    })
    process.stdout.write(`${JSON.stringify(outcome)}\n`)
  } finally {
    close()
  }
}

/** 子进程：新宿主启动后的中断核对。 */
async function childRecover(site: Site): Promise<void> {
  const { deployments, close } = openDeployments(site)
  try {
    const recovered = await deployments.recoverInterrupted()
    process.stdout.write(`${JSON.stringify({ recovered })}\n`)
  } finally {
    close()
  }
}

function runChild(mode: string, site: Site): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [resolve(import.meta.dirname, 'real-deploy-interrupt.ts'), mode, JSON.stringify(site)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('exit', (code) => done({ code, out }))
  })
}

async function scenario(options: {
  readonly name: string
  readonly loseSideEffect: boolean
}): Promise<Record<string, unknown>> {
  const site = makeSite()
  const host = spawn(
    process.execPath,
    [
      resolve(import.meta.dirname, 'real-deploy-interrupt.ts'),
      '--child-apply',
      JSON.stringify(site),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const started = await waitFor(() => {
    const state = readState(site)
    return state.state === 'applying' && installCount(site) >= 1
  }, 60_000)
  if (!started) {
    host.kill('SIGKILL')
    throw new Error(`${options.name}：部署没有进入 applying，无法注入中断`)
  }
  const beforeKill = { state: readState(site), installs: installCount(site) }
  host.kill('SIGKILL')
  await new Promise((done) => host.on('exit', done))
  // 工具进程是宿主的子进程：宿主被杀后它可能仍在执行，正是“副作用已完成但结果未持久化”。
  await waitFor(() => existsSync(join(site.root, 'target', 'installed.json')), 30_000)
  if (options.loseSideEffect) {
    // 让 status 无法确认安装结果：模拟制品丢失、结果无法核对。
    rmSync(join(site.root, 'target', 'installed.json'), { force: true })
  }
  // 中断判定窗口是配置下限 30 秒：超过窗口后才允许核对，避免把正常执行误判为中断。
  await sleep(31_000)
  const recover = await runChild('--child-recover', site)
  const after = { state: readState(site), installs: installCount(site) }
  const result = {
    scenario: options.name,
    site: site.root,
    beforeKill,
    recoverOutput: recover.out.trim(),
    recoverCode: recover.code,
    after,
    noReinstall: after.installs === beforeKill.installs,
  }
  if (!process.argv.includes('--keep')) {
    // 摘要已记录，现场可按需保留。
  }
  return result
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode === '--child-apply') {
    await childApply(JSON.parse(process.argv[3]!) as Site)
    return
  }
  if (mode === '--child-recover') {
    await childRecover(JSON.parse(process.argv[3]!) as Site)
    return
  }

  const results: Record<string, unknown>[] = []
  const failures: string[] = []
  try {
    const applied = await scenario({ name: '副作用可确认', loseSideEffect: false })
    results.push(applied)
    const appliedState = (applied.after as { state: { state: string } }).state.state
    if (appliedState !== 'applied_pending_verify' && appliedState !== 'verified') {
      failures.push(`可确认场景没有收口为待核对/已验证：${appliedState}`)
    }
    if ((applied.after as { installs: number }).installs !== 1) {
      failures.push('可确认场景发生了重复安装')
    }
  } catch (error) {
    failures.push(`可确认场景失败：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const unknown = await scenario({ name: '副作用无法确认', loseSideEffect: true })
    results.push(unknown)
    const unknownState = (unknown.after as { state: { state: string; decisions: string[] } }).state
    if (!unknownState.decisions.includes('recovery_unknown')) {
      failures.push('无法确认场景没有记录 recovery_unknown')
    }
    if ((unknown.after as { installs: number }).installs !== 1) {
      failures.push('无法确认场景发生了重复安装')
    }
  } catch (error) {
    failures.push(`无法确认场景失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(ROOT, 'reports', 'm1', `interrupt-${stamp}`)
  mkdirSync(dir, { recursive: true })
  const summary = { at: new Date().toISOString(), results, failures }
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(
    join(dir, 'index.md'),
    [
      '# M1-5 真实中断恢复演练',
      '',
      `- 时间：${summary.at}`,
      '- 方法：在部署进入 applying、安装计数已 +1 后，对宿主进程发送 SIGKILL；',
      '  工具进程作为宿主子进程可能继续完成安装，正是“副作用已完成但结果未持久化”的场景。',
      '- 恢复：新宿主进程调用 recoverInterrupted() 读取记录并观测外部副作用，不重新安装。',
      '',
      '## 结果',
      '',
      '```json',
      JSON.stringify(results, null, 2),
      '```',
      '',
      '## 失败项',
      '',
      failures.length === 0 ? '无' : failures.map((item) => `- ${item}`).join('\n'),
      '',
    ].join('\n'),
  )
  for (const item of results) {
    const site = String(item.site ?? '')
    const db = join(site, 'records', 'projects', PROJECT, 'records.sqlite')
    if (!existsSync(db)) continue
    const target = join(dir, `records-${String(item.scenario)}.sqlite`)
    const source = new DatabaseSync(db, { readOnly: true })
    try {
      source.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
    } finally {
      source.close()
    }
  }
  process.stdout.write(`证据已写入 ${dir}\n`)
  process.stdout.write(`${JSON.stringify({ failures })}\n`)
  if (failures.length > 0) process.exitCode = 1
}

await main()
