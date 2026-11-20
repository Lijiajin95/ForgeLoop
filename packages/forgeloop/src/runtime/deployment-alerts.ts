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
