import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'

/**
 * 需求详情中受控提交信息的只读界面展示：
 * 在没有浏览器的情况下执行 client.js，直接渲染 RequirementDetail 组件，覆盖
 * - 非空提交信息显示原文；
 * - 空串/纯空白提交信息显示“无提交信息”，且不出现“—”；
 * - 没有提交记录时仍保持空态；
 * - 提交证据块不出现批准、推进、验收等写动作。
 * 除直接渲染固定详情数据外，最后一条用例通过 requirementDetail 验证
 * 服务端组装与客户端展示的衔接。
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
    const children = value.children.length <= 1 ? value.children[0] : value.children
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

/** 证据块必须只读：不允许出现输入框、下拉框或可编辑区域。 */
function editableIn(node: unknown): VNode[] {
  const found: VNode[] = []
  walk(node, (current) => {
    if (
      typeof current.type === 'string' &&
      ['input', 'textarea', 'select'].includes(current.type)
    ) {
      found.push(current)
    }
    if (current.props.contentEditable === true || current.props.contentEditable === 'true') {
      found.push(current)
    }
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
    reqId: 'req-commit-message-view',
    versions: [
      {
        version: 1,
        text: '需求原文：展示受控提交信息',
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

/** 受控提交证据的固定身份字段；各用例只替换 commitMessage 或整条记录。 */
function commitEvidence(commitMessage: string): Record<string, unknown> {
  return {
    commitSha: 'commit-message-1234',
    commitMessage,
    files: ['packages/forgeloop/client.js'],
    committedAt: '2026-10-31T02:00:00.000Z',
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

function commitBlock(data: DetailData): VNode {
  const page = renderDetail(data)
  const block = findByAttr(page, 'data-evidence', 'commit')
  if (!block) throw new Error('需求详情没有渲染受控提交证据块')
  return block
}

/** 证据块只读：没有按钮、可编辑控件，也没有批准/推进/验收动作文案。 */
function expectReadOnlyEvidence(block: VNode): void {
  expect(buttonsIn(block)).toEqual([])
  expect(editableIn(block)).toEqual([])
  expect(textOf(block)).not.toMatch(/批准|推进|验收|approve|advance|accept/i)
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

describe('requirement detail commit message view', () => {
  it('renders the original text for a non-empty commit message', () => {
    const block = commitBlock(detailData({ commit: commitEvidence('feat: 保留提交原文') }))
    const text = textOf(block)

    expect(text).toContain('提交信息: feat: 保留提交原文')
    expect(text).not.toContain('无提交信息')
    expectReadOnlyEvidence(block)
  })

  it('renders 无提交信息 for an empty or whitespace-only commit message without a dash', () => {
    for (const commitMessage of ['', ' \n\t ']) {
      const block = commitBlock(detailData({ commit: commitEvidence(commitMessage) }))
      const text = textOf(block)

      expect(text).toContain('提交信息: 无提交信息')
      expect(text).not.toContain('—')
      expectReadOnlyEvidence(block)
    }
  })

  it('keeps the null empty state when there is no controlled commit record', () => {
    const page = renderDetail(detailData({ commit: null }))
    const empty = findByAttr(page, 'data-evidence-empty', 'commit')!
    const block = findByAttr(page, 'data-evidence', 'commit')!

    expect(textOf(empty)).toBe('没有受控提交记录')
    expect(textOf(block)).not.toContain('提交信息')
    expect(textOf(block)).not.toContain('无提交信息')
    expectReadOnlyEvidence(block)
  })

  it('verifies the assembled detail and read-only rendering end to end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeloop-commit-message-verify-'))
    const config = resolveConfig(
      {
        project: 'testproj',
        projectPath: dir,
        recordsRoot: join(dir, '.forgeloop'),
        pollSeconds: 1,
        agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
        formalTestTimeoutSeconds: 30,
        maxTaskAttempts: 2,
      },
      dir,
    )
    const runtime = new ForgeLoopRuntime({ ctx: {}, config })
    try {
      const submitted = runtime.submit({
        text: '验证提交信息展示',
        by: 'owner',
        source: 'test',
      })
      expect(submitted.ok, submitted.message).toBe(true)
      const reqId = (submitted.data as { reqId: string }).reqId
      const record = (candidateSha256: string, commitMessage: string, committedAt: string): void => {
        runtime.repo.recordCommit({
          requirementId: reqId,
          planVersion: 1,
          candidateSha256,
          commitSha: candidateSha256,
          commitMessage,
          checkCommand: ['npm', 'run', 'check'],
          checkLogPath: join(dir, `${candidateSha256}.log`),
          checkSha256: `check-${candidateSha256}`,
          files: ['packages/forgeloop/client.js'],
          committedAt,
        })
      }

      record('candidate-assembled-empty', '', '2026-10-31T01:00:00.000Z')
      const emptyResult = runtime.requirementDetail(reqId)
      expect(emptyResult.ok, emptyResult.message).toBe(true)
      expect(
        (emptyResult.data as { commit: { commitMessage: string } }).commit.commitMessage,
      ).toBe('无提交信息')
      const emptyBlock = commitBlock(emptyResult.data as unknown as DetailData)
      expect(textOf(emptyBlock)).toContain('提交信息: 无提交信息')
      expect(textOf(emptyBlock)).not.toContain('—')
      expectReadOnlyEvidence(emptyBlock)

      record('candidate-assembled-original', 'feat: 组装后的提交原文', '2026-10-31T02:00:00.000Z')
      const originalResult = runtime.requirementDetail(reqId)
      expect(originalResult.ok, originalResult.message).toBe(true)
      const originalBlock = commitBlock(originalResult.data as unknown as DetailData)
      expect(textOf(originalBlock)).toContain('提交信息: feat: 组装后的提交原文')
      expect(textOf(originalBlock)).not.toContain('无提交信息')
      expectReadOnlyEvidence(originalBlock)

      const old = runtime.submit({
        text: '没有受控提交记录的旧需求',
        by: 'owner',
        source: 'test',
      })
      expect(old.ok, old.message).toBe(true)
      const oldId = (old.data as { reqId: string }).reqId
      const oldResult = runtime.requirementDetail(oldId)
      expect(oldResult.ok, oldResult.message).toBe(true)
      expect((oldResult.data as { commit: unknown }).commit).toBeNull()
      const oldPage = renderDetail(oldResult.data as unknown as DetailData)
      const oldEmpty = findByAttr(oldPage, 'data-evidence-empty', 'commit')!
      const oldBlock = findByAttr(oldPage, 'data-evidence', 'commit')!
      expect(textOf(oldEmpty)).toBe('没有受控提交记录')
      expect(textOf(oldBlock)).not.toContain('提交信息')
      expectReadOnlyEvidence(oldBlock)
    } finally {
      runtime.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
