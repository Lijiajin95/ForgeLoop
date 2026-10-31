import { beforeAll, describe, expect, it } from 'vitest'

/**
 * 需求详情页的准入/提交证据展示：
 * 在没有浏览器的情况下执行 client.js，直接渲染 RequirementDetail 组件，
 * 确认两组只读证据（含空态）真实出现在页面结构中，且证据块内没有任何操作按钮。
 * 这里不启动 DSH，也不访问网络。
 */

interface VNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

interface Registered {
  id: string
}

interface ClientExports {
  name: string
  inject: string[]
  apply: (ctx: unknown) => void
  __components: { RequirementDetail: (props: Record<string, unknown>) => unknown }
}

const dictionaries = new Map<string, Record<string, Record<string, string>>>()
let exportsValue: ClientExports
let registered: Registered
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

/** 递归展开函数组件，得到只有原生元素的渲染树。 */
function renderVNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renderVNode)
  if (!isVNode(value)) return value
  if (typeof value.type === 'function') {
    const children =
      value.children.length <= 1 ? value.children[0] : value.children
    const rendered = (value.type as (props: Record<string, unknown>) => unknown)({
      ...value.props,
      children,
    })
    return renderVNode(rendered)
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

function findByAttr(root: unknown, attribute: string, value: string): VNode | null {
  let found: VNode | null = null
  walk(root, (node) => {
    if (!found && node.props[attribute] === value) found = node
  })
  return found
}

function buttonsIn(node: unknown): VNode[] {
  const found: VNode[] = []
  walk(node, (current) => {
    if (current.type === 'button') found.push(current)
  })
  return found
}

interface DetailData {
  reqId: string
  versions: Array<{ version: number; text: string; createdAt: string; revisedBy: string }>
  analysis: null
  latestPlan: null
  artifacts: unknown[]
  failureRoundDetails: unknown[]
  pendingRequests: unknown[]
  progress: { total: number; delivered: number; failed: number; running: number; awaitingInput: number }
  acceptanceRecord: null
  planReview: null
  verification: null
  admission?: unknown
  commit?: unknown
}

function detailData(overrides: Partial<DetailData> = {}): DetailData {
  return {
    reqId: 'req-evidence-view',
    versions: [
      {
        version: 1,
        text: '需求原文：展示准入与提交证据',
        createdAt: '2026-10-31T00:00:00.000Z',
        revisedBy: 'owner',
      },
    ],
    analysis: null,
    latestPlan: null,
    artifacts: [],
    failureRoundDetails: [],
    pendingRequests: [],
    progress: { total: 0, delivered: 0, failed: 0, running: 0, awaitingInput: 0 },
    acceptanceRecord: null,
    planReview: null,
    verification: null,
    ...overrides,
  }
}

function renderDetail(data: DetailData): VNode {
  const Component = exportsValue.__components.RequirementDetail
  const rendered = renderVNode({
    type: Component,
    props: {
      t,
      detail: { phase: 'ready', reqId: data.reqId, data, error: '' },
      tasks: [],
      onOpenTask: () => {},
    },
    children: [],
  })
  if (!isVNode(rendered)) throw new Error('RequirementDetail 没有渲染出元素')
  return rendered
}

beforeAll(async () => {
  ;(globalThis as { window?: unknown }).window = {
    __ModuleLoader__: {
      load(options: { id: string; factory: (require: (name: string) => unknown) => ClientExports }) {
        exportsValue = options.factory((name) => {
          if (name === 'react') return fakeReact
          throw new Error(`client.js 只允许 require('react')，收到 ${name}`)
        })
        registered = { id: options.id }
      },
    },
  }
  await import('../client.js')
  expect(registered.id).toBe('forgeloop-dsh')

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

describe('requirement detail evidence view', () => {
  it('renders the latest admission and controlled commit as read-only evidence', () => {
    const data = detailData({
      admission: {
        decision: 'admit',
        code: 'admitted',
        reason: '可信来源与需求说明齐备',
        createdAt: '2026-10-31T01:00:00.000Z',
      },
      commit: {
        commitSha: 'abcdef1234567890',
        files: ['packages/forgeloop/src/a.ts', 'packages/forgeloop/src/b.ts'],
        committedAt: '2026-10-31T02:00:00.000Z',
      },
    })

    const page = renderDetail(data)
    const admissionBlock = findByAttr(page, 'data-evidence', 'admission')!
    const commitBlock = findByAttr(page, 'data-evidence', 'commit')!
    expect(admissionBlock).not.toBeNull()
    expect(commitBlock).not.toBeNull()

    const admissionText = textOf(admissionBlock)
    expect(admissionText).toContain('最近一次系统准入')
    expect(admissionText).toContain('准入通过')
    expect(admissionText).toContain('admit')
    expect(admissionText).toContain('admitted')
    expect(admissionText).toContain('可信来源与需求说明齐备')
    expect(admissionText).toContain(new Date('2026-10-31T01:00:00.000Z').toLocaleString())

    const commitText = textOf(commitBlock)
    expect(commitText).toContain('最近一次受控提交')
    expect(commitText).toContain('abcdef1234567890')
    expect(commitText).toContain('packages/forgeloop/src/a.ts')
    expect(commitText).toContain('packages/forgeloop/src/b.ts')
    expect(commitText).toContain(new Date('2026-10-31T02:00:00.000Z').toLocaleString())

    expect(textOf(page)).toContain('系统准入与受控提交')
    // 证据块只读：没有按钮，也没有批准/推进/验收等动作文案。
    for (const block of [admissionBlock, commitBlock]) {
      expect(buttonsIn(block)).toEqual([])
      expect(textOf(block)).not.toMatch(/批准|推进|验收|approve|advance|accept/i)
    }
  })

  it('renders empty placeholders for an old requirement without evidence and keeps other details', () => {
    const page = renderDetail(detailData({ admission: null, commit: null }))

    const admissionEmpty = findByAttr(page, 'data-evidence-empty', 'admission')!
    const commitEmpty = findByAttr(page, 'data-evidence-empty', 'commit')!
    expect(textOf(admissionEmpty)).toBe('没有系统准入记录')
    expect(textOf(commitEmpty)).toBe('没有受控提交记录')

    const pageText = textOf(page)
    expect(pageText).toContain('需求原文：展示准入与提交证据')
    expect(pageText).toContain('尚未分析')
    expect(pageText).toContain('交付进度与验收依据')

    const admissionBlock = findByAttr(page, 'data-evidence', 'admission')!
    const commitBlock = findByAttr(page, 'data-evidence', 'commit')!
    expect(buttonsIn(admissionBlock)).toEqual([])
    expect(buttonsIn(commitBlock)).toEqual([])
  })

  it('treats a missing evidence field as empty instead of failing to render', () => {
    const data = detailData()
    delete (data as { admission?: unknown }).admission
    delete (data as { commit?: unknown }).commit

    const page = renderDetail(data)

    expect(textOf(findByAttr(page, 'data-evidence-empty', 'admission')!)).toBe('没有系统准入记录')
    expect(textOf(findByAttr(page, 'data-evidence-empty', 'commit')!)).toBe('没有受控提交记录')
    expect(textOf(page)).toContain('需求原文：展示准入与提交证据')
  })
})
