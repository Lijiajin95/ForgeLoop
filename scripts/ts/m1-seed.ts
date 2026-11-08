#!/usr/bin/env node
/**
 * M1-1 种子证据（不调用模型）：把当前插件打成 tarball，装进隔离 profile，
 * 启动真实 DSH 宿主，从运行进程写出的 runtime-identity.json 核对版本与进程身份，
 * 并把证据归档到 reports/m1/seed-<stamp>/。
 *
 * 用法：node scripts/ts/m1-seed.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { terminate } from './platform.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const PROFILE = 'm1-seed'
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const DSH_CLI = process.env.FORGELOOP_DSH_CLI?.trim() ?? ''
const PATCH = process.env.FORGELOOP_REAL_MODEL_PATCH?.trim() ?? ''

interface Site {
  readonly root: string
  readonly home: string
  readonly project: string
  readonly records: string
  readonly config: string
  readonly tarball: string
  readonly tarballSha256: string
  readonly version: string
}

function dshCommand(args: string[]): {
  file: string
  args: string[]
  spawnOptions?: { shell: true }
} {
  return DSH_CLI
    ? { file: process.execPath, args: [DSH_CLI, ...args] }
    : { file: 'dsh', args, spawnOptions: { shell: process.platform === 'win32' } }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => done(port))
    })
  })
}

function prepare(): Site {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-m1-seed-'))
  const home = join(root, 'dsh-home')
  const project = join(root, 'project')
  const records = join(root, 'records')
  const config = join(root, 'forgeloop.json')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(records, { recursive: true })
  execFileSync(NPM, ['run', 'build', '--workspace', 'forgeloop-dsh'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  const packed = execFileSync(NPM, ['pack', './packages/forgeloop', '--pack-destination', root], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1) as string
  const tarball = join(root, packed)
  const tarballSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const version = (
    JSON.parse(readFileSync(join(ROOT, 'packages/forgeloop/package.json'), 'utf8')) as {
      version: string
    }
  ).version
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        project: 'm1-seed',
        projectPath: project,
        recordsRoot: records,
        deployments: { enabled: false },
      },
      null,
      2,
    )}\n`,
  )
  return { root, home, project, records, config, tarball, tarballSha256, version }
}

async function main(): Promise<void> {
  const site = prepare()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: site.home,
    FORGELOOP_CONFIG: site.config,
  }
  const created = dshCommand([
    '--profile',
    PROFILE,
    '--from-default-profile',
    'web',
    '--dump-config',
  ])
  execFileSync(created.file, created.args, { cwd: ROOT, env, stdio: 'ignore' })
  const add = dshCommand(['plugin', '--profile', PROFILE, 'add', site.tarball])
  execFileSync(add.file, add.args, { cwd: ROOT, env, stdio: 'ignore' })
  // 安装器职责：把本次制品摘要写进安装目录，运行身份据此报告实际装载的制品。
  const installedRoot = join(site.home, 'profiles', PROFILE, 'node_modules', 'forgeloop-dsh')
  if (!existsSync(installedRoot)) throw new Error(`profile ${PROFILE} 没有安装 forgeloop-dsh`)
  writeFileSync(join(installedRoot, 'artifact.sha256'), `${site.tarballSha256}\n`)

  const port = await freePort()
  const spec = dshCommand([
    '--profile',
    PROFILE,
    ...(PATCH ? ['--patch', PATCH] : []),
    '--port',
    String(port),
    '--no-open',
  ])
  const logPath = join(site.root, 'host.log')
  const logFd = openSync(logPath, 'a')
  const child: ChildProcess = spawn(spec.file, spec.args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', logFd, logFd],
    ...(spec.spawnOptions ?? {}),
  })
  const host = { child, logPath }
  const identityPath = join(
    site.home,
    'profiles',
    PROFILE,
    'node_modules',
    'forgeloop-dsh',
    'runtime-identity.json',
  )
  const failures: string[] = []
  try {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline && !existsSync(identityPath)) await sleep(500)
    if (!existsSync(identityPath)) failures.push('宿主启动后没有写出 runtime-identity.json')
    const identity = existsSync(identityPath)
      ? (JSON.parse(readFileSync(identityPath, 'utf8')) as Record<string, unknown>)
      : {}
    if (String(identity.version ?? '') !== site.version) {
      failures.push(`运行身份版本与安装包不一致：${String(identity.version)} != ${site.version}`)
    }
    if (Number(identity.pid ?? 0) !== Number(host.child.pid ?? 0)) {
      failures.push(
        `运行身份 pid 与宿主进程不一致：${String(identity.pid)} != ${String(host.child.pid)}`,
      )
    }
    try {
      process.kill(Number(identity.pid ?? host.child.pid ?? 0), 0)
    } catch {
      failures.push('运行身份记录的进程已不在运行')
    }
    const startedAt = Date.parse(String(identity.startedAt ?? ''))
    if (!Number.isFinite(startedAt)) failures.push('运行身份缺少可信启动时间')
    for (const field of ['indexSha256', 'serviceSha256', 'clientSha256']) {
      if (!/^[0-9a-f]{64}$/.test(String(identity[field] ?? ''))) {
        failures.push(`运行身份缺少 ${field}`)
      }
    }
    if (!/^[0-9a-f]{64}$/.test(String(identity.artifactSha256 ?? ''))) {
      failures.push('运行身份缺少本次制品摘要（artifact.sha256 未写入）')
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(ROOT, 'reports', 'm1', `seed-${stamp}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`)
    // 归档要能独立复核：宿主日志与生效配置一起复制，不依赖临时目录。
    for (const name of ['host.log', 'forgeloop.json']) {
      const from = join(site.root, name)
      if (existsSync(from)) writeFileSync(join(dir, name), readFileSync(from))
    }
    writeFileSync(
      join(dir, 'summary.json'),
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
          pluginVersion: site.version,
          tarball: site.tarball,
          tarballSha256: site.tarballSha256,
          profile: PROFILE,
          port,
          hostPid: host.child.pid,
          identityPath,
          identity,
          failures,
        },
        null,
        2,
      )}\n`,
    )
    writeFileSync(
      join(dir, 'index.md'),
      [
        '# M1-1 种子安装与运行身份',
        '',
        `- 插件 tarball：${site.tarball} sha256 ${site.tarballSha256}`,
        `- 隔离 profile：${PROFILE}，DSH_HOME=${site.home}`,
        `- 宿主 pid：${String(host.child.pid)}，端口 ${String(port)}`,
        `- 运行身份文件：${identityPath}`,
        '',
        '## 核对',
        '',
        '- 版本、pid、启动时间、入口/服务/客户端摘要均来自运行进程写出的文件，不是计划值。',
        `- 失败项：${failures.length === 0 ? '无' : failures.join('；')}`,
        '',
      ].join('\n'),
    )
    process.stdout.write(`证据已写入 ${dir}\n${JSON.stringify({ failures })}\n`)
  } finally {
    terminate(host.child)
    closeSync(logFd)
  }
  if (failures.length > 0) process.exitCode = 1
}

await main()
