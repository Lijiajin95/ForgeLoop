/**
 * DSH Web 的测试侧 RPC 与工作区会话辅助。
 *
 * 浏览器连接把同名 Remote 暴露在 `/api/<namespace>/<method>`；请求体是
 * `{ type: 'client-request', rpcId, method, payload: { args } }`。这里只实现
 * 验收脚本需要的四个动作：建工作区、建会话、发消息、读看板。
 */
import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from 'playwright-core'

interface RpcEnvelope {
  readonly type: 'server-response'
  readonly rpcId: string
  readonly result?:
    | { readonly ok: true; readonly value?: unknown }
    | {
        readonly ok: false
        readonly error?: { readonly code?: unknown; readonly message?: unknown }
      }
}

/** 调用一个 Remote；失败时抛出带 code 的错误，不把 HTTP 200 当成功。 */
export async function webRpc(
  context: APIRequestContext,
  endpoint: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const rpcId = randomUUID()
  const response = await context.post(`/api/${endpoint}`, {
    data: {
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    },
  })
  const body = (await response.json()) as RpcEnvelope
  if (response.status() !== 200 || body.rpcId !== rpcId) {
    throw new Error(`RPC ${endpoint} 传输失败：HTTP ${response.status()}`)
  }
  if (body.result?.ok !== true) {
    const error = body.result?.error
    throw new Error(
      `RPC ${endpoint} 失败：${String(error?.code ?? 'unknown')} ${String(error?.message ?? '')}`,
    )
  }
  return body.result.value
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** 注册或复用工作区；返回稳定 id 与标题。 */
export async function ensureWorkspace(
  context: APIRequestContext,
  path: string,
): Promise<{ id: string; title: string }> {
  const value = recordOf(await webRpc(context, 'workspace/create', { request: { path } }))
  const workspace = recordOf(value.workspace)
  const id = typeof workspace.workspaceId === 'string' ? workspace.workspaceId : ''
  if (!id) throw new Error(`workspace/create 没有返回工作区 id：${JSON.stringify(value)}`)
  return { id, title: typeof workspace.title === 'string' ? workspace.title : path }
}

/** 在工作区内建会话；preset 省略时使用宿主默认 Agent。 */
export async function createWorkspaceSession(
  context: APIRequestContext,
  workspaceId: string,
  agentPreset?: string,
): Promise<string> {
  const request: Record<string, unknown> = { workspaceId }
  if (agentPreset) request.agentPreset = agentPreset
  const value = recordOf(await webRpc(context, 'session/create', { request }))
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
  if (!sessionId) throw new Error(`session/create 没有返回会话 id：${JSON.stringify(value)}`)
  return sessionId
}

/** 向会话投递一条用户文本；只确认入队，不等待回合结束。 */
export async function promptSession(
  context: APIRequestContext,
  sessionId: string,
  text: string,
): Promise<void> {
  await webRpc(context, 'session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
  })
}

/** 读看板；工作区模式必须带会话身份。 */
export async function readBoard(
  context: APIRequestContext,
  body: Record<string, unknown> & { sessionId: string },
): Promise<Record<string, unknown>> {
  const response = await context.post('/api/forgeloop/board', { data: body })
  const parsed = recordOf(await response.json())
  if (response.status() !== 200 || parsed.ok !== true) {
    const error = recordOf(parsed.error)
    throw new Error(
      `看板 ${String(body.endpoint)} 返回异常：HTTP ${response.status()} ${String(error.code ?? '')} ${String(error.message ?? '')}`,
    )
  }
  return recordOf(parsed.value)
}
