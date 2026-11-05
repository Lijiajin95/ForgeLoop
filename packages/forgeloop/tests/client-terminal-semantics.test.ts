import { beforeAll, describe, expect, it } from 'vitest'

/**
 * 天工页终态语义与运行身份显示的只读测试：
 * - committed 与服务端一样属于终态，“进行中”筛选不能把它算进去；
 * - 取消需求的任务不进入进度分母；
 * - 终态需求不再渲染历史门禁警告；
 * - 搜索范围提示使用实际请求上限；
 * - 页脚运行身份在缺失与不一致时给出明确文案。
 * 这里不启动浏览器，也不访问网络。
 */

interface VNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

interface ClientExports {
  name: string
  inject: string[]
  apply: (ctx: unknown) => void
  __components: {
    BuildStamp: (props: Record<string, unknown>) => unknown
  }
  __rules: {
    isTerminalStatus: (status: string) => boolean
    filterRequirements: (
      requirements: Array<{ reqId: string; status: string }>,
      filter: string,
      issues: Array<{ reqId: string }>,
    ) => Array<{ reqId: string; status: string }>
    tasksForProgress: (requirement: { status: string }, tasks: unknown[]) => unknown[]
    showsLegacyGateWarnings: (status: string) => boolean
    searchScopeText: (
      t: (key: string, params?: Record<string, unknown>) => string,
      limit?: number,
    ) => string
  }
}

const dictionaries = new Map<string, Record<string, Record<string, string>>>()
let exportsValue: ClientExports
let t: (key: string, params?: Record<string, unknown>) => string

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(params, key) ? String(params[key]) : match,
  )
}

function flatten(children: unknown[]): unknown[] {
  const result: unknown[] = []
  for (const child of children) {
    if (Array.isArray(child)) result.push(...flatten(child))
    else result.push(child)
  }
  return result
}

function createElement(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): VNode {
  return { type, props: props || {}, children: flatten(children) }
}

const fakeReact = {
  createElement,
  useState: (initial: unknown) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (callback: () => unknown) => callback,
  useRef: () => ({ current: null }),
  useMemo: (factory: () => unknown) => factory(),
}

function isVNode(value: unknown): value is VNode {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value
}

function renderVNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renderVNode)
  if (!isVNode(value)) return value
  if (typeof value.type === 'function') {
    const children = value.children.length <= 1 ? value.children[0] : value.children
    return renderVNode(
      (value.type as (props: Record<string, unknown>) => unknown)({
        ...value.props,
        children,
      }),
    )
  }
  return {
    type: value.type,
    props: value.props,
    children: value.children.map(renderVNode),
  }
}

function walk(node: unknown, visit: (node: VNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!isVNode(node)) return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

function textOf(node: unknown): string {
  let text = ''
  walk(node, (current) => {
    for (const child of current.children) {
      if (typeof child === 'string' || typeof child === 'number') text += String(child)
    }
  })
  return text
}

beforeAll(async () => {
  ;(globalThis as { window?: unknown }).window = {
    __ModuleLoader__: {
      load(options: {
        id: string
        factory: (require: (name: string) => unknown) => ClientExports
      }) {
        exportsValue = options.factory((name) => {
          if (name === 'react') return fakeReact
          throw new Error(`client.js 只允许 require('react')，收到 ${name}`)
        })
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
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (_key: string, callback: () => unknown) => {
        callback()
        return () => {}
      },
      register: () => () => {},
    },
    uiConversation: {
      events: {
        register: () => () => {},
      },
    },
  }
  exportsValue.apply(ctx)

  const dictionary = dictionaries.get('forgeloop-board')
  expect(dictionary).toBeDefined()
  t = (key, params) => interpolate(dictionary!.zh[key] ?? key, params)
})

describe('terminal semantics', () => {
  it('treats committed as terminal, matching the server status set', () => {
    const rules = exportsValue.__rules
    for (const status of ['committed', 'accepted', 'rejected', 'cancelled']) {
      expect(rules.isTerminalStatus(status), status).toBe(true)
    }
    for (const status of ['draft', 'specified', 'developing', 'verifying']) {
      expect(rules.isTerminalStatus(status), status).toBe(false)
    }
  })

  it('excludes drafts and all terminal states from the active filter', () => {
    const requirements = [
      { reqId: 'draft', status: 'draft' },
      { reqId: 'specified', status: 'specified' },
      { reqId: 'committed', status: 'committed' },
      { reqId: 'cancelled', status: 'cancelled' },
    ]
    const active = exportsValue.__rules.filterRequirements(requirements, 'active', [])
    expect(active.map((item) => item.reqId)).toEqual(['specified'])
  })

  it('keeps cancelled tasks out of the progress denominator', () => {
    const tasks = [{ taskId: 'a' }, { taskId: 'b' }]
    expect(exportsValue.__rules.tasksForProgress({ status: 'cancelled' }, tasks)).toEqual([])
    expect(exportsValue.__rules.tasksForProgress({ status: 'developing' }, tasks)).toEqual(tasks)
  })

  it('does not show legacy gate warnings on terminal requirements', () => {
    expect(exportsValue.__rules.showsLegacyGateWarnings('committed')).toBe(false)
    expect(exportsValue.__rules.showsLegacyGateWarnings('cancelled')).toBe(false)
    expect(exportsValue.__rules.showsLegacyGateWarnings('specified')).toBe(true)
  })
})

describe('search scope copy', () => {
  it('uses the actual board limit instead of a hard-coded 50', () => {
    const text = exportsValue.__rules.searchScopeText(t, 100)
    expect(text).toContain('最多显示 100 条')
    expect(text).not.toContain('50')
    const dictionary = dictionaries.get('forgeloop-board')!
    expect(dictionary.zh['overview.searchScope']).toContain('{limit}')
    expect(dictionary.en['overview.searchScope']).toContain('{limit}')
  })
})

describe('build stamp', () => {
  it('renders version, client digest and a source mismatch warning', () => {
    const page = renderVNode(
      exportsValue.__components.BuildStamp({
        t,
        build: {
          version: '0.0.2',
          startedAt: '2026-11-05T13:50:17.518Z',
          serverSha256: 'a'.repeat(64),
          clientSha256: 'b'.repeat(64),
          sourceClientSha256: 'c'.repeat(64),
          sourceMatches: false,
        },
      }),
    )
    const text = textOf(page)
    expect(text).toContain('运行 0.0.2')
    expect(text).toContain('bbbbbbbbbbbbbbbb…')
    expect(text).toContain('界面与源码不一致')
    expect(text).toContain('cccccccccccccccc…')
  })

  it('renders a clear missing state when the host has no identity', () => {
    const page = renderVNode(exportsValue.__components.BuildStamp({ t, build: null }))
    expect(textOf(page)).toBe('运行版本未记录')
  })
})
