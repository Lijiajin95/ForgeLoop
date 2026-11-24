import { parseJsonObject } from '../domain/json.js'
import { prepareCommand } from './command-launch.js'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { sha256OfBytes } from '../domain/delivery.js'
import type { TaskPlan } from '../domain/task-plan.js'

const MAX_MEMBER_BYTES = 64 * 1024 * 1024

function extractMember(
  tarballDir: string,
  tarballName: string,
  member: string,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const launch = prepareCommand(['tar', '-xzf', tarballName, '-O', member])
    const child = spawn(launch.argv[0] ?? 'tar', launch.argv.slice(1), {
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      cwd: tarballDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let captured = 0
    let overflow = false
    child.stdout.on('data', (chunk: Buffer) => {
      captured += chunk.length
      if (captured > MAX_MEMBER_BYTES) {
        overflow = true
        child.kill('SIGTERM')
        return
      }
      chunks.push(chunk)
    })
    child.once('error', () => {
      resolve(null)
    })
    child.once('close', (code: number | null) => {
      resolve(code === 0 && !overflow ? Buffer.concat(chunks) : null)
    })
  })
}

export async function readInstalledVersion(installedRoot: string): Promise<string> {
  try {
    const installed = parseJsonObject(await readFile(join(installedRoot, 'package.json'), 'utf8'))
    return typeof installed.version === 'string' ? installed.version : ''
  } catch {
    return ''
  }
}

export async function verifyInstalledFiles(
  build: { readonly files: readonly string[]; readonly tarball: string },
  installedRoot: string,
): Promise<{ ok: boolean; detail: string }> {
  const issues: string[] = []
  // 以包所在目录为工作目录、只传文件名：GNU tar（Git for Windows 自带）会把 `C:\...`
  // 里的盘符当成远程主机（Cannot connect to C:），相对路径对 GNU tar 与 bsdtar 都成立。
  const tarballDir = dirname(build.tarball)
  const tarballName = basename(build.tarball)
  for (const file of build.files) {
    const installedPath = join(installedRoot, file)
    if (!existsSync(installedPath)) {
      issues.push(`缺少 ${file}`)
      continue
    }
    let packed: Buffer | null = null
    // npm pack 的成员带 `package/` 前缀；测试或本地 tar 可能没有，两种都核对。
    for (const member of [`package/${file}`, file]) {
      packed = await extractMember(tarballDir, tarballName, member)
      if (packed) break
    }
    if (!packed) {
      issues.push(`无法读取包内 ${file}`)
      continue
    }
    if (sha256OfBytes(packed) !== sha256OfBytes(await readFile(installedPath))) {
      issues.push(`内容不一致 ${file}`)
    }
  }
  return issues.length === 0
    ? { ok: true, detail: `${build.files.length} 个文件与包内容一致` }
    : { ok: false, detail: issues.join('；') }
}

export async function inspectRuntimeIdentity(
  installedRoot: string,
  build: { readonly packageVersion: string },
): Promise<{ id: string; ok: boolean; detail: string } | null> {
  const identityPath = join(installedRoot, 'runtime-identity.json')
  if (!existsSync(identityPath)) return null
  try {
    const identity = parseJsonObject(await readFile(identityPath, 'utf8'))
    const pid = typeof identity.pid === 'number' ? identity.pid : 0
    const alive = processAlive(pid)
    const indexHash = sha256OfBytes(await readFile(join(installedRoot, 'lib/index.js')))
    const serviceHash = sha256OfBytes(await readFile(join(installedRoot, 'lib/runtime/service.js')))
    return {
      id: 'running_identity',
      ok:
        identity.kind === 'forgeloop-runtime-identity' &&
        identity.version === build.packageVersion &&
        alive &&
        identity.indexSha256 === indexHash &&
        identity.serviceSha256 === serviceHash,
      detail: `运行身份 pid=${pid || '未知'}，入口摘要 ${typeof identity.indexSha256 === 'string' ? identity.indexSha256 : ''}，服务摘要 ${typeof identity.serviceSha256 === 'string' ? identity.serviceSha256 : ''}`,
    }
  } catch {
    return { id: 'running_identity', ok: false, detail: '运行身份文件无法解析' }
  }
}

export async function inspectRequirementModules(
  admitted: boolean,
  candidateDiffPath: string,
  plan: TaskPlan,
  installedRoot: string,
): Promise<{ ok: boolean; detail: string }> {
  const expectedSources = admitted
    ? [
        ...(await readFile(candidateDiffPath, 'utf8')).matchAll(
          /^\+\+\+ b\/(packages\/forgeloop\/src\/[^\n]+\.ts)$/gm,
        ),
      ].map((match) => match[1] ?? '')
    : plan.tasks.flatMap((task) => task.files)
  const expectedModules = [...new Set(expectedSources)]
    .filter((file) => file.startsWith('packages/forgeloop/src/') && file.endsWith('.ts'))
    .map((file) => file.replace('packages/forgeloop/src/', 'lib/').replace(/\.ts$/, '.js'))
  const absentModules = expectedModules.filter((file) => !existsSync(join(installedRoot, file)))
  return absentModules.length === 0
    ? { ok: true, detail: `本次需求的 ${expectedModules.length} 个源码模块已随安装包加载` }
    : { ok: false, detail: `安装包缺少本次需求的模块：${absentModules.join('、')}` }
}

export function processAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
