#!/usr/bin/env node
/**
 * 真实模型闭环 E2E（opt-in，会产生模型费用）：
 * 隔离 DSH_HOME 与临时 Git 项目 → 安装插件 → 启动 web 协调器 →
 * 由真实模型通过 forgeloop_submit_requirement 提交需求 →
 * 轮询权威 SQLite，直到需求完成准入、研发、独立验证与受控提交。
 *
 * 默认跳过；`make real-model-e2e` 或 `FORGELOOP_REAL_MODEL=1` 才运行。
 * 设置 FORGELOOP_REAL_MODEL_DEPLOY=1 时，提交后继续构建候选、所有者验收并调用登记部署工具
 * 部署到隔离目标 profile；默认只验证到受控提交。
 * 派生 profile 默认沿用官方模板的模型；把 `FORGELOOP_REAL_MODEL_PATCH` 指向一个
 * loader patch 文件，即可改用启动环境里有凭据的 provider（例如 Qwen Token Plan）。
 * 需要启动环境提供对应密钥；脚本不改动生产记录与正式 profile。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ForgeLoopRuntime } from '../../packages/forgeloop/lib/runtime/service.js'
import { resolveConfig } from '../../packages/forgeloop/lib/config.js'

const ROOT = resolve(import.meta.dirname, '../..')
const PROFILE = process.env.FORGELOOP_REAL_MODEL_PROFILE ?? 'forgeloop-real-model'
const WEB_PROFILE = `${PROFILE}-web`
const HEADLESS_PROFILE = `${PROFILE}-headless`
const DSH = process.env.FORGELOOP_DSH ?? 'dsh'
/** Windows/开发环境可指向 `apps/cli/lib/bin.js`，用当前 node 启动，绕开 .cmd 限制。 */
const DSH_CLI = process.env.FORGELOOP_DSH_CLI ?? ''
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function dshCommand(args: string[]): [string, string[]] {
  return DSH_CLI ? [process.execPath, [DSH_CLI, ...args]] : [DSH, args]
}
const PROJECT = 'forgeloop-real-model'
/** 可选 loader patch：叠加在派生 profile 之后，只影响隔离实例的模型路由。 */
const PATCH = process.env.FORGELOOP_REAL_MODEL_PATCH
/** opt-in：提交后再构建候选、验收并走真实部署工具到隔离目标。 */
const DEPLOY = process.env.FORGELOOP_REAL_MODEL_DEPLOY === '1'
const TIMEOUT_MS = Number(process.env.FORGELOOP_REAL_MODEL_TIMEOUT_MS ?? 1_800_000)
const HEADLESS_TIMEOUT_MS = Number(process.env.FORGELOOP_REAL_MODEL_SUBMIT_TIMEOUT_MS ?? 600_000)
/** blocked 的宽限期：默认可自动重排，持续阻塞超过该时长才判失败。 */
const BLOCKED_GRACE_MS = Number(process.env.FORGELOOP_REAL_MODEL_BLOCKED_GRACE_MS ?? 240_000)
/** 单回合上限：真实模型规划/实现可能超过 10 分钟，默认放宽到 30 分钟。 */
const TURN_TIMEOUT_SECONDS = Number(process.env.FORGELOOP_REAL_MODEL_TURN_TIMEOUT_SECONDS ?? 1800)
/** E2E 的研发尝试次数：有界，避免真实模型判断异常时空转到超时；默认 3。 */
const MAX_TASK_ATTEMPTS = Number(process.env.FORGELOOP_REAL_MODEL_MAX_TASK_ATTEMPTS ?? 3)

const REQUIREMENT = [
  '在 docs/real-model-e2e.md 中写入一行 real model e2e ok。',
  '非目标：不要新增测试文件，也不要修改 docs/real-model-e2e.md 以外的任何文件。',
  '验收标准：docs/real-model-e2e.md 存在，且内容包含 real model e2e ok。',
  `测试命令：node -e "const fs=require('node:fs');const t=fs.readFileSync('docs/real-model-e2e.md','utf8');if(!t.includes('real model e2e ok')){console.log('missing');process.exit(1)}console.log('real-model-e2e-ok')"`,
].join('\n')

