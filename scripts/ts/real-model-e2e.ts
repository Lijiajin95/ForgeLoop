#!/usr/bin/env node
/**
 * 真实模型闭环 E2E（opt-in，会产生模型费用）：
 * 隔离 DSH_HOME 与临时 Git 项目 → 安装插件 → 启动 web 协调器 →
 * 由真实模型通过 forgeloop_submit_requirement 提交需求 →
 * 轮询权威 SQLite，直到需求完成准入、研发、独立验证与受控提交。
 *
 * 默认跳过；`make real-model-e2e` 或 `FORGELOOP_REAL_MODEL=1` 才运行。
 * 需要当前默认 DSH profile 已配置可用的模型凭据；脚本不改动生产记录与正式 profile。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = resolve(import.meta.dirname, '../..')
const PROFILE = process.env.FORGELOOP_REAL_MODEL_PROFILE ?? 'forgeloop-real-model'
const WEB_PROFILE = `${PROFILE}-web`
const HEADLESS_PROFILE = `${PROFILE}-headless`
const DSH = process.env.FORGELOOP_DSH ?? 'dsh'
const PROJECT = 'forgeloop-real-model'
const TIMEOUT_MS = Number(process.env.FORGELOOP_REAL_MODEL_TIMEOUT_MS ?? 1_800_000)
const HEADLESS_TIMEOUT_MS = Number(process.env.FORGELOOP_REAL_MODEL_SUBMIT_TIMEOUT_MS ?? 600_000)

const REQUIREMENT = [
  '在 docs/real-model-e2e.md 中写入一行 real model e2e ok。',
  '验收标准：docs/real-model-e2e.md 存在，且内容包含 real model e2e ok。',
  "测试命令：node -e \"const fs=require('node:fs');const t=fs.readFileSync('docs/real-model-e2e.md','utf8');if(!t.includes('real model e2e ok'))process.exit(1)\"",
].join('\n')

interface RequirementRow {
  readonly req_id: string
  readonly status: string
  readonly source: string
  readonly submitted_by: string
}

interface CountRow {
  readonly count: number
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => done(port))
    })
  })
}

function dshSync(args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(DSH, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 300_000 })
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(' ')} 失败：${result.stderr || result.stdout}`)
  }
}

function waitForToken(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<string> {
  let buffer = ''
  return new Promise((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`等待 web 启动超时；输出：${buffer.slice(-800)}`)),
      timeoutMs,
    )
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(buffer)
      if (match?.[1]) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        done(match[1])
      }
    }
    child.stdout?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`web 进程提前退出（code=${String(code)}）：${buffer.slice(-800)}`))
    })
  })
}

function initProject(projectDir: string): void {
  mkdirSync(join(projectDir, 'docs'), { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# ForgeLoop real-model E2E\n')
  writeFileSync(join(projectDir, 'docs', 'baseline.md'), 'baseline\n')
  const git = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
  }
  git(['init', '-q'])
  git(['config', 'user.email', 'real-model-e2e@example.com'])
  git(['config', 'user.name', 'Real Model E2E'])
  git(['add', '-A'])
  git(['commit', '-qm', 'baseline'])
}

function queryOne<T>(db: DatabaseSync, sql: string, params: unknown[] = []): T | undefined {
  const statement = db.prepare(sql)
  return statement.get(...(params as never[])) as T | undefined
}

function count(db: DatabaseSync, sql: string, params: unknown[] = []): number {
  return Number(queryOne<CountRow>(db, sql, params)?.count ?? 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function poll(
  dbPath: string,
  startedAt: string,
): Promise<{
  requirement: RequirementRow
  summary: Record<string, number | string | null>
}> {
  const deadline = Date.now() + TIMEOUT_MS
  let lastLine = ''
  while (Date.now() < deadline) {
    if (!existsSync(dbPath)) {
      await sleep(5_000)
      continue
    }
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const requirement = queryOne<RequirementRow>(
        db,
        'SELECT req_id, status, source, submitted_by FROM requirements ORDER BY created_at DESC LIMIT 1',
      )
      if (requirement) {
        const verification = queryOne<{ verdict: string }>(
          db,
          'SELECT verdict FROM requirement_verifications WHERE req_id = ? ORDER BY verified_at DESC LIMIT 1',
          [requirement.req_id],
        )
        const summary = {
          status: requirement.status,
          source: requirement.source,
          submittedBy: requirement.submitted_by,
          admissions: count(
            db,
            "SELECT COUNT(*) AS count FROM requirement_admissions WHERE req_id = ? AND decision = 'admit'",
            [requirement.req_id],
          ),
          plans: count(
            db,
            'SELECT COUNT(*) AS count FROM requirement_task_plans WHERE req_id = ?',
            [requirement.req_id],
          ),
          verifications: count(
            db,
            'SELECT COUNT(*) AS count FROM requirement_verifications WHERE req_id = ?',
            [requirement.req_id],
          ),
          commits: count(db, 'SELECT COUNT(*) AS count FROM requirement_commits WHERE req_id = ?', [
            requirement.req_id,
          ]),
          deployments: count(
            db,
            'SELECT COUNT(*) AS count FROM requirement_deployments WHERE req_id = ?',
            [requirement.req_id],
          ),
          verdict: verification?.verdict ?? null,
        }
        const line = JSON.stringify(summary)
        if (line !== lastLine) {
          console.log(`[real-model-e2e] 进度：${line}`)
          lastLine = line
        }
        if (requirement.status === 'committed' || requirement.status === 'accepted') {
          return { requirement, summary }
        }
        if (
          requirement.status === 'blocked' ||
          requirement.status === 'cancelled' ||
          requirement.status === 'rejected'
        ) {
          throw new Error(`需求停在 ${requirement.status}：${line}`)
        }
      }
    } finally {
      db.close()
    }
    await sleep(5_000)
  }
  throw new Error(
    `等待闭环超时（${Math.round(TIMEOUT_MS / 1000)} 秒）；需求创建于 ${startedAt}，最后状态：${lastLine}`,
  )
}

async function main(): Promise<void> {
  if (process.env.FORGELOOP_REAL_MODEL !== '1') {
    console.log(
      '[real-model-e2e] 跳过：设置 FORGELOOP_REAL_MODEL=1 或运行 make real-model-e2e（会调用真实模型并产生费用）',
    )
    return
  }
  const workspace = mkdtempSync(join(tmpdir(), 'forgeloop-real-model-'))
  const home = join(workspace, 'dsh-home')
  const projectDir = join(workspace, 'project')
  const recordsRoot = join(workspace, 'records')
  const configPath = join(workspace, 'forgeloop.json')
  const dbPath = join(recordsRoot, 'projects', PROJECT, 'records.sqlite')
  execFileSync('npm', ['run', 'build', '--workspace', 'forgeloop-dsh'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  })
  mkdirSync(home, { recursive: true })
  mkdirSync(recordsRoot, { recursive: true })
  initProject(projectDir)
  writeFileSync(
    configPath,
    `${JSON.stringify({
      project: PROJECT,
      projectPath: projectDir,
      recordsRoot,
      pollSeconds: 1,
      autoAdvance: true,
      owner: 'real-model-e2e',
      agent: { timeoutSeconds: 600, maxTurnSeconds: 600 },
      formalTestTimeoutSeconds: 120,
      failureRoundsPerGrant: -1,
      maxVerificationAttempts: -1,
      maxTaskAttempts: -1,
      autonomy: { enabled: true, allowAnySource: true, allowCodeCommit: true, requireOwner: false },
    })}\n`,
  )
  const env = { ...process.env, DSH_HOME: home, FORGELOOP_CONFIG: configPath }
  let child: ReturnType<typeof spawn> | undefined
  try {
    dshSync(['--profile', WEB_PROFILE, '--from-default-profile', 'web', '--dump-config'], env)
    dshSync(
      ['--profile', HEADLESS_PROFILE, '--from-default-profile', 'headless', '--dump-config'],
      env,
    )
    dshSync(['plugin', '--profile', WEB_PROFILE, 'add', join(ROOT, 'packages/forgeloop')], env)
    dshSync(['plugin', '--profile', HEADLESS_PROFILE, 'add', join(ROOT, 'packages/forgeloop')], env)
    const port = await freePort()
    child = spawn(DSH, ['--profile', WEB_PROFILE, '--port', String(port), '--no-open'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForToken(child, 90_000)

    const startedAt = new Date().toISOString()
    const submitted = spawnSync(
      DSH,
      [
        '--profile',
        HEADLESS_PROFILE,
        '--json',
        `只调用一次工具 forgeloop_submit_requirement 提交下面的需求原文；不要修改任何文件，也不要调用其他工具。\n\n${REQUIREMENT}`,
      ],
      {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        timeout: HEADLESS_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      },
    )
    if (submitted.status !== 0) {
      throw new Error(`真实模型提交需求失败：${submitted.stderr || submitted.stdout}`)
    }
    let submittedRequirement = false
    for (let attempt = 0; attempt < 15 && !submittedRequirement; attempt += 1) {
      if (existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath, { readOnly: true })
        try {
          submittedRequirement = count(db, 'SELECT COUNT(*) AS count FROM requirements') > 0
        } finally {
          db.close()
        }
      }
      if (!submittedRequirement) await sleep(1_000)
    }
    if (!submittedRequirement) {
      throw new Error(
        `真实模型没有调用 forgeloop_submit_requirement；输出：${(submitted.stdout || submitted.stderr).slice(-800)}`,
      )
    }

    const result = await poll(dbPath, startedAt)
    const { requirement, summary } = result
    if (requirement.source !== 'dsh-tool:submit_requirement') {
      throw new Error(`需求来源未按工具记录：${requirement.source}`)
    }
    if (summary.admissions === 0) throw new Error('需求没有系统准入记录')
    if (summary.plans === 0) throw new Error('需求没有任务包')
    if (summary.commits === 0) throw new Error('需求没有受控提交')
    if (summary.verdict !== 'pass') throw new Error(`独立验证未通过：${String(summary.verdict)}`)
    if (summary.deployments !== 0) throw new Error('研发链路不应产生部署记录')

    console.log(`[real-model-e2e] OK：${requirement.req_id} 完成准入、研发、验证与受控提交`)
    console.log(
      `[real-model-e2e] 记录：${dbPath}；项目：${projectDir}（临时目录会在脚本结束时删除）`,
    )
  } finally {
    child?.kill('SIGTERM')
    rmSync(workspace, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(`[real-model-e2e] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
