#!/usr/bin/env node
/**
 * 看板 HTTP 路由 E2E（Playwright request，不依赖模型）：
 * 初始化隔离 DSH web profile 并安装插件 → 启动 web → token 换取 cookie →
 * 创建工作区与工作区会话 → POST /api/forgeloop/board（带 sessionId），
 * 校验返回的是该工作区租户、标题与摘要结构，并核对租户日志落盘。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { request } from 'playwright-core'
import { launch, terminate } from './platform.ts'
import { createWorkspaceSession, ensureWorkspace, readBoard } from './web-rpc.ts'

import { requireVerificationContainer, verificationCandidate } from './verification-container.ts'

requireVerificationContainer()

const ROOT = resolve(import.meta.dirname, '../..')
const PROFILE = process.env.FORGELOOP_E2E_PROFILE ?? 'forgeloop-e2e'
const DSH = process.env.FORGELOOP_DSH ?? 'dsh'
const PROJECT = 'forgeloop-e2e'

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
  const command = launch(DSH, args)
  const result = spawnSync(command.file, [...command.args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    ...(command.spawnOptions ?? {}),
  })
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(' ')} 失败：${result.stderr || result.stdout}`)
  }
}

async function waitForToken(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<string> {
  let buffer = ''
  return await new Promise((done, fail) => {
    const timer = setTimeout(() => {
      fail(new Error(`等待 web 启动超时；输出：${buffer.slice(-800)}`))
    }, timeoutMs)
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

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8')
    await new Promise((done) => setTimeout(done, 200))
  }
  throw new Error(`等待日志超时：${path}`)
}

const workspace = mkdtempSync(join(tmpdir(), 'forgeloop-e2e-board-'))
const home = join(workspace, 'dsh-home')
const baseProject = join(workspace, 'base-project')
const workspacePath = join(workspace, 'workspace-a')
const configPath = join(workspace, 'forgeloop.json')
const recordsRoot = join(workspace, 'records')
mkdirSync(baseProject, { recursive: true })
mkdirSync(workspacePath, { recursive: true })
mkdirSync(home, { recursive: true })
writeFileSync(
  configPath,
  `${JSON.stringify({
    project: PROJECT,
    projectPath: baseProject,
    recordsRoot,
    autoAdvance: false,
  })}\n`,
)
const env = { ...process.env, DSH_HOME: home, FORGELOOP_CONFIG: configPath }
let child: ReturnType<typeof spawn> | undefined
let exitCode = 0
try {
  const candidate = verificationCandidate(ROOT)
  dshSync(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], env)
  dshSync(['plugin', '--profile', PROFILE, 'add', '--offline', candidate.path], env)
  const port = await freePort()
  const web = launch(DSH, ['--profile', PROFILE, '--port', String(port), '--no-open'])
  child = spawn(web.file, [...web.args], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(web.spawnOptions ?? {}),
  })
  const tokenUrl = await waitForToken(child, 90_000)
  const baseLog = join(recordsRoot, 'logs', 'plugin.log')
  const baseText = await waitForFile(baseLog, 30_000)
  if (!baseText.includes('已加载 records=')) throw new Error('运行日志缺少启动记录')
  console.log(`[e2e-board] 运行日志已落盘：${baseLog}`)

  const context = await request.newContext({ baseURL: `http://127.0.0.1:${port}` })
  try {
    const auth = await context.get(tokenUrl.replace(`http://127.0.0.1:${port}`, ''))
    if (!auth.ok()) throw new Error(`token 换取会话失败：HTTP ${auth.status()}`)
    const ws = await ensureWorkspace(context, workspacePath)
    const expectedProject = `ws-${ws.id}`
    const sessionId = await createWorkspaceSession(context, ws.id)
    const value = await readBoard(context, { endpoint: 'board', limit: 3, sessionId })
    if (value.project !== expectedProject) {
      throw new Error(`看板租户不符：${String(value.project)}（期望 ${expectedProject}）`)
    }
    const workspaceView = value.workspace
    if (
      typeof workspaceView !== 'object' ||
      workspaceView === null ||
      (workspaceView as { title?: unknown }).title !== 'workspace-a'
    ) {
      throw new Error(`看板缺少工作区标题：${JSON.stringify(workspaceView)}`)
    }
    if (typeof value.summary !== 'object' || value.summary === null) {
      throw new Error('看板缺少 summary')
    }
    const tenantDir = join(recordsRoot, 'projects', expectedProject)
    const dbPath = join(tenantDir, 'records.sqlite')
    const bindDeadline = Date.now() + 30_000
    while (Date.now() < bindDeadline) {
      const text = readFileSync(baseLog, 'utf8')
      if (text.includes(`绑定项目 ${expectedProject}`) && existsSync(dbPath)) break
      await new Promise((done) => setTimeout(done, 200))
    }
    if (!readFileSync(baseLog, 'utf8').includes(`绑定项目 ${expectedProject}`)) {
      throw new Error(`基础日志缺少工作区绑定记录：${expectedProject}`)
    }
    if (!existsSync(dbPath)) throw new Error(`租户记录库未创建：${dbPath}`)
    const reports = join(ROOT, 'reports')
    mkdirSync(reports, { recursive: true })
    writeFileSync(
      join(reports, 'e2e-board.json'),
      `${JSON.stringify({ candidateSha256: candidate.sha256, pid: child.pid, port, project: expectedProject, dbPath }, null, 2)}\n`,
    )
    console.log(
      `[e2e-board] OK：看板返回 project=${expectedProject}，workspace.title=workspace-a，租户目录=${tenantDir}`,
    )
  } finally {
    await context.dispose()
  }
} catch (error) {
  console.error(`[e2e-board] 失败：${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  terminate(child)
  rmSync(workspace, { recursive: true, force: true })
}
process.exitCode = exitCode
