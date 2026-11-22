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
    attentionRows: (
      t: (key: string) => string,
      items: Array<{
        issueId: string
        reqId: string
        requirementTitle: string
        taskId?: string
        taskGoal: string
        severity: string
        priority: string
        title: string
        detail: string
      }>,
    ) => Array<{
      key: string
      priorityLabel: string
      reason: string
      target: string
      stage: string
      actionLabel: string
      reqId: string
      taskId: string
    }>

    verificationAnomaly: (detail: { data?: Record<string, unknown> | null }) => {
      blocking: string[]
      failureKind: string
      verifiedAt: string
    } | null
    verificationScenarioRows: (detail: { data?: Record<string, unknown> | null }) => Array<{
      name: string
      status: string
      evidence: string
    }>
    businessPointRows: (
      analysis: {
        businessPoints?: Array<{ id: string; behavior: string }>
        acceptanceItems?: Array<{ pointIds: readonly string[]; then: string; when: string }>
      } | null,
      planTasks: Array<{ taskId: string; covers?: readonly string[] }>,
    ) => {
      rows: Array<{ id: string; text: string; acceptance: string[]; covers: string[] }>
      unlinked: string[]
    }
    filterLibraryEntries: (
      entries: Array<{
        id: string
        title: string
        summary: string
        status: string
        topics?: readonly string[]
      }>,
      filter: { query?: string; status?: string; topic?: string },
    ) => Array<{ id: string }>
    libraryTopics: (entries: Array<{ topics?: readonly string[] }>) => string[]
    stageStatuses: (
      t: (key: string) => string,
      requirement: { status: string } | null,
      tasks: Array<{ state: string }>,
      detail: { phase: string; data?: Record<string, unknown> | null; error?: string },
    ) => {
      product: { tone: string; label: string }
      development: { tone: string; label: string }
      verification: { tone: string; label: string }
    }
    boardProjectLabel: (board: { project: string; workspace?: { title?: string } }) => string
    stageActionsFor: (actions: string[] | undefined, stage: string) => string[]
    STAGE_ACTIONS: Set<string>
    shouldRenderSessionTail: (
      preset: string | undefined,
      turn: number | undefined,
      latestTurn: number | null,
    ) => boolean
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
  it('shows the DSH workspace title instead of the tenant key', () => {
    const rules = exportsValue.__rules
    expect(
      rules.boardProjectLabel({ project: 'ws-2844648b', workspace: { title: 'ForgeLoop' } }),
    ).toBe('ForgeLoop')
    expect(rules.boardProjectLabel({ project: 'ws-2844648b', workspace: { title: '   ' } })).toBe(
      'ws-2844648b',
    )
    expect(rules.boardProjectLabel({ project: 'legacy' })).toBe('legacy')
  })

  it('renders the session requirement tail only on the latest turn', () => {
    const rules = exportsValue.__rules
    expect(rules.shouldRenderSessionTail('forgeloop', 3, 5)).toBe(false)
    expect(rules.shouldRenderSessionTail('forgeloop', 5, 5)).toBe(true)
    // 非 ForgeLoop 会话不显示。
    expect(rules.shouldRenderSessionTail('standard', 5, 5)).toBe(false)
    expect(rules.shouldRenderSessionTail(undefined, 5, 5)).toBe(false)
    // 轮次未知时保留显示，避免旧宿主或加载中把内容整体藏掉。
    expect(rules.shouldRenderSessionTail('forgeloop', 5, null)).toBe(true)
    expect(rules.shouldRenderSessionTail('forgeloop', undefined, 5)).toBe(true)
  })

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
          sourceMatches: 'mismatch',
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

