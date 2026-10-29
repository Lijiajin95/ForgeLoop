/**
 * 模型工具：只读查询 + 需求受理（数据入口）。
 * 批准、验收、推进、停止、追加授权不在工具里暴露——这些动作只从人类命令入口进入，
 * 模型不能通过工具参数自证 owner 或 approved。
 */

import { randomUUID } from 'node:crypto'
import type { ForgeLoopRuntime } from './runtime/service.js'
import type { ForgeLoopConfig } from './config.js'

type AnyRecord = Record<string, unknown>

interface ToolSchemaNode {
  type?: string
  properties?: Record<string, ToolSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  description?: string
  items?: ToolSchemaNode
}

interface ToolDefinitionLike {
  name: string
  description: string
  parameters: AnyRecord
  output: { schema: ToolSchemaNode; render(args: unknown, value: unknown): unknown[] }
  execute(args: unknown, exec: AnyRecord): Promise<unknown>
}

function textBlocks(value: unknown): unknown[] {
  const payload = value as { text?: unknown; ok?: unknown; data?: unknown }
  const head = typeof payload?.text === 'string' ? payload.text : JSON.stringify(value)
  const structured = JSON.stringify({ ok: payload?.ok ?? null, data: payload?.data ?? null }, null, 2)
  return [{ type: 'text', text: `${head}\n\n\`\`\`json\n${structured}\n\`\`\`` }]
}

function defineTool(input: {
  name: string
  description: string
  parameters: AnyRecord
  run(args: AnyRecord): Promise<{ ok: boolean; text: string; data?: unknown }>
}): ToolDefinitionLike {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          data: { type: 'object' },
        },
        required: ['ok', 'text'],
        additionalProperties: true,
      },
      render: (_args, value) => textBlocks(value),
    },
    // 工具永远不因模型自述而改变授权；只读与受理都不消耗授权额度。
    async execute(rawArgs) {
      const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as AnyRecord
      const result = await input.run(args)
      return { ok: result.ok, text: result.text, ...(result.data === undefined ? {} : { data: result.data }) }
    },
  }
}

