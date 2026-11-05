#!/usr/bin/env node
/**
 * M0 全链路闭环 E2E（脚本化、真实 Git/构建/部署工具/运维命令，不依赖模型）。
 *
 * 覆盖：
 *  S1 需求 → 分析 → 准入 → 研发 → 独立验证 → 受控提交 → 候选构建 → 部署 → 核对
 *  S2 真实进程故障 → 运维巡检 → 诊断 → 授权内恢复 → 检查复核 recovered
 *  S3 同一事件 fix_required → 关联修复需求 → 研发/验证/提交 → 重新构建 → 再次部署成功
 *  M0-4 负例：非所有者批准被拒、模型工具面没有部署/批准入口、越界文件被拒
 *  可选真实制品 leg：FORGELOOP_M0_REAL_ARTIFACT=1 时，只读复制生产记录，用真实需求
 *  req-20261031080821-f940b9 的候选制品走新部署接口到隔离目标（生产库只读）。
 *
 * 说明：研发/验证/诊断由脚本化 Agent 替身驱动；Git、构建、部署工具、运维检查与恢复
 * 命令都是真实执行。真实模型 leg 需 `FORGELOOP_M0_LOOP_REAL_MODEL=1`，本脚本不替代它。
 *
 * 用法：node scripts/ts/m0-loop-e2e.ts [--keep]
 * 退出码 0 表示三段闭环与负例全部通过；任何断言失败非 0。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { ForgeLoopRuntime } from '../../packages/forgeloop/lib/runtime/service.js'
import { resolveConfig } from '../../packages/forgeloop/lib/config.js'

const ROOT = resolve(import.meta.dirname, '../..')
const KEEP = process.argv.includes('--keep')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const EVIDENCE_DIR = join(ROOT, 'reports', 'm0-loop-e2e', STAMP)

const failures: string[] = []
const summary: Record<string, unknown> = { stamp: STAMP, legs: {} }

function check(condition: unknown, message: string): void {
  if (!condition) {
    failures.push(message)
    console.error(`[m0-loop] FAIL：${message}`)
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function writeScripts(root: string): void {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(
    join(root, 'scripts', 'package.mjs'),
    [
      "import { createHash } from 'node:crypto'",
      "import { execFileSync } from 'node:child_process'",
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "mkdirSync('dist', { recursive: true })",
      "writeFileSync('dist/app.txt', 'm0 app ' + new Date().toISOString() + '\\n')",
      "const sha = createHash('sha256').update(readFileSync('dist/app.txt')).digest('hex')",
      "const version = JSON.parse(readFileSync('packages/forgeloop/package.json', 'utf8')).version",
      "let gitHead = ''",
      "try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}",
      "writeFileSync('dist/artifact.json', JSON.stringify({ sha256: sha, tarball: join(process.cwd(), 'dist/app.txt'), version, files: ['docs/m0.txt'], gitHead }))",
    ].join('\n'),
  )
}

function writeOpsScripts(root: string): void {
  mkdirSync(join(root, 'ops'), { recursive: true })
  writeFileSync(
    join(root, 'ops', 'server.mjs'),
    "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.M0_PID_FILE, String(process.pid))\nsetInterval(() => {}, 1000)\n",
  )
  writeFileSync(
    join(root, 'ops', 'check.mjs'),
    [
      "import { readFileSync } from 'node:fs'",
      'let pid = 0',
      'try { pid = Number(readFileSync(process.env.M0_PID_FILE, "utf8")) } catch {}',
      'if (!pid) { console.log("no pid"); process.exit(1) }',
      'try { process.kill(pid, 0); console.log(`alive ${pid}`); process.exit(0) } catch { console.log(`dead ${pid}`); process.exit(1) }',
    ].join('\n'),
  )
  writeFileSync(
    join(root, 'ops', 'restart.mjs'),
    [
      "import { spawn } from 'node:child_process'",
      "import { readFileSync, rmSync } from 'node:fs'",
      'try { rmSync(process.env.M0_PID_FILE, { force: true }) } catch {}',
      'const child = spawn(process.execPath, [process.env.M0_SERVER], { detached: true, stdio: "ignore", env: process.env })',
      'child.unref()',
      'const started = Date.now()',
      'while (Date.now() - started < 5000) {',
      '  try {',
      '    const pid = Number(readFileSync(process.env.M0_PID_FILE, "utf8"))',
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
}

function writeDeploymentTool(recordsRoot: string): string {
  const toolDir = join(recordsRoot, 'projects', 'm0', 'deployments', 'tools')
  mkdirSync(toolDir, { recursive: true })
  const path = join(toolDir, 'tool.py')
  writeFileSync(
    path,
    [
      'import json, os, sys',
      'args = sys.argv',
      'op = args[args.index("--op") + 1]',
      'plan = json.load(open(args[args.index("--plan") + 1]))',
      'target = plan["params"]["target"]',
      'current = os.path.join(target, "current.json")',
      'previous = os.path.join(target, "previous.json")',
      'os.makedirs(target, exist_ok=True)',
      'def read(path):',
      '    try:',
      '        return json.load(open(path))',
      '    except Exception:',
      '        return None',
      'if op == "preflight":',
      '    print(json.dumps({"ok": True, "state": "ready", "detail": "preflight ok", "restorePoint": "previous-1" if os.path.exists(current) else ""}))',
      'elif op == "apply":',
      '    old = read(current)',
      '    if old is not None:',
      '        json.dump(old, open(previous, "w"))',
      '    json.dump({"version": plan["artifact"]["version"], "artifactSha256": plan["artifact"]["sha256"], "runningArtifactSha256": plan["artifact"]["sha256"], "runningPid": os.getpid(), "runningStartedAt": "2026-11-05T10:00:00Z"}, open(current, "w"))',
      '    print(json.dumps({"ok": True, "state": "applied", "version": plan["artifact"]["version"], "detail": "applied"}))',
      'elif op == "status":',
      '    now = read(current) or {}',
      '    print(json.dumps({"ok": True, "state": "running", "version": now.get("version", ""), "artifactSha256": now.get("artifactSha256", ""), "runningArtifactSha256": now.get("runningArtifactSha256", ""), "runningPid": now.get("runningPid", 0), "runningStartedAt": now.get("runningStartedAt", ""), "detail": "status"}))',
      'elif op == "rollback":',
      '    old = read(previous)',
      '    if old is None:',
      '        print(json.dumps({"ok": False, "state": "failed", "detail": "no previous artifact"}))',
      '    else:',
      '        json.dump(old, open(current, "w"))',
      '        print(json.dumps({"ok": True, "state": "rolled_back", "version": old.get("version", ""), "detail": "rolled back"}))',
      'elif op == "data-rollback":',
      '    print(json.dumps({"ok": True, "state": "rolled_back", "detail": "no data scope"}))',
      'else:',
      '    print(json.dumps({"ok": False, "state": "failed", "detail": "unknown op"}))',
    ].join('\n'),
  )
  return path
}

function writeRealArtifactTool(recordsRoot: string): string {
  const toolDir = join(recordsRoot, 'projects', 'forgeloop', 'deployments', 'tools')
  mkdirSync(toolDir, { recursive: true })
  const path = join(toolDir, 'install.py')
  writeFileSync(
    path,
    [
      'import json, os, shutil, sys, tarfile, tempfile',
      'args = sys.argv',
      'op = args[args.index("--op") + 1]',
      'plan = json.load(open(args[args.index("--plan") + 1]))',
      'target = plan["params"]["target"]',
      'module = os.path.join(target, "node_modules", "forgeloop-dsh")',
      'current = os.path.join(target, "install.json")',
      'previous = os.path.join(target, "previous-install")',
      'os.makedirs(target, exist_ok=True)',
      'def read(path):',
      '    try:',
      '        return json.load(open(path))',
      '    except Exception:',
      '        return None',
      'def installed_version():',
      '    try:',
      '        return json.load(open(os.path.join(module, "package.json"))).get("version", "")',
      '    except Exception:',
      '        return ""',
      'if op == "preflight":',
      '    print(json.dumps({"ok": True, "state": "ready", "detail": "preflight ok", "restorePoint": "previous-1" if os.path.exists(current) else ""}))',
      'elif op == "apply":',
      '    if os.path.exists(module):',
      '        shutil.rmtree(previous, ignore_errors=True)',
      '        shutil.copytree(module, previous)',
      '    shutil.rmtree(module, ignore_errors=True)',
      '    os.makedirs(module)',
      '    extract = tempfile.mkdtemp(dir=target)',
      '    with tarfile.open(plan["artifact"]["path"]) as tar:',
      '        tar.extractall(extract)',
      '    shutil.copytree(os.path.join(extract, "package"), module, dirs_exist_ok=True)',
      '    shutil.rmtree(extract, ignore_errors=True)',
      '    json.dump({"version": plan["artifact"]["version"], "artifactSha256": plan["artifact"]["sha256"], "runningArtifactSha256": plan["artifact"]["sha256"], "runningPid": os.getpid(), "runningStartedAt": "2026-11-05T10:00:00Z"}, open(current, "w"))',
      '    print(json.dumps({"ok": True, "state": "applied", "version": installed_version(), "detail": "installed into profile"}))',
      'elif op == "status":',
      '    now = read(current) or {}',
      '    print(json.dumps({"ok": True, "state": "running", "version": installed_version(), "artifactSha256": now.get("artifactSha256", ""), "runningArtifactSha256": now.get("runningArtifactSha256", ""), "runningPid": os.getpid(), "runningStartedAt": now.get("runningStartedAt", ""), "detail": "profile status"}))',
      'elif op == "rollback":',
      '    if not os.path.isdir(previous):',
      '        print(json.dumps({"ok": False, "state": "failed", "detail": "no previous profile"}))',
      '    else:',
      '        shutil.rmtree(module, ignore_errors=True)',
      '        shutil.copytree(previous, module)',
      '        print(json.dumps({"ok": True, "state": "rolled_back", "version": installed_version(), "detail": "profile rolled back"}))',
      'elif op == "data-rollback":',
      '    print(json.dumps({"ok": True, "state": "rolled_back", "detail": "no data scope"}))',
      'else:',
      '    print(json.dumps({"ok": False, "state": "failed", "detail": "unknown op"}))',
    ].join('\n'),
  )
  return path
}

function makeProject(root: string): string {
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  git(project, ['init', '-q'])
  git(project, ['config', 'user.email', 'm0@example.com'])
  git(project, ['config', 'user.name', 'M0'])
  writeFileSync(join(project, '.gitignore'), 'dist/\n')
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'm0-app', version: '1.0.0' }, null, 2),
  )
  mkdirSync(join(project, 'packages', 'forgeloop'), { recursive: true })
  writeFileSync(
    join(project, 'packages', 'forgeloop', 'package.json'),
    JSON.stringify({ name: 'forgeloop-dsh', version: '1.0.0' }, null, 2),
  )
  writeScripts(project)
  git(project, ['add', '-A'])
  git(project, ['commit', '-qm', 'baseline'])
  return project
}

const ANALYSIS = JSON.stringify({
  goal: '写一份可验证的 M0 文档',
  scenarios: ['文档存在且可读'],
  business_rules: ['文档内容由研发任务产出'],
  exceptions: ['文件缺失时验证失败'],
  acceptance_criteria: ['docs/a.txt 与 docs/b.txt 存在'],
  clarifications: [],
})

const PLAN = JSON.stringify({
  technical_solution: {
    summary: '写入两份文档',
    approach: ['写 docs/a.txt 与 docs/b.txt'],
    risks: [],
  },
  tasks: [
    {
      task_id: 'a',
      goal: '写入 M0 文档 A',
      files: ['docs/a.txt'],
      acceptance: 'docs/a.txt 存在',
      test_command: [
        'node',
        '-e',
        "process.exit(require('node:fs').existsSync('docs/a.txt') ? 0 : 1)",
      ],
    },
    {
      task_id: 'b',
      goal: '写入 M0 文档 B',
      files: ['docs/b.txt'],
      depends_on: ['a'],
      acceptance: 'docs/b.txt 存在',
      test_command: [
        'node',
        '-e',
        "process.exit(require('node:fs').existsSync('docs/b.txt') ? 0 : 1)",
      ],
    },
  ],
})

let verificationFails = false

function verificationPlan(): string {
  const check = verificationFails
    ? "const fs=require('node:fs');console.log('broken');process.exit(1)"
    : "const fs=require('node:fs');if(fs.existsSync('docs/a.txt')&&fs.existsSync('docs/b.txt')){console.log('verified ok');process.exit(0)}console.log('broken');process.exit(1)"
  return JSON.stringify({
    scenarios: [
      {
        scenario: '文档存在且可读',
        acceptance_criterion: 'docs/a.txt 与 docs/b.txt 存在',
        method:
          '运行检查命令并核对输出；业务规则：文档内容由研发任务产出；异常与边界：文件缺失时验证失败',
        required: true,
        checks: [
          { label: 'smoke', argv: ['node', '-e', check], expected_output: 'verified ok' },
          {
            label: 'smoke-negative',
            argv: ['node', '-e', 'process.exit(1)'],
            expect_failure: true,
          },
        ],
      },
    ],
  })
}

const BUSINESS_REVIEW = JSON.stringify({
  verdict: 'pass',
  summary: '业务场景通过',
  findings: [],
  blocking: [],
  scenarios: [
    {
      scenario: '文档存在且可读',
      status: 'pass',
      evidence: 'verified ok',
      commands: ['smoke', 'smoke-negative'],
    },
  ],
  acceptance: [
    {
      criterion: 'docs/a.txt 与 docs/b.txt 存在',
      status: 'pass',
      evidence: 'verified ok',
      commands: ['smoke', 'smoke-negative'],
    },
  ],
  business_rules: [
    {
      rule: '文档内容由研发任务产出',
      status: 'pass',
      evidence: 'verified ok',
      commands: ['smoke', 'smoke-negative'],
    },
  ],
  exceptions: [
    {
      exception: '文件缺失时验证失败',
      status: 'pass',
      evidence: 'verified ok',
      commands: ['smoke', 'smoke-negative'],
    },
  ],
})

function diagnosisText(input: { action?: string; fixRequired?: boolean }): string {
  return JSON.stringify({
    impact: '受控目标健康检查失败，用户无法访问',
    facts: ['健康检查退出码 1'],
    hypotheses: [{ statement: '目标进程被终止', confidence: 'high' }],
    proposed_action:
      input.action === null ? null : { action_id: input.action ?? 'restart-web', params: {} },
    decision_required: false,
    fix_required: input.fixRequired ?? false,
    summary: '重启目标进程并复核健康检查',
  })
}

interface RunnerOptions {
  getRuntime: () => ForgeLoopRuntime | null
  opsDiagnosis: () => string
}

function fakeRunner(options: RunnerOptions): unknown {
  const sessionFor = (request: { role: string; cwd: string }) => ({
    sessionId: `session-m0-${request.role}`,
    async send(turn: { prompt: string; transcriptPath: string }) {
      const reply = (text: string) => ({
        status: 'completed',
        text,
        sessionId: `session-m0-${request.role}`,
        reason: '',
        transcriptPath: turn.transcriptPath,
        durationMs: 1,
        toolCalls: [],
      })
      if (request.role === 'dev' && turn.prompt.includes('技术方案与研发任务拆解'))
        return reply(PLAN)
      if (request.role === 'dev' && turn.prompt.includes('当前任务：')) {
        const taskId = /当前任务：(.+)/.exec(turn.prompt)?.[1]?.trim() ?? 'a'
        mkdirSync(join(request.cwd, 'docs'), { recursive: true })
        writeFileSync(join(request.cwd, `docs/${taskId}.txt`), `m0 ${taskId} ${Date.now()}\n`)
        return reply('done')
      }
      if (request.role === 'dev' && turn.prompt.includes('发现缺陷')) {
        mkdirSync(join(request.cwd, 'docs'), { recursive: true })
        writeFileSync(join(request.cwd, 'docs/a.txt'), `m0 fixed ${Date.now()}\n`)
        return reply('fixed')
      }
      if (request.role === 'verify' && turn.prompt.includes('现在只依据需求说明')) {
        return reply(verificationPlan())
      }
      if (request.role === 'verify' && turn.prompt.includes('你必须使用工具')) {
        const reqId = /需求身份：(\S+)/.exec(turn.prompt)?.[1] ?? ''
        const labels = [...turn.prompt.matchAll(/- label: (.+)/g)].map((match) => match[1]!.trim())
        const runtime = options.getRuntime()
        if (!runtime) throw new Error('runtime not ready')
        for (const label of labels) {
          const outcome = await runtime.runVerificationCheck(reqId, label)
          if (!outcome.ok) throw new Error(outcome.text)
        }
        return reply(JSON.stringify({ executed: labels, summary: 'executed' }))
      }
      if (request.role === 'verify' && turn.prompt.includes('业务验收'))
        return reply(BUSINESS_REVIEW)
      throw new Error(`unexpected role/prompt：${request.role}`)
    },
    async close() {
      return undefined
    },
  })

  return {
    async run(request: { role: string; prompt: string; transcriptPath?: string }) {
      const reply = (text: string) => ({
        status: 'completed',
        text,
        sessionId: `session-m0-${request.role}`,
        reason: '',
        transcriptPath: request.transcriptPath ?? '',
        durationMs: 1,
        toolCalls: [],
      })
      if (request.role === 'product') return reply(ANALYSIS)
      if (request.role === 'ops') return reply(options.opsDiagnosis())
      if (request.role === 'orchestrator') {
        return reply(JSON.stringify({ session_id: null, reason: 'm0-loop' }))
      }
      throw new Error(`unexpected single-turn role：${request.role}`)
    },
    async open(request: { role: string; cwd: string }) {
      return sessionFor(request)
    },
    async resume(request: { role: string; cwd?: string }) {
      return sessionFor({ role: request.role, cwd: request.cwd ?? projectRoot })
    },
  }
}

let projectRoot = ''
let runtime: ForgeLoopRuntime | null = null
const opsDiagnosisPhase: 'fix' | 'plain' = 'fix'

function configFor(
  project: string,
  recordsRoot: string,
  root: string,
  limits: { maxVerificationAttempts?: number } = {},
): unknown {
  return resolveConfig(
    {
      project: 'm0',
      projectPath: project,
      recordsRoot,
      owner: 'owner',
      pollSeconds: 3600,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 60 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
      failureRoundsPerGrant: 3,
      ...(limits.maxVerificationAttempts === undefined
        ? {}
        : { maxVerificationAttempts: limits.maxVerificationAttempts }),
      autonomy: {
        enabled: true,
        // ops: 前缀只为运维修复需求显式放开；普通来源仍走 dsh-session。
        trustedSources: ['dsh-session:', 'ops:'],
        allowCodeCommit: true,
        commitCheckCommand: [
          'node',
          '-e',
          "const fs=require('node:fs');process.exit(fs.existsSync('docs/a.txt')&&fs.existsSync('docs/b.txt')?0:1)",
        ],
      },
      candidateBuildCommand: ['node', '-e', 'process.exit(0)'],
      candidatePackageCommand: ['node', 'scripts/package.mjs'],
      candidateArtifactPath: 'dist/artifact.json',
      deployments: {
        enabled: true,
        toolRoot: join(recordsRoot, 'projects', 'm0', 'deployments', 'tools'),
        alerts: { webhook: 'http://127.0.0.1:9/unreachable' },
        tools: [
          {
            id: 'm0-tool',
            kind: 'python',
            path: join(recordsRoot, 'projects', 'm0', 'deployments', 'tools', 'tool.py'),
            capabilities: ['preflight', 'apply', 'status', 'rollback', 'data-rollback'],
            timeoutSeconds: 30,
          },
        ],
        targets: [
          {
            id: 'm0-target',
            toolId: 'm0-tool',
            requirementId: '',
            approval: 'auto',
            autoDeliver: true,
            params: { target: join(root, 'dsh-home', 'profiles', 'm0-target') },
            rollback: { keep: 1 },
          },
        ],
      },
      ops: {
        enabled: true,
        intervalSeconds: 60,
        resources: [{ id: 'web', kind: 'app', label: 'M0 受控目标' }],
        checks: [
          {
            id: 'web-health',
            resourceId: 'web',
            command: ['node', join(root, 'ops', 'check.mjs')],
            timeoutSeconds: 15,
            severity: 'major',
          },
        ],
        actions: [
          {
            id: 'restart-web',
            resourceId: 'web',
            command: ['node', join(root, 'ops', 'restart.mjs')],
            params: [],
            timeoutSeconds: 15,
            auto: true,
            verifyCheckId: 'web-health',
          },
        ],
      },
    },
    project,
  )
}

function makeRuntime(config: unknown): ForgeLoopRuntime {
  const runner = fakeRunner({
    getRuntime: () => runtime,
    opsDiagnosis: () => diagnosisText({ fixRequired: opsDiagnosisPhase === 'fix' }),
  })
  return new ForgeLoopRuntime({ ctx: {}, config, runner })
}

async function runNext(reqId: string, action: string): Promise<unknown> {
  if (!runtime) throw new Error('runtime not ready')
  const claimed = runtime.repo.claimNextRequest('m0-script', new Date().toISOString())
  check(claimed !== null, `没有可领取的 ${action} 请求`)
  if (!claimed) return null
  check(claimed.reqId === reqId, `${action} 请求属于 ${claimed.reqId} 而不是 ${reqId}`)
  check(claimed.action === action, `领取到 ${claimed.action} 而不是 ${action}`)
  const outcome = await runtime.executeRequest(claimed, new AbortController().signal)
  runtime.repo.resolveRequest(
    claimed.requestId,
    outcome.state,
    outcome.detail,
    new Date().toISOString(),
  )
  return outcome
}

async function deliver(
  project: string,
  recordsRoot: string,
  reqId: string,
): Promise<{ config: unknown; runtime: ForgeLoopRuntime }> {
  const config = configFor(project, recordsRoot, process.env.M0_ROOT!)
  runtime?.close()
  runtime = makeRuntime(config)
  const analyzed = await runNext(reqId, 'analyze')
  check(
    (analyzed as { state?: string } | null)?.state === 'done',
    `分析未完成：${JSON.stringify(analyzed)}`,
  )
  const queued = runtime.autoAdvanceRequests()
  check(queued.includes(reqId), `分析后没有排入自动推进：${JSON.stringify(queued)}`)
  const advance = await runNext(reqId, 'advance')
  check(
    (advance as { state?: string } | null)?.state === 'done',
    `研发/验证未完成：${JSON.stringify(advance)}`,
  )
  return { config, runtime }
}

/**
 * 真实制品 leg：从生产记录只读复制一份记录，用真实需求 req-20261031080821-f940b9 的
 * 提交、验证、业务终审与候选制品，走新部署接口到隔离目标。生产库只读（VACUUM INTO），
 * owner 决定只写入副本；不触碰正式 profile 与生产记录。
 */
