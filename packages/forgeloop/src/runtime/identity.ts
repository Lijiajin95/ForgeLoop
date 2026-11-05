/**
 * 运行身份自述：把实际加载的包版本、进程和已加载入口/服务/客户端摘要写到安装包目录，
 * 供上线核对区分“同版本但不同构建”，不把安装回执当作运行证据。
 */
import { createHash } from 'node:crypto'
import { errorMessage } from '../domain/errors.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_VERSION } from './version.js'

export interface RuntimeIdentity {
  readonly kind: 'forgeloop-runtime-identity'
  readonly version: string
  readonly pid: number
  readonly startedAt: string
  readonly cwd: string
  readonly indexSha256: string
  readonly serviceSha256: string
  /** 实际装载的客户端包摘要；用于和源码 client.js 比较。 */
  readonly clientSha256: string
}

/** 页面只读展示的构建身份；空字符串表示宿主没有记录，不猜测。 */
export interface BuildIdentityView {
  readonly version: string
  readonly startedAt: string
  readonly serverSha256: string
  readonly clientSha256: string
  readonly sourceClientSha256: string
  /** null 表示无法比较（缺安装包或源码摘要）。 */
  readonly sourceMatches: boolean | null
}

let currentIdentity: RuntimeIdentity | null = null
/** 源码工程路径；由宿主装载时设置，用于比较装载客户端与源码。 */
let buildSourcePath = ''

function sha256(path: string): string {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : ''
}

/** 写入当前安装包根目录；失败只告警，不阻止插件装载。 */
export function writeRuntimeIdentity(moduleUrl: string): RuntimeIdentity | null {
  try {
    const packageRoot = resolve(dirname(fileURLToPath(moduleUrl)), '..')
    const identity: RuntimeIdentity = {
      kind: 'forgeloop-runtime-identity',
      version: PLUGIN_VERSION,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
      indexSha256: sha256(join(packageRoot, 'lib/index.js')),
      serviceSha256: sha256(join(packageRoot, 'lib/runtime/service.js')),
      clientSha256: sha256(join(packageRoot, 'client.js')),
    }
    currentIdentity = identity
    writeFileSync(
      join(packageRoot, 'runtime-identity.json'),
      `${JSON.stringify(identity, null, 2)}\n`,
      'utf8',
    )
    return identity
  } catch (error) {
    console.warn(`[forgeloop] 无法写入运行身份：${errorMessage(error)}`)
    return null
  }
}

/**
 * 由已知身份与源码目录构造页面使用的构建视图；纯函数，便于测试。
 * 源码摘要只在传入 projectPath 且能找到 client.js 时计算。
 */
export function buildIdentityFrom(
  identity: RuntimeIdentity | null,
  projectPath?: string,
): BuildIdentityView {
  const clientSha256 = identity?.clientSha256 ?? ''
  const sourceClientSha256 = projectPath
    ? sha256(join(projectPath, 'packages/forgeloop/client.js'))
    : ''
  return {
    version: identity?.version ?? PLUGIN_VERSION,
    startedAt: identity?.startedAt ?? '',
    serverSha256: identity?.indexSha256 ?? '',
    clientSha256,
    sourceClientSha256,
    sourceMatches: clientSha256 && sourceClientSha256 ? clientSha256 === sourceClientSha256 : null,
  }
}

/** 宿主装载时记录源码工程路径；不改变业务配置。 */
export function setBuildSourcePath(projectPath: string): void {
  buildSourcePath = projectPath
}

/** 当前进程写入的运行身份与源码身份；未装载（如单测直接构造 runtime）时字段为空。 */
export function buildIdentity(projectPath?: string): BuildIdentityView {
  return buildIdentityFrom(currentIdentity, projectPath ?? buildSourcePath)
}
