/**
 * 部署告警：向登记的 webhook 尽力发送一次告警。
 *
 * 约束与部署工具一致：固定请求方法、有界超时、最多一次重试、不抛错、不进入部署判定。
 * 发送失败只返回错误摘要，不改变部署状态；调用方自行决定是否记录。
 */

export interface AlertSendResult {
  readonly ok: boolean
  readonly error: string
}

export type AlertFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>

const MAX_ATTEMPTS = 2

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.name === 'AbortError' ? '请求超时' : error.message
  return String(error)
}

/**
 * 发送告警：超时按 AbortController 截断，失败后最多重试一次（合计两次请求）。
 * 永不抛出；超时、网络错误与非 2xx 都作为失败摘要返回。
 */
export async function sendDeploymentAlert(
  url: string,
  body: Record<string, unknown>,
  timeoutSeconds: number,
  fetchImpl?: AlertFetch,
): Promise<AlertSendResult> {
  const doFetch: AlertFetch = fetchImpl ?? (async (url, init) => await globalThis.fetch(url, init))
  const payload = JSON.stringify(body)
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000
  let lastError = ''
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: controller.signal,
      })
      if (response.ok) return { ok: true, error: '' }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = errorMessage(error)
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: lastError || '告警发送失败' }
}
