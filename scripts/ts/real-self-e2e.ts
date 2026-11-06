#!/usr/bin/env node
/**
 * 真实自身需求 → 新版本实际运行 E2E（opt-in，会产生模型费用）：
 *
 * 隔离现场（临时 Git 工作树 / 协调宿主 home / 目标宿主 home / 独立 records）→
 * 安装当前插件 tarball 的协调宿主，由真实模型通过 forgeloop_submit_requirement 提交
 * 一条真实自身需求（docs/status.md §160 的控制补丁缺陷）→
 * 协调器完成分析、准入、规划、研发、独立验证、业务终审、受控提交与候选构建 →
 * 真实 Python 安装器把新 tarball 装进隔离目标 profile、写入安装制品摘要并重启真实宿主 →
 * 上线核对 verified 后，用固定 reqId 从 SQLite 与运行身份逐项核对。
 *
 * 默认跳过；`FORGELOOP_REAL_SELF=1` 或 `--self` 才运行。
 * 现场默认在成功后清理；失败或 KEEP=1（FORGELOOP_REAL_SELF_KEEP=1）时保留并写 summary.json。
 * 需要 FORGELOOP_DSH_CLI 指向 dsh 的 lib/bin.js，目标安装器用它启动真实宿主。
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { launch, npmLaunch, terminate, type Launch } from './platform.js'

const ROOT = resolve(import.meta.dirname, '../..')
/** 目标安装器必须能启动真实宿主：用当前 node 执行 dsh 的 CLI 入口。 */
const DSH_CLI = process.env.FORGELOOP_DSH_CLI?.trim() ?? ''
const PATCH = process.env.FORGELOOP_REAL_MODEL_PATCH?.trim() ?? ''
const GIT = process.platform === 'win32' ? 'git.exe' : 'git'
const PYTHON =
  process.platform === 'win32' ? 'python.exe' : process.env.FORGELOOP_PYTHON?.trim() || 'python3'
const ENABLED = process.env.FORGELOOP_REAL_SELF === '1' || process.argv.includes('--self')
const KEEP = process.env.KEEP === '1' || process.env.FORGELOOP_REAL_SELF_KEEP === '1'
const TIMEOUT_MS = Number(process.env.FORGELOOP_REAL_SELF_TIMEOUT_MS ?? 3_600_000)
const SUBMIT_TIMEOUT_MS = Number(process.env.FORGELOOP_REAL_SELF_SUBMIT_TIMEOUT_MS ?? 600_000)
const BLOCKED_GRACE_MS = Number(process.env.FORGELOOP_REAL_SELF_BLOCKED_GRACE_MS ?? 900_000)
const TURN_TIMEOUT_SECONDS = Number(process.env.FORGELOOP_REAL_SELF_TURN_TIMEOUT_SECONDS ?? 2400)
const MAX_TASK_ATTEMPTS = Number(process.env.FORGELOOP_REAL_SELF_MAX_TASK_ATTEMPTS ?? 3)
const MAX_FAILURE_ROUNDS = Number(process.env.FORGELOOP_REAL_SELF_MAX_FAILURE_ROUNDS ?? 5)

const PROJECT = 'm1-self'
const COORDINATOR_PROFILE = 'm1-self-coordinator'
const HEADLESS_PROFILE = 'm1-self-headless'
const TARGET_PROFILE = 'm1-self-target'
const TARGET_ID = 'm1-self-target'
const TOOL_ID = 'm1-self-install'
const OWNER = 'm1-self-agent'

/**
 * 需求原文：来源是 docs/status.md §160 记录的真实待办，不是 fixture、不是测试造数。
 * 提交者按脚本 Agent 身份记录；这里不声明 owner 批准，也不冒充所有者验收。
 */
const REQUIREMENT = [
  '修复 verification-controls 的控制补丁应用（来源：docs/status.md §160「发现但不碰」记录的真实待办，不是 fixture 或测试造数）。',
  '',
  '背景：验证敏感性对照 executeVerificationControls 把候选复制到 controlDir 后执行 git apply。',
  '当 controlDir 位于被测 Git 仓库的子目录时（默认 recordsRoot 就在项目内 .forgeloop 下），',
  '仓库根相对路径的补丁会被 git apply 静默忽略并返回 0，出现“补丁未应用但对照判为通过”。',
  '',
  '要求：',
  '1. 控制补丁必须真正应用到被测仓库根相对路径：controlDir 位于仓库子目录时，先按仓库根解析再应用（例如 git rev-parse --show-toplevel 后配合 git apply --directory，或等价正确做法）。',
  '2. 补丁不能应用、应用后没有实际变化、或无法确认已应用时必须失败（applied 为 false 并产生 issue），不得静默通过。',
  '3. 新增回归测试覆盖 controlDir 位于仓库子目录的场景，并证明修复前会失败、修复后通过。',
  '4. 保持现有对照语义：正式候选不被修改；对照命令失败时仍要求退出码非零且输出命中 expectedFailureOutput。',
  '',
  '允许修改的文件（仅限）：',
  '- packages/forgeloop/src/runtime/verification-controls.ts',
  '- packages/forgeloop/tests/verification-integrity.test.ts（回归测试写在这里；如确需新文件，命名为 packages/forgeloop/tests/verification-controls.test.ts）',
  '',
  '非目标：不新增依赖；不改记录表结构、部署与运维实现；不修改 docs/ 下的其他文档。',
  '',
  '验收标准：',
  '- controlDir 位于仓库子目录时补丁真正应用；不可应用或应用后无变化时必须失败并留 issue。',
  '- 现有相关测试通过。',
  '- TypeScript 类型检查通过。',
  '',
  '测试命令：node scripts/m1-check.mjs',
  '需求来源：docs/status.md §160（真实待办）。提交者：脚本 Agent（m1-self-e2e）；不是 owner 批准，也不代表所有者验收。',
].join('\n')

const REQUIREMENT_DOC = [
  '# M1-2 真实自身需求基线：控制补丁在仓库子目录中的应用',
  '',
  '- 需求来源：docs/status.md §160「发现但不碰」记录的真实待办，非 fixture、非测试造数。',
  '- 提交者：脚本 Agent（m1-self-e2e）。本文不是 owner 批准，也不代表所有者验收。',
  '- 生成方式：由 scripts/ts/real-self-e2e.ts 写入并随现场基线提交；提交给 ForgeLoop 的原文与下方完全一致。',
  '',
  '## 需求原文',
  '',
  REQUIREMENT,
  '',
].join('\n')

/**
 * 基线检查脚本（不属于模型需求改动）：
 * 真实执行 TypeScript 类型检查与定向 Vitest。验证副本与提交检查工作树都不带
 * node_modules，脚本按 FORGELOOP_SELF_NODE_MODULES（协调宿主环境注入）临时建立
 * junction，结束后移除，避免被复制进候选构建目录。
 */
const CHECK_SCRIPT = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const cwd = process.cwd()
const deps = resolve(process.env.FORGELOOP_SELF_NODE_MODULES || findDeps(cwd) || join(cwd, 'node_modules'))
function findDeps(start) {
  let dir = start
  for (;;) {
    const candidate = join(dir, 'node_modules')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return ''
    dir = parent
  }
}
const tsc = join(deps, 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) {
  console.error('[m1-check] 依赖根不可用：' + deps + '；需要 FORGELOOP_SELF_NODE_MODULES')
  process.exit(1)
}

const link = join(cwd, 'node_modules')
let created = false
if (!existsSync(link)) {
  // 验证/提交工作树通常没有 node_modules；优先使用祖先目录中预先建立的依赖链接，
  // 不在候选工作树内创建 junction，避免被宿主沙箱拒绝。
  const ancestor = findDeps(cwd)
  if (ancestor && resolve(ancestor) !== resolve(link)) {
    process.env.FORGELOOP_SELF_NODE_MODULES = ancestor
  } else {
    try {
      symlinkSync(deps, link, 'junction')
      created = true
    } catch (error) {
      console.error('[m1-check] 无法建立 node_modules：' + (error && error.message ? error.message : String(error)))
      process.exit(1)
    }
  }
}

