/**
 * 运维事件的外部告警：只发送到所有者登记的 webhook，一次尝试、不重试。
 * 发送结果作为观测留档；失败不会回滚事件，也不会伪造“已通知”。
 */

import { errorMessage } from '../domain/errors.js'
import type { ForgeLoopConfig } from '../config.js'
import type { Repository } from '../records/repository.js'

const MAX_ALERT_ERROR = 300

export interface OpsAlertInput {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly now: Date
  readonly eventId: string
  readonly severity: string
  readonly title: string
  readonly impact: string
  readonly source: string
  readonly summary: string
  readonly signal?: AbortSignal
}

export interface OpsAlertOutcome {
  /** 只有 webhook 返回 2xx 才算已发送；未配置 webhook 时为 false 且不记观测。 */
  readonly sent: boolean
  readonly error: string
}

function bounded(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ')
  return text.length > MAX_ALERT_ERROR ? `${text.slice(0, MAX_ALERT_ERROR)}…` : text
}

function originOf(webhook: string): string {
  try {
    return new URL(webhook).origin
  } catch {
    return 'invalid-url'
  }
}

async function cancelBody(response: Response): Promise<void> {
  if (!response.body) return
  try {
    await response.body.cancel()
  } catch {
    // 告警结论只看状态码，不读响应体。
  }
}

function record(
  input: OpsAlertInput,
  kind: 'alert' | 'alert_error',
  summary: string,
  detail: Record<string, unknown>,
): void {
  const at = input.now.toISOString()
  input.repo.appendOpsObservation({
    eventId: input.eventId,
    at,
    kind,
    summary,
    detailJson: JSON.stringify(detail),
  })
  input.repo.updateOpsEvent(input.eventId, { updatedAt: at })
}

/**
 * 发送一次告警。webhook 为空时直接返回，不把“没有配置”写成发送失败。
 * 告警正文只包含事件事实，不包含 webhook URL 或凭据。
 */
export async function sendOpsAlert(input: OpsAlertInput): Promise<OpsAlertOutcome> {
  const webhook = input.config.ops.alerts.webhook
  if (!webhook) return { sent: false, error: '' }
  const origin = originOf(webhook)
  const timeout = AbortSignal.timeout(input.config.ops.alerts.timeoutSeconds * 1000)
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project: input.config.project,
        eventId: input.eventId,
        severity: input.severity,
        title: input.title,
        impact: input.impact,
        source: input.source,
        at: input.now.toISOString(),
        summary: input.summary,
      }),
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
    })
    await cancelBody(response)
    if (!response.ok) {
      const error = `告警发送失败（${origin}）：HTTP ${response.status}`
      record(input, 'alert_error', error, { origin, status: response.status, source: input.source })
      return { sent: false, error }
    }
    record(input, 'alert', `告警已发送到 ${origin}（HTTP ${response.status}）`, {
      origin,
      status: response.status,
      source: input.source,
    })
    return { sent: true, error: '' }
  } catch (error) {
    const message = bounded(errorMessage(error))
    const summary = `告警发送失败（${origin}）：${message}`
    record(input, 'alert_error', summary, { origin, source: input.source, error: message })
    return { sent: false, error: summary }
  }
}