async function runRealArtifactLeg(root: string): Promise<void> {
  if (process.env.FORGELOOP_M0_REAL_ARTIFACT !== '1') {
    summary.realArtifact = { skipped: 'FORGELOOP_M0_REAL_ARTIFACT!=1' }
    return
  }
  const prodDb = join(
    homedir(),
    '.forgeloop',
    'production',
    'projects',
    'forgeloop',
    'records.sqlite',
  )
  if (!existsSync(prodDb)) {
    summary.realArtifact = { skipped: `生产记录不存在：${prodDb}` }
    return
  }
  const reqId = 'req-20261031080821-f940b9'
  const owner = 'link'
  const recordsRoot = join(root, 'real-records')
  const targetDir = join(root, 'dsh-home', 'profiles', 'm0-real-target')
  mkdirSync(join(recordsRoot, 'projects', 'forgeloop'), { recursive: true })
  mkdirSync(targetDir, { recursive: true })
  const copyPath = join(recordsRoot, 'projects', 'forgeloop', 'records.sqlite')
  const source = new DatabaseSync(prodDb, { readOnly: true })
  try {
    source.exec(`VACUUM INTO '${copyPath.replaceAll("'", "''")}'`)
  } finally {
    source.close()
  }
  const toolPath = writeRealArtifactTool(recordsRoot)
  const config = resolveConfig(
    {
      project: 'forgeloop',
      projectPath: ROOT,
      recordsRoot,
      owner,
      pollSeconds: 3600,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      deployments: {
        enabled: true,
        alerts: { webhook: '', timeoutSeconds: 10 },
        tools: [
          {
            id: 'm0-real-tool',
            kind: 'python',
            path: toolPath,
            capabilities: ['preflight', 'apply', 'status', 'rollback', 'data-rollback'],
            timeoutSeconds: 60,
          },
        ],
        targets: [
          {
            id: 'm0-real-target',
            toolId: 'm0-real-tool',
            requirementId: '',
            approval: 'owner',
            params: { target: targetDir },
            rollback: { keep: 1 },
          },
        ],
      },
    },
    ROOT,
  )
  const local = new ForgeLoopRuntime({
    ctx: {},
    config,
    runner: {
      async run() {
        throw new Error('真实制品 leg 不需要 Agent')
      },
      async open() {
        throw new Error('真实制品 leg 不需要 Agent')
      },
    },
  })
  try {
    const build = local.repo.latestCandidateBuild(reqId)
    check(build !== null, '真实需求没有候选构建记录')
    check(build?.artifactSha256.startsWith('f3eeee74') === true, '真实制品摘要与生产记录不一致')
    const accepted = local.accept({ reqId, by: owner, source: 'm0-loop:real-artifact-accept' })
    check(accepted.ok, `真实需求验收副本失败：${accepted.message}`)
    const requested = await local.deploymentService.request({
      targetId: 'm0-real-target',
      requirementId: reqId,
      by: owner,
      source: 'm0-loop:real-artifact',
    })
    check(requested.ok, `真实制品部署提议失败：${requested.message}`)
    const intentId = (requested.data as { intentId: string }).intentId
    const denied = await local.deploymentService.approve({ intentId, by: 'not-owner' })
    check(denied.ok === false && denied.code === 'forbidden', '真实制品：非所有者批准未被拒绝')
    const approved = await local.deploymentService.approve({ intentId, by: owner })
    check(approved.ok, `真实制品部署批准失败：${approved.message}`)
    const verified = await local.deploymentService.verify({ intentId, by: owner })
    check(verified.ok, `真实制品部署核对失败：${verified.message}`)
    const installed = JSON.parse(readFileSync(join(targetDir, 'install.json'), 'utf8'))
    check(installed.version === build!.packageVersion, '真实制品安装版本与构建记录不一致')
    check(installed.artifactSha256 === build!.artifactSha256, '真实制品安装摘要与构建记录不一致')
    summary.realArtifact = {
      reqId,
      commitSha: local.repo.latestCommit(reqId)?.commitSha ?? '',
      artifact: build!.artifactSha256,
      intentId,
      verified: true,
      rollout: local.deploymentService.rollout(intentId),
    }
    console.log(`[m0-loop] 真实制品 leg 完成：${reqId} -> ${intentId}`)
  } finally {
    local.close()
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-m0-loop-'))
  process.env.M0_ROOT = root
  // 受控目标放在隔离 DSH_HOME 的派生 profile 下；配置出口也隔离到临时文件。
  process.env.DSH_HOME = join(root, 'dsh-home')
  mkdirSync(join(process.env.DSH_HOME, 'profiles'), { recursive: true })
  process.env.FORGELOOP_CONFIG = join(root, 'forgeloop-config.json')
  console.log(`[m0-loop] 工作目录 ${root}`)
  const project = makeProject(root)
  projectRoot = project
  const recordsRoot = join(root, 'records')

  writeOpsScripts(root)
  writeDeploymentTool(recordsRoot)
  mkdirSync(join(root, 'dsh-home', 'profiles', 'm0-target'), { recursive: true })
  process.env.M0_PID_FILE = join(root, 'ops', 'server.pid')
  process.env.M0_SERVER = join(root, 'ops', 'server.mjs')

  // 基线部署：启动一次真实目标进程（S2 用它制造真实故障）。
  execFileSync('node', [join(root, 'ops', 'restart.mjs')], { env: process.env })
  const serverPid = Number(readFileSync(process.env.M0_PID_FILE, 'utf8'))
  console.log(`[m0-loop] 目标进程 pid=${serverPid}`)

  try {
    // ---------------- S1：需求 → 研发 → 验证 → 提交 → 构建 → 部署 ----------------
    runtime = makeRuntime(configFor(project, recordsRoot, root), root)
    const submitted = runtime.submit({
      text: 'M0 闭环：写一份可验证的文档并部署到受控目标',
      by: 'owner',
      source: 'dsh-session:m0-loop:msg-1',
    })
    check(submitted.ok, `提交需求失败：${submitted.message}`)
    const reqId = (submitted.data as { reqId: string }).reqId
    console.log(`[m0-loop] S1 需求 ${reqId}`)

    await deliver(project, recordsRoot, reqId)
    if (!runtime) throw new Error('runtime missing')
    const commit = runtime.repo.latestCommit(reqId)
    check(commit !== null, '没有受控提交')
    check(git(project, ['status', '--porcelain']) === '', '受控提交后工作树不干净')
    const commitSha = commit?.commitSha ?? ''
    const delivery = await runtime.deliveryHandoff.tick()
    check(delivery.built >= 1, '协调器没有自动构建候选')
    const built = runtime.repo.latestCandidateBuild(reqId)
    check(built !== null, '没有候选构建记录')
    const intent = runtime.deployments.list().find((item) => item.requirementId === reqId)
    check(intent !== undefined, '协调器没有创建部署 intent')
    check(intent?.state === 'verified', `自动部署未核对通过：${intent?.state ?? 'missing'}`)
    const intentId = intent?.intentId ?? ''
    const denied = await runtime.deploymentService.approve({ intentId, by: 'not-owner' })
    check(denied.ok === false && denied.code === 'forbidden', '非所有者批准没有被拒绝')
    const deployed = JSON.parse(
      readFileSync(join(root, 'dsh-home', 'profiles', 'm0-target', 'current.json'), 'utf8'),
    )
    check(deployed.version === built!.packageVersion, '目标运行版本与制品版本不一致')
    check(deployed.artifactSha256 === built!.artifactSha256, '目标安装摘要与制品不一致')
    check(deployed.runningArtifactSha256 === built!.artifactSha256, '目标运行摘要与制品不一致')
    console.log(
      `[m0-loop] S1 完成：commit=${commitSha.slice(0, 10)} artifact=${built!.artifactSha256.slice(0, 10)}`,
    )

    // ---------------- S2：真实故障 → 巡检 → 恢复 ----------------
    process.kill(serverPid, 'SIGKILL')
    await sleep(300)
    let eventId = ''
    for (let i = 0; i < 5; i += 1) {
      const tick = await runtime.opsTick()
      const events = runtime.ops.list()
      if (events.length > 0) {
        eventId = events[0]!.eventId
        check(tick.executed > 0, '运维巡检没有执行恢复动作')
        if (runtime.ops.detail(eventId)?.event.state === 'recovered') break
        break
      }
      await sleep(200)
    }
    check(eventId !== '', 'S2 没有产生运维事件')
    const event = runtime.ops.detail(eventId)?.event
    check(event?.state === 'recovered', `S2 事件状态不是 recovered：${event?.state}`)
    const recoveredPid = Number(readFileSync(process.env.M0_PID_FILE, 'utf8'))
    check(recoveredPid !== serverPid, 'S2 恢复没有启动新进程')
    console.log(`[m0-loop] S2 完成：event=${eventId} recovered`)

    // ---------------- S3：永久修复需求 → 再次交付与部署 ----------------
    const tick2 = await runtime.opsTick()
    check(tick2.errors.length === 0, `S3 巡检错误：${tick2.errors.join('；')}`)
    const fixReqId = runtime.ops.detail(eventId)?.event.fixRequirementId ?? ''
    check(fixReqId !== '', 'S3 没有生成关联修复需求')
    const fixSource = runtime.repo.getRequirement(fixReqId)?.source ?? ''
    check(fixSource === `ops:${eventId}`, `修复需求来源不是 ops:${eventId}：${fixSource}`)

    await deliver(project, recordsRoot, fixReqId)
    if (!runtime) throw new Error('runtime missing')
    const fixCommit = runtime.repo.latestCommit(fixReqId)
    check(fixCommit !== null, 'S3 没有受控提交')
    const fixDelivery = await runtime.deliveryHandoff.tick()
    check(fixDelivery.built >= 1, 'S3 协调器没有自动构建修复制品')
    const fixBuilt = runtime.repo.latestCandidateBuild(fixReqId)
    check(fixBuilt !== null, 'S3 没有候选构建记录')
    const fixIntent = runtime.deployments.list().find((item) => item.requirementId === fixReqId)
    check(fixIntent !== undefined, 'S3 协调器没有创建修复部署 intent')
    check(
      fixIntent?.state === 'verified',
      `S3 修复部署未核对通过：${fixIntent?.state ?? 'missing'}`,
    )
    const fixDeployed = JSON.parse(
      readFileSync(join(root, 'dsh-home', 'profiles', 'm0-target', 'current.json'), 'utf8'),
    )
    check(fixDeployed.version === fixBuilt!.packageVersion, 'S3 目标运行版本与修复制品不一致')
    check(
      fixDeployed.artifactSha256 === fixBuilt!.artifactSha256,
      'S3 目标安装摘要与修复制品不一致',
    )
    const fixedEvent = runtime.ops.detail(eventId)?.event
    check(fixedEvent?.state === 'closed', `S3 原事件未在修复复核后关闭：${fixedEvent?.state}`)
    const fixCheck = runtime.ops
      .detail(eventId)
      ?.observations.find((item) => item.kind === 'fix_check')
    check(fixCheck !== undefined, 'S3 没有记录原检查复核')
    console.log(`[m0-loop] S3 完成：fixReq=${fixReqId} deploy=${fixIntent?.intentId ?? ''}`)

    // ---------------- M0-7 停止：真实请求阻止推进，显式恢复后才继续 ----------------
    const stopSubmit = runtime.submit({
      text: 'M0-7 停止测试：文档更新（用于验证停止与显式恢复）',
      by: 'owner',
      source: 'dsh-session:m0-loop:stop-leg',
    })
    check(stopSubmit.ok, `停止测试需求提交失败：${stopSubmit.message}`)
    const stopReqId = (stopSubmit.data as { reqId: string }).reqId
    const stopAnalyze = await runNext(stopReqId, 'analyze')
    check((stopAnalyze as { state?: string } | null)?.state === 'done', '停止测试需求分析未完成')
    check(runtime.autoAdvanceRequests().includes(stopReqId), '停止前没有自动排队')
    const stopResult = runtime.stop({
      reqId: stopReqId,
      by: 'owner',
      reason: 'M0-7 停止请求实测',
    })
    check(stopResult.ok, `停止请求失败：${stopResult.message}`)
    check(runtime.repo.activeStop(stopReqId), '停止请求没有落库')
    check(!runtime.autoAdvanceRequests().includes(stopReqId), '停止后仍被自动排队')
    check(
      runtime.repo.claimNextRequest('m0-script', new Date().toISOString()) === null,
      '停止后仍能领到推进请求',
    )
    const stopped = runtime.repo.getRequirement(stopReqId)
    check(stopped?.status === 'blocked', `停止后状态不是 blocked：${stopped?.status}`)
    const resumed = runtime.requestOperation({
      reqId: stopReqId,
      action: 'advance',
      by: 'owner',
      source: 'm0-loop:resume',
      reason: 'M0-7 显式恢复实测',
    })
    check(resumed.ok, `显式恢复失败：${resumed.message}`)
    const stopAdvance = await runNext(stopReqId, 'advance')
    check((stopAdvance as { state?: string } | null)?.state === 'done', '恢复后推进未完成')
    check(
      runtime.repo.getRequirement(stopReqId)?.status === 'committed',
      '恢复后需求未回到 committed',
    )
    console.log(`[m0-loop] M0-7 完成：停止阻止推进，显式恢复后 ${stopReqId} committed`)

    // 正数限额：maxVerificationAttempts=1 时，验证失败必须停住而不是无限重试。
    runtime.close()
    runtime = null
    verificationFails = true
    runtime = makeRuntime(configFor(project, recordsRoot, root, { maxVerificationAttempts: 1 }))
    const limitSubmit = runtime.submit({
      text: 'M0-7 限额测试：验证必然失败，用于确认正数次数上限会停住',
      by: 'owner',
      source: 'dsh-session:m0-loop:limit-leg',
    })
    check(limitSubmit.ok, `限额测试需求提交失败：${limitSubmit.message}`)
    const limitReqId = (limitSubmit.data as { reqId: string }).reqId
    const limitAnalyze = await runNext(limitReqId, 'analyze')
    check((limitAnalyze as { state?: string } | null)?.state === 'done', '限额测试需求分析未完成')
    runtime.autoAdvanceRequests()
    const limitAdvance = await runNext(limitReqId, 'advance')
    check((limitAdvance as { state?: string } | null)?.state === 'failed', '验证失败没有被限额停住')
    check(
      runtime.repo.getRequirement(limitReqId)?.status === 'blocked',
      '限额用尽后需求状态不是 blocked',
    )
    check(runtime.repo.latestCommit(limitReqId) === null, '限额测试不应产生受控提交')
    // 问题单仍开放时协调器会再排 advance（这是既有的跨请求重试语义）；
    // 本轮只证明正数上限让当前执行停下并置 blocked，不宣称跨请求总次数封顶。
    check(
      (runtime.repo.getRequirement(limitReqId)?.blockedReason ?? '').includes('问题单'),
      '限额用尽后没有留下问题单说明',
    )
    verificationFails = false
    runtime.close()
    runtime = null
    runtime = makeRuntime(configFor(project, recordsRoot, root))
    console.log(`[m0-loop] M0-7 限额完成：${limitReqId} 在 1 次验证上限后 blocked`)

    // ---------------- M0-4 负例：模型工具面与越界文件 ----------------
    const toolsSource = readFileSync(join(ROOT, 'packages/forgeloop/src/tools.ts'), 'utf8')
    check(
      !/name:\s*'forgeloop_(deploy|approve|rollback)/.test(toolsSource),
      '模型工具面出现了部署/批准/回退入口',
    )
    check(
      toolsSource.includes("name: 'forgeloop_rollouts'"),
      '模型工具面缺少只读 forgeloop_rollouts',
    )
    let boundaryRejected = false
    try {
      const { parseTaskPlanDraft } =
        await import('../../packages/forgeloop/lib/domain/task-plan.js')
      parseTaskPlanDraft(
        {
          tasks: [
            {
              task_id: 'a',
              goal: '越界',
              files: ['../escape.txt'],
              acceptance: '不应通过',
              test_command: ['node', '-e', 'process.exit(0)'],
            },
          ],
        },
        {
          requirementId: 'm0-boundary',
          project: 'm0',
          planVersion: 1,
          requirementVersion: 1,
          now: new Date().toISOString(),
        },
      )
    } catch {
      boundaryRejected = true
    }
    check(boundaryRejected, '越界文件计划没有被拒绝')

    await runRealArtifactLeg(root)

    summary.s1Rollout = runtime.deploymentService.rollout(intentId)
    const snapshot = configFor(project, recordsRoot, root) as {
      deployments: unknown
      ops: unknown
      autonomy: unknown
    }
    summary.s1Config = {
      deployments: snapshot.deployments,
      ops: snapshot.ops,
      autonomy: snapshot.autonomy,
    }
    summary.opsEvent = runtime.ops.detail(eventId)
    summary.opsFix = {
      eventId,
      state: fixedEvent?.state ?? '',
      check: fixCheck?.summary ?? '',
    }
    summary.s3Rollout = runtime.deploymentService.rollout(fixIntent?.intentId ?? '')
    summary.legs = {
      s1: { reqId, commitSha, artifact: built!.artifactSha256, intentId },
      m07: {
        reqId: stopReqId,
        stopped: 'blocked',
        resumed: 'committed',
        limitReqId,
        limit: 'maxVerificationAttempts=1 -> blocked',
      },
      s2: { eventId, state: event?.state, recoveredPid },
      s3: { fixReqId, fixCommit: fixCommit?.commitSha ?? '', fixIntent: fixIntent?.intentId ?? '' },
      negatives: {
        unauthorizedApprove: 'forbidden',
        toolSurface: 'no deploy/approve',
        boundary: 'rejected',
      },
    }
    summary.boundary =
      '脚本化 Agent 驱动研发/验证/诊断；Git、构建、python 部署工具与运维检查/恢复命令均为真实执行。'
  } finally {
    try {
      const pid = Number(readFileSync(process.env.M0_PID_FILE ?? '', 'utf8'))
      if (pid > 0) process.kill(pid, 'SIGKILL')
    } catch {
      // 清理失败不掩盖主流程结果。
    }
    runtime?.close()
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(join(EVIDENCE_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    if (summary.s1Config) {
      const configText = `${JSON.stringify(summary.s1Config, null, 2)}\n`
      writeFileSync(join(EVIDENCE_DIR, 'config.snapshot.json'), configText)
      if (process.env.FORGELOOP_CONFIG) writeFileSync(process.env.FORGELOOP_CONFIG, configText)
    }
    if (summary.s1Rollout) {
      writeFileSync(
        join(EVIDENCE_DIR, 's1-rollout.json'),
        `${JSON.stringify(summary.s1Rollout, null, 2)}\n`,
      )
    }
    if (summary.opsEvent) {
      writeFileSync(
        join(EVIDENCE_DIR, 's2-event.json'),
        `${JSON.stringify(summary.opsEvent, null, 2)}\n`,
      )
    }
    if (summary.s3Rollout) {
      writeFileSync(
        join(EVIDENCE_DIR, 's3-rollout.json'),
        `${JSON.stringify(summary.s3Rollout, null, 2)}\n`,
      )
    }
    if (summary.realArtifact) {
      writeFileSync(
        join(EVIDENCE_DIR, 'real-artifact.json'),
        `${JSON.stringify(summary.realArtifact, null, 2)}\n`,
      )
    }
    if (!KEEP) rmSync(root, { recursive: true, force: true })
    else console.log(`[m0-loop] 保留现场：${root}`)
  }

  if (failures.length > 0) {
    console.error(`[m0-loop] 失败 ${failures.length} 项：\n- ${failures.join('\n- ')}`)
    process.exit(1)
  }
  console.log(`[m0-loop] OK：S1/S2/S3 与负例全部通过；证据 ${join(EVIDENCE_DIR, 'summary.json')}`)
}

main().catch((error) => {
  console.error(`[m0-loop] 未捕获错误：${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