describe('需要处理队列', () => {
  const items = [
    {
      issueId: 'i1',
      reqId: 'req-1',
      requirementTitle: '把可靠性标签页名称修改为度量',
      taskId: 't1',
      taskGoal: '更新页签显示名称',
      severity: 'blocking',
      priority: 'blocked',
      title: '测试方案生成失败',
      detail: '尚无可用测试结果',
    },
    {
      issueId: 'i2',
      reqId: 'req-2',
      requirementTitle: '周报统计范围',
      taskGoal: '',
      severity: 'attention',
      priority: 'input',
      title: '需明确统计范围',
      detail: '',
    },
  ]

  it('maps the server rows without re-aggregating or guessing', () => {
    const rows = exportsValue.__rules.attentionRows(t, items)
    expect(rows.map((row) => row.key)).toEqual(['i1', 'i2'])
    expect(rows.map((row) => row.priorityLabel)).toEqual(['阻塞', '待输入'])
    expect(rows[0]).toMatchObject({
      target: '更新页签显示名称',
      stage: '任务',
      actionLabel: '查看任务 ↗',
      reqId: 'req-1',
      taskId: 't1',
    })
    expect(rows[1]).toMatchObject({
      target: '周报统计范围',
      stage: '需求',
      actionLabel: '查看需求 ↗',
      reqId: 'req-2',
      taskId: '',
    })
  })

  it('falls back to the recorded identities when display text is missing', () => {
    const rows = exportsValue.__rules.attentionRows(t, [
      {
        issueId: 'i3',
        reqId: 'req-3',
        requirementTitle: '',
        taskId: 't9',
        taskGoal: '',
        severity: 'blocking',
        priority: 'blocked',
        title: '对象已消失',
        detail: '',
      },
    ])
    expect(rows[0]).toMatchObject({ target: 't9', stage: '任务' })
  })
})

describe('summary rail and quality verdict', () => {
  it('turns snapshot availability, gate and coverage failures into one verdict', () => {
    const rules = exportsValue.__rules
    expect(rules.reliabilityVerdict({ snapshot: { availability: 'missing' } })).toMatchObject({
      tone: 'idle',
      code: 'missing',
    })
    expect(
      rules.reliabilityVerdict({
        snapshot: {
          availability: 'fresh',
          gates: [{ status: 'fail' }, { status: 'pass' }],
          tests: { failed: 2 },
          coverage: { lines: 80, thresholds: { lines: 90 } },
        },
      }),
    ).toMatchObject({
      tone: 'error',
      code: 'failed',
      failedGates: 1,
      failedTests: 2,
      lowCoverage: 1,
    })
    expect(
      rules.reliabilityVerdict({
        snapshot: { availability: 'fresh', gates: [{ status: 'pass' }], tests: { failed: 0 } },
      }),
    ).toMatchObject({ tone: 'success', code: 'pass' })
    expect(
      rules.reliabilityVerdict({ snapshot: { availability: 'stale', gates: [] } }),
    ).toMatchObject({ tone: 'warn', code: 'stale' })
  })

  it('marks small samples as warning instead of pass or failure', () => {
    const rules = exportsValue.__rules
    expect(rules.reliabilityRateTone({ rate: 100, total: 3 }, 90)).toBe('warn')
    expect(rules.reliabilityRateTone({ rate: 100, total: 12 }, 90)).toBe('success')
    expect(rules.reliabilityRateTone({ rate: 60, total: 12 }, 90)).toBe('error')
    expect(rules.reliabilityRateTone(null, 90)).toBe('idle')
  })

  it('shortens requirement ids only for dense tree labels', () => {
    expect(exportsValue.__rules.shortReqId('req-20261031091537-a0b4bc')).toBe('…a0b4bc')
    expect(exportsValue.__rules.shortReqId('plain')).toBe('plain')
  })
})

describe('requirement focus', () => {
  it('summarizes the next action from status and available actions', () => {
    const focus = exportsValue.__rules.requirementFocus
    expect(focus(t, { status: 'committed', actions: ['deploy'] })).toMatchObject({
      tone: 'success',
      text: '可以核对上线',
    })
    expect(focus(t, { status: 'specified', actions: ['build'] })).toMatchObject({
      tone: 'brand',
      text: '可以构建候选安装包',
    })
    expect(focus(t, { status: 'blocked', actions: [] })).toMatchObject({ tone: 'error' })
    expect(focus(t, { status: 'cancelled', actions: [] })).toBeNull()
    expect(focus(t, { status: 'specified', actions: ['plan', 'cancel'] })).toMatchObject({
      tone: 'brand',
      text: '可生成任务包进入研发',
    })
    expect(focus(t, { status: 'plan_proposed', actions: ['approve', 'cancel'] })).toMatchObject({
      tone: 'brand',
      text: '任务包待批准',
    })
    expect(focus(t, { status: 'executing', actions: ['advance', 'stop', 'cancel'] })).toMatchObject(
      { tone: 'brand', text: '已批准，可执行任务' },
    )
    expect(focus(t, { status: 'executing', actions: ['verify', 'stop', 'cancel'] })).toMatchObject({
      tone: 'brand',
      text: '任务已交付，可运行验证',
    })
  })
})

