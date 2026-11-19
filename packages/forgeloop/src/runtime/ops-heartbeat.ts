import { errorMessage } from '../domain/errors.js'
import { bestEffortAsync } from './best-effort.js'

const MAX_HEARTBEAT_ERROR = 300

export interface OpsHeartbeatInput {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly timeoutSeconds: number
  readonly project: string
  readonly at: Date
  readonly status: string
  readonly issues: number
  readonly signal?: AbortSignal
}

export interface OpsHeartbeatOutcome {
  readonly ok: boolean
  readonly status: number
  readonly error: string
}

function bounded(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ')
  return text.length > MAX_HEARTBEAT_ERROR ? `${text.slice(0, MAX_HEARTBEAT_ERROR)}…` : text
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'invalid-url'
  }
}

async function cancelBody(response: Response): Promise<void> {
  const body = response.body
  if (!body) return
  await bestEffortAsync(() => body.cancel())
}

/**
 * 上报一次心跳。地址为空表示关闭，调用方应在此之前跳过。
 * 返回结果只包含状态码与错误，不保存完整 URL，避免把凭据写进证据。
 */
export async function sendOpsHeartbeat(input: OpsHeartbeatInput): Promise<OpsHeartbeatOutcome> {
  const origin = originOf(input.url)
  const timeout = AbortSignal.timeout(input.timeoutSeconds * 1000)
  const body =
    input.method === 'POST'
      ? JSON.stringify({
          project: input.project,
          at: input.at.toISOString(),
          status: input.status,
          issues: input.issues,
        })
      : undefined
  try {
    const response = await fetch(input.url, {
      method: input.method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body } : {}),
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
    })
    await cancelBody(response)
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `心跳上报失败（${origin}）：HTTP ${response.status}`,
      }
    }
    return { ok: true, status: response.status, error: '' }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: `心跳上报失败（${origin}）：${bounded(errorMessage(error))}`,
    }
  }
}