let code = 0
try {
  execFileSync(process.execPath, [tsc, '-p', 'packages/forgeloop/tsconfig.json', '--noEmit'], { cwd, stdio: 'inherit' })
} catch (error) {
  code = error && typeof error.status === 'number' && error.status > 0 ? error.status : 1
} finally {
  if (created) {
    try {
      rmdirSync(link)
    } catch {
      try {
        unlinkSync(link)
      } catch {
        // 链接已被移除；没有需要清理的副作用。
      }
    }
  }
}
process.exit(code)
`

/**
 * 基线打包脚本（不属于模型需求改动）：
 * 真实编译插件、npm pack 出候选 tarball，并写出候选清单 `dist/artifact.json`，
 * 使制品包含本次需求提交后的编译结果。依赖根处理与 m1-check 相同。
 */
const PACKAGE_SCRIPT = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const cwd = process.cwd()

function fail(message) {
  console.error('[m1-package] ' + message)
  process.exit(1)
}

function findDeps(start) {
  let dir = start
  for (;;) {
    const candidate = join(dir, 'node_modules')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return ''
    dir = parent
  }
}

const deps = resolve(process.env.FORGELOOP_SELF_NODE_MODULES || findDeps(cwd) || join(cwd, 'node_modules'))
const tsc = join(deps, 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) fail('依赖根不可用：' + deps + '；需要 FORGELOOP_SELF_NODE_MODULES')

const link = join(cwd, 'node_modules')
let created = false
if (!existsSync(link)) {
  const ancestor = findDeps(cwd)
  if (ancestor && resolve(ancestor) !== resolve(link)) {
    process.env.FORGELOOP_SELF_NODE_MODULES = ancestor
  } else {
    try {
      symlinkSync(deps, link, 'junction')
      created = true
    } catch (error) {
      fail('无法建立 node_modules：' + (error && error.message ? error.message : String(error)))
    }
  }
}

try {
  execFileSync(process.execPath, [tsc, '-p', 'packages/forgeloop/tsconfig.json'], { cwd, stdio: 'inherit' })
  execFileSync(process.execPath, [join(cwd, 'packages', 'forgeloop', 'lib', 'cli', 'pack.js')], { cwd, stdio: 'inherit' })
  const packedPath = join(cwd, 'packages', 'forgeloop', 'dist', 'artifact.json')
  if (!existsSync(packedPath)) fail('打包后没有产物清单：' + packedPath)
  const packed = JSON.parse(readFileSync(packedPath, 'utf8'))
  const tarball = packed.tarball
  if (!tarball || !existsSync(tarball)) fail('打包后没有 tarball：' + String(tarball))
  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  if (sha256 !== packed.sha256) fail('tarball 摘要与打包记录不一致')
  mkdirSync(join(cwd, 'dist'), { recursive: true })
  const artifact = {
    name: packed.name,
    version: packed.version,
    tarball,
    sha256,
    files: Array.isArray(packed.files) ? packed.files : [],
    gitHead: packed.gitHead || '',
    builtAt: packed.builtAt || new Date().toISOString(),
  }
  writeFileSync(join(cwd, 'dist', 'artifact.json'), JSON.stringify(artifact, null, 2) + '\\n')
  process.stdout.write(JSON.stringify(artifact) + '\\n')
} catch (error) {
  fail(error && error.message ? error.message : String(error))
} finally {
  if (created) {
    try {
      rmdirSync(link)
    } catch {
      try {
        unlinkSync(link)
      } catch {
        // 链接已被移除；没有需要清理的副作用。
      }
    }
  }
}
`

interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface RunOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}

interface Paths {
  readonly root: string
  readonly project: string
  readonly coordinatorHome: string
  readonly targetHome: string
  readonly recordsRoot: string
  readonly dbPath: string
  readonly targetDir: string
  readonly installScript: string
  readonly coordinatorConfig: string
  readonly coordinatorLog: string
  readonly targetConfig: string
  readonly summaryPath: string
}

type Row = Record<string, unknown>

