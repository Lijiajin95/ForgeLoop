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
    __test?: {
      nextDraft: (mode: string, previousMode: string, draft: string) => string | null
    }
  }
}

interface SlotRegistration {
  name: string
  id: string
  order: number
  locale: string
  label: () => string
  component: (props: unknown) => unknown
}

const dictionaries = new Map<string, Record<string, Record<string, string>>>()
const registrations: SlotRegistration[] = []
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
  }
  registered.exports.apply(ctx)
})

describe('client conversation view', () => {
  it('loads as a dsh client module for the forgeloop package', () => {
    expect(registered.id).toBe('forgeloop-dsh')
    expect(registered.exports.inject).toEqual(['slots', 'locale'])
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

  it('registers the workflow selector in the composer tool row', () => {
    const control = registrations.find((entry) => entry.name === 'conversation.input.left')
    expect(control).toBeDefined()
    expect(control!.id).toBe('forgeloop-mode')
    expect(control!.order).toBe(50)
    expect(control!.label()).toBe('工作流')
    expect(typeof control!.component).toBe('function')
  })

  it('routes composer drafts between DSH and ForgeLoop without clobbering typed commands', () => {
    const nextDraft = registered.exports.__test!.nextDraft
    expect(nextDraft('dsh', 'dsh', '')).toBeNull()
    expect(nextDraft('forgeloop', 'dsh', '')).toBe('/fl submit ')
    expect(nextDraft('forgeloop', 'dsh', '给看板加过滤')).toBe('/fl submit 给看板加过滤')
    expect(nextDraft('forgeloop', 'forgeloop', '继续输入')).toBeNull()
    expect(nextDraft('forgeloop', 'dsh', '/fl status')).toBeNull()
    expect(nextDraft('dsh', 'forgeloop', '/fl submit 给看板加过滤')).toBe('给看板加过滤')
    expect(nextDraft('dsh', 'forgeloop', '/fl status')).toBeNull()
  })

  it('ships both locales for every visible label', () => {
    const dicts = dictionaries.get('forgeloop-board')
    expect(dicts).toBeDefined()
    expect(Object.keys(dicts!.zh).sort()).toEqual(Object.keys(dicts!.en).sort())
    expect(dicts!.zh['view.label']).toBe('天工')
    expect(dicts!.en['view.label']).toBe('Forge')
  })
})
