import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256OfBytes } from '../domain/delivery.js'
import type { TaskPlan } from '../domain/task-plan.js'

export function readInstalledVersion(installedRoot: string): string {
  try {
    const installed = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof installed.version === 'string' ? installed.version : ''
  } catch {
    return ''
  }
}

export function verifyInstalledFiles(
  build: { readonly files: readonly string[]; readonly tarball: string },
  installedRoot: string,
): { ok: boolean; detail: string } {
  const issues: string[] = []
  for (const file of build.files) {
    const installedPath = join(installedRoot, file)
    if (!existsSync(installedPath)) {
      issues.push(`缺少 ${file}`)
      continue
    }
    let packed: Buffer | null = null
    // npm pack 的成员带 `package/` 前缀；测试或本地 tar 可能没有，两种都核对。
    for (const member of [`package/${file}`, file]) {
      try {
        packed = execFileSync('tar', ['-xzf', build.tarball, '-O', member], {
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        break
      } catch {
        packed = null
      }
    }
    if (!packed) {
      issues.push(`无法读取包内 ${file}`)
      continue
    }
    if (sha256OfBytes(packed) !== sha256OfBytes(readFileSync(installedPath))) {
      issues.push(`内容不一致 ${file}`)
    }
  }
  return issues.length === 0
    ? { ok: true, detail: `${build.files.length} 个文件与包内容一致` }
    : { ok: false, detail: issues.join('；') }
}

export function inspectRuntimeIdentity(
  installedRoot: string,
  build: { readonly packageVersion: string },
): { id: string; ok: boolean; detail: string } | null {
  const identityPath = join(installedRoot, 'runtime-identity.json')
  if (!existsSync(identityPath)) return null
  try {
    const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as {
      kind?: unknown
      version?: unknown
      pid?: unknown
      startedAt?: unknown
      indexSha256?: unknown
      serviceSha256?: unknown
    }
    const pid = typeof identity.pid === 'number' ? identity.pid : 0
    const alive = processAlive(pid)
    const indexHash = sha256OfBytes(readFileSync(join(installedRoot, 'lib/index.js')))
    const serviceHash = sha256OfBytes(readFileSync(join(installedRoot, 'lib/runtime/service.js')))
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

export function inspectRequirementModules(
  admitted: boolean,
  candidateDiffPath: string,
  plan: TaskPlan,
  installedRoot: string,
): { ok: boolean; detail: string } {
  // 新链路按候选 diff 的实际源码文件核对；旧链路仍按任务包声明核对。
  const expectedSources = admitted
    ? [
        ...readFileSync(candidateDiffPath, 'utf8').matchAll(
          /^\+\+\+ b\/(packages\/forgeloop\/src\/[^\n]+\.ts)$/gm,
        ),
      ].map((match) => match[1]!)
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