interface RequirementRow {
  readonly req_id: string
  readonly status: string
  readonly source: string
  readonly submitted_by: string
  readonly blocked_reason: string
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
  const [command, argv] = dshCommand(args)
  const result = spawnSync(command, argv, { cwd: ROOT, env, encoding: 'utf8', timeout: 300_000 })
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(' ')} 失败：${result.stderr || result.stdout}`)
  }
}

/** 给一次启动拼上 profile 与可选的覆盖层；`--patch` 放在 `--profile` 之后、app 参数之前。 */
function launchArgs(profile: string, appArgs: string[]): string[] {
  return ['--profile', profile, ...(PATCH ? ['--patch', PATCH] : []), ...appArgs]
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
  /** 首次进入 blocked 的时间；离开 blocked 即清零。 */
  let blockedSince: number | null = null
  while (Date.now() < deadline) {
    if (!existsSync(dbPath)) {
      await sleep(5_000)
      continue
    }
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const requirement = queryOne<RequirementRow>(
        db,
        'SELECT req_id, status, source, submitted_by, blocked_reason FROM requirements ORDER BY created_at DESC LIMIT 1',
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
          blockedReason: requirement.blocked_reason || '',
        }
        const line = JSON.stringify(summary)
        if (line !== lastLine) {
          console.log(`[real-model-e2e] 进度：${line}`)
          lastLine = line
        }
        if (requirement.status === 'committed' || requirement.status === 'accepted') {
          return { requirement, summary }
        }
        if (requirement.status === 'cancelled' || requirement.status === 'rejected') {
          throw new Error(`需求停在 ${requirement.status}：${line}`)
        }
        // blocked 不是终态：默认 MAX 限额下协调器会自动重排。只有持续阻塞超过宽限期才判失败。
        if (requirement.status === 'blocked') {
          blockedSince ??= Date.now()
          if (Date.now() - blockedSince > BLOCKED_GRACE_MS) {
            throw new Error(`需求持续阻塞超过 ${BLOCKED_GRACE_MS / 1000} 秒：${line}`)
          }
        } else {
          blockedSince = null
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

interface DeploymentFixture {
  readonly toolPath: string
  readonly targetDir: string
  readonly port: number
}

/** 真实运行体：从制品里加载 app.mjs，用 /identity 暴露启动时缓存的介质摘要。 */
const SERVER_SOURCE = `import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { message, VERSION } from './app.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// 启动时读取并缓存安装介质摘要：进程活着就只报告它启动时加载的那一份。
const artifactSha256 = createHash('sha256').update(readFileSync(join(here, 'bundle.tgz'))).digest('hex')
const startedAt = new Date().toISOString()
const port = Number(process.env.FORGELOOP_M1_PORT || 0)
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  if (req.url === '/identity') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: VERSION, artifactSha256, pid: process.pid, startedAt, message: message() }))
    return
  }
  res.writeHead(404)
  res.end()
})
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('listening ' + String(server.address().port) + '\\n')
})
`

/**
 * 真实安装器：解包制品、替换安装目录、重启真实 node 进程，
 * status 通过 HTTP 观测运行进程启动时缓存的介质摘要，而不是复制计划里的期望值。
 */
function prepareDeployment(
  projectDir: string,
  recordsRoot: string,
  home: string,
): DeploymentFixture {
  // 候选构建要求项目内有插件包清单；这是隔离夹具的基线内容，不属于需求改动。
  mkdirSync(join(projectDir, 'packages', 'forgeloop'), { recursive: true })
  writeFileSync(
    join(projectDir, 'packages', 'forgeloop', 'package.json'),
    `${JSON.stringify({ name: 'forgeloop-dsh', version: '1.0.0' }, null, 2)}\n`,
  )
  const scripts = join(projectDir, 'scripts')
  mkdirSync(scripts, { recursive: true })
  writeFileSync(
    join(scripts, 'package.mjs'),
    [
      "import { createHash } from 'node:crypto'",
      "import { execFileSync } from 'node:child_process'",
      "import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'",
      '// 制品必须包含本次需求的真实产物：把需求写入的标记行编进可运行模块。',
      "const doc = readFileSync('docs/real-model-e2e.md', 'utf8')",
      "const occurrences = doc.split('real model e2e ok').length - 1",
      "if (occurrences < 1) throw new Error('需求产物缺少 real model e2e ok')",
      "rmSync('dist/bundle', { recursive: true, force: true })",
      "mkdirSync('dist/bundle', { recursive: true })",
      `writeFileSync('dist/bundle/app.mjs', "export const VERSION = '1.0.0'\\nexport const MARKER = 'real model e2e ok'\\nexport const OCCURRENCES = " + String(occurrences) + "\\nexport function message() { return MARKER + ':' + String(OCCURRENCES) }\\n")`,
      "writeFileSync('dist/bundle/server.mjs', process.env.FORGELOOP_M1_SERVER_SOURCE)",
      "execFileSync('tar', ['-czf', 'dist/bundle.tgz', '-C', 'dist/bundle', '.'])",
      "const sha = createHash('sha256').update(readFileSync('dist/bundle.tgz')).digest('hex')",
      "let gitHead = ''",
      "try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}",
      "writeFileSync('dist/artifact.json', JSON.stringify({ sha256: sha, tarball: process.cwd() + '/dist/bundle.tgz', version: '1.0.0', files: ['app.mjs', 'server.mjs'], gitHead }))",
    ].join('\n'),
  )
  const toolDir = join(recordsRoot, 'projects', PROJECT, 'deployments', 'tools')
  mkdirSync(toolDir, { recursive: true })
  const toolPath = join(toolDir, 'install.py')
  writeFileSync(
    toolPath,
    [
      'import hashlib, json, os, shutil, signal, socket, subprocess, sys, tarfile, time, urllib.request',
      'args = sys.argv',
      'op = args[args.index("--op") + 1]',
      'plan = json.load(open(args[args.index("--plan") + 1]))',
      'target = plan["params"]["target"]',
      'current = os.path.join(target, "current")',
      'previous = os.path.join(target, "previous")',
      'pidfile = os.path.join(target, "process.pid")',
      'portfile = os.path.join(target, "port")',
      'def sha(path):',
      '    h = hashlib.sha256()',
      '    with open(path, "rb") as f:',
      '        for chunk in iter(lambda: f.read(65536), b""):',
      '            h.update(chunk)',
      '    return h.hexdigest()',
      'def alive(pid):',
      '    try:',
      '        os.kill(pid, 0)',
      '        return True',
      '    except Exception:',
      '        return False',
      'def stop():',
      '    try:',
      '        pid = int(open(pidfile).read().strip())',
      '    except Exception:',
      '        return',
      '    if pid and alive(pid):',
      '        try:',
      '            os.kill(pid, signal.SIGKILL)',
      '        except Exception:',
      '            pass',
      '        for _ in range(50):',
      '            if not alive(pid):',
      '                break',
      '            time.sleep(0.1)',
      'def free_port():',
      '    s = socket.socket()',
      '    s.bind(("127.0.0.1", 0))',
      '    port = s.getsockname()[1]',
      '    s.close()',
      '    return port',
      'def probe(port):',
      '    with urllib.request.urlopen("http://127.0.0.1:%d/identity" % port, timeout=2) as r:',
      '        return json.loads(r.read().decode("utf-8"))',
      'def start(port):',
      '    log = open(os.path.join(target, "server.log"), "w")',
      '    env = dict(os.environ)',
      '    env["FORGELOOP_M1_PORT"] = str(port)',
      '    proc = subprocess.Popen(["node", os.path.join(current, "server.mjs")], cwd=current, stdout=log, stderr=log, env=env, start_new_session=True)',
      '    open(pidfile, "w").write(str(proc.pid))',
      '    open(portfile, "w").write(str(port))',
      '    for _ in range(100):',
      '        try:',
      '            return probe(port)',
      '        except Exception:',
      '            if proc.poll() is not None:',
      '                raise RuntimeError("服务进程已退出：" + open(os.path.join(target, "server.log")).read()[-300:])',
      '            time.sleep(0.1)',
      '    raise RuntimeError("服务在 10 秒内没有提供 /identity")',
      'if op == "preflight":',
      '    restorable = os.path.isdir(current)',
      '    print(json.dumps({"ok": True, "state": "ready", "detail": "preflight ok", "restorePoint": "previous-1" if restorable else ""}))',
      'elif op == "apply":',
      '    stop()',
      '    if os.path.isdir(previous):',
      '        shutil.rmtree(previous)',
      '    if os.path.isdir(current):',
      '        shutil.move(current, previous)',
      '    os.makedirs(current)',
      '    with tarfile.open(plan["artifact"]["path"]) as tar:',
      '        tar.extractall(current)',
      '    shutil.copyfile(plan["artifact"]["path"], os.path.join(current, "bundle.tgz"))',
      '    port = free_port()',
      '    identity = start(port)',
      '    json.dump({"version": plan["artifact"]["version"], "artifactSha256": sha(os.path.join(current, "bundle.tgz")), "port": port}, open(os.path.join(target, "install.json"), "w"))',
      '    print(json.dumps({"ok": True, "state": "applied", "version": identity.get("version", ""), "detail": "installed and restarted pid=" + str(identity.get("pid"))}))',
      'elif op == "status":',
      '    try:',
      '        installed = sha(os.path.join(current, "bundle.tgz"))',
      '    except Exception:',
      '        installed = ""',
      '    try:',
      '        port = int(open(portfile).read().strip())',
      '        identity = probe(port)',
      '        print(json.dumps({"ok": True, "state": "running", "version": identity.get("version", ""), "artifactSha256": installed, "runningArtifactSha256": identity.get("artifactSha256", ""), "runningPid": identity.get("pid", 0), "runningStartedAt": identity.get("startedAt", ""), "detail": "identity=" + str(identity.get("message", ""))}))',
      '    except Exception as error:',
      '        print(json.dumps({"ok": False, "state": "unknown", "detail": "无法观测运行身份：" + str(error)}))',
      'elif op == "rollback":',
      '    stop()',
      '    if not os.path.isdir(previous):',
      '        print(json.dumps({"ok": False, "state": "failed", "detail": "no previous install"}))',
      '    else:',
      '        shutil.rmtree(current, ignore_errors=True)',
      '        shutil.move(previous, current)',
      '        port = free_port()',
      '        identity = start(port)',
      '        print(json.dumps({"ok": True, "state": "rolled_back", "version": identity.get("version", ""), "detail": "rolled back and restarted"}))',
      'elif op == "data-rollback":',
      '    print(json.dumps({"ok": True, "state": "rolled_back", "detail": "no data scope"}))',
      'else:',
      '    print(json.dumps({"ok": False, "state": "failed", "detail": "unknown op"}))',
    ].join('\n'),
  )
  const targetDir = join(home, 'profiles', 'real-model-target')
  mkdirSync(targetDir, { recursive: true })
  return { toolPath, targetDir, port: 0 }
}

function configFor(projectDir: string, recordsRoot: string, deploy?: DeploymentFixture) {
  return {
    project: PROJECT,
    projectPath: projectDir,
    recordsRoot,
    pollSeconds: 1,
    autoAdvance: true,
    owner: 'real-model-e2e',
    agent: { timeoutSeconds: TURN_TIMEOUT_SECONDS, maxTurnSeconds: TURN_TIMEOUT_SECONDS },
    formalTestTimeoutSeconds: 120,
    failureRoundsPerGrant: -1,
    maxVerificationAttempts: -1,
    maxTaskAttempts: MAX_TASK_ATTEMPTS,
    autonomy: { enabled: true, allowAnySource: true, allowCodeCommit: true, requireOwner: false },
    ...(deploy
      ? {
          candidateBuildCommand: ['node', '-e', 'process.exit(0)'],
          candidatePackageCommand: ['node', 'scripts/package.mjs'],
          candidateArtifactPath: 'dist/artifact.json',
          deployments: {
            enabled: true,
            alerts: { webhook: 'http://127.0.0.1:9/unreachable', timeoutSeconds: 5 },
            tools: [
              {
                id: 'real-model-tool',
                kind: 'python',
                path: deploy.toolPath,
                capabilities: ['preflight', 'apply', 'status', 'rollback', 'data-rollback'],
                timeoutSeconds: 60,
              },
            ],
            targets: [
              {
                id: 'real-model-target',
                toolId: 'real-model-tool',
                requirementId: '',
                approval: 'auto',
                autoDeliver: true,
                params: { target: deploy.targetDir },
                rollback: { keep: 1 },
              },
            ],
          },
        }
      : {}),
  }
}

/** 提交后由所有者入口构建、验收并部署；不使用模型，工具与目标都是真实进程。 */
async function deployCommitted(input: {
  reqId: string
  projectDir: string
  recordsRoot: string
  deploy: DeploymentFixture
}): Promise<{ intentId: string; artifact: string }> {
  const config = resolveConfig(
    configFor(input.projectDir, input.recordsRoot, input.deploy),
    input.projectDir,
  )
  const runtime = new ForgeLoopRuntime({
    ctx: {},
    config,
    runner: {
      async run() {
        throw new Error('部署 leg 不需要 Agent')
      },
      async open() {
        throw new Error('部署 leg 不需要 Agent')
      },
    },
  })
  try {
    const delivery = await runtime.deliveryHandoff.tick()
    if (delivery.built < 1) throw new Error('协调器没有自动构建候选')
    const build = runtime.repo.latestCandidateBuild(input.reqId)
    if (!build) throw new Error('候选构建记录缺失')
    const intent = runtime.deployments.list().find((item) => item.requirementId === input.reqId)
    if (!intent) throw new Error('协调器没有创建部署 intent')
    if (intent.state !== 'verified') throw new Error(`部署未核对通过：${intent.state}`)
    const portFile = join(input.deploy.targetDir, 'port')
    if (!existsSync(portFile)) throw new Error('安装器没有记录运行端口')
    const port = Number(readFileSync(portFile, 'utf8').trim())
    const response = await fetch(`http://127.0.0.1:${port}/identity`)
    if (!response.ok) throw new Error(`运行进程 /identity 返回 ${response.status}`)
    const identity = (await response.json()) as {
      version?: string
      artifactSha256?: string
      pid?: number
      startedAt?: string
      message?: string
    }
    // 运行进程自己报告的介质摘要必须等于本次构建的制品，版本相同不足以证明。
    if (identity.artifactSha256 !== build.artifactSha256) {
      throw new Error(
        `运行进程介质 ${identity.artifactSha256 ?? '未知'} 与制品 ${build.artifactSha256} 不一致`,
      )
    }
    if (identity.version !== build.packageVersion) {
      throw new Error(
        `运行版本 ${identity.version ?? '未知'} 与候选 ${build.packageVersion} 不一致`,
      )
    }
    if (!identity.pid || identity.pid <= 0) throw new Error('运行进程没有报告 pid')
    // 业务行为来自需求产物：标记行在打包时进入可运行模块。
    if (!String(identity.message ?? '').startsWith('real model e2e ok')) {
      throw new Error(`运行进程业务输出不符合需求产物：${String(identity.message)}`)
    }
    const startedAt = Date.parse(String(identity.startedAt ?? ''))
    if (!Number.isFinite(startedAt) || Date.now() - startedAt > 30 * 60_000) {
      throw new Error(`运行进程启动时间不可信：${String(identity.startedAt)}`)
    }
    return { intentId: intent.intentId, artifact: build.artifactSha256 }
  } finally {
    runtime.close()
  }
}

