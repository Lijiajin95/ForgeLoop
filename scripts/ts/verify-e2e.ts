#!/usr/bin/env node
/**
 * 真实端到端门禁：候选 tarball 安装到隔离 DSH 宿主，真实模型调用真实工具提交需求，
 * 协调器自动完成分析、规划、研发、独立验证与受控提交，最后由模型读取需求与证据。
 *
 * 需要真实模型凭据（DEEPSEEK_API_KEY）与候选包：
 * - FORGELOOP_CANDIDATE_TARBALL 指向 tarball；缺省取 packages/forgeloop/dist 最新包。
 * - FORGELOOP_E2E_TIMEOUT_MS 控制等待提交完成的上限，默认 15 分钟。
 * 凭据或候选缺失时直接失败，不跳过、不伪造成功。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { request, type APIRequestContext } from 'playwright-core'
import { launch, terminate } from './platform.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const DSH = process.env.FORGELOOP_DSH ?? 'dsh'
const TIMEOUT_MS = positiveInt(process.env.FORGELOOP_E2E_TIMEOUT_MS, 15 * 60 * 1000)
const WEB_PROFILE = 'forgeloop-e2e-web'
const HEADLESS_PROFILE = 'forgeloop-e2e-headless'
const PROJECT = 'forgeloop-e2e'
const TOKEN = `E2E-${Date.now().toString(36).toUpperCase()}`
const REQUIREMENT = [
  `在项目中创建 docs/e2e-proof.md，文件第一行必须包含标记 ${TOKEN}。`,
  '不要修改其他文件。',
  `验收标准：docs/e2e-proof.md 存在且包含 ${TOKEN}。`,
].join('\n')

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function log(message: string): void {
  console.log(`[verify-e2e] ${message}`)
}

function requireCredential(): void {
  if (!process.env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error(
      '缺少 DEEPSEEK_API_KEY；真实 DSH + 真实模型 E2E 必须显式提供，不能跳过或伪造成功',
    )
  }
}

function candidateTarball(): string {
  const configured = process.env.FORGELOOP_CANDIDATE_TARBALL?.trim()
  if (configured) {
    const path = resolve(configured)
    if (!existsSync(path)) throw new Error(`候选包不存在：${path}`)
    return path
  }
  const dist = join(ROOT, 'packages/forgeloop/dist')
  const found = existsSync(dist)
    ? readdirSync(dist)
        .filter((name) => /^forgeloop-dsh-.*\.tgz$/.test(name))
        .sort()
        .at(-1)
    : undefined
  if (!found) {
    throw new Error(
      '没有候选 tarball；请先 make package，或用 FORGELOOP_CANDIDATE_TARBALL 指定真实安装包',
    )
  }
  return join(dist, found)
}

function run(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  cwd = ROOT,
): { code: number; stdout: string; stderr: string } {
  const command = launch(executable, args)
  const result = spawnSync(command.file, [...command.args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    ...(command.spawnOptions ?? {}),
  })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  }
}

function dsh(args: readonly string[], env: NodeJS.ProcessEnv, timeout = 300_000) {
  return run(DSH, args, env, timeout)
}

function mustDsh(args: readonly string[], env: NodeJS.ProcessEnv, timeout = 300_000): void {
  const result = dsh(args, env, timeout)
  if (result.code !== 0) {
    throw new Error(
      `dsh ${args.join(' ')} 失败：${(result.stderr || result.stdout).trim().slice(0, 800)}`,
    )
  }
}

function git(args: readonly string[], cwd: string): string {
  const result = run('git', args, process.env, 60_000, cwd)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout
}

function makeProject(): void {
  mkdirSync(join(PROJECT_DIR, 'docs'), { recursive: true })
  writeFileSync(join(PROJECT_DIR, 'README.md'), '# ForgeLoop E2E project\n', 'utf8')
  writeFileSync(join(PROJECT_DIR, 'docs/README.md'), '# Docs\n', 'utf8')
  writeFileSync(
    join(PROJECT_DIR, 'package.json'),
    JSON.stringify({ name: 'forgeloop-e2e-project', private: true, type: 'module' }, null, 2),
    'utf8',
  )
  git(['init', '-q'], PROJECT_DIR)
  git(['config', 'user.email', 'e2e@example.com'], PROJECT_DIR)
  git(['config', 'user.name', 'ForgeLoop E2E'], PROJECT_DIR)
  git(['add', '-A'], PROJECT_DIR)
  git(['commit', '-qm', 'e2e base'], PROJECT_DIR)
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

function waitForToken(child: ChildProcess, timeoutMs: number): Promise<string> {
  let buffer = ''
  return new Promise((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`等待 web 启动超时；输出：${buffer.slice(-800)}`)),
      timeoutMs,
    )
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(buffer)
      if (!match?.[1]) return
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      done(match[1])
    }
    child.stdout?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`web 进程提前退出（code=${String(code)}）：${buffer.slice(-800)}`))
    })
  })
}

async function board(
  context: APIRequestContext,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await context.post('/api/forgeloop/board', { data: body })
  const parsed: unknown = await response.json()
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  if (response.status() !== 200 || record.ok !== true) {
    throw new Error(
      `看板 ${String(body.endpoint)} 返回异常：HTTP ${response.status()} ${JSON.stringify(record).slice(0, 500)}`,
    )
  }
  const value = record.value
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

async function pollCommitted(
  context: APIRequestContext,
  reqId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + TIMEOUT_MS
  let lastStatus = ''
  while (Date.now() < deadline) {
    const detail = await board(context, { endpoint: 'detail', reqId })
    const status = typeof detail.status === 'string' ? detail.status : ''
    if (status !== lastStatus) {
      log(`需求 ${reqId} 状态：${status || '(unknown)'}`)
      lastStatus = status
    }
    if (status === 'committed') return detail
    await new Promise((done) => setTimeout(done, 1000))
  }
  throw new Error(
    `等待需求 ${reqId} 提交超时（${TIMEOUT_MS}ms）；最后状态：${lastStatus || '(unknown)'}`,
  )
}

function parseRequirementId(output: string): string {
  const match = /req-\d{14}-[a-z0-9]{6}/i.exec(output)
  if (!match) throw new Error(`真实模型没有返回需求 ID；输出：${output.slice(-1200)}`)
  return match[0]
}

function submitWithModel(env: NodeJS.ProcessEnv): string {
  const prompt = [
    'You are running a ForgeLoop end-to-end check.',
    'Call the forgeloop_submit_requirement tool exactly once with these arguments:',
    `text: ${JSON.stringify(REQUIREMENT)}`,
    `client_key: ${JSON.stringify(`e2e-${TOKEN}`)}`,
    'After the tool returns, answer with the requirement id exactly as returned. Do not call other tools.',
  ].join('\n')
  const result = dsh(['--profile', HEADLESS_PROFILE, '--json', prompt], env, 600_000)
  if (result.code !== 0) {
    throw new Error(
      `真实模型提交需求失败（退出码 ${result.code}）：${(result.stderr || result.stdout).slice(-1200)}`,
    )
  }
  if (!result.stdout.includes('"tool":"forgeloop_submit_requirement"')) {
    throw new Error(
      `模型没有调用 forgeloop_submit_requirement；输出：${result.stdout.slice(-1200)}`,
    )
  }
  return parseRequirementId(result.stdout)
}

function readWithModel(env: NodeJS.ProcessEnv, reqId: string): void {
  const prompt = [
    `Call the forgeloop_show_requirement tool with req_id ${JSON.stringify(reqId)}.`,
    `Then call the forgeloop_evidence tool with the same req_id ${JSON.stringify(reqId)}.`,
    'Then answer with the requirement status and the commit sha exactly as returned. Do not call other tools.',
  ].join('\n')
  const result = dsh(['--profile', HEADLESS_PROFILE, '--json', prompt], env, 600_000)
  if (result.code !== 0) {
    throw new Error(
      `真实模型读取最终记录失败（退出码 ${result.code}）：${(result.stderr || result.stdout).slice(-1200)}`,
    )
  }
  for (const tool of ['forgeloop_show_requirement', 'forgeloop_evidence']) {
    if (!result.stdout.includes(`"tool":"${tool}"`)) {
      throw new Error(`模型没有调用 ${tool}；输出：${result.stdout.slice(-1200)}`)
    }
  }
  if (!result.stdout.includes(reqId)) {
    throw new Error(`模型读取结果没有包含需求 ${reqId}；输出：${result.stdout.slice(-1200)}`)
  }
  if (!result.stdout.includes('"kind":"completed"')) {
    throw new Error('真实模型读取回合没有正常结束')
  }
  log(`真实模型已通过实际工具读取 ${reqId} 的需求与证据`)
}

function assertDelivered(detail: Record<string, unknown>): void {
  const commit = detail.commit
  if (typeof commit !== 'object' || commit === null)
    throw new Error('需求已 committed 但没有受控提交记录')
  const sha = (commit as Record<string, unknown>).commitSha
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`受控提交摘要异常：${JSON.stringify(sha)}`)
  }
  const files = git(['show', '--name-only', '--pretty=format:', sha], PROJECT_DIR)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!files.includes('docs/e2e-proof.md')) {
    throw new Error(`受控提交没有包含 docs/e2e-proof.md；实际文件：${files.join('、')}`)
  }
  const content = git(['show', `${sha}:docs/e2e-proof.md`], PROJECT_DIR)
  if (!content.includes(TOKEN)) throw new Error('受控提交中的证明文件缺少 E2E 标记')
  const plan = detail.latestPlan
  if (typeof plan !== 'object' || plan === null) throw new Error('需求完成但没有任务包记录')
  const artifacts = detail.artifacts
  if (!Array.isArray(artifacts) || artifacts.length === 0)
    throw new Error('需求完成但没有任务交付记录')
  log(`受控提交 ${sha.slice(0, 12)} 包含 docs/e2e-proof.md，任务交付 ${artifacts.length} 个`)
}

const workspace = mkdtempSync(join(tmpdir(), 'forgeloop-verify-e2e-'))
const HOME = join(workspace, 'dsh-home')
let PROJECT_DIR = join(workspace, 'project')
const RECORDS = join(workspace, 'records')
const CONFIG_PATH = join(workspace, 'forgeloop.json')
let child: ChildProcess | undefined
let context: APIRequestContext | undefined
let exitCode = 0

try {
  requireCredential()
  const tarball = candidateTarball()
  PROJECT_DIR = join(workspace, 'project')
  mkdirSync(PROJECT_DIR, { recursive: true })
  mkdirSync(HOME, { recursive: true })
  makeProject()
  writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify(
      {
        project: PROJECT,
        projectPath: PROJECT_DIR,
        recordsRoot: RECORDS,
        owner: 'e2e-owner',
        pollSeconds: 1,
        autoAdvance: true,
        agent: {
          provider: '',
          model: '',
          timeoutSeconds: 300,
          maxTurnSeconds: 600,
          idleTimeoutSeconds: 120,
        },
        formalTestTimeoutSeconds: 120,
        maxTaskAttempts: 2,
        failureRoundsPerGrant: 1,
        maxVerificationAttempts: 1,
        autonomy: {
          enabled: true,
          allowCodeCommit: true,
          trustedSources: ['dsh-tool:', 'dsh-session:'],
          commitCheckCommand: [],
        },
        ops: { enabled: false },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: HOME,
    FORGELOOP_CONFIG: CONFIG_PATH,
  }

  for (const [profile, template] of [
    [WEB_PROFILE, 'web'],
    [HEADLESS_PROFILE, 'headless'],
  ] as const) {
    mustDsh(['--profile', profile, '--from-default-profile', template, '--dump-config'], env)
    mustDsh(['plugin', '--profile', profile, 'add', tarball], env)
    const installed = join(HOME, 'profiles', profile, 'node_modules', 'forgeloop-dsh')
    if (!existsSync(installed)) throw new Error(`profile ${profile} 未安装 forgeloop-dsh`)
    if (lstatSync(installed).isSymbolicLink()) {
      throw new Error(`profile ${profile} 使用链接安装，不能证明真实 tarball 安装`)
    }
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    log(`profile ${profile} 已从 tarball 安装 forgeloop-dsh@${String(manifest.version ?? '?')}`)
  }

  const port = await freePort()
  const web = launch(DSH, ['--profile', WEB_PROFILE, '--port', String(port), '--no-open'])
  child = spawn(web.file, [...web.args], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(web.spawnOptions ?? {}),
  })
  const tokenUrl = await waitForToken(child, 120_000)
  context = await request.newContext({ baseURL: `http://127.0.0.1:${port}` })
  const auth = await context.get(tokenUrl.replace(`http://127.0.0.1:${port}`, ''))
  if (!auth.ok()) throw new Error(`token 换取会话失败：HTTP ${auth.status()}`)
  const boardView = await board(context, { endpoint: 'board', limit: 3 })
  if (boardView.project !== PROJECT) throw new Error(`看板项目不符：${String(boardView.project)}`)
  log(`web 宿主已就绪：http://127.0.0.1:${port}`)

  const reqId = submitWithModel(env)
  log(`真实模型已通过实际工具提交需求 ${reqId}`)
  const detail = await pollCommitted(context, reqId)
  assertDelivered(detail)
  readWithModel(env, reqId)

  log(`OK：真实 DSH + 真实模型 + 实际工具的端到端主路径通过（${reqId}）`)
} catch (error) {
  exitCode = 1
  console.error(`[verify-e2e] 失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await context?.dispose()
  terminate(child)
  rmSync(workspace, { recursive: true, force: true })
}
process.exitCode = exitCode