function stringArg(args: AnyRecord, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function buildTools(runtime: ForgeLoopRuntime, config: ForgeLoopConfig): ToolDefinitionLike[] {
  return [
    defineTool({
      name: 'forgeloop_status',
      description:
        'Read ForgeLoop requirements and their status. Optionally pass req_id for one requirement. Read-only.',
      parameters: {
        type: 'object',
        properties: { req_id: { type: 'string', description: 'Exact requirement id, e.g. req-20261022...' } },
        additionalProperties: false,
      },
      async run(args) {
        const reqId = stringArg(args, 'req_id')
        const outcome = runtime.status(reqId)
        return { ok: outcome.ok, text: outcome.message, data: outcome.data }
      },
    }),
    defineTool({
      name: 'forgeloop_show_requirement',
      description:
        'Read one ForgeLoop requirement: all versions, latest analysis, plans, approval, delivered tasks and pending requests. Read-only.',
      parameters: {
        type: 'object',
        properties: { req_id: { type: 'string' } },
        required: ['req_id'],
        additionalProperties: false,
      },
      async run(args) {
        const reqId = stringArg(args, 'req_id')
        if (!reqId) return { ok: false, text: 'req_id is required' }
        const outcome = runtime.status(reqId)
        return { ok: outcome.ok, text: outcome.message, data: outcome.data }
      },
    }),
    defineTool({
      name: 'forgeloop_show_plan',
      description:
        'Read the approved/latest task plan of a requirement, including dependency order and authorization state. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          req_id: { type: 'string' },
          plan_version: { type: 'number', description: 'Exact plan version; omit for latest' },
        },
        required: ['req_id'],
        additionalProperties: false,
      },
      async run(args) {
        const reqId = stringArg(args, 'req_id')
        if (!reqId) return { ok: false, text: 'req_id is required' }
        const version = typeof args.plan_version === 'number' ? args.plan_version : undefined
        const outcome = runtime.showPlan(reqId, version)
        return { ok: outcome.ok, text: outcome.message, data: outcome.data }
      },
    }),
    defineTool({
      name: 'forgeloop_evidence',
      description:
        'Read delivery evidence for a requirement: candidate diff digest, formal test log digest, independent review digest, authorization source and file paths. Read-only.',
      parameters: {
        type: 'object',
        properties: { req_id: { type: 'string' } },
        required: ['req_id'],
        additionalProperties: false,
      },
      async run(args) {
        const reqId = stringArg(args, 'req_id')
        if (!reqId) return { ok: false, text: 'req_id is required' }
        const outcome = runtime.evidence(reqId)
        return { ok: outcome.ok, text: outcome.message, data: outcome.data }
      },
    }),
    defineTool({
      name: 'forgeloop_requests',
      description:
        'Read durable ForgeLoop operation requests (pending/claimed/done/failed/unknown) for a requirement or the whole project. Read-only.',
      parameters: {
        type: 'object',
        properties: { req_id: { type: 'string' } },
        additionalProperties: false,
      },
      async run(args) {
        const reqId = stringArg(args, 'req_id')
        const outcome = runtime.listRequests(reqId)
        return { ok: outcome.ok, text: outcome.message, data: outcome.data }
      },
    }),
    defineTool({
      name: 'forgeloop_impact',
      description:
        'Read the deterministic revision impact summary for a requirement: all requirement versions, analyses and plans with their basis versions, tasks, current approval binding, delivery materials, stale/pending marks and unknown requests. Set explain=true only when the user explicitly asks for model inference; inference is separated from facts and marked as inference. Read-only; never approves, advances or accepts.',
      parameters: {
        type: 'object',
        properties: {
          req_id: { type: 'string', description: 'Exact requirement id, e.g. req-20261022...' },
          explain: {
            type: 'boolean',
            description: 'Request optional model inference; defaults to false and calls no model',
          },
        },
        required: ['req_id'],
        additionalProperties: false,
      },
      async run(args) {
        const reqId = stringArg(args, 'req_id')
        if (!reqId) return { ok: false, text: 'req_id is required' }
        const outcome = await runtime.impact(reqId, { explain: args.explain === true })
        return { ok: outcome.ok, text: outcome.message, data: outcome.data }
      },
    }),
    defineTool({
      name: 'forgeloop_ops',
      description:
        'Read ForgeLoop operations events, diagnoses, registered recovery attempts and statistics. Pass event_id for one event. Read-only; never executes a check, action or decision.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'Exact ops event id, e.g. ops-20261029...' },
        },
        additionalProperties: false,
      },
      async run(args) {
        const eventId = stringArg(args, 'event_id')
        const outcome = runtime.opsStatus(eventId)
        return { ok: outcome.ok, text: outcome.message, data: outcome.data }
      },
    }),
    defineTool({
      name: 'forgeloop_submit_requirement',
      description:
        'Submit a new ForgeLoop requirement as durable intake (version 1). This records a work item only; it does not approve, execute or accept anything. Use client_key to make retries idempotent.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Full requirement text with scope and acceptance expectations' },
          client_key: { type: 'string', description: 'Optional idempotency key for retrying the same submission' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async run(args) {
        const text = stringArg(args, 'text')
        if (!text) return { ok: false, text: 'text is required' }
        const clientKey = stringArg(args, 'client_key') ?? `tool-${randomUUID()}`
        const outcome = runtime.submit({
          text,
          by: `agent:${config.owner}`,
          source: 'dsh-tool:submit_requirement',
          clientKey,
        })
        return { ok: outcome.ok, text: outcome.message, data: outcome.data }
      },
    }),
  ]
}

export function registerTools(
  tools: { register(definition: unknown): () => void },
  definitions: readonly ToolDefinitionLike[],
): Array<() => void> {
  return definitions.map((definition) => tools.register(definition))
}