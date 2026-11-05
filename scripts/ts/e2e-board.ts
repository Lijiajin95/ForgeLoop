#!/usr/bin/env node
/**
 * 看板 HTTP 路由 E2E（Playwright request，不依赖模型）：
 * 初始化隔离 DSH web profile 并安装插件 → 启动 web → token 换取 cookie →
 * POST /api/forgeloop/board，校验返回项目与摘要结构。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { request } from 'playwright-core'
import { launch, terminate } from './platform.ts'

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

const workspace = mkdtempSync(join(tmpdir(), 'forgeloop-e2e-board-'))
const home = join(workspace, 'dsh-home')
const projectDir = join(workspace, 'project')
const configPath = join(workspace, 'forgeloop.json')
mkdirSync(projectDir, { recursive: true })
mkdirSync(home, { recursive: true })
writeFileSync(
  configPath,
  `${JSON.stringify({
    project: PROJECT,
    projectPath: projectDir,
    recordsRoot: join(workspace, 'records'),
    autoAdvance: false,
  })}\n`,
)
const env = { ...process.env, DSH_HOME: home, FORGELOOP_CONFIG: configPath }
let child: ReturnType<typeof spawn> | undefined
let exitCode = 0
try {
  dshSync(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], env)
  dshSync(['plugin', '--profile', PROFILE, 'add', join(ROOT, 'packages/forgeloop')], env)
  const port = await freePort()
  const web = launch(DSH, ['--profile', PROFILE, '--port', String(port), '--no-open'])
  child = spawn(web.file, [...web.args], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(web.spawnOptions ?? {}),
  })
  const tokenUrl = await waitForToken(child, 90_000)
  const pluginLog = join(workspace, 'records', 'projects', PROJECT, 'logs', 'plugin.log')
  if (!existsSync(pluginLog)) throw new Error(`未生成运行日志：${pluginLog}`)
  const logText = readFileSync(pluginLog, 'utf8')
  if (!logText.includes('已加载 records=')) throw new Error('运行日志缺少启动记录')
  console.log(`[e2e-board] 运行日志已落盘：${pluginLog}`)
  const context = await request.newContext({ baseURL: `http://127.0.0.1:${port}` })
  try {
    const auth = await context.get(tokenUrl.replace(`http://127.0.0.1:${port}`, ''))
    if (!auth.ok()) throw new Error(`token 换取会话失败：HTTP ${auth.status()}`)
    const response = await context.post('/api/forgeloop/board', {
      data: { endpoint: 'board', limit: 3 },
    })
    const body = (await response.json()) as {
      ok?: unknown
      value?: { project?: unknown; summary?: unknown }
    }
    if (response.status() !== 200 || body.ok !== true) {
      throw new Error(
        `看板返回异常：HTTP ${response.status()} ${JSON.stringify(body).slice(0, 300)}`,
      )
    }
    if (body.value?.project !== PROJECT) {
      throw new Error(`看板项目不符：${String(body.value?.project)}`)
    }
    if (typeof body.value.summary !== 'object' || body.value.summary === null) {
      throw new Error('看板缺少 summary')
    }
    console.log(`[e2e-board] OK：看板路由返回 project=${PROJECT}（HTTP 200）`)
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