async function main(): Promise<void> {
  if (process.env.FORGELOOP_REAL_MODEL !== '1') {
    console.log(
      '[real-model-e2e] 跳过：设置 FORGELOOP_REAL_MODEL=1 或运行 make real-model-e2e（会调用真实模型并产生费用）',
    )
    return
  }
  if (PATCH !== undefined && !existsSync(PATCH)) {
    throw new Error(`FORGELOOP_REAL_MODEL_PATCH 指向的文件不存在：${PATCH}`)
  }
  const workspace = mkdtempSync(join(tmpdir(), 'forgeloop-real-model-'))
  const home = join(workspace, 'dsh-home')
  const projectDir = join(workspace, 'project')
  const recordsRoot = join(workspace, 'records')
  const configPath = join(workspace, 'forgeloop.json')
  const dbPath = join(recordsRoot, 'projects', PROJECT, 'records.sqlite')
  execFileSync(NPM, ['run', 'build', '--workspace', 'forgeloop-dsh'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  })
  mkdirSync(home, { recursive: true })
  mkdirSync(recordsRoot, { recursive: true })
  // 打包脚本读取服务器模板：由本进程注入，不写入仓库。
  process.env.FORGELOOP_M1_SERVER_SOURCE = SERVER_SOURCE
  const deploy = DEPLOY ? prepareDeployment(projectDir, recordsRoot, home) : undefined
  initProject(projectDir)
  writeFileSync(configPath, `${JSON.stringify(configFor(projectDir, recordsRoot, deploy))}\n`)
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
    const [webCommand, webArgs] = dshCommand(
      launchArgs(WEB_PROFILE, ['--port', String(port), '--no-open']),
    )
    child = spawn(webCommand, webArgs, {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForToken(child, 90_000)

    const startedAt = new Date().toISOString()
    const [submitCommand, submitArgs] = dshCommand(
      launchArgs(HEADLESS_PROFILE, [
        '--json',
        `只调用一次工具 forgeloop_submit_requirement 提交下面的需求原文；不要修改任何文件，也不要调用其他工具。\n\n${REQUIREMENT}`,
      ]),
    )
    const submitted = spawnSync(submitCommand, submitArgs, {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: HEADLESS_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    })
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
    if (!DEPLOY && summary.deployments !== 0) throw new Error('研发链路不应产生部署记录')

    if (DEPLOY) {
      if (!deploy) throw new Error('部署现场没有初始化')
      if (child) {
        await stopChild(child)
        child = undefined
      }
      const deployed = await deployCommitted({
        reqId: requirement.req_id,
        projectDir,
        recordsRoot,
        deploy,
      })
      console.log(
        `[real-model-e2e] 部署 OK：${deployed.intentId}；制品 ${deployed.artifact.slice(0, 12)}`,
      )
    }

    console.log(`[real-model-e2e] OK：${requirement.req_id} 完成准入、研发、验证与受控提交`)
    console.log(
      `[real-model-e2e] 记录：${dbPath}；项目：${projectDir}（默认在脚本结束时删除，FORGELOOP_REAL_MODEL_KEEP=1 保留）`,
    )
  } finally {
    if (child) await stopChild(child)
    if (process.env.FORGELOOP_REAL_MODEL_KEEP === '1') {
      console.log(`[real-model-e2e] 保留现场：DSH_HOME=${home}；项目=${projectDir}；记录=${dbPath}`)
    } else {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
}

/** 关闭隔离 web 进程：先 SIGTERM，5 秒内没退出就 SIGKILL，避免脚本卡在子进程回收上。 */
async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((done) => child.once('exit', () => done())),
    new Promise<void>((done) => {
      setTimeout(done, 5_000).unref()
    }),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
  child.unref()
}

main().catch((error: unknown) => {
  console.error(`[real-model-e2e] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
