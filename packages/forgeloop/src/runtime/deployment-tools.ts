import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DeploymentOperation, DeploymentDataScope } from '../domain/deployment.js'
import type { DeploymentToolConfig } from '../config.js'
import { sha256OfBytes } from '../domain/delivery.js'
import type { DeploymentStore } from '../records/deployment-store.js'

const MAX_OUTPUT_BYTES = 64 * 1024

export interface DeploymentToolPlan {
  readonly intentId: string
  readonly op: DeploymentOperation
  readonly artifact: { readonly sha256: string; readonly path: string; readonly version: string }
  readonly previous: {
    readonly sha256: string
    readonly path: string
    readonly version: string
    readonly restorePoint: string
  } | null
  readonly params: Readonly<Record<string, string>>
  readonly device: { readonly id: string; readonly transport: 'local' }
  readonly data: DeploymentDataScope
  readonly timeoutSeconds: number
}

export interface DeploymentToolRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly truncated: boolean
  readonly sha256: string
  readonly durationMs: number
}

export function deploymentToolArgv(
  tool: DeploymentToolConfig,
  op: DeploymentOperation,
  planPath: string,
): { command: string; args: string[] } {
  const command = tool.kind === 'python' ? 'python3' : '/bin/sh'
  return { command, args: [tool.path, '--op', op, '--plan', planPath] }
}

export function deploymentToolEnv(tool: DeploymentToolConfig): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
  for (const name of tool.env) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

export function deploymentToolDigest(path: string): { sha256: string; size: number } {
  return { sha256: sha256OfBytes(readFileSync(path)), size: statSync(path).size }
}

/**
 * 实际制品文件摘要：apply 前复核磁盘上的制品与 intent 记录一致，
 * 避免等待批准期间制品被换掉后仍按旧记录部署。读不到时返回空串，由调用方拒绝部署。
 */
export function artifactFileDigest(path: string): string {
  try {
    return sha256OfBytes(readFileSync(path))
  } catch {
    return ''
  }
}

export function syncDeploymentToolScript(
  repo: DeploymentStore,
  tool: DeploymentToolConfig,
  now: string,
): { sha256: string; changed: boolean } {
  const digest = deploymentToolDigest(tool.path)
  const previous = repo.deploymentToolScript(tool.id)
  if (previous && previous.sha256 !== digest.sha256) {
    repo.recordDeploymentToolChange({
      changeId: `dtc-${randomUUID()}`,
      toolId: tool.id,
      path: tool.path,
      previousSha256: previous.sha256,
      sha256: digest.sha256,
      changedAt: now,
    })
  }
  if (!previous || previous.sha256 !== digest.sha256) {
    repo.recordDeploymentToolScript({
      toolId: tool.id,
      path: tool.path,
      sha256: digest.sha256,
      size: digest.size,
      recordedAt: now,
    })
  }
  return { sha256: digest.sha256, changed: Boolean(previous && previous.sha256 !== digest.sha256) }
}

class OutputBuffer {
  text = ''
  truncated = false

  append(chunk: Buffer): void {
    if (this.text.length >= MAX_OUTPUT_BYTES) {
      this.truncated = true
      return
    }
    const room = MAX_OUTPUT_BYTES - this.text.length
    this.text += chunk.subarray(0, room).toString('utf8')
    if (chunk.length > room) this.truncated = true
  }
}

export async function runDeploymentTool(
  tool: DeploymentToolConfig,
  op: DeploymentOperation,
  planPath: string,
): Promise<DeploymentToolRun> {
  const started = Date.now()
  const { command, args } = deploymentToolArgv(tool, op, planPath)
  const stdout = new OutputBuffer()
  const stderr = new OutputBuffer()
  const child = spawn(command, args, {
    cwd: dirname(tool.path),
    env: deploymentToolEnv(tool),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, tool.timeoutSeconds * 1000)
  child.stdout.on('data', (chunk: Buffer) => {
    stdout.append(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.append(chunk)
  })
  const exitCode = await new Promise<number>((resolve) => {
    child.on('error', () => {
      resolve(-1)
    })
    child.on('close', (code) => {
      resolve(code ?? -1)
    })
  })
  clearTimeout(timer)
  return {
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    timedOut,
    truncated: stdout.truncated || stderr.truncated,
    sha256: deploymentToolDigest(tool.path).sha256,
    durationMs: Date.now() - started,
  }
}
