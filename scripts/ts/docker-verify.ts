import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launch } from './platform.ts'
import { modelProxyProbe } from './verification-model-probe.ts'
import {
  assertLocalDockerHost,
  isVerificationTarget,
  requireVerificationContainer,
  VERIFICATION_TARGETS,
  verificationSettings,
  type VerificationTarget,
} from './verification-container.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const DOCKERFILE = 'scripts/docker/verification/Dockerfile'
const REPORTS = '/opt/forgeloop/reports'
const GATEWAY_MODE = 'com.docker.network.bridge.gateway_mode_ipv4'

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8' }).trim()
}

function dockerFile(): string {
  const configured = process.env.FORGELOOP_DOCKER_CLI?.trim()
  if (configured) return configured
  const brewDocker = '/opt/homebrew/bin/docker'
  return process.platform === 'darwin' && existsSync(brewDocker) ? brewDocker : 'docker'
}

function dockerHost(file: string): string {
  if (process.platform === 'darwin') {
    const profile = process.env.FORGELOOP_VERIFY_COLIMA_PROFILE?.trim() || 'forgeloop-verify'
    if (!/^[a-z][a-z0-9-]*$/.test(profile)) throw new Error('Colima profile 名称无效')
    const socket = join(homedir(), '.colima', profile, 'docker.sock')
    if (!existsSync(socket)) {
      throw new Error(
        `Colima profile ${profile} 未启动，请先运行 colima start --profile ${profile}`,
      )
    }
    return `unix://${socket}`
  }
  return (
    process.env.DOCKER_HOST?.trim() ||
    execFileSync(file, ['context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
  )
}

function dockerClient(config: string) {
  const file = dockerFile()
  const endpoint = dockerHost(file)
  assertLocalDockerHost(endpoint)
  const base = ['--config', config, '--host', endpoint]
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.DOCKER_CONTEXT
  delete env.DOCKER_HOST

  function sync(
    args: readonly string[],
    extra: Record<string, string> = {},
    quiet = false,
  ): string {
    const command = launch(file, [...base, ...args])
    const result = spawnSync(command.file, [...command.args], {
      cwd: ROOT,
      env: { ...env, ...extra },
      encoding: 'utf8',
      ...(command.spawnOptions ?? {}),
    })
    if (result.error || result.status !== 0) {
      if (quiet) return ''
      throw new Error(
        `Docker ${args.slice(0, 2).join(' ')} 失败：${result.error?.message ?? result.stderr.trim()}`,
      )
    }
    return result.stdout.trim()
  }

  function attached(args: readonly string[], signal: AbortSignal): Promise<number> {
    const command = launch(file, [...base, ...args])
    return new Promise((done, fail) => {
      const child = spawn(command.file, [...command.args], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
        signal,
        ...(command.spawnOptions ?? {}),
      })
      child.once('error', fail)
      child.once('close', (code) => done(code ?? 1))
    })
  }

  return { sync, attached }
}

type Docker = ReturnType<typeof dockerClient>

function fileMount(input: string, destination: string): string {
  return `type=bind,"source=${input.replaceAll('"', '""')}",target=${destination},readonly`
}

function stageInput(path: string, directory: string, name: string): string {
  const source = realpathSync(resolve(ROOT, path))
  if (!statSync(source).isFile()) throw new Error(`验证输入需要普通文件：${path}`)
  const target = join(directory, name)
  copyFileSync(source, target)
  return realpathSync(target)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function snapshot(directory: string): string {
  const index = git(['ls-files', '--stage', '-z'])
  mkdirSync(directory)
  git(['checkout-index', '--all', `--prefix=${directory}${sep}`])
  if (git(['ls-files', '--stage', '-z']) !== index) {
    throw new Error('创建 Docker 构建快照时 Git 暂存索引发生变化，请重新运行验证')
  }
  if (!existsSync(join(directory, DOCKERFILE))) {
    throw new Error('Docker 验证从 Git 暂存索引构建，请先将 Dockerfile 和本次改动加入索引')
  }
  return createHash('sha256').update(index).digest('hex')
}

async function modelNetwork(
  docker: Docker,
  name: string,
  proxy: string,
  image: string,
  hosts: readonly string[],
  password: string,
): Promise<void> {
  docker.sync(['network', 'create', '--internal', '--opt', `${GATEWAY_MODE}=isolated`, name])
  const isolation = docker.sync([
    'network',
    'inspect',
    '--format',
    `{{.Internal}} {{index .Options "${GATEWAY_MODE}"}} {{.EnableIPv6}}`,
    name,
  ])
  if (isolation !== 'true isolated false') {
    throw new Error('Docker 模型验收需要 IPv4 isolated 的内部网络，无法建立出站隔离')
  }
  docker.sync(
    [
      'create',
      '--name',
      proxy,
      '--network',
      name,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--env',
      'FORGELOOP_MODEL_HOSTS',
      '--env',
      'FORGELOOP_MODEL_PROXY_PASSWORD',
      '--entrypoint',
      'node',
      image,
      'scripts/ts/verification-model-egress.ts',
    ],
    { FORGELOOP_MODEL_HOSTS: hosts.join(','), FORGELOOP_MODEL_PROXY_PASSWORD: password },
  )
  docker.sync(['start', proxy])
  docker.sync(['network', 'connect', 'bridge', proxy])
  const probe = modelProxyProbe(proxy)
  for (let retry = 0; retry < 20; retry += 1) {
    if (docker.sync(probe, {}, true) === 'ready') return
    await delay(250)
  }
  throw new Error('测试模型代理未就绪')
}

function inside(target: VerificationTarget): number {
  requireVerificationContainer()
  const scripts = VERIFICATION_TARGETS[target].scripts
  const runs: Array<{ script: string; exitCode: number }> = []
  mkdirSync(join(ROOT, 'reports'), { recursive: true })
  try {
    for (const script of scripts) {
      const result = spawnSync(process.execPath, [`scripts/ts/${script}.ts`], {
        cwd: ROOT,
        stdio: 'inherit',
      })
      const exitCode = result.status ?? 1
      runs.push({ script, exitCode })
      if (result.error) throw result.error
      if (exitCode !== 0) return exitCode
    }
    return 0
  } finally {
    writeFileSync(
      join(ROOT, 'reports', 'scenario.json'),
      `${JSON.stringify({ target, runs }, null, 2)}\n`,
    )
  }
}

async function verify(target: VerificationTarget): Promise<number> {
  const settings = verificationSettings(target, process.env)
  const run = `forgeloop-verify-${randomUUID()}`
  const proxy = `${run}-model`
  const usesModel = settings.modelHosts.length > 0
  const network = usesModel ? run : 'none'
  const stageRoot = join(ROOT, '.cache', 'docker-verification')
  mkdirSync(stageRoot, { recursive: true })
  const pending = mkdtempSync(join(stageRoot, 'input-'))
  const control = new AbortController()
  const stop = () => control.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  let docker: Docker | undefined
  let launched = false
  let exitCode = 1
  const report = join(
    dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir'])),
    'reports',
    'docker-verification',
    run,
  )
  let identity: { sourceSha256: string; image: string; candidateSha256: string } | null = null
  try {
    const config = join(pending, 'docker-config')
    mkdirSync(config)
    writeFileSync(
      join(config, 'config.json'),
      JSON.stringify({
        cliPluginsExtraDirs: [
          '/opt/homebrew/lib/docker/cli-plugins',
          '/usr/local/lib/docker/cli-plugins',
        ],
      }),
    )
    docker = dockerClient(config)
    if (docker.sync(['info', '--format', '{{.OSType}}']) !== 'linux') {
      throw new Error('ForgeLoop 验证镜像需要 Linux Docker 引擎')
    }
    const context = join(tmpdir(), run)
    try {
      const sourceSha256 = snapshot(context)
      const imageId = join(pending, 'image-id')
      const build = await docker.attached(
        ['build', '--file', join(context, DOCKERFILE), '--iidfile', imageId, context],
        control.signal,
      )
      if (build !== 0) throw new Error('验证镜像构建失败')
      const image = readFileSync(imageId, 'utf8').trim()
      if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error('验证镜像没有有效摘要')
      identity = { sourceSha256, image, candidateSha256: '' }
    } finally {
      rmSync(context, { recursive: true, force: true })
    }

    const env = { ...settings.env }
    const mounts: string[] = []
    if (settings.candidate) {
      const candidate = stageInput(settings.candidate, pending, 'candidate.tgz')
      mounts.push('--mount', fileMount(candidate, '/tmp/verification-candidate.tgz'))
      env.FORGELOOP_CANDIDATE_TARBALL = '/tmp/verification-candidate.tgz'
      identity.candidateSha256 = sha256(candidate)
      env.FORGELOOP_CANDIDATE_SHA256 = identity.candidateSha256
    }
    if (settings.modelPatch) {
      const patch = stageInput(settings.modelPatch, pending, 'model.patch.yml')
      mounts.push('--mount', fileMount(patch, '/tmp/verification-model.patch.yml'))
      env.FORGELOOP_REAL_MODEL_PATCH = '/tmp/verification-model.patch.yml'
    }
    if (usesModel) {
      const password = randomUUID()
      await modelNetwork(docker, network, proxy, identity.image, settings.modelHosts, password)
      env.HTTPS_PROXY = `http://forge:${password}@${proxy}:8123`
      env.HTTP_PROXY = env.HTTPS_PROXY
      env.NO_PROXY = 'localhost,127.0.0.1,::1'
      env.NODE_USE_ENV_PROXY = '1'
    }

    docker.sync(
      [
        'create',
        '--name',
        run,
        '--network',
        network,
        '--init',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        ...mounts,
        ...Object.keys(env).flatMap((key) => ['--env', key]),
        identity.image,
        target,
      ],
      env,
    )
    launched = true
    if (docker.sync(['inspect', '--format', '{{.HostConfig.NetworkMode}}', run]) !== network) {
      throw new Error('验证容器网络与本轮隔离要求不一致')
    }
    exitCode = await docker.attached(['start', '--attach', run], control.signal)
    return exitCode
  } finally {
    try {
      mkdirSync(report, { recursive: true })
      writeFileSync(
        join(report, 'container.json'),
        `${JSON.stringify({ target, run, network, identity, exitCode }, null, 2)}\n`,
      )
      if (launched && docker) docker.sync(['cp', `${run}:${REPORTS}/.`, report])
      if (usesModel && docker) {
        const proxyLog = docker.sync(['logs', proxy], {}, true)
        if (proxyLog) writeFileSync(join(report, 'model-proxy.log'), proxyLog)
      }
      console.log(`[docker-verify] 验收证据 ${report}`)
    } finally {
      docker?.sync(['rm', '--force', run], {}, true)
      if (usesModel) {
        docker?.sync(['rm', '--force', proxy], {}, true)
        docker?.sync(['network', 'rm', network], {}, true)
      }
      rmSync(pending, { recursive: true, force: true })
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
  }
}

const [mode, name] = process.argv.slice(2)
const target = mode === '--inside' ? name : mode
try {
  if (!target || !isVerificationTarget(target)) {
    throw new Error(
      `用法：node scripts/ts/docker-verify.ts <${Object.keys(VERIFICATION_TARGETS).join('|')}>`,
    )
  }
  process.exitCode = mode === '--inside' ? inside(target) : await verify(target)
} catch (error) {
  console.error(`[docker-verify] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