describe('stage action buttons', () => {
  it('shows only the actions that belong to each stage column', () => {
    const rules = exportsValue.__rules
    expect(rules.stageActionsFor(['plan', 'cancel'], 'product')).toEqual(['plan'])
    expect(rules.stageActionsFor(['approve', 'advance', 'stop', 'cancel'], 'development')).toEqual([
      'approve',
      'advance',
    ])
    expect(rules.stageActionsFor(['verify', 'cancel'], 'verification')).toEqual(['verify'])
    expect(rules.stageActionsFor(['verify', 'plan', 'cancel', 'approve'], 'all')).toEqual([
      'plan',
      'approve',
      'verify',
    ])
    expect(rules.stageActionsFor(['plan'], 'development')).toEqual([])
    expect(rules.stageActionsFor(undefined, 'product')).toEqual([])
    expect(rules.STAGE_ACTIONS.has('advance')).toBe(true)
    expect(rules.STAGE_ACTIONS.has('cancel')).toBe(false)
  })
})

describe('按需求三列映射', () => {
  const analysis = {
    businessPoints: [
      { id: 'BP-1', behavior: '页签显示为「度量」' },
      { id: 'BP-2', behavior: '页面标题同步' },
    ],
    acceptanceItems: [
      { pointIds: ['BP-1'], then: '页签与无障碍名称一致', when: '' },
      { pointIds: [], then: '旧记录没有编号', when: '' },
    ],
  }
  const planTasks = [
    { taskId: 't1', covers: ['BP-1'] },
    { taskId: 't2', covers: ['BP-1', 'BP-2'] },
    { taskId: 't3' },
  ]

  it('groups acceptance under business points and keeps legacy items unlinked', () => {
    const rows = exportsValue.__rules.businessPointRows(analysis, planTasks)
    expect(rows.rows.map((row) => row.id)).toEqual(['BP-1', 'BP-2'])
    expect(rows.rows[0]).toMatchObject({
      text: '页签显示为「度量」',
      acceptance: ['页签与无障碍名称一致'],
      covers: ['t1', 't2'],
    })
    expect(rows.rows[1]?.covers).toEqual(['t2'])
    expect(rows.unlinked).toEqual(['旧记录没有编号'])
  })

  it('derives each stage status from recorded facts without guessing', () => {
    const rules = exportsValue.__rules
    const loading = rules.stageStatuses(t, { status: 'executing' }, [], { phase: 'loading' })
    expect(loading.product).toEqual({ tone: 'idle', label: '读取中…' })

    const ready = rules.stageStatuses(
      t,
      { status: 'executing' },
      [{ state: 'running' }, { state: 'delivered' }],
      {
        phase: 'ready',
        data: {
          analysis,
          analysisActivity: [],
          verification: { fresh: true, verdict: 'pass', candidateSha256: 'a' },
        },
      },
    )
    expect(ready.product).toEqual({ tone: 'success', label: '已形成说明' })
    expect(ready.development).toEqual({ tone: 'brand', label: '执行中' })
    expect(ready.verification).toEqual({ tone: 'success', label: '验证通过' })

    const failedAnalysis = rules.stageStatuses(t, { status: 'analysis_failed' }, [], {
      phase: 'ready',
      data: { analysis: null, analysisActivity: [{ outcome: 'failed' }] },
    })
    expect(failedAnalysis.product).toEqual({ tone: 'error', label: '分析失败' })

    const stale = rules.stageStatuses(t, { status: 'executing' }, [], {
      phase: 'ready',
      data: { verification: { fresh: false, verdict: 'pass', candidateSha256: 'a' } },
    })
    expect(stale.verification).toEqual({ tone: 'warn', label: '需重新验证' })

    const blocked = rules.stageStatuses(t, { status: 'blocked' }, [{ state: 'blocked' }], {
      phase: 'ready',
      data: { verification: { fresh: true, verdict: 'block', candidateSha256: 'a' } },
    })
    expect(blocked.development).toEqual({ tone: 'error', label: '阻塞' })
    expect(blocked.verification).toEqual({ tone: 'error', label: '验证未通过' })

    const cancelled = rules.stageStatuses(t, { status: 'cancelled' }, [], {
      phase: 'ready',
      data: {},
    })
    expect(cancelled.development.label).toBe('已取消')
    expect(cancelled.verification.label).toBe('尚无结论')
  })

  it('reports a verification anomaly only when it is not the current candidate', () => {
    const rules = exportsValue.__rules
    expect(
      rules.verificationAnomaly({
        data: {
          verification: { candidateSha256: 'a' },
          verificationActivity: [{ candidateSha256: 'a' }],
        },
      }),
    ).toBeNull()
    expect(
      rules.verificationAnomaly({
        data: {
          verification: { candidateSha256: 'a' },
          verificationActivity: [
            {
              candidateSha256: 'b',
              blocking: ['测试方案生成失败'],
              failureKind: 'test_error',
              verifiedAt: '2026-11-18T08:00:00.000Z',
            },
          ],
        },
      }),
    ).toEqual({
      blocking: ['测试方案生成失败'],
      failureKind: 'test_error',
      verifiedAt: '2026-11-18T08:00:00.000Z',
    })
  })

  it('lists verification scenarios with their recorded status', () => {
    const rows = exportsValue.__rules.verificationScenarioRows({
      data: {
        verification: {
          scenarios: [
            { scenario: '核对名称', status: 'pass' },
            { scenario: '无障碍名称', status: 'fail', evidence: '断言失败' },
          ],
        },
      },
    })
    expect(rows).toEqual([
      { name: '核对名称', status: 'pass', evidence: '' },
      { name: '无障碍名称', status: 'fail', evidence: '断言失败' },
    ])
  })
})

