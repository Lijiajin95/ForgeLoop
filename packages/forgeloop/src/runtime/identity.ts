/**
 * 运行身份自述：把实际加载的包版本、进程和已加载入口/服务摘要写到安装包目录，
 * 供上线核对区分“同版本但不同构建”，不把安装回执当作运行证据。
 */
import { createHash } from 'node:crypto'
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
}

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
    }
    writeFileSync(join(packageRoot, 'runtime-identity.json'), `${JSON.stringify(identity, null, 2)}\n`, 'utf8')
    return identity
  } catch (error) {
    console.warn(`[forgeloop] 无法写入运行身份：${(error as Error).message}`)
    return null
  }
}
