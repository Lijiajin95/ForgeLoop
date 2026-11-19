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
  readonly clientSha256: string
  readonly artifactSha256: string
}

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
let buildSourcePath = ''
let buildClientEntryFile = ''

function sha256(path: string): string {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : ''
}

export function writeRuntimeIdentity(
  moduleUrl: string,
  log: (message: string) => void = (message) => {
    console.warn(message)
  },
): RuntimeIdentity | null {
  try {
    const packageRoot = resolve(dirname(fileURLToPath(moduleUrl)), '..')
    const artifactFile = join(packageRoot, 'artifact.sha256')
    const artifactSha256 = existsSync(artifactFile) ? readFileSync(artifactFile, 'utf8').trim() : ''
    const identity: RuntimeIdentity = {
      kind: 'forgeloop-runtime-identity',
      version: PLUGIN_VERSION,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
      indexSha256: sha256(join(packageRoot, 'lib/index.js')),
      serviceSha256: sha256(join(packageRoot, 'lib/runtime/service.js')),
      clientSha256: sha256(join(packageRoot, 'client.js')),
      artifactSha256: /^[0-9a-f]{64}$/.test(artifactSha256) ? artifactSha256 : '',
    }
    currentIdentity = identity
    writeFileSync(
      join(packageRoot, 'runtime-identity.json'),
      `${JSON.stringify(identity, null, 2)}\n`,
      'utf8',
    )
    return identity
  } catch (error) {
    log(`[forgeloop] 无法写入运行身份：${errorMessage(error)}`)
    return null
  }
}

export function buildIdentityFrom(
  identity: RuntimeIdentity | null,
  projectPath?: string,
  clientEntryFile = '',
): BuildIdentityView {
  const clientSha256 = identity?.clientSha256 ?? ''
  const sourceClientSha256 =
    projectPath && clientEntryFile ? sha256(join(projectPath, clientEntryFile)) : ''
  return {
    version: identity?.version ?? PLUGIN_VERSION,
    startedAt: identity?.startedAt ?? '',
    serverSha256: identity?.indexSha256 ?? '',
    clientSha256,
    sourceClientSha256,
    sourceMatches: clientSha256 && sourceClientSha256 ? clientSha256 === sourceClientSha256 : null,
  }
}

export function setBuildSourcePath(projectPath: string, clientEntryFile = ''): void {
  buildSourcePath = projectPath
  buildClientEntryFile = clientEntryFile
}

export function buildIdentity(projectPath?: string, clientEntryFile?: string): BuildIdentityView {
  return buildIdentityFrom(
    currentIdentity,
    projectPath ?? buildSourcePath,
    clientEntryFile ?? buildClientEntryFile,
  )
}
