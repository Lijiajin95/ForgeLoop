import { beforeAll, describe, expect, it } from 'vitest'

/**
 * 客户端注册测试：在没有浏览器的情况下执行 `client.js` 的模块体与 apply，
 * 验证它向 `conversation.view` 注册了正确的槽位身份与顺序。
 * 这里不渲染 React 组件（浏览器负责），只固定页面入口这一层契约，
 * 避免重启宿主后才发现标签没有注册。
 */

interface Registered {
  id: string
  exports: {
    name?: string
    inject: string[]
    apply: (ctx: unknown) => void
  }
}

interface SlotRegistration {
  name: string
  key?: string
  id?: string
  order?: number
  locale: string
  label?: () => string
  component: (props: unknown) => unknown
}

interface ConversationDefinition {
  kind: string
  target: string
  match(event: { type: string; seq: number; data: Record<string, unknown> }): { id: string; role: string } | null
  start(context: unknown, match: { event: unknown }): unknown
  buildViewNode(context: unknown): unknown
}

const dictionaries = new Map<string, Record<string, Record<string, string>>>()
const registrations: SlotRegistration[] = []
const definitions: ConversationDefinition[] = []
let registered: Registered

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(params, key) ? String(params[key]) : match,
  )
}

const fakeReact = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (callback: () => unknown) => callback,
  useRef: () => ({ current: null }),
}

beforeAll(async () => {
  ;(globalThis as { window?: unknown }).window = {
    __ModuleLoader__: {
      load(options: { id: string; factory: (require: (name: string) => unknown) => Registered['exports'] }) {
        registered = { id: options.id, exports: options.factory((name) => {
          if (name === 'react') return fakeReact
          throw new Error(`client.js 只允许 require('react')，收到 ${name}`)
        }) }
      },
    },
  }
  await import('../client.js')

  const ctx = {
    effect: (callback: () => () => void) => {
      callback()
      return () => {}
    },
    locale: {
      register: (namespace: string, dicts: Record<string, Record<string, string>>) => {
        dictionaries.set(namespace, dicts)
        return () => {}
      },
      bind: (namespace: string) => {
        const dicts = dictionaries.get(namespace)
        return (key: string, params?: Record<string, unknown>) =>
          interpolate(dicts?.zh?.[key] ?? key, params)
      },
    },
    slots: {
      inject: (_key: string, callback: () => unknown) => {
        callback()
        return () => {}
      },
      register: (options: SlotRegistration, component: (props: unknown) => unknown) => {
        registrations.push({ ...options, component })
        return () => {}
      },
    },
    uiConversation: {
      events: {
        register: (definition: ConversationDefinition) => {
          definitions.push(definition)
          return () => {}
        },
      },
    },
  }
  registered.exports.apply(ctx)
})

