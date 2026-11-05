#!/usr/bin/env node
/**
 * 真实模型运维闭环 E2E（opt-in，会产生模型费用）：
 * 隔离 DSH_HOME / 临时 Git 项目 / 临时记录根 → 起常驻 web 宿主 →
 * 启动真实目标进程与健康检查 → 注入已标注的真实故障（SIGKILL）→
 * 由真实模型巡检、诊断并在授权内执行恢复动作 →
 * 断言事件 recovered 且恢复后进程 pid 变化。
 *
 * 默认跳过；`make real-ops-e2e` 或 `FORGELOOP_REAL_OPS=1` 才运行。
 * 不改动生产记录、正式 profile 与版本号。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = resolve(import.meta.dirname, '../..')
const DSH = process.env.FORGELOOP_DSH ?? 'dsh'
const DSH_CLI = process.env.FORGELOOP_DSH_CLI ?? ''
const PATCH = process.env.FORGELOOP_REAL_MODEL_PATCH
const ENABLED = process.env.FORGELOOP_REAL_OPS === '1' || process.argv.includes('--ops')
const TIMEOUT_MS = Number(process.env.FORGELOOP_REAL_OPS_TIMEOUT_MS ?? 900_000)
const KEEP = process.env.FORGELOOP_REAL_OPS_KEEP === '1'

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
  const pidFile = join(opsDir, 'server.pid')
  const serverScript = join(opsDir, 'server.mjs')
  const checkScript = join(opsDir, 'check.mjs')
  const restartScript = join(opsDir, 'restart.mjs')
  const serverLog = join(opsDir, 'server.log')
  const targetDir = join(root, 'target')
  const toolDir = join(recordsRoot, 'projects', 'real-ops', 'deployments', 'tools')
  mkdirSync(toolDir, { recursive: true })
  const installScript = join(toolDir, 'install.py')

  writeFileSync(
    serverScript,
    [
      "import { appendFileSync } from 'node:fs'",
      'appendFileSync(process.env.M1_OPS_LOG, `starting ${new Date().toISOString()}\\n`)',
      'await import(process.env.M1_OPS_ENTRY)',
      '',
    ].join('\n'),
  )
  writeFileSync(
    checkScript,
    [
      "import { readFileSync } from 'node:fs'",
      'let pid = 0',
      'try { pid = Number(readFileSync(process.env.M1_OPS_PID, "utf8")) } catch {}',
      'if (!pid) { console.log("missing pid"); process.exit(1) }',
      'try { process.kill(pid, 0) } catch { console.log(`dead ${pid}`); process.exit(1) }',
      "fetch('http://127.0.0.1:' + process.env.M1_OPS_PORT + '/health').then(async (response) => { console.log('health ' + response.status); process.exit(response.status === 200 ? 0 : 1) }).catch((error) => { console.log('health error ' + error.message); process.exit(1) })",
    ].join('\n'),
  )
  writeFileSync(
    restartScript,
    [
      "import { spawn } from 'node:child_process'",
      "import { readFileSync, rmSync } from 'node:fs'",
      'try { rmSync(process.env.M1_OPS_PID, { force: true }) } catch {}',
      'const child = spawn(process.execPath, [process.env.M1_OPS_SERVER], { detached: true, stdio: "ignore", env: process.env })',
      'child.unref()',
      'const started = Date.now()',
      'while (Date.now() - started < 5000) {',
      '  try {',
      '    const pid = Number(readFileSync(process.env.M1_OPS_PID, "utf8"))',
      '    process.kill(pid, 0)',
      '    console.log(`restarted ${pid}`)',
      '    process.exit(0)',
      '  } catch {}',
      '  await new Promise((done) => setTimeout(done, 100))',
      '}',
      'console.log("restart timeout")',
      'process.exit(1)',
    ].join('\n'),
  )
  // 部署夹具：写入安装记录并重启真实目标进程；M1-3 只验证运维闭环，安装器真实性与 M1-2 分开记录。
  writeFileSync(
    installScript,
    [
      'import json, os, signal, subprocess, sys, time',
      'args = sys.argv',
      'op = args[args.index("--op") + 1]',
      'plan = json.load(open(args[args.index("--plan") + 1]))',
      'target = plan["params"]["target"]',
      'current = os.path.join(target, "current.json")',
      'pidfile = os.environ["M1_OPS_PID"]',
      'def restart():',
      '    try:',
      '        pid = int(open(pidfile).read().strip())',
      '        os.kill(pid, signal.SIGKILL)',
      '        time.sleep(0.3)',
      '    except Exception:',
      '        pass',
      '    subprocess.Popen(["node", os.environ["M1_OPS_SERVER"]], env=dict(os.environ), start_new_session=True)',
      '    for _ in range(50):',
      '        try:',
      '            os.kill(int(open(pidfile).read().strip()), 0)',
      '            return True',
      '        except Exception:',
      '            time.sleep(0.1)',
      '    return False',
      'if op == "preflight":',
      '    print(json.dumps({"ok": True, "state": "ready", "detail": "preflight ok", "restorePoint": ""}))',
      'elif op == "apply":',
      '    os.makedirs(target, exist_ok=True)',
      '    alive = restart()',
      '    json.dump({"version": plan["artifact"]["version"], "artifactSha256": plan["artifact"]["sha256"]}, open(current, "w"))',
      '    print(json.dumps({"ok": alive, "state": "applied" if alive else "failed", "version": plan["artifact"]["version"], "detail": "restarted" if alive else "restart failed"}))',
      'elif op == "status":',
      '    now = json.load(open(current)) if os.path.exists(current) else {}',
      '    try:',
      '        pid = int(open(pidfile).read().strip())',
      '        os.kill(pid, 0)',
      '    except Exception:',
      '        pid = 0',
      '    print(json.dumps({"ok": pid > 0, "state": "running" if pid > 0 else "unknown", "version": now.get("version", ""), "artifactSha256": now.get("artifactSha256", ""), "runningArtifactSha256": now.get("artifactSha256", "") if pid else "", "runningPid": pid, "runningStartedAt": "", "detail": "ops fixture status"}))',
      'elif op == "rollback":',
      '    print(json.dumps({"ok": True, "state": "rolled_back", "version": "", "detail": "no previous artifact"}))',
      'elif op == "data-rollback":',
      '    print(json.dumps({"ok": True, "state": "rolled_back", "detail": "no data scope"}))',
      'else:',
      '    print(json.dumps({"ok": False, "state": "failed", "detail": "unknown op"}))',
    ].join('\n'),
  )
  mkdirSync(targetDir, { recursive: true })

  const git = (args: string[]): void => {
    const done = execFileSync('git', args, { cwd: project, encoding: 'utf8' })
    void done
  }
  execFileSync('git', ['init', '-q'], { cwd: project })
  writeFileSync(join(project, 'README.md'), '# real ops e2e\n')
  // 真实小工程：服务需要心跳文件刷新，否则看门狗判定失联后退出（缺陷就在这里）。
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(join(project, 'test'), { recursive: true })
  mkdirSync(join(project, 'scripts'), { recursive: true })
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify(
      {
        name: 'real-ops-service',
        private: true,
        version: '1.0.0',
        scripts: { test: 'node --test', check: 'node --test' },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(project, 'src', 'service.mjs'),
    [
      "import { createServer } from 'node:http'",
      "import { writeFileSync } from 'node:fs'",
      '',
      'const pidFile = process.env.M1_OPS_PID',
      'const port = Number(process.env.M1_OPS_PORT || 0)',
      'writeFileSync(pidFile, String(process.pid))',
      '// 心跳：每 500ms 刷新心跳文件；看门狗超过 3s 没有新心跳就退出。',
      'setInterval(() => {',
      '  writeFileSync(process.env.M1_OPS_HEARTBEAT, String(Date.now()))',
      '}, 500)',
      'const server = createServer((request, response) => {',
      "  if (request.url === '/health') {",
      "    response.writeHead(200, { 'content-type': 'text/plain' })",
      "    response.end('ok')",
      '    return',
      '  }',
      '  response.writeHead(404)',
      '  response.end()',
      '})',
      "server.listen(port, '127.0.0.1', () => {",
      "  process.stdout.write('listening ' + String(server.address().port) + '\\n')",
      '})',
      '// 真实缺陷：5 秒后未处理异常退出，重启不能解决，必须改代码。',
      "setTimeout(() => { throw new Error('liveness watchdog expired') }, 5000)",
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'test', 'service.test.mjs'),
    [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      '',
      "test('service 模块可以加载', async () => {",
      "  const module = await import('../src/service.mjs')",
      "  assert.equal(typeof module, 'object')",
      '})',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'scripts', 'package.mjs'),
    [
      "import { createHash } from 'node:crypto'",
      "import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'",
      "mkdirSync('dist', { recursive: true })",
      "const sha = createHash('sha256').update(readFileSync('src/service.mjs')).digest('hex')",
      "writeFileSync('dist/artifact.json', JSON.stringify({ sha256: sha, tarball: process.cwd() + '/src/service.mjs', version: '1.0.0', files: ['src/service.mjs'], gitHead: '' }))",
      '',
    ].join('\n'),
  )
  git(['config', 'user.email', 'real-ops-e2e@example.com'])
  git(['config', 'user.name', 'Real Ops E2E'])
  git(['add', '-A'])
  git(['commit', '-qm', 'baseline'])

  const port = await freePort()
  const servicePort = await freePort()
  const configPath = join(root, 'config.json')
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        project: 'real-ops',
        projectPath: project,
        // 受控目标工程自己的允许路径：临时项目不是 ForgeLoop 仓库。
        activeRoots: ['src/', 'test/', 'scripts/', 'docs/', 'README.md', 'package.json'],
        recordsRoot,
        pollSeconds: 2,
        owner: 'real-ops-e2e',
        autoAdvance: true,
        ops: {
          enabled: true,
          intervalSeconds: 30,
          resources: [{ id: 'svc', kind: 'app', label: 'M1 受控服务' }],
          artifacts: [
            { id: 'svc', label: 'M1 受控服务', logs: [{ id: 'svc-log', path: serverLog }] },
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
        formalTestTimeoutSeconds: 120,
        candidateBuildCommand: ['node', '-e', 'process.exit(0)'],
        candidatePackageCommand: ['node', 'scripts/package.mjs'],
        candidateArtifactPath: 'dist/artifact.json',
        failureRoundsPerGrant: 5,
        maxVerificationAttempts: 3,
        maxTaskAttempts: 3,
        agent: { timeoutSeconds: 900, maxTurnSeconds: 900 },
        deployments: {
          enabled: true,
          verifyTimeoutSeconds: 120,
          alerts: { webhook: 'http://127.0.0.1:9/unreachable', timeoutSeconds: 5 },
          tools: [
            {
              id: 'ops-install',
              kind: 'python',
              path: installScript,
              capabilities: ['preflight', 'apply', 'status', 'rollback'],
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
    M1_OPS_PID: pidFile,
    M1_OPS_SERVER: serverScript,
    M1_OPS_LOG: serverLog,
    M1_OPS_ENTRY: join(project, 'src', 'service.mjs'),
    M1_OPS_PORT: String(servicePort),
    M1_OPS_HEARTBEAT: join(opsDir, 'heartbeat'),
  }
  // 基线：启动真实目标进程。
  execFileSync('node', [restartScript], { env })
  const beforePid = Number(readFileSync(pidFile, 'utf8'))
  log(`基线进程 pid=${beforePid}（${project}）`)

  // 先建 profile 并安装插件包，再起常驻宿主。
  const packDir = join(root, 'pack')
  mkdirSync(packDir, { recursive: true })
  const packed = execFileSync('npm', ['pack', '--pack-destination', packDir], {
    cwd: join(ROOT, 'packages', 'forgeloop'),
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(ROOT, '.cache', 'npm') },
  })
    .trim()
    .split('\n')
    .at(-1) as string
  const tarball = join(packDir, packed)
  // 从官方 headless 模板派生 profile：研发会话需要 agentPresets 组合编码工具。
  const [bootCommand, bootArgs] = dshCommand([
    '--profile',
    'm1-ops-host',
    '--from-default-profile',
    'web',
    '--dump-config',
  ])
  execFileSync(bootCommand, bootArgs, {
    cwd: ROOT,
    env,
    stdio: 'ignore',
    timeout: 300_000,
  })
  const [pluginCommand, pluginArgs] = dshCommand([
    'plugin',
    '--profile',
    'm1-ops-host',
    'add',
    tarball,
  ])
  execFileSync(pluginCommand, pluginArgs, { cwd: ROOT, env, stdio: 'ignore' })
  log(`插件已安装：${tarball}`)

  // 常驻宿主：让模型执行一条长时间命令撑住会话，协调器与运维定时器在此期间运行。
  const [command, args] = dshCommand([
    '--profile',
    'm1-ops-host',
    ...(PATCH ? ['--patch', PATCH] : []),
    '--port',
    String(port),
    '--no-open',
  ])
  const hostLog = openSync(join(root, 'host.log'), 'w')
  const host = spawn(command, args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', hostLog, hostLog],
    detached: true,
  })
  host.unref()
  log(`宿主启动 pid=${host.pid} port=${port}`)

  const dbPath = join(recordsRoot, 'projects', 'real-ops', 'records.sqlite')
  const started = Date.now()
  let eventId = ''
  let recovered = false
  let recoveredPid = 0
  let fixReqId = ''
  let closed = false
  const injectedAt = new Date().toISOString()
  try {
    while (Date.now() - started < 60_000) {
      if (existsSync(dbPath)) break
      await sleep(500)
    }
    if (!existsSync(dbPath)) {
      const log = existsSync(join(root, 'host.log'))
        ? readFileSync(join(root, 'host.log'), 'utf8').slice(-1200)
        : '(无宿主日志)'
      throw new Error(`记录库未出现：${dbPath}\n宿主日志：${log}`)
    }
    // 已标注的真实故障注入：直接杀掉目标进程。
    process.kill(beforePid, 'SIGKILL')
    log(`已注入故障（SIGKILL pid=${beforePid}，${injectedAt}）`)

    while (Date.now() - started < TIMEOUT_MS) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const event = db
          .prepare('SELECT event_id, state FROM ops_events ORDER BY rowid DESC LIMIT 1')
          .get() as { event_id?: string; state?: string } | undefined
        if (event?.event_id) {
          eventId = event.event_id
          if (event.state === 'recovered' || event.state === 'closed') {
            recovered = true
            break
          }
        }
      } finally {
        db.close()
      }
      await sleep(2_000)
    }
    if (existsSync(pidFile)) recoveredPid = Number(readFileSync(pidFile, 'utf8'))
    // 后半段：修复需求由真实模型研发、提交、自动部署，原检查复核通过后事件关闭。
    while (Date.now() - started < TIMEOUT_MS) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = db
          .prepare(
            'SELECT state, closed_at, fix_requirement_id FROM ops_events ORDER BY rowid DESC LIMIT 1',
          )
          .get() as { state?: string; closed_at?: string; fix_requirement_id?: string } | undefined
        fixReqId = row?.fix_requirement_id ?? ''
        if (row?.closed_at) {
          closed = true
          break
        }
      } finally {
        db.close()
      }
      await sleep(3_000)
    }
  } finally {
    try {
      process.kill(-host.pid!, 'SIGKILL')
    } catch {
      try {
        host.kill('SIGKILL')
      } catch {
        // 进程可能已退出。
      }
    }
    if (!KEEP) log(`现场保留在 ${root}`)
  }

  const summary = {
    root,
    project,
    recordsRoot,
    eventId,
    recovered,
    beforePid,
    recoveredPid,
    fixReqId,
    closed,
    injectedAt,
    injected: 'SIGKILL 目标进程（已标注）',
  }
  writeFileSync(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  log(`结果：${JSON.stringify(summary)}`)
  if (!recovered) {
    log('失败：真实模型没有把事件恢复到 recovered')
    process.exitCode = 1
    return
  }
  if (!recoveredPid || recoveredPid === beforePid) {
    log('失败：恢复后进程 pid 没有变化')
    process.exitCode = 1
    return
  }
  if (!closed) {
    log('失败：修复需求没有走完研发/部署，或原检查复核后事件未关闭')
    process.exitCode = 1
    return
  }
  log('OK：真实故障 → 真实模型诊断 → 授权内恢复 → 修复需求 → 自动部署 → 原检查复核 → 事件关闭')
}

await main()
