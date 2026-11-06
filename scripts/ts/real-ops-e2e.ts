#!/usr/bin/env node
/**
 * 真实模型运维闭环 E2E（opt-in，会产生模型费用）：
 * 隔离 DSH_HOME / 临时 Git 工程 / 临时记录根 → 起常驻 web 宿主 →
 * 用真实安装器把基线制品装到隔离目标并从安装目录启动 →
 * 注入已标注的真实故障（SIGKILL）→ 真实模型诊断并在授权内恢复 →
 * 修复需求由真实模型研发/验证/提交 → 自动部署新制品 → 原检查复核 → 事件关闭。
 *
 * 默认跳过；`make real-ops-e2e` 或 `FORGELOOP_REAL_OPS=1` 才运行。
 * 不改动生产记录、正式 profile 与版本号。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { launch, npmLaunch, terminate } from './platform.js'

const ROOT = resolve(import.meta.dirname, '../..')
const DSH = process.env.FORGELOOP_DSH ?? 'dsh'
const DSH_CLI = process.env.FORGELOOP_DSH_CLI ?? ''
const PATCH = process.env.FORGELOOP_REAL_MODEL_PATCH
const ENABLED = process.env.FORGELOOP_REAL_OPS === '1' || process.argv.includes('--ops')
const TIMEOUT_MS = Number(process.env.FORGELOOP_REAL_OPS_TIMEOUT_MS ?? 3_600_000)
const KEEP = process.env.FORGELOOP_REAL_OPS_KEEP === '1'
const PROJECT = 'real-ops'
const VERSION = '1.0.0'

function log(message: string): void {
  console.log(`[real-ops] ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function freePort(): Promise<number> {
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

function dshCommand(args: string[]): [string, string[]] {
  return DSH_CLI ? [process.execPath, [DSH_CLI, ...args]] : [DSH, args]
}

function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const launched = launch(file, args)
  execFileSync(launched.file, launched.args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: 'ignore',
    timeout: 300_000,
    ...launched.spawnOptions,
  })
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function killPid(pid: number): void {
  if (!pid) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 进程可能已退出。
  }
  if (!alive(pid)) return
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
  } catch {
    // Windows 以外的平台没有 taskkill；上面的 process.kill 已经生效。
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function probeIdentity(port: number): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/identity`)
  if (!response.ok) throw new Error(`/identity 返回 ${response.status}`)
  return (await response.json()) as Record<string, unknown>
}

async function main(): Promise<void> {
  if (!ENABLED) {
    log('跳过（需要 FORGELOOP_REAL_OPS=1）')
    return
  }
  const root = process.env.FORGELOOP_REAL_OPS_ROOT ?? mkdtempSync(join(tmpdir(), 'forgeloop-ops-'))
  const project = join(root, 'project')
  const recordsRoot = join(root, 'records')
  const dshHome = join(root, 'dsh-home')
  const opsDir = join(root, 'ops')
  for (const dir of [project, recordsRoot, dshHome, opsDir]) mkdirSync(dir, { recursive: true })
  const serverLog = join(root, 'target', 'server.log')
  const targetDir = join(root, 'target')
  const toolDir = join(recordsRoot, 'projects', PROJECT, 'deployments', 'tools')
  mkdirSync(toolDir, { recursive: true })
  const installScript = join(toolDir, 'install.py')
  const checkScript = join(opsDir, 'check.mjs')
  const restartScript = join(opsDir, 'restart.mjs')
  const configPath = join(root, 'config.json')

  // 受控小工程：服务有真实存活缺陷（5 秒后无条件抛错），重启只能短暂止血。
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify(
      {
        name: 'real-ops-service',
        private: true,
        version: VERSION,
        type: 'module',
        scripts: {
          test: 'node scripts/check.mjs',
          check: 'node scripts/check.mjs',
          package: 'node scripts/package.mjs',
        },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(project, 'README.md'), '# real ops e2e\n')
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(join(project, 'scripts'), { recursive: true })
  writeFileSync(
    join(project, 'src', 'service.mjs'),
    [
      "import { createServer } from 'node:http'",
      "import { writeFileSync } from 'node:fs'",
      "import { resolve } from 'node:path'",
      "import { fileURLToPath } from 'node:url'",
      '',
      'export async function startService(options = {}) {',
      '  const port = Number(options.port ?? process.env.M1_OPS_PORT ?? 0)',
      "  const pidFile = options.pidFile ?? process.env.M1_OPS_PID ?? ''",
      "  const heartbeatFile = options.heartbeatFile ?? process.env.M1_OPS_HEARTBEAT ?? ''",
      '  if (pidFile) writeFileSync(pidFile, String(process.pid))',
      '  if (heartbeatFile) {',
      '    setInterval(() => writeFileSync(heartbeatFile, String(Date.now())), 500).unref()',
      '  }',
      "  const identity = options.identity ?? { message: 'real ops service alive' }",
      '  const server = createServer((request, response) => {',
      "    if (request.url === '/health') {",
      "      response.writeHead(200, { 'content-type': 'text/plain' })",
      "      response.end('ok')",
      '      return',
      '    }',
      "    if (request.url === '/identity') {",
      "      response.writeHead(200, { 'content-type': 'application/json' })",
      '      response.end(JSON.stringify({ ...identity, pid: process.pid }))',
      '      return',
      '    }',
      '    response.writeHead(404)',
      '    response.end()',
      '  })',
      '  await new Promise((done) => server.listen(port, "127.0.0.1", done))',
      '  // 真实缺陷：无条件在 5 秒后抛错；重启不能消除，必须修改代码。',
      "  setTimeout(() => { throw new Error('liveness watchdog expired') }, 5000)",
      '  return { server, port: server.address().port }',
      '}',
      '',
      '// 直接执行时提供可复现入口：测试与运维排查都按这个入口启动；server.mjs 仍可显式启动。',
      'if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {',
      '  await startService({',
      '    port: Number(process.env.M1_OPS_PORT ?? 8861),',
      "    heartbeatFile: process.env.M1_OPS_HEARTBEAT ?? '',",
      '  })',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'server.mjs'),
    [
      "import { createHash } from 'node:crypto'",
      "import { existsSync, readFileSync } from 'node:fs'",
      "import { dirname, join } from 'node:path'",
      "import { fileURLToPath } from 'node:url'",
      "import { startService } from './service.mjs'",
      '',
      'const here = dirname(fileURLToPath(import.meta.url))',
      'const bundle = join(here, "bundle.tgz")',
      '// 启动时缓存介质摘要：进程活着就只报告启动时加载的那一份。',
      'const artifactSha256 = existsSync(bundle)',
      '  ? createHash("sha256").update(readFileSync(bundle)).digest("hex")',
      '  : "source"',
      'const startedAt = new Date().toISOString()',
      'const started = await startService({',
      '  identity: { version: "1.0.0", artifactSha256, startedAt, message: "real ops service alive" },',
      '})',
      'process.stdout.write("listening " + String(started.port) + "\\n")',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'scripts', 'check.mjs'),
    [
      "import { spawn } from 'node:child_process'",
      "import { createServer } from 'node:net'",
      "import { mkdtempSync, rmSync } from 'node:fs'",
      "import { tmpdir } from 'node:os'",
      "import { join } from 'node:path'",
      '',
      'const root = mkdtempSync(join(tmpdir(), "real-ops-check-"))',
      'const port = await new Promise((done, fail) => {',
      '  const s = createServer()',
      '  s.once("error", fail)',
      '  s.listen(0, "127.0.0.1", () => {',
      '    const p = s.address().port',
      '    s.close(() => done(p))',
      '  })',
      '})',
      'const child = spawn(process.execPath, ["server.mjs"], {',
      '  cwd: process.cwd(),',
      '  env: { ...process.env, M1_OPS_PORT: String(port), M1_OPS_PID: join(root, "pid"), M1_OPS_HEARTBEAT: join(root, "heartbeat") },',
      '  stdio: "ignore",',
      '})',
      'let exited = false',
      'let exitCode = null',
      'child.on("exit", (code) => { exited = true; exitCode = code })',
      'const waitHealth = async (deadline) => {',
      '  while (Date.now() < deadline) {',
      '    if (exited) return false',
      '    try {',
      '      const response = await fetch(`http://127.0.0.1:${port}/health`)',
      '      if (response.status === 200) return true',
      '    } catch {}',
      '    await new Promise((done) => setTimeout(done, 100))',
      '  }',
      '  return false',
      '}',
      'let ok = false',
      'try {',
      '  ok = await waitHealth(Date.now() + 3000)',
      '  if (ok) await new Promise((done) => setTimeout(done, 6500))',
      '  if (exited) {',
      '    console.log(`service exited early code=${exitCode}`)',
      '    ok = false',
      '  } else if (ok) {',
      '    const response = await fetch(`http://127.0.0.1:${port}/health`)',
      '    ok = response.status === 200',
      '    console.log(ok ? "service survived" : `health ${response.status}`)',
      '  } else {',
      '    console.log("health unavailable")',
      '  }',
      '} finally {',
      '  try { child.kill("SIGKILL") } catch {}',
      '  rmSync(root, { recursive: true, force: true })',
      '}',
      'process.exit(ok ? 0 : 1)',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'scripts', 'package.mjs'),
    [
      "import { createHash } from 'node:crypto'",
      "import { execFileSync } from 'node:child_process'",
      "import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      '',
      "rmSync('dist/bundle', { recursive: true, force: true })",
      "mkdirSync('dist/bundle', { recursive: true })",
      "copyFileSync('server.mjs', join('dist/bundle', 'server.mjs'))",
      "copyFileSync(join('src', 'service.mjs'), join('dist/bundle', 'service.mjs'))",
      "execFileSync('tar', ['-czf', 'dist/bundle.tgz', '-C', 'dist/bundle', '.'])",
      "const sha = createHash('sha256').update(readFileSync('dist/bundle.tgz')).digest('hex')",
      "let gitHead = ''",
      "try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}",
      "writeFileSync('dist/artifact.json', JSON.stringify({ sha256: sha, tarball: process.cwd() + '/dist/bundle.tgz', version: '1.0.0', files: ['server.mjs', 'service.mjs'], gitHead }))",
      '',
    ].join('\n'),
  )
  writeFileSync(
    restartScript,
    [
      "import { spawn } from 'node:child_process'",
      "import { createServer } from 'node:net'",
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      '',
      `const target = ${JSON.stringify(targetDir)}`,
      'const current = join(target, "current")',
      'const pidFile = join(target, "process.pid")',
      'const portFile = join(target, "port")',
      'try {',
      '  const pid = Number(readFileSync(pidFile, "utf8"))',
      '  process.kill(pid, "SIGKILL")',
      '} catch {}',
      'const port = await new Promise((done, fail) => {',
      '  const s = createServer()',
      '  s.once("error", fail)',
      '  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => done(p)) })',
      '})',
      'const child = spawn(process.execPath, [join(current, "server.mjs")], {',
      '  cwd: current,',
      '  env: { ...process.env, M1_OPS_PORT: String(port), M1_OPS_PID: pidFile, M1_OPS_HEARTBEAT: join(target, "heartbeat") },',
      '  stdio: "ignore",',
      '  detached: true,',
      '})',
      'child.unref()',
      'writeFileSync(pidFile, String(child.pid))',
      'writeFileSync(portFile, String(port))',
      'for (let i = 0; i < 50; i += 1) {',
      '  try {',
      '    const response = await fetch(`http://127.0.0.1:${port}/health`)',
      '    if (response.status === 200) {',
      '      console.log(`restarted ${child.pid}`)',
      '      process.exit(0)',
      '    }',
      '  } catch {}',
      '  await new Promise((done) => setTimeout(done, 100))',
      '}',
      'console.log("restart timeout")',
      'process.exit(1)',
      '',
    ].join('\n'),
  )
  writeFileSync(
    checkScript,
    [
      "import { readFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      '',
      `const target = ${JSON.stringify(targetDir)}`,
      'let pid = 0',
      'try { pid = Number(readFileSync(join(target, "process.pid"), "utf8")) } catch {}',
      'if (!pid) { console.log("missing pid"); process.exit(1) }',
      'try { process.kill(pid, 0) } catch { console.log(`dead ${pid}`); process.exit(1) }',
      'const port = Number(readFileSync(join(target, "port"), "utf8"))',
      'fetch(`http://127.0.0.1:${port}/health`).then(async (response) => {',
      '  console.log("health " + response.status)',
      '  process.exit(response.status === 200 ? 0 : 1)',
      '}).catch((error) => { console.log("health error " + error.message); process.exit(1) })',
      '',
    ].join('\n'),
  )

  // 真实安装器：解包本次制品、替换安装目录、从 current 启动新进程；
  // status 从安装内容与运行进程 /identity 独立观测，不复制计划期望值。
  writeFileSync(
    installScript,
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
      '            subprocess.run(["taskkill", "/pid", str(pid), "/t", "/f"], capture_output=True)',
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
      '    env["M1_OPS_PORT"] = str(port)',
      '    env["M1_OPS_PID"] = pidfile',
      '    env["M1_OPS_HEARTBEAT"] = os.path.join(target, "heartbeat")',
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
      'elif op == "restart":',
      '    stop()',
      '    port = free_port()',
      '    identity = start(port)',
      '    print(json.dumps({"ok": True, "state": "applied", "version": identity.get("version", ""), "detail": "restarted pid=" + str(identity.get("pid"))}))',
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
      '',
    ].join('\n'),
  )

  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        project: PROJECT,
        projectPath: project,
        activeRoots: ['src/', 'scripts/', 'server.mjs', 'README.md', 'package.json'],
        recordsRoot,
        pollSeconds: 2,
        owner: 'real-ops-e2e',
        autoAdvance: true,
        ops: {
          enabled: true,
          intervalSeconds: 30,
          resources: [{ id: 'svc', kind: 'app', label: 'M1 受控服务' }],
          artifacts: [
            {
              id: 'svc',
              label: 'M1 受控服务',
              logs: [{ id: 'svc-log', path: serverLog }],
            },
          ],
          checks: [
            {
              id: 'svc-health',
              resourceId: 'svc',
              command: ['node', checkScript],
              timeoutSeconds: 15,
              severity: 'major',
            },
          ],
          actions: [
            {
              id: 'restart-svc',
              resourceId: 'svc',
              command: ['node', restartScript],
              params: [],
              timeoutSeconds: 20,
              auto: true,
              verifyCheckId: 'svc-health',
            },
          ],
        },
        autonomy: {
          enabled: true,
          allowAnySource: true,
          allowCodeCommit: true,
          requireOwner: false,
        },
        formalTestTimeoutSeconds: 900,
        // 提交检查必须是真正验证候选的命令；失败时不得提交。
        commitCheckCommand: ['node', 'scripts/check.mjs'],
        candidateBuildCommand: ['node', '-e', 'process.exit(0)'],
        candidatePackageCommand: ['node', 'scripts/package.mjs'],
        candidateArtifactPath: 'dist/artifact.json',
        failureRoundsPerGrant: 3,
        maxVerificationAttempts: 3,
        maxTaskAttempts: 3,
        agent: { timeoutSeconds: 2400, maxTurnSeconds: 2400 },
        deployments: {
          enabled: true,
          verifyTimeoutSeconds: 120,
          alerts: { webhook: 'http://127.0.0.1:9/unreachable', timeoutSeconds: 5 },
          tools: [
            {
              id: 'ops-install',
              kind: 'python',
              path: installScript,
              capabilities: ['preflight', 'apply', 'status', 'rollback', 'data-rollback'],
              timeoutSeconds: 120,
            },
          ],
          targets: [
            {
              id: 'ops-target',
              toolId: 'ops-install',
              requirementId: '',
              autoDeliver: true,
              approval: 'auto',
              params: { target: targetDir },
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  )

  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    FORGELOOP_CONFIG: configPath,
  }

  writeFileSync(join(project, '.gitignore'), 'dist/\n')
  execFileSync('git', ['init', '-q'], { cwd: project })
  execFileSync('git', ['config', 'user.email', 'real-ops-e2e@example.com'], { cwd: project })
  execFileSync('git', ['config', 'user.name', 'Real Ops E2E'], { cwd: project })
  execFileSync('git', ['add', '-A'], { cwd: project })
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: project })

  // 基线制品：从当前工程构建、安装到隔离目标并从安装目录启动。
  run(process.execPath, ['scripts/package.mjs'], { cwd: project, env })
  const baselineArtifact = readJson(join(project, 'dist', 'artifact.json'))
  const baselinePlan = join(root, 'baseline-plan.json')
  writeFileSync(
    baselinePlan,
    `${JSON.stringify({
      artifact: {
        path: baselineArtifact.tarball,
        sha256: baselineArtifact.sha256,
        version: VERSION,
      },
      params: { target: targetDir },
      data: {},
    })}\n`,
  )
  run('python.exe', [installScript, '--op', 'preflight', '--plan', baselinePlan], {
    cwd: project,
    env,
  })
  run('python.exe', [installScript, '--op', 'apply', '--plan', baselinePlan], { cwd: project, env })
  const beforePid = Number(readFileSync(join(targetDir, 'process.pid'), 'utf8'))
  log(`基线制品已安装，进程 pid=${beforePid}，安装目录=${join(targetDir, 'current')}`)

  // 先安装插件并起常驻宿主，再注入故障，确保巡检与协调器已经在线。
  const packDir = join(root, 'pack')
  mkdirSync(packDir, { recursive: true })
  const buildLaunch = npmLaunch(['run', 'build'])
  execFileSync(buildLaunch.file, buildLaunch.args, {
    cwd: join(ROOT, 'packages', 'forgeloop'),
    env: process.env,
    stdio: 'ignore',
    ...buildLaunch.spawnOptions,
  })
  const packedLaunch = npmLaunch(['pack', '--pack-destination', packDir, '--json'])
  const packedOutput = execFileSync(packedLaunch.file, packedLaunch.args, {
    cwd: join(ROOT, 'packages', 'forgeloop'),
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(ROOT, '.cache', 'npm') },
    ...packedLaunch.spawnOptions,
  })
  const packedInfo = JSON.parse(packedOutput) as Array<{ filename: string }>
  const tarball = join(packDir, packedInfo[0]!.filename)
  const [bootCommand, bootArgs] = dshCommand([
    '--profile',
    'm1-ops-host',
    '--from-default-profile',
    'web',
    '--dump-config',
  ])
  run(bootCommand, bootArgs, { cwd: ROOT, env })
  const [pluginCommand, pluginArgs] = dshCommand([
    'plugin',
    '--profile',
    'm1-ops-host',
    'add',
    tarball,
  ])
  run(pluginCommand, pluginArgs, { cwd: ROOT, env })
  log(`插件已安装：${tarball}`)

  const port = await freePort()
  const [command, args] = dshCommand([
    '--profile',
    'm1-ops-host',
    ...(PATCH ? ['--patch', PATCH] : []),
    '--port',
    String(port),
    '--no-open',
  ])
  const hostLog = openSync(join(root, 'host.log'), 'w')
  const hostLaunch = launch(command, args)
  const host = spawn(hostLaunch.file, hostLaunch.args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', hostLog, hostLog],
    ...hostLaunch.spawnOptions,
  })
  log(`宿主启动 pid=${host.pid} port=${port}`)

  const dbPath = join(recordsRoot, 'projects', PROJECT, 'records.sqlite')
  const started = Date.now()
  let eventId = ''
  let recoveredPid: number | null
  let fixReqId = ''
  let closed = false
  const injectedAt = new Date().toISOString()
  try {
    while (Date.now() - started < 60_000) {
      if (existsSync(dbPath)) break
      await sleep(500)
    }
    if (!existsSync(dbPath)) {
      const logTail = existsSync(join(root, 'host.log'))
        ? readFileSync(join(root, 'host.log'), 'utf8').slice(-1500)
        : '(无宿主日志)'
      throw new Error(`记录库未出现：${dbPath}\n宿主日志：${logTail}`)
    }
    await sleep(3_000)

    // 已标注的真实故障注入：直接杀掉从安装目录启动的目标进程。
    killPid(beforePid)
    log(`已注入故障（SIGKILL pid=${beforePid}，${injectedAt}）`)

    // 捕获本次注入后的第一条同检查事件，而不是“数据库最新一行”。
    while (Date.now() - started < TIMEOUT_MS) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const event = db
          .prepare(
            "SELECT event_id, state, fix_requirement_id FROM ops_events WHERE check_id = 'svc-health' AND opened_at >= ? ORDER BY rowid ASC LIMIT 1",
          )
          .get(injectedAt) as
          { event_id?: string; state?: string; fix_requirement_id?: string } | undefined
        if (event?.event_id) {
          eventId = event.event_id
          fixReqId = event.fix_requirement_id ?? ''
          if (event.state === 'recovered' || event.state === 'closed') break
        }
      } finally {
        db.close()
      }
      await sleep(2_000)
    }
    if (!eventId) throw new Error('60 秒内没有捕获到注入后的运维事件')
    try {
      recoveredPid = Number(readFileSync(join(targetDir, 'process.pid'), 'utf8'))
    } catch {
      recoveredPid = 0
    }
    log(`事件 ${eventId} 已恢复，pid=${recoveredPid}`)

    while (Date.now() - started < TIMEOUT_MS) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = db
          .prepare('SELECT state, closed_at, fix_requirement_id FROM ops_events WHERE event_id = ?')
          .get(eventId) as
          { state?: string; closed_at?: string; fix_requirement_id?: string } | undefined
        fixReqId = row?.fix_requirement_id ?? fixReqId
        if (row?.closed_at && row.state === 'closed') {
          closed = true
          break
        }
      } finally {
        db.close()
      }
      await sleep(3_000)
    }
  } finally {
    terminate(host)
    if (!KEEP) log(`现场保留在 ${root}`)
  }

  const summary: Record<string, unknown> = {
    root,
    project,
    recordsRoot,
    targetDir,
    eventId,
    recoveredPid,
    beforePid,
    fixReqId,
    closed,
    injectedAt,
    injected: 'SIGKILL 安装目录启动的目标进程（已标注）',
  }
  const failures: string[] = []
  if (!closed) failures.push('事件没有在原检查复核后关闭')
  if (!recoveredPid || recoveredPid === beforePid) failures.push('恢复后进程 pid 没有变化')
  if (!fixReqId) failures.push('事件没有关联修复需求')
  if (closed && fixReqId) {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const event = db
        .prepare(
          'SELECT event_id, state, closed_at, fix_requirement_id, resource_id, check_id FROM ops_events WHERE event_id = ?',
        )
        .get(eventId) as Record<string, unknown>
      const requirement = db
        .prepare('SELECT req_id, status, source FROM requirements WHERE req_id = ?')
        .get(fixReqId) as Record<string, unknown> | undefined
      const commit = db
        .prepare(
          'SELECT commit_sha, candidate_sha256 FROM requirement_commits WHERE req_id = ? ORDER BY committed_at DESC LIMIT 1',
        )
        .get(fixReqId) as Record<string, unknown> | undefined
      const build = db
        .prepare(
          'SELECT artifact_sha256, package_version, tarball FROM requirement_candidate_builds WHERE req_id = ? ORDER BY rowid DESC LIMIT 1',
        )
        .get(fixReqId) as Record<string, unknown> | undefined
      const intent = db
        .prepare(
          'SELECT intent_id, state, artifact_sha256, artifact_version FROM deployment_intents WHERE requirement_id = ? ORDER BY rowid DESC LIMIT 1',
        )
        .get(fixReqId) as Record<string, unknown> | undefined
      const decision = intent
        ? (db
            .prepare(
              'SELECT decision, decided_by FROM deployment_decisions WHERE intent_id = ? ORDER BY rowid DESC LIMIT 1',
            )
            .get(String(intent.intent_id)) as Record<string, unknown> | undefined)
        : undefined
      const duplicateSources = db
        .prepare(
          "SELECT COUNT(DISTINCT fix_requirement_id) AS n FROM ops_events WHERE check_id = 'svc-health' AND fix_requirement_id <> ''",
        )
        .get() as { n?: number }
      const installedPath = join(targetDir, 'current', 'bundle.tgz')
      const installedSha = existsSync(installedPath) ? sha256(installedPath) : ''
      const portFile = join(targetDir, 'port')
      const identity = existsSync(portFile)
        ? await probeIdentity(Number(readFileSync(portFile, 'utf8')))
        : {}
      summary.event = event
      summary.requirement = requirement
      summary.commit = commit
      summary.build = build
      summary.intent = intent
      summary.decision = decision
      summary.installedSha256 = installedSha
      summary.identity = identity
      summary.fixRequirementCount = duplicateSources.n ?? 0

      if (!event || event.state !== 'closed' || !event.closed_at) {
        failures.push('事件未以 closed 状态收口')
      }
      if (!requirement || requirement.status !== 'committed') {
        failures.push(`修复需求未提交：${String(requirement?.status)}`)
      }
      if (!requirement || !String(requirement.source).startsWith('ops:')) {
        failures.push(`修复需求来源不是 ops:<eventId>：${String(requirement?.source)}`)
      }
      if (!commit?.commit_sha) failures.push('修复需求没有受控提交')
      if (!build?.artifact_sha256) failures.push('修复需求没有候选制品')
      if (!intent || intent.state !== 'verified') {
        failures.push(`部署 intent 不是 verified：${String(intent?.state)}`)
      }
      if (intent && build && intent.artifact_sha256 !== build.artifact_sha256) {
        failures.push('部署 intent 制品摘要与候选制品不一致')
      }
      if (installedSha && build && installedSha !== build.artifact_sha256) {
        failures.push('安装目录制品摘要与候选制品不一致')
      }
      if (identity.artifactSha256 !== build?.artifact_sha256) {
        failures.push('运行进程报告的制品摘要与候选制品不一致')
      }
      if (!identity.pid || Number(identity.pid) <= 0) {
        failures.push('运行进程没有报告 pid')
      }
      if (!identity.startedAt || !Number.isFinite(Date.parse(String(identity.startedAt)))) {
        failures.push('运行进程没有报告可信启动时间')
      }
      if (Number(identity.pid) !== recoveredPid) {
        failures.push('运行进程 pid 与恢复后 pid 不一致')
      }
      if ((duplicateSources.n ?? 0) > 1) {
        failures.push(`同一检查生成了 ${String(duplicateSources.n)} 个修复需求，去重未生效`)
      }
      if (intent && decision && decision.decision !== 'verify') {
        failures.push(`部署决定不是系统核对：${String(decision.decision)}`)
      }
    } finally {
      db.close()
    }
  }
  summary.failures = failures
  writeFileSync(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  log(`结果：${JSON.stringify({ eventId, fixReqId, closed, failures })}`)
  if (failures.length > 0) {
    process.exitCode = 1
    return
  }
  log(
    'OK：真实故障 → 真实模型诊断 → 授权内恢复 → 修复需求 → 独立验证/提交 → 自动部署 → 原检查复核 → 事件关闭',
  )
}

await main()