function log(message: string): void {
  console.log(`[real-self-e2e] ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tail(path: string, bytes = 2000): string {
  try {
    return readFileSync(path, 'utf8').slice(-bytes)
  } catch {
    return '(无日志)'
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sha256Buffer(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readJsonFile(path: string): Row {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`不是 JSON 对象：${path}`)
  }
  return value as Row
}

function asRow(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined
}

function rowString(row: Row | undefined, key: string): string {
  const value = row?.[key]
  return typeof value === 'string' ? value : ''
}

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function rowNumber(row: Row | undefined, key: string): number {
  const value = row?.[key]
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
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

function gitIdentityEnv(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: 'Real Self E2E',
    GIT_AUTHOR_EMAIL: 'real-self-e2e@example.invalid',
    GIT_COMMITTER_NAME: 'Real Self E2E',
    GIT_COMMITTER_EMAIL: 'real-self-e2e@example.invalid',
  }
}

/** 统一启动方式：Windows 上的 .cmd/.bat 由 launch 转成 cmd.exe，调用方带上 spawnOptions。 */
function runLaunched(spec: Launch, options: RunOptions = {}): CommandResult {
  try {
    const stdout = execFileSync(spec.file, [...spec.args], {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
      ...(spec.spawnOptions ?? {}),
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as {
      status?: number
      stdout?: string
      stderr?: string
      message?: string
    }
    return {
      code: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? '',
    }
  }
}

function runCommand(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): CommandResult {
  return runLaunched(launch(file, [...args]), options)
}

function dshCommand(args: readonly string[]): Launch {
  return launch(process.execPath, [DSH_CLI, ...args])
}

function spawnLogged(
  spec: Launch,
  options: { cwd?: string; env: NodeJS.ProcessEnv; logPath: string },
): ChildProcess {
  const fd = openSync(options.logPath, 'w')
  try {
    return spawn(spec.file, [...spec.args], {
      cwd: options.cwd ?? ROOT,
      env: options.env,
      stdio: ['ignore', fd, fd],
      ...(spec.spawnOptions ?? {}),
    })
  } finally {
    closeSync(fd)
  }
}

function killPid(pid: number): void {
  if (!pid || pid <= 0) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 进程可能已退出。
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!alive(pid)) return
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {
      // 非 Windows 没有 taskkill；上面的 process.kill 已经生效。
    }
    const until = Date.now() + 100
    while (Date.now() < until) {
      // 等待进程退出；SIGKILL 是异步回收。
    }
  }
}

function alive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function requireEnvironment(): void {
  if (!DSH_CLI) {
    throw new Error(
      '需要 FORGELOOP_DSH_CLI 指向 dsh 的 lib/bin.js：目标安装器用它把制品装进隔离 profile 并启动真实宿主',
    )
  }
  if (!existsSync(DSH_CLI)) throw new Error(`FORGELOOP_DSH_CLI 指向的文件不存在：${DSH_CLI}`)
  if (PATCH && !existsSync(PATCH)) {
    throw new Error(`FORGELOOP_REAL_MODEL_PATCH 指向的文件不存在：${PATCH}`)
  }
}

/* ------------------------------------------------------------------ */
/* 现场：真实 Git 工作树、依赖链接、基线文件与基线提交                    */
/* ------------------------------------------------------------------ */

function createProjectWorktree(project: string): void {
  const result = runCommand(GIT, ['worktree', 'add', '--detach', project, 'HEAD'], {
    cwd: ROOT,
  })
  if (result.code !== 0) {
    throw new Error(`创建项目工作树失败：${result.stderr || result.stdout}`)
  }
}

/** 依赖复用仓库现有的 node_modules，不复制记录、缓存或构建产物。 */
function linkDependencies(project: string): void {
  const link = join(project, 'node_modules')
  if (existsSync(link)) return
  const target = join(ROOT, 'node_modules')
  if (!existsSync(target)) throw new Error(`仓库依赖不存在：${target}`)
  if (process.platform === 'win32') {
    const command = `mklink /J "${link}" "${target}"`
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    })
    if (result.status !== 0) {
      throw new Error(
        `建立 node_modules junction 失败（${command}）：${result.stderr || result.stdout || '无输出'}`,
      )
    }
  } else {
    symlinkSync(target, link, 'dir')
  }
  if (!existsSync(link)) throw new Error(`node_modules 链接没有建立：${link}`)
}

function writeBaseline(project: string): void {
  mkdirSync(join(project, 'docs'), { recursive: true })
  mkdirSync(join(project, 'scripts'), { recursive: true })
  writeFileSync(join(project, 'docs', 'm1-self-requirement.md'), REQUIREMENT_DOC, 'utf8')
  writeFileSync(join(project, 'scripts', 'm1-check.mjs'), CHECK_SCRIPT, 'utf8')
  writeFileSync(join(project, 'scripts', 'm1-package.mjs'), PACKAGE_SCRIPT, 'utf8')
}

/** 基线文件先提交，保证需求提交时项目干净、候选 diff 只含模型改动。 */
function commitBaseline(project: string): string {
  const added = runCommand(GIT, ['add', '-A'], { cwd: project })
  if (added.code !== 0) throw new Error(`暂存基线失败：${added.stderr || added.stdout}`)
  const committed = runCommand(GIT, ['commit', '-qm', 'forgeloop self e2e baseline'], {
    cwd: project,
    env: { ...process.env, ...gitIdentityEnv() },
  })
  if (committed.code !== 0) {
    throw new Error(`提交基线失败：${committed.stderr || committed.stdout}`)
  }
  const head = runCommand(GIT, ['rev-parse', 'HEAD'], { cwd: project })
  if (head.code !== 0) throw new Error(`读取基线提交失败：${head.stderr}`)
  return head.stdout.trim()
}

/* ------------------------------------------------------------------ */
/* 当前插件 tarball、profile 安装与协调宿主                              */
/* ------------------------------------------------------------------ */

function buildCurrentTarball(): { tarball: string; sha256: string; version: string } {
  const built = runLaunched(npmLaunch(['run', 'candidate']), {
    cwd: join(ROOT, 'packages', 'forgeloop'),
  })
  if (built.code !== 0) {
    throw new Error(`构建当前插件包失败：${(built.stderr || built.stdout).slice(-1200)}`)
  }
  const artifactPath = join(ROOT, 'packages', 'forgeloop', 'dist', 'artifact.json')
  if (!existsSync(artifactPath)) throw new Error(`插件包清单不存在：${artifactPath}`)
  const artifact = readJsonFile(artifactPath)
  const tarball = rowString(artifact, 'tarball')
  const declared = rowString(artifact, 'sha256')
  const version = rowString(artifact, 'version')
  if (!tarball || !existsSync(tarball)) throw new Error(`插件 tarball 不存在：${tarball}`)
  if (!version) throw new Error('插件包清单缺少版本号')
  const actual = sha256File(tarball)
  if (declared !== actual) {
    throw new Error(`插件 tarball 摘要与清单不一致：清单 ${declared}，实际 ${actual}`)
  }
  return { tarball, sha256: actual, version }
}

function installProfile(
  home: string,
  profile: string,
  template: string,
  tarball: string,
  env: NodeJS.ProcessEnv,
): void {
  const created = runLaunched(
    dshCommand(['--profile', profile, '--from-default-profile', template, '--dump-config']),
    { cwd: ROOT, env },
  )
  if (created.code !== 0) {
    throw new Error(
      `初始化 profile ${profile} 失败：${(created.stderr || created.stdout).slice(-800)}`,
    )
  }
  const added = runLaunched(dshCommand(['plugin', '--profile', profile, 'add', tarball]), {
    cwd: ROOT,
    env,
  })
  if (added.code !== 0) {
    throw new Error(`安装插件到 ${profile} 失败：${(added.stderr || added.stdout).slice(-800)}`)
  }
  const installed = join(home, 'profiles', profile, 'node_modules', 'forgeloop-dsh')
  if (!existsSync(installed)) throw new Error(`profile ${profile} 没有安装 forgeloop-dsh`)
}

function writeCoordinatorConfig(paths: Paths): void {
  const config = {
    project: PROJECT,
    projectPath: paths.project,
    recordsRoot: paths.recordsRoot,
    pollSeconds: 2,
    owner: OWNER,
    autoAdvance: true,
    agent: {
      provider: '',
      model: '',
      timeoutSeconds: TURN_TIMEOUT_SECONDS,
      maxTurnSeconds: TURN_TIMEOUT_SECONDS,
      idleTimeoutSeconds: 600,
    },
    formalTestTimeoutSeconds: 300,
    maxTaskAttempts: MAX_TASK_ATTEMPTS,
    failureRoundsPerGrant: MAX_FAILURE_ROUNDS,
    maxVerificationAttempts: 3,
    // 候选构建的编译与打包在 m1-package.mjs 里真实执行；这里只要求命令存在且可运行。
    candidateBuildCommand: ['node', '-e', 'process.exit(0)'],
    candidatePackageCommand: ['node', 'scripts/m1-package.mjs'],
    candidateArtifactPath: 'dist/artifact.json',
    dshProfilesRoot: join(paths.targetHome, 'profiles'),
    autonomy: {
      enabled: true,
      allowAnySource: true,
      allowCodeCommit: true,
      requireOwner: false,
      // 提交检查必须是真实验证候选的命令；m1-check 会跑 tsc 与定向 vitest，失败即拒绝提交。
      commitCheckCommand: ['node', 'scripts/m1-check.mjs'],
    },
    ops: { enabled: false },
    deployments: {
      enabled: true,
      verifyTimeoutSeconds: 300,
      alerts: { webhook: 'http://127.0.0.1:9/unreachable', timeoutSeconds: 5 },
      tools: [
        {
          id: TOOL_ID,
          kind: 'python',
          path: paths.installScript,
          capabilities: ['preflight', 'apply', 'status', 'rollback', 'data-rollback'],
          timeoutSeconds: 900,
          env: [
            'SystemRoot',
            'TEMP',
            'TMP',
            'USERPROFILE',
            'APPDATA',
            'LOCALAPPDATA',
            'HOMEDRIVE',
            'HOMEPATH',
            'PATHEXT',
            'COMSPEC',
          ],
        },
      ],
      targets: [
        {
          id: TARGET_ID,
          toolId: TOOL_ID,
          requirementId: '',
          autoDeliver: true,
          approval: 'auto',
          params: { target: paths.targetDir },
          rollback: { keep: 1 },
        },
      ],
    },
  }
  writeFileSync(paths.coordinatorConfig, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

/** 目标宿主只需要被动加载插件并写出运行身份；独立 records、不自动推进。 */
function writeTargetConfig(paths: Paths): void {
  const config = {
    project: 'm1-self-target',
    projectPath: paths.project,
    recordsRoot: join(paths.targetDir, 'records'),
    pollSeconds: 3600,
    owner: 'm1-self-target',
    autoAdvance: false,
    autonomy: { enabled: false },
    ops: { enabled: false },
    deployments: { enabled: false },
  }
  writeFileSync(paths.targetConfig, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function startCoordinator(paths: Paths, env: NodeJS.ProcessEnv, port: number): ChildProcess {
  const spec = dshCommand([
    '--profile',
    COORDINATOR_PROFILE,
    ...(PATCH ? ['--patch', PATCH] : []),
    '--port',
    String(port),
    '--no-open',
  ])
  return spawnLogged(spec, { cwd: ROOT, env, logPath: paths.coordinatorLog })
}

async function waitForDatabase(
  child: ChildProcess,
  dbPath: string,
  logPath: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(dbPath)) return
    if (child.exitCode !== null) {
      throw new Error(`协调宿主提前退出（code=${String(child.exitCode)}）：${tail(logPath)}`)
    }
    await sleep(500)
  }
  throw new Error(`协调宿主没有创建记录库 ${dbPath}：${tail(logPath)}`)
}

/* ------------------------------------------------------------------ */
/* 真实模型提交需求                                                     */
/* ------------------------------------------------------------------ */

function parseRequirementId(output: string): string {
  const match = /req-\d{14}-[a-z0-9]{6}/i.exec(output)
  return match ? match[0] : ''
}

function submitRequirement(env: NodeJS.ProcessEnv, clientKey: string): string {
  const prompt = [
    'You are running a ForgeLoop end-to-end check.',
    'Call the forgeloop_submit_requirement tool exactly once with these arguments:',
    `text: ${JSON.stringify(REQUIREMENT)}`,
    `client_key: ${JSON.stringify(clientKey)}`,
    'After the tool returns, answer with the requirement id exactly as returned. Do not call other tools and do not modify any file.',
  ].join('\n')
  const spec = dshCommand([
    '--profile',
    HEADLESS_PROFILE,
    ...(PATCH ? ['--patch', PATCH] : []),
    '--json',
    prompt,
  ])
  const result = spawnSync(spec.file, [...spec.args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: SUBMIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    ...(spec.spawnOptions ?? {}),
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.status !== 0) {
    throw new Error(
      `真实模型提交需求失败（退出码 ${String(result.status)}）：${(stderr || stdout).slice(-1200)}`,
    )
  }
  if (!stdout.includes('"tool":"forgeloop_submit_requirement"')) {
    throw new Error(`模型没有调用 forgeloop_submit_requirement；输出：${stdout.slice(-1200)}`)
  }
  const reqId = parseRequirementId(stdout)
  if (!reqId) {
    throw new Error(`模型输出里没有需求 ID；输出：${stdout.slice(-1200)}`)
  }
  return reqId
}

/* ------------------------------------------------------------------ */
/* 固定 reqId 读取权威记录                                              */
/* ------------------------------------------------------------------ */

function openDatabase(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true })
}

function queryOne(
  db: DatabaseSync,
  sql: string,
  params: readonly (string | number)[] = [],
): Row | undefined {
  return asRow(db.prepare(sql).get(...params))
}

function queryAll(db: DatabaseSync, sql: string, params: readonly (string | number)[] = []): Row[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => asRow(row))
    .filter((row): row is Row => row !== undefined)
}

function queryCount(
  db: DatabaseSync,
  sql: string,
  params: readonly (string | number)[] = [],
): number {
  return rowNumber(queryOne(db, sql, params), 'count')
}

interface Snapshot {
  readonly requirement?: Row
  readonly analysisCount: number
  readonly admission?: Row
  readonly planCount: number
  readonly tasksTotal: number
  readonly tasksCompleted: number
  readonly codeCandidateCount: number
  readonly verification?: Row
  readonly review?: Row
  readonly commit?: Row
  readonly build?: Row
  readonly intent?: Row
  readonly handoff?: Row
}

function readSnapshot(dbPath: string, reqId: string): Snapshot {
  const db = openDatabase(dbPath)
  try {
    return {
      requirement: queryOne(db, 'SELECT * FROM requirements WHERE req_id = ?', [reqId]),
      analysisCount: queryCount(
        db,
        'SELECT COUNT(*) AS count FROM requirement_analyses WHERE req_id = ?',
        [reqId],
      ),
      admission: queryOne(
        db,
        'SELECT * FROM requirement_admissions WHERE req_id = ? ORDER BY created_at DESC LIMIT 1',
        [reqId],
      ),
      planCount: queryCount(
        db,
        'SELECT COUNT(*) AS count FROM requirement_task_plans WHERE req_id = ?',
        [reqId],
      ),
      tasksTotal: queryCount(
        db,
        'SELECT COUNT(*) AS count FROM requirement_task_runs WHERE req_id = ?',
        [reqId],
      ),
      tasksCompleted: queryCount(
        db,
        "SELECT COUNT(*) AS count FROM requirement_task_runs WHERE req_id = ? AND state = 'completed'",
        [reqId],
      ),
      codeCandidateCount: queryCount(
        db,
        'SELECT COUNT(*) AS count FROM requirement_code_candidates WHERE req_id = ?',
        [reqId],
      ),
      verification: queryOne(
        db,
        'SELECT * FROM requirement_verifications WHERE req_id = ? ORDER BY verified_at DESC LIMIT 1',
        [reqId],
      ),
      review: queryOne(
        db,
        'SELECT * FROM requirement_business_reviews WHERE req_id = ? ORDER BY reviewed_at DESC LIMIT 1',
        [reqId],
      ),
      commit: queryOne(
        db,
        'SELECT * FROM requirement_commits WHERE req_id = ? ORDER BY committed_at DESC LIMIT 1',
        [reqId],
      ),
      build: queryOne(
        db,
        'SELECT * FROM requirement_candidate_builds WHERE req_id = ? ORDER BY built_at DESC LIMIT 1',
        [reqId],
      ),
      intent: queryOne(
        db,
        'SELECT * FROM deployment_intents WHERE requirement_id = ? ORDER BY created_at DESC LIMIT 1',
        [reqId],
      ),
      handoff: queryOne(
        db,
        'SELECT state, detail FROM delivery_handoffs WHERE req_id = ? AND state IN (?, ?) ORDER BY updated_at DESC LIMIT 1',
        [reqId, 'build_failed', 'deploy_failed'],
      ),
    }
  } finally {
    db.close()
  }
}

function describeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify({
    status: rowString(snapshot.requirement, 'status'),
    analyses: snapshot.analysisCount,
    admission: rowString(snapshot.admission, 'decision'),
    plans: snapshot.planCount,
    tasks: `${snapshot.tasksCompleted}/${snapshot.tasksTotal}`,
    candidates: snapshot.codeCandidateCount,
    verification: rowString(snapshot.verification, 'verdict'),
    review: rowString(snapshot.review, 'verdict'),
    commit: rowString(snapshot.commit, 'commit_sha').slice(0, 12),
    build: rowString(snapshot.build, 'artifact_sha256').slice(0, 12),
    intent: rowString(snapshot.intent, 'state'),
    handoff: rowString(snapshot.handoff, 'state'),
    blocked: rowString(snapshot.requirement, 'blocked_reason').slice(0, 120),
  })
}

const TERMINAL_INTENT_STATES = new Set([
  'failed',
  'verify_failed',
  'preflight_failed',
  'rejected',
  'rolled_back',
])

/** 只按固定 reqId 等待；任何“最新一行”都不能替代本次需求。 */
async function waitForDelivery(dbPath: string, reqId: string): Promise<Snapshot> {
  const deadline = Date.now() + TIMEOUT_MS
  let lastLine = ''
  let blockedSince: number | null = null
  while (Date.now() < deadline) {
    const snapshot = readSnapshot(dbPath, reqId)
    const line = describeSnapshot(snapshot)
    if (line !== lastLine) {
      log(`进度：${line}`)
      lastLine = line
    }
    const status = rowString(snapshot.requirement, 'status')
    if (status === 'cancelled' || status === 'rejected') {
      throw new Error(`需求停在 ${status}：${rowString(snapshot.requirement, 'blocked_reason')}`)
    }
    const intentState = rowString(snapshot.intent, 'state')
    if (TERMINAL_INTENT_STATES.has(intentState)) {
      throw new Error(
        `部署 intent 停在 ${intentState}（制品 ${rowString(snapshot.intent, 'artifact_version')}）；记录库 ${dbPath}`,
      )
    }
    if (rowString(snapshot.handoff, 'state')) {
      throw new Error(`自动交付失败：${rowString(snapshot.handoff, 'detail')}`)
    }
    if (status === 'blocked') {
      blockedSince ??= Date.now()
      if (Date.now() - blockedSince > BLOCKED_GRACE_MS) {
        throw new Error(
          `需求持续阻塞超过 ${Math.round(BLOCKED_GRACE_MS / 1000)} 秒：${rowString(snapshot.requirement, 'blocked_reason')}`,
        )
      }
    } else {
      blockedSince = null
    }
    const delivered = status === 'committed' || status === 'accepted'
    if (delivered && intentState === 'verified') return snapshot
    await sleep(5_000)
  }
  throw new Error(
    `等待需求到 verified 超时（${Math.round(TIMEOUT_MS / 1000)} 秒）；最后状态：${lastLine}`,
  )
}

/* ------------------------------------------------------------------ */
/* 真实目标安装器与目标宿主                                             */
/* ------------------------------------------------------------------ */

function installerSource(paths: Paths): string {
  const lines = [
    'import hashlib, json, os, signal, socket, subprocess, sys, time',
    '',
    `NODE_EXE = ${JSON.stringify(process.execPath)}`,
    `DSH_CLI = ${JSON.stringify(DSH_CLI)}`,
    `TARGET_HOME = ${JSON.stringify(paths.targetHome)}`,
    `TARGET_PROFILE = ${JSON.stringify(TARGET_PROFILE)}`,
    `TARGET_CONFIG = ${JSON.stringify(paths.targetConfig)}`,
    `SYSTEM_ROOT = ${JSON.stringify(process.env.SystemRoot ?? '')}`,
    '',
    'args = sys.argv',
    'op = args[args.index("--op") + 1]',
    'with open(args[args.index("--plan") + 1], "r", encoding="utf-8") as handle:',
    '    plan = json.load(handle)',
    'target = plan["params"]["target"]',
    'profile_dir = os.path.join(TARGET_HOME, "profiles", TARGET_PROFILE)',
    'installed = os.path.join(profile_dir, "node_modules", "forgeloop-dsh")',
    'identity_path = os.path.join(installed, "runtime-identity.json")',
    'pid_file = os.path.join(target, "host.pid")',
    'port_file = os.path.join(target, "port")',
    'host_log = os.path.join(target, "host.log")',
    'install_record = os.path.join(target, "install.json")',
    '',
    'def sha256(path):',
    '    digest = hashlib.sha256()',
    '    with open(path, "rb") as handle:',
    '        for chunk in iter(lambda: handle.read(65536), b""):',
    '            digest.update(chunk)',
    '    return digest.hexdigest()',
    '',
    'def read_json(path):',
    '    with open(path, "r", encoding="utf-8") as handle:',
    '        return json.load(handle)',
    '',
    'def write_text(path, text):',
    '    parent = os.path.dirname(path)',
    '    if parent:',
    '        os.makedirs(parent, exist_ok=True)',
    '    with open(path, "w", encoding="utf-8") as handle:',
    '        handle.write(text)',
    '',
    'def tail(path, limit=2000):',
    '    try:',
    '        with open(path, "r", encoding="utf-8", errors="replace") as handle:',
    '            return handle.read()[-limit:]',
    '    except Exception:',
    '        return "(无日志)"',
    '',
    'def alive(pid):',
    '    if not pid or pid <= 0:',
    '        return False',
    '    try:',
    '        os.kill(pid, 0)',
    '        return True',
    '    except Exception:',
    '        return False',
    '',
    'def host_env():',
    '    env = dict(os.environ)',
    '    if SYSTEM_ROOT and not env.get("SystemRoot"):',
    '        env["SystemRoot"] = SYSTEM_ROOT',
    '    env["DSH_HOME"] = TARGET_HOME',
    '    env["FORGELOOP_CONFIG"] = TARGET_CONFIG',
    '    env["FORGELOOP_DSH_CLI"] = DSH_CLI',
    '    return env',
    '',
    'def run_cli(cli_args, timeout=600):',
    '    command = [NODE_EXE, DSH_CLI] + cli_args',
    '    proc = subprocess.run(command, cwd=target, env=host_env(), capture_output=True, text=True,',
    '                          encoding="utf-8", errors="replace", timeout=timeout)',
    '    if proc.returncode != 0:',
    '        raise RuntimeError("dsh " + " ".join(cli_args) + " 退出码 " + str(proc.returncode) + "："',
    '                           + (proc.stderr or proc.stdout or "")[-800:])',
    '    return proc.stdout',
    '',
    'def stop_host():',
    '    pid = 0',
    '    try:',
    '        with open(pid_file, "r", encoding="utf-8") as handle:',
    '            pid = int(handle.read().strip())',
    '    except Exception:',
    '        pid = 0',
    '    if pid and alive(pid):',
    '        try:',
    '            os.kill(pid, signal.SIGKILL)',
    '        except Exception:',
    '            subprocess.run(["taskkill", "/pid", str(pid), "/t", "/f"], capture_output=True, text=True)',
    '        for _ in range(100):',
    '            if not alive(pid):',
    '                break',
    '            time.sleep(0.1)',
    '    try:',
    '        os.remove(pid_file)',
    '    except Exception:',
    '        pass',
    '',
    'def free_port():',
    '    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
    '    sock.bind(("127.0.0.1", 0))',
    '    port = sock.getsockname()[1]',
    '    sock.close()',
    '    return port',
    '',
    'def ensure_profile():',
    '    if os.path.isfile(os.path.join(profile_dir, "package.json")):',
    '        return',
    '    run_cli(["--profile", TARGET_PROFILE, "--from-default-profile", "web", "--dump-config"])',
    '',
    'def install_tarball(tarball):',
    '    if not os.path.isfile(tarball):',
    '        raise RuntimeError("制品不存在：" + tarball)',
    '    digest = sha256(tarball)',
    '    ensure_profile()',
    '    run_cli(["plugin", "--profile", TARGET_PROFILE, "add", tarball])',
    '    if not os.path.isdir(installed):',
    '        raise RuntimeError("安装后没有找到插件包目录：" + installed)',
    '    if os.path.islink(installed):',
    '        raise RuntimeError("目标 profile 使用链接安装，不能证明真实 tarball 安装")',
    '    write_text(os.path.join(installed, "artifact.sha256"), digest + "\\n")',
    '    return digest',
    '',
    'def start_host():',
    '    try:',
    '        os.remove(identity_path)',
    '    except Exception:',
    '        pass',
    '    port = free_port()',
    '    with open(host_log, "w", encoding="utf-8") as log_handle:',
    '        proc = subprocess.Popen(',
    '            [NODE_EXE, DSH_CLI, "--profile", TARGET_PROFILE, "--port", str(port), "--no-open"],',
    '            cwd=target,',
    '            env=host_env(),',
    '            stdin=subprocess.DEVNULL,',
    '            stdout=log_handle,',
    '            stderr=log_handle,',
    '            start_new_session=True,',
    '        )',
    '    write_text(pid_file, str(proc.pid) + "\\n")',
    '    write_text(port_file, str(port) + "\\n")',
    '    deadline = time.time() + 120',
    '    while time.time() < deadline:',
    '        if proc.poll() is not None:',
    '            raise RuntimeError("target host 提前退出（退出码 " + str(proc.returncode) + "）：" + tail(host_log))',
    '        try:',
    '            identity = read_json(identity_path)',
    '        except Exception:',
    '            identity = None',
    '        if identity and int(identity.get("pid", 0) or 0) == proc.pid:',
    '            return {"pid": proc.pid, "port": port, "identity": identity}',
    '        time.sleep(0.2)',
    '    raise RuntimeError("target host 120 秒内没有写出与进程 pid 一致的 runtime-identity.json：" + tail(host_log))',
    '',
    'def installed_digest(relative):',
    '    try:',
    '        return sha256(os.path.join(installed, relative))',
    '    except Exception:',
    '        return ""',
    '',
    'def status_result():',
    '    installed_version = ""',
    '    try:',
    '        installed_version = str(read_json(os.path.join(installed, "package.json")).get("version", ""))',
    '    except Exception:',
    '        installed_version = ""',
    '    marker = ""',
    '    try:',
    '        with open(os.path.join(installed, "artifact.sha256"), "r", encoding="utf-8") as handle:',
    '            marker = handle.read().strip()',
    '    except Exception:',
    '        marker = ""',
    '    identity = None',
    '    try:',
    '        identity = read_json(identity_path)',
    '    except Exception:',
    '        identity = None',
    '    identity = identity or {}',
    '    host_pid = 0',
    '    try:',
    '        with open(pid_file, "r", encoding="utf-8") as handle:',
    '            host_pid = int(handle.read().strip())',
    '    except Exception:',
    '        host_pid = 0',
    '    pid = int(identity.get("pid", 0) or 0)',
    '    running = alive(pid)',
    '    index_sha = str(identity.get("indexSha256", ""))',
    '    service_sha = str(identity.get("serviceSha256", ""))',
    '    client_sha = str(identity.get("clientSha256", ""))',
    '    installed_index = installed_digest(os.path.join("lib", "index.js"))',
    '    installed_service = installed_digest(os.path.join("lib", "runtime", "service.js"))',
    '    installed_client = installed_digest("client.js")',
    '    issues = []',
    '    if not installed_version:',
    '        issues.append("安装包缺少版本号")',
    '    if len(marker) != 64:',
    '        issues.append("安装包缺少 artifact.sha256")',
    '    if not identity:',
    '        issues.append("缺少 runtime-identity.json")',
    '    if identity and identity.get("kind") != "forgeloop-runtime-identity":',
    '        issues.append("运行身份 kind 不符")',
    '    if identity and installed_version and identity.get("version") != installed_version:',
    '        issues.append("运行版本与安装版本不一致")',
    '    if identity and marker and identity.get("artifactSha256") != marker:',
    '        issues.append("运行进程制品摘要与安装摘要不一致")',
    '    if identity and host_pid and pid != host_pid:',
    '        issues.append("运行身份 pid 与 host.pid 不一致")',
    '    if identity and not running:',
    '        issues.append("运行进程不存活")',
    '    if identity and index_sha != installed_index:',
    '        issues.append("入口摘要与安装内容不一致")',
    '    if identity and service_sha != installed_service:',
    '        issues.append("服务摘要与安装内容不一致")',
    '    if identity and client_sha != installed_client:',
    '        issues.append("客户端摘要与安装内容不一致")',
    '    result = {',
    '        "ok": len(issues) == 0,',
    '        "state": "running" if len(issues) == 0 else "unknown",',
    '        "version": installed_version or str(identity.get("version", "")),',
    '        "artifactSha256": marker,',
    '        "runningArtifactSha256": str(identity.get("artifactSha256", "")),',
    '        "runningPid": pid,',
    '        "runningStartedAt": str(identity.get("startedAt", "")),',
    '        "installedVersion": installed_version,',
    '        "identityVersion": str(identity.get("version", "")),',
    '        "identityKind": str(identity.get("kind", "")),',
    '        "indexSha256": index_sha,',
    '        "serviceSha256": service_sha,',
    '        "clientSha256": client_sha,',
    '        "installedIndexSha256": installed_index,',
    '        "installedServiceSha256": installed_service,',
    '        "installedClientSha256": installed_client,',
    '        "hostPid": host_pid,',
    '        "detail": "；".join(issues) if issues else "安装与运行身份一致",',
    '    }',
    '    try:',
    '        with open(port_file, "r", encoding="utf-8") as handle:',
    '            result["port"] = int(handle.read().strip())',
    '    except Exception:',
    '        result["port"] = 0',
    '    return result',
    '',
    'if op == "preflight":',
    '    restorable = os.path.isdir(installed)',
    '    print(json.dumps({"ok": True, "state": "ready", "detail": "preflight ok",',
    '                      "restorePoint": "profile:" + TARGET_PROFILE if restorable else ""}))',
    'elif op == "apply":',
    '    artifact = plan["artifact"]',
    '    tarball = artifact["path"]',
    '    expected = str(artifact.get("sha256", ""))',
    '    actual = sha256(tarball)',
    '    if expected and actual != expected:',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": "制品摘要与计划不一致"}))',
    '        sys.exit(0)',
    '    stop_host()',
    '    try:',
    '        marker = install_tarball(tarball)',
    '        started = start_host()',
    '    except Exception as error:',
    '        try:',
    '            stop_host()',
    '        except Exception:',
    '            pass',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": str(error)}))',
    '        sys.exit(0)',
    '    identity = started["identity"]',
    '    with open(install_record, "w", encoding="utf-8") as handle:',
    '        json.dump({"version": str(artifact.get("version", "")), "artifactSha256": marker,',
    '                   "pid": started["pid"], "port": started["port"],',
    '                   "startedAt": str(identity.get("startedAt", "")),',
    '                   "appliedAtEpoch": time.time()}, handle)',
    '    print(json.dumps({"ok": True, "state": "applied", "version": str(artifact.get("version", "")),',
    '                      "artifactSha256": marker, "runningArtifactSha256": str(identity.get("artifactSha256", "")),',
    '                      "runningPid": started["pid"], "runningStartedAt": str(identity.get("startedAt", "")),',
    '                      "detail": "已安装并重启 target host pid=" + str(started["pid"])}))',
    'elif op == "status":',
    '    print(json.dumps(status_result(), ensure_ascii=False))',
    'elif op == "rollback":',
    '    previous = plan.get("previous")',
    '    if not previous:',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": "没有上一已验证制品"}))',
    '        sys.exit(0)',
    '    path = str(previous.get("path", ""))',
    '    expected = str(previous.get("sha256", ""))',
    '    if not os.path.isfile(path):',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": "上一已验证制品不存在"}))',
    '        sys.exit(0)',
    '    if expected and sha256(path) != expected:',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": "上一已验证制品摘要不一致"}))',
    '        sys.exit(0)',
    '    stop_host()',
    '    try:',
    '        marker = install_tarball(path)',
    '        started = start_host()',
    '    except Exception as error:',
    '        try:',
    '            stop_host()',
    '        except Exception:',
    '            pass',
    '        print(json.dumps({"ok": False, "state": "failed", "detail": str(error)}))',
    '        sys.exit(0)',
    '    identity = started["identity"]',
    '    print(json.dumps({"ok": True, "state": "rolled_back", "version": str(previous.get("version", "")),',
    '                      "artifactSha256": marker, "runningArtifactSha256": str(identity.get("artifactSha256", "")),',
    '                      "runningPid": started["pid"], "runningStartedAt": str(identity.get("startedAt", "")),',
    '                      "detail": "已回退并重启 target host pid=" + str(started["pid"])}))',
    'elif op == "data-rollback":',
    '    print(json.dumps({"ok": True, "state": "rolled_back", "detail": "no data scope"}))',
    'else:',
    '    print(json.dumps({"ok": False, "state": "failed", "detail": "unknown op"}))',
    '',
  ]
  return lines.join('\n')
}

function writeInstaller(paths: Paths): void {
  mkdirSync(dirname(paths.installScript), { recursive: true })
  writeFileSync(paths.installScript, installerSource(paths), 'utf8')
}

function runInstaller(paths: Paths, op: string, planPath: string): Row {
  const spec = launch(PYTHON, [paths.installScript, '--op', op, '--plan', planPath])
  const result = spawnSync(spec.file, [...spec.args], {
    cwd: dirname(paths.installScript),
    env: process.env,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 16 * 1024 * 1024,
    ...(spec.spawnOptions ?? {}),
  })
  const stdout = (result.stdout ?? '').trim()
  if (result.status !== 0) {
    throw new Error(
      `安装器 ${op} 退出码 ${String(result.status)}：${(result.stderr || stdout).slice(-800)}`,
    )
  }
  const parsed = asRow(JSON.parse(stdout))
  if (!parsed) throw new Error(`安装器 ${op} 输出不是 JSON 对象：${stdout.slice(-500)}`)
  return parsed
}

function writeStatusPlan(paths: Paths, build: Row): string {
  const planPath = join(paths.root, 'status-plan.json')
  const plan = {
    intentId: 'self-e2e-status',
    op: 'status',
    artifact: {
      sha256: rowString(build, 'artifact_sha256'),
      path: rowString(build, 'tarball'),
      version: rowString(build, 'package_version'),
    },
    previous: null,
    params: { target: paths.targetDir },
    device: { id: 'local', transport: 'local' },
    data: { volumes: [], migrations: [] },
    timeoutSeconds: 300,
  }
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  return planPath
}

function stopTargetHost(paths: Paths): void {
  const pidFile = join(paths.targetDir, 'host.pid')
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (Number.isFinite(pid) && pid > 0) killPid(pid)
}

/* ------------------------------------------------------------------ */
/* 证据收集与断言                                                       */
/* ------------------------------------------------------------------ */

function parseStringArray(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function tarballMember(tarball: string, member: string): Buffer | null {
  try {
    return execFileSync('tar', ['-xzf', tarball, '-O', member], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/** 从已经 verified 的记录与真实安装现场收集证据；只读，不改写任何记录。 */
async function collectEvidence(paths: Paths, reqId: string): Promise<Row> {
  const db = openDatabase(paths.dbPath)
  try {
    const requirement = queryOne(db, 'SELECT * FROM requirements WHERE req_id = ?', [reqId])
    const versions = queryAll(
      db,
      'SELECT version, text, revised_by, source FROM requirement_versions WHERE req_id = ? ORDER BY version',
      [reqId],
    )
    const analysisCount = queryCount(
      db,
      'SELECT COUNT(*) AS count FROM requirement_analyses WHERE req_id = ?',
      [reqId],
    )
    const admission = queryOne(
      db,
      'SELECT * FROM requirement_admissions WHERE req_id = ? ORDER BY created_at DESC LIMIT 1',
      [reqId],
    )
    const plan = queryOne(
      db,
      'SELECT * FROM requirement_task_plans WHERE req_id = ? ORDER BY plan_version DESC LIMIT 1',
      [reqId],
    )
    const planVersion = rowNumber(plan, 'plan_version')
    const taskRuns = queryAll(
      db,
      'SELECT task_id, state, reason FROM requirement_task_runs WHERE req_id = ? AND plan_version = ?',
      [reqId, planVersion],
    )
    const build = queryOne(
      db,
      'SELECT * FROM requirement_candidate_builds WHERE req_id = ? AND plan_version = ? ORDER BY built_at DESC LIMIT 1',
      [reqId, planVersion],
    )
    const candidateSha256 = rowString(build, 'candidate_sha256')
    const verification = queryOne(
      db,
      'SELECT * FROM requirement_verifications WHERE req_id = ? AND plan_version = ? AND candidate_sha256 = ?',
      [reqId, planVersion, candidateSha256],
    )
    const review = queryOne(
      db,
      'SELECT * FROM requirement_business_reviews WHERE req_id = ? AND plan_version = ? AND candidate_sha256 = ?',
      [reqId, planVersion, candidateSha256],
    )
    const commit = queryOne(
      db,
      'SELECT * FROM requirement_commits WHERE req_id = ? AND plan_version = ? AND candidate_sha256 = ?',
      [reqId, planVersion, candidateSha256],
    )
    const codeCandidate = queryOne(
      db,
      'SELECT * FROM requirement_code_candidates WHERE req_id = ? AND plan_version = ? ORDER BY candidate_version DESC LIMIT 1',
      [reqId, planVersion],
    )
    const intents = queryAll(
      db,
      'SELECT * FROM deployment_intents WHERE requirement_id = ? ORDER BY created_at',
      [reqId],
    )
    const intent = intents.find(
      (item) => rowString(item, 'artifact_sha256') === rowString(build, 'artifact_sha256'),
    )
    const intentId = rowString(intent, 'intent_id')
    const attempts = intentId
      ? queryAll(
          db,
          'SELECT op, state, exit_code, detail FROM deployment_attempts WHERE intent_id = ? ORDER BY started_at',
          [intentId],
        )
      : []
    const decisions = intentId
      ? queryAll(
          db,
          'SELECT decision, decided_by, detail FROM deployment_decisions WHERE intent_id = ? ORDER BY decided_at',
          [intentId],
        )
      : []
    const applyAttempt = attempts.find(
      (item) => rowString(item, 'op') === 'apply' && rowString(item, 'state') === 'ready',
    )
    return {
      requirement,
      versions,
      analysisCount,
      admission,
      plan,
      planVersion,
      taskRuns,
      build,
      candidateSha256,
      verification,
      review,
      commit,
      codeCandidate,
      intents,
      intent,
      attempts,
      decisions,
      applyStartedAt: rowString(applyAttempt, 'started_at'),
    }
  } finally {
    db.close()
  }
}

function evaluateEvidence(
  paths: Paths,
  reqId: string,
  evidence: Row,
): { failures: string[]; values: Row } {
  const failures: string[] = []
  const ok = (condition: boolean, message: string): void => {
    if (!condition) failures.push(message)
  }
  const requirement = asRow(evidence.requirement) ?? {}
  const versions = Array.isArray(evidence.versions) ? (evidence.versions as Row[]) : []
  const planVersion = rowNumber(evidence, 'planVersion')
  const build = asRow(evidence.build) ?? {}
  const verification = asRow(evidence.verification) ?? {}
  const review = asRow(evidence.review) ?? {}
  const commit = asRow(evidence.commit) ?? {}
  const intent = asRow(evidence.intent) ?? {}
  const admission = asRow(evidence.admission) ?? {}
  const codeCandidate = asRow(evidence.codeCandidate) ?? {}
  const attempts = Array.isArray(evidence.attempts) ? (evidence.attempts as Row[]) : []
  const decisions = Array.isArray(evidence.decisions) ? (evidence.decisions as Row[]) : []
  const intents = Array.isArray(evidence.intents) ? (evidence.intents as Row[]) : []
  const taskRuns = Array.isArray(evidence.taskRuns) ? (evidence.taskRuns as Row[]) : []
  const candidateSha256 = valueText(evidence.candidateSha256)
  const latestVersionText =
    versions.length > 0 ? rowString(versions[versions.length - 1], 'text') : ''

  // 1. 需求身份与进度（固定 reqId）。
  ok(rowString(requirement, 'req_id') === reqId, '记录库中没有固定 reqId 对应的需求')
  ok(
    rowString(requirement, 'status') === 'committed',
    `需求状态不是 committed：${rowString(requirement, 'status')}`,
  )
  ok(
    rowString(requirement, 'project') === PROJECT,
    `需求项目不符：${rowString(requirement, 'project')}`,
  )
  ok(
    rowString(requirement, 'source') === 'dsh-tool:submit_requirement',
    `需求来源不是真实模型工具：${rowString(requirement, 'source')}`,
  )
  ok(
    rowString(requirement, 'submitted_by') === `agent:${OWNER}`,
    `提交者不是脚本 Agent 身份：${rowString(requirement, 'submitted_by')}`,
  )
  ok(
    !rowString(requirement, 'accepted_by'),
    `需求被写入了验收人，脚本不应伪造验收：${rowString(requirement, 'accepted_by')}`,
  )
  ok(latestVersionText === REQUIREMENT, '需求原文与基线记录不一致')
  ok(latestVersionText.includes('docs/status.md §160'), '需求原文没有标注 docs/status.md §160 来源')
  ok(Number(evidence.analysisCount) >= 1, '需求没有分析记录')
  ok(
    rowString(admission, 'decision') === 'admit',
    `系统准入没有通过：${rowString(admission, 'decision')}`,
  )
  ok(planVersion >= 1, '需求没有任务包')
  ok(
    taskRuns.length > 0 && taskRuns.every((run) => rowString(run, 'state') === 'completed'),
    `任务没有全部完成：${taskRuns.map((run) => `${rowString(run, 'task_id')}=${rowString(run, 'state')}`).join('、')}`,
  )

  // 2. 候选 → 验证 → 终审 → 提交 → 构建必须绑定同一候选身份。
  ok(candidateSha256.length === 64, '候选构建缺少候选身份')
  ok(
    rowString(codeCandidate, 'candidate_sha256') === candidateSha256,
    '最新代码候选与候选构建身份不一致',
  )
  ok(
    rowString(verification, 'verdict') === 'pass',
    `独立验证未通过：${rowString(verification, 'verdict')}`,
  )
  ok(
    rowString(verification, 'candidate_sha256') === candidateSha256,
    '独立验证绑定的候选与构建候选不一致（验证不新鲜）',
  )
  ok(
    rowNumber(verification, 'requirement_version') === versions.length,
    `独立验证绑定的需求版本已过期：${String(rowNumber(verification, 'requirement_version'))} != ${versions.length}`,
  )
  ok(
    rowString(verification, 'report_path') && existsSync(rowString(verification, 'report_path'))
      ? sha256File(rowString(verification, 'report_path')) ===
          rowString(verification, 'report_sha256')
      : false,
    '独立验证报告文件缺失或摘要不一致（验证不新鲜）',
  )
  ok(
    rowString(build, 'verification_sha256') === rowString(verification, 'report_sha256'),
    '候选构建绑定的验证报告与当前验证不一致',
  )
  ok(rowString(review, 'verdict') === 'pass', `业务终审未通过：${rowString(review, 'verdict')}`)
  ok(
    rowString(review, 'candidate_sha256') === candidateSha256,
    '业务终审绑定的候选与构建候选不一致',
  )
  ok(
    rowString(review, 'verification_sha256') === rowString(verification, 'report_sha256'),
    '业务终审绑定的验证与当前验证不一致',
  )
  ok(
    rowString(review, 'report_path') && existsSync(rowString(review, 'report_path'))
      ? sha256File(rowString(review, 'report_path')) === rowString(review, 'report_sha256')
      : false,
    '业务终审报告文件缺失或摘要不一致',
  )
  const commitSha = rowString(commit, 'commit_sha')
  ok(/^[0-9a-f]{40}$/.test(commitSha), `受控提交 sha 异常：${commitSha}`)
  ok(
    rowString(commit, 'candidate_sha256') === candidateSha256,
    '受控提交绑定的候选与构建候选不一致',
  )

  // 3. 提交内容必须包含本次需求的实现与测试。
  const recordedFiles = parseStringArray(rowString(commit, 'files_json'))
  const gitFiles =
    commitSha && existsSync(paths.project)
      ? runCommand(GIT, ['show', '--name-only', '--pretty=format:', commitSha], {
          cwd: paths.project,
        })
      : { code: 1, stdout: '', stderr: '' }
  const actualFiles = gitFiles.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const implemented = recordedFiles.includes(
    'packages/forgeloop/src/runtime/verification-controls.ts',
  )
  const tested = recordedFiles.some(
    (file) => file.startsWith('packages/forgeloop/tests/') && file.endsWith('.test.ts'),
  )
  ok(implemented, `受控提交没有包含 verification-controls.ts：${recordedFiles.join('、')}`)
  ok(tested, `受控提交没有包含回归测试改动：${recordedFiles.join('、')}`)
  ok(
    actualFiles.includes('packages/forgeloop/src/runtime/verification-controls.ts'),
    `真实提交没有包含 verification-controls.ts：${actualFiles.join('、')}`,
  )
  ok(
    actualFiles.some(
      (file) => file.startsWith('packages/forgeloop/tests/') && file.endsWith('.test.ts'),
    ),
    `真实提交没有包含回归测试改动：${actualFiles.join('、')}`,
  )

  // 4. 候选 tarball 必须是真实文件、摘要一致，并包含本次需求的编译产物。
  const tarball = rowString(build, 'tarball')
  const buildSha = rowString(build, 'artifact_sha256')
  const actualTarballSha = tarball && existsSync(tarball) ? sha256File(tarball) : ''
  ok(Boolean(tarball && existsSync(tarball)), `候选 tarball 不存在：${tarball}`)
  ok(buildSha.length === 64, '候选构建缺少制品摘要')
  ok(
    actualTarballSha === buildSha,
    `候选构建摘要与 tarball 实际摘要不一致：${buildSha} != ${actualTarballSha}`,
  )
  const moduleMember = tarball
    ? tarballMember(tarball, 'package/lib/runtime/verification-controls.js')
    : null
  const moduleSha = moduleMember ? sha256Buffer(moduleMember) : ''
  ok(Boolean(moduleMember), '候选 tarball 没有包含 verification-controls 的编译产物')
  ok(
    rowString(build, 'git_head').length >= 7 || recordedFiles.length > 0,
    '候选构建缺少可回查的提交或文件清单',
  )

  // 5. 部署 intent 与运行现场。
  ok(intents.length >= 1, '需求没有部署 intent')
  ok(
    intents.filter((item) => rowString(item, 'state') === 'verified').length === 1,
    `需求应恰好有 1 个 verified intent，实际 ${intents.length} 个 intent`,
  )
  ok(
    rowString(intent, 'state') === 'verified',
    `部署 intent 不是 verified：${rowString(intent, 'state')}`,
  )
  ok(
    rowString(intent, 'target_id') === TARGET_ID,
    `部署目标不符：${rowString(intent, 'target_id')}`,
  )
  ok(
    rowString(intent, 'approval') === 'auto',
    `部署审批方式不是 auto：${rowString(intent, 'approval')}`,
  )
  ok(rowString(intent, 'artifact_sha256') === buildSha, '部署 intent 制品摘要与候选构建不一致')
  ok(rowString(intent, 'artifact_path') === tarball, '部署 intent 制品路径与候选构建不一致')
  ok(
    attempts.some(
      (item) => rowString(item, 'op') === 'apply' && rowString(item, 'state') === 'ready',
    ),
    '部署没有成功的 apply 记录',
  )
  ok(
    attempts.some(
      (item) => rowString(item, 'op') === 'status' && rowString(item, 'state') === 'ready',
    ),
    '部署没有成功的 status 核对记录',
  )
  const verifyDecision = decisions.find((item) => rowString(item, 'decision') === 'verify')
  ok(Boolean(verifyDecision), '部署缺少系统核对决定')
  ok(
    verifyDecision ? rowString(verifyDecision, 'decided_by') === 'system:coordinator' : false,
    `部署核对不是系统执行：${rowString(verifyDecision, 'decided_by')}`,
  )
  ok(
    !decisions.some((item) => rowString(item, 'decision') === 'approve'),
    '部署出现了人工批准记录；脚本不应伪造 owner 批准',
  )

  // 6. 真实安装器观测：安装摘要、运行身份与安装文件摘要必须一致。
  const installerStatus = asRow(evidence.installerStatus) ?? {}
  ok(
    installerStatus.ok === true,
    `目标安装器 status 不 ok：${rowString(installerStatus, 'detail')}`,
  )
  ok(
    rowString(installerStatus, 'version') === rowString(build, 'package_version'),
    '安装版本与候选包版本不一致',
  )
  ok(
    rowString(installerStatus, 'artifactSha256') === buildSha,
    '安装包 artifact.sha256 与候选制品摘要不一致',
  )
  ok(
    rowString(installerStatus, 'runningArtifactSha256') === buildSha,
    '运行进程报告的制品摘要与候选制品摘要不一致',
  )
  ok(
    rowString(installerStatus, 'identityVersion') === rowString(build, 'package_version'),
    '运行身份版本与候选包版本不一致',
  )
  ok(
    rowString(installerStatus, 'identityKind') === 'forgeloop-runtime-identity',
    '运行身份 kind 不符',
  )
  ok(
    rowString(installerStatus, 'indexSha256') ===
      rowString(installerStatus, 'installedIndexSha256'),
    '运行身份入口摘要与安装文件不一致',
  )
  ok(
    rowString(installerStatus, 'serviceSha256') ===
      rowString(installerStatus, 'installedServiceSha256'),
    '运行身份服务摘要与安装文件不一致',
  )
  ok(
    rowString(installerStatus, 'clientSha256') ===
      rowString(installerStatus, 'installedClientSha256'),
    '运行身份客户端摘要与安装文件不一致',
  )
  const runningPid = rowNumber(installerStatus, 'runningPid')
  ok(runningPid > 0, '安装器没有给出有效运行进程 pid')
  ok(rowNumber(installerStatus, 'hostPid') === runningPid, '安装器 host.pid 与运行身份 pid 不一致')
  ok(alive(runningPid), `目标宿主进程不存活：${runningPid}`)
  const startedAt = Date.parse(rowString(installerStatus, 'runningStartedAt'))
  const appliedAt = Date.parse(valueText(evidence.applyStartedAt))
  ok(Number.isFinite(startedAt), '运行进程启动时间不可解析')
  ok(
    !Number.isFinite(appliedAt) || startedAt >= appliedAt - 5_000,
    '运行进程启动时间早于本次安装，进程可能仍加载旧制品',
  )

  return {
    failures,
    values: {
      reqId,
      commitSha,
      candidateSha256,
      buildSha,
      tarball,
      planVersion,
      intentId: rowString(intent, 'intent_id'),
      installStatus: installerStatus,
      committedFiles: recordedFiles,
      actualCommitFiles: actualFiles,
      moduleShaInTarball: moduleSha,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

function preparePaths(root: string): Paths {
  const project = join(root, 'project')
  const coordinatorHome = join(root, 'coordinator-home')
  const targetHome = join(root, 'target-home')
  const recordsRoot = join(root, 'records')
  const targetDir = join(root, 'target')
  return {
    root,
    project,
    coordinatorHome,
    targetHome,
    recordsRoot,
    dbPath: join(recordsRoot, 'projects', PROJECT, 'records.sqlite'),
    targetDir,
    installScript: join(recordsRoot, 'projects', PROJECT, 'deployments', 'tools', 'install.py'),
    coordinatorConfig: join(root, 'forgeloop.json'),
    coordinatorLog: join(root, 'coordinator.log'),
    targetConfig: join(targetDir, 'dsh-config.json'),
    summaryPath: join(root, 'summary.json'),
  }
}

function writeSummary(paths: Paths, summary: Row): void {
  writeFileSync(paths.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
}

function cleanupWorktree(project: string): void {
  const link = join(project, 'node_modules')
  if (existsSync(link)) {
    try {
      rmdirSync(link)
    } catch {
      // node_modules 不是本脚本建立的链接时保持原样；工作树移除会自行处理。
    }
  }
  runCommand(GIT, ['worktree', 'remove', '--force', project], { cwd: ROOT })
  runCommand(GIT, ['worktree', 'prune'], { cwd: ROOT })
}

async function main(): Promise<void> {
  if (!ENABLED) {
    log(
      '跳过：设置 FORGELOOP_REAL_SELF=1 或运行脚本时带 --self（会调用真实模型并产生费用；需要 FORGELOOP_DSH_CLI）',
    )
    return
  }
  const root =
    process.env.FORGELOOP_REAL_SELF_ROOT?.trim() || mkdtempSync(join(tmpdir(), 'forgeloop-self-'))
  const paths = preparePaths(root)
  for (const dir of [
    paths.project,
    paths.coordinatorHome,
    paths.targetHome,
    paths.recordsRoot,
    paths.targetDir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  // 验证/提交工作树位于 records 下；在项目记录根的祖先放依赖链接，
  // 让候选工作树无需在沙箱内创建 node_modules。
  const recordsProjectRoot = join(paths.recordsRoot, 'projects', PROJECT)
  mkdirSync(recordsProjectRoot, { recursive: true })
  linkDependencies(recordsProjectRoot)
  const failures: string[] = []
  const summary: Row = {
    mode: 'real-self-e2e',
    root,
    projectPath: paths.project,
    recordsRoot: paths.recordsRoot,
    coordinatorHome: paths.coordinatorHome,
    targetHome: paths.targetHome,
    targetDir: paths.targetDir,
    dbPath: paths.dbPath,
    coordinatorLog: paths.coordinatorLog,
    targetHostLog: join(paths.targetDir, 'host.log'),
    installScript: paths.installScript,
    startedAt: new Date().toISOString(),
  }
  let coordinator: ChildProcess | undefined
  let reqId = ''
  let tarballInfo: { tarball: string; sha256: string; version: string } | undefined
  try {
    requireEnvironment()
    log('创建真实项目工作树并准备基线文件')
    createProjectWorktree(paths.project)
    linkDependencies(paths.project)
    writeBaseline(paths.project)
    const baseline = commitBaseline(paths.project)
    summary.baselineCommit = baseline

    log('构建当前插件 tarball，并准备隔离的协调/提交 profile')
    tarballInfo = buildCurrentTarball()
    summary.pluginTarball = tarballInfo.tarball
    summary.pluginTarballSha256 = tarballInfo.sha256
    summary.pluginVersion = tarballInfo.version

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...gitIdentityEnv(),
      DSH_HOME: paths.coordinatorHome,
      FORGELOOP_CONFIG: paths.coordinatorConfig,
      FORGELOOP_SELF_NODE_MODULES: join(paths.project, 'node_modules'),
      FORGELOOP_DSH_CLI: DSH_CLI,
    }
    installProfile(paths.coordinatorHome, COORDINATOR_PROFILE, 'web', tarballInfo.tarball, env)
    installProfile(paths.coordinatorHome, HEADLESS_PROFILE, 'headless', tarballInfo.tarball, env)
    writeCoordinatorConfig(paths)
    writeTargetConfig(paths)
    writeInstaller(paths)

    const port = await freePort()
    summary.coordinatorPort = port
    coordinator = startCoordinator(paths, env, port)
    log(`协调宿主已启动 pid=${String(coordinator.pid)} port=${port}`)
    await waitForDatabase(coordinator, paths.dbPath, paths.coordinatorLog)

    const clientKey = `m1-self-${Date.now().toString(36)}`
    reqId = submitRequirement(env, clientKey)
    summary.reqId = reqId
    summary.clientKey = clientKey
    log(`真实模型已提交需求 ${reqId}`)

    // 固定 reqId 复核提交身份，避免把别人的需求当成本次样本。
    const submitted = readSnapshot(paths.dbPath, reqId)
    if (!submitted.requirement) {
      throw new Error(`记录库中没有提交后的需求 ${reqId}`)
    }
    summary.submittedBy = rowString(submitted.requirement, 'submitted_by')
    summary.requirementSource = rowString(submitted.requirement, 'source')

    log('等待分析 → 准入 → 规划 → 研发 → 验证 → 终审 → 提交 → 构建 → 部署核对')
    const delivered = await waitForDelivery(paths.dbPath, reqId)
    summary.deliveredAt = new Date().toISOString()
    summary.deliveredStatus = rowString(delivered.requirement, 'status')
    summary.intentState = rowString(delivered.intent, 'state')

    const evidence = await collectEvidence(paths, reqId)
    const build = asRow(evidence.build)
    if (!build) throw new Error('需求已 verified 但记录库中没有候选构建')
    const statusPlan = writeStatusPlan(paths, build)
    const installerStatus = runInstaller(paths, 'status', statusPlan)
    evidence.installerStatus = installerStatus
    summary.installerStatus = installerStatus

    const evaluated = evaluateEvidence(paths, reqId, evidence)
    failures.push(...evaluated.failures)
    summary.values = evaluated.values
    summary.evidence = {
      requirement: evidence.requirement,
      versions: evidence.versions,
      admission: evidence.admission,
      planVersion: evidence.planVersion,
      taskRuns: evidence.taskRuns,
      codeCandidate: evidence.codeCandidate,
      verification: evidence.verification,
      businessReview: evidence.review,
      commit: evidence.commit,
      build: evidence.build,
      intents: evidence.intents,
      intent: evidence.intent,
      attempts: evidence.attempts,
      decisions: evidence.decisions,
      statusPlan,
    }
    log(`证据已收集：reqId=${reqId} intent=${rowString(asRow(evidence.intent), 'intent_id')}`)
  } catch (error) {
    failures.push(`执行失败：${errorText(error)}`)
  } finally {
    summary.finishedAt = new Date().toISOString()
    stopTargetHost(paths)
    terminate(coordinator)
    summary.targetHostStopped = true
    const keep = failures.length > 0 || KEEP
    summary.failures = failures
    if (keep) {
      summary.kept = true
      writeSummary(paths, summary)
    } else {
      cleanupWorktree(paths.project)
      rmSync(root, { recursive: true, force: true })
      summary.removed = true
    }
  }
  if (failures.length > 0) {
    log(`FAIL：${failures.join('；')}`)
    log(`现场与 summary.json：${paths.summaryPath}`)
    process.exitCode = 1
    return
  }
  log(
    `OK：${reqId} 完成真实需求 → 研发 → 独立验证/终审/提交 → 候选构建 → 真实安装 → 运行身份核对 verified；插件 ${tarballInfo?.version ?? ''}`,
  )
  log(`记录库：${paths.dbPath}（成功默认清理；KEEP=1 保留现场）`)
}

await main()