describe('client conversation view', () => {
  it('loads as a dsh client module for the forgeloop package', () => {
    expect(registered.id).toBe('forgeloop-dsh')
    expect(registered.exports.inject).toEqual(['slots', 'locale', 'uiConversation'])
    expect(typeof registered.exports.apply).toBe('function')
  })

  it('registers the 天工 view beside 对话 and 轨迹', () => {
    const view = registrations.find((entry) => entry.name === 'conversation.view')
    expect(view).toBeDefined()
    expect(view!.id).toBe('forgeloop')
    expect(view!.order).toBe(20)
    expect(view!.locale).toBe('forgeloop-board')
    expect(view!.label()).toBe('天工')
    expect(typeof view!.component).toBe('function')
  })

  it('does not register a workflow selector in the composer tool row', () => {
    const control = registrations.find((entry) => entry.name === 'conversation.input.left')
    expect(control).toBeUndefined()
    expect(registrations.map((entry) => entry.id)).not.toContain('forgeloop-mode')
  })

  it('registers custom chat nodes for ForgeLoop intake, analysis and errors', () => {
    const nodes = registrations.filter((entry) => entry.name === 'conversation.chat.node')
    expect(nodes.map((entry) => entry.key).sort()).toEqual([
      'forgeloop-analysis',
      'forgeloop-answer',
      'forgeloop-clarification',
      'forgeloop-error',
      'forgeloop-intake',
      'forgeloop-plan',
    ])
    expect(nodes.every((entry) => typeof entry.component === 'function')).toBe(true)
    expect(definitions.map((definition) => definition.kind).sort()).toEqual([
      'forgeloop-analysis',
      'forgeloop-answer',
      'forgeloop-clarification',
      'forgeloop-error',
      'forgeloop-intake',
      'forgeloop-plan',
    ])
    expect(definitions.every((definition) => definition.target === 'chat')).toBe(true)
    const tail = registrations.find((entry) => entry.name === 'conversation.chat.turnTail')
    expect(tail).toMatchObject({ id: 'forgeloop-requirements', order: 80, locale: 'forgeloop-board' })
    expect(typeof tail!.component).toBe('function')
  })

  it('folds ForgeLoop intake and analysis events into chat nodes', () => {
    const intake = definitions.find((definition) => definition.kind === 'forgeloop-intake')!
    const analysis = definitions.find((definition) => definition.kind === 'forgeloop-analysis')!
    const intakeEvent = {
      type: 'plugin:forgeloop/intake',
      seq: 3,
      data: { eventId: 'forgeloop:intake:s:m', reqId: 'req-1', text: '加过滤' },
    }
    expect(intake.match(intakeEvent)).toEqual({ id: 'forgeloop:intake:s:m', role: 'start' })
    expect(intake.match({ type: 'plugin:forgeloop/analysis', seq: 4, data: {} })).toBeNull()

    const node = intake.buildViewNode({
      key: 'forgeloop-intake:forgeloop:intake:s:m',
      id: 'forgeloop:intake:s:m',
      start: { event: intakeEvent, location: { kind: 'turn', turn: {} } },
      state: intakeEvent.data,
    }) as { kind: string; data: Record<string, unknown>; visibility: string }
    expect(node.kind).toBe('forgeloop-intake')
    expect(node.visibility).toBe('visible')
    expect(node.data.text).toBe('加过滤')

    const analysisEvent = {
      type: 'plugin:forgeloop/analysis',
      seq: 4,
      data: { eventId: 'forgeloop:analysis:req-1:v1', reqId: 'req-1', goal: '目标', scenarios: ['场景'] },
    }
    expect(analysis.match(analysisEvent)).toEqual({ id: 'forgeloop:analysis:req-1:v1', role: 'start' })
  })

  it('ships both locales for every visible label', () => {
    const dicts = dictionaries.get('forgeloop-board')
    expect(dicts).toBeDefined()
    expect(Object.keys(dicts!.zh).sort()).toEqual(Object.keys(dicts!.en).sort())
    expect(dicts!.zh['view.label']).toBe('天工')
    expect(dicts!.en['view.label']).toBe('Forge')
  })

  it('ships failure-reason, solution and retry labels for failed task cards', () => {
    const dicts = dictionaries.get('forgeloop-board')
    expect(dicts!.zh['task.failureReason']).toBe('失败原因')
    expect(dicts!.zh['task.solution']).toBe('解决方案')
    expect(dicts!.zh['task.retry']).toBe('重试任务')
    expect(dicts!.en['task.failureReason']).toBe('Failure reason')
    expect(dicts!.en['task.retry']).toBe('Retry task')
  })

  it('has no unknown-state labels left in either locale', () => {
    const dicts = dictionaries.get('forgeloop-board')
    const removed = [
      'status.unknown',
      'task.retryConfirm',
      'task.retryRecoveryHint',
      'requirement.unknownCount',
      'detail.unknownRequest',
      'overview.next.unknown',
      'ops.unknown',
      'ops.state.unknown',
      'ops.confirmUnknown',
      'ops.unknownConfirm',
    ]
    for (const key of removed) {
      expect(dicts!.zh[key], key).toBeUndefined()
      expect(dicts!.en[key], key).toBeUndefined()
    }
  })
})