describe('需求库筛选', () => {
  const entries = [
    {
      id: 'a',
      title: '工作台展示口径',
      summary: '同一名称用于页签与标题',
      status: 'confirmed',
      topics: ['工作台'],
    },
    {
      id: 'b',
      title: '候选交付条件',
      summary: '交付前核对候选身份',
      status: 'draft',
      topics: ['交付'],
    },
    {
      id: 'c',
      title: '旧口径',
      summary: '已被取代的说明',
      status: 'superseded',
      topics: ['工作台'],
    },
  ]

  it('shows current entries by default and recovers superseded ones by filter', () => {
    const rules = exportsValue.__rules
    expect(rules.filterLibraryEntries(entries, {}).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(rules.filterLibraryEntries(entries, { status: 'all' }).map((entry) => entry.id)).toEqual(
      ['a', 'b', 'c'],
    )
    expect(
      rules.filterLibraryEntries(entries, { status: 'superseded' }).map((entry) => entry.id),
    ).toEqual(['c'])
    expect(
      rules.filterLibraryEntries(entries, { status: 'all', topic: '工作台' }).map((e) => e.id),
    ).toEqual(['a', 'c'])
  })

  it('searches titles and summaries without inventing matches', () => {
    const rules = exportsValue.__rules
    expect(rules.filterLibraryEntries(entries, { query: '候选' }).map((entry) => entry.id)).toEqual(
      ['b'],
    )
    expect(rules.filterLibraryEntries(entries, { query: '页签' }).map((entry) => entry.id)).toEqual(
      ['a'],
    )
    expect(rules.filterLibraryEntries(entries, { query: '不存在' })).toEqual([])
  })

  it('derives the topic directory from the entries rather than a fixed list', () => {
    expect(exportsValue.__rules.libraryTopics(entries)).toEqual(['交付', '工作台'])
    expect(
      exportsValue.__rules.libraryTopics([{ topics: ['b'] }, { topics: ['a', 'b'] }, {}]),
    ).toEqual(['a', 'b'])
  })
})
