/**
 * ForgeLoop Web 客户端：在会话区「对话 / 轨迹」旁增加「需求」页。
 *
 * 页面只读：从本插件 Host 半的认证路由 `/api/forgeloop/board` 读取状态看板，
 * 展示需求、任务与待处理问题。可展开单条需求查看分析、任务、批准、失败轮次与请求。
 *
 * 信任边界：页面不提供批准、推进、验收或停止入口，也没有任何写入通道。
 *
 * 作为普通 dsh.client 模块加载：`factory(require)` 只注册，副作用在 apply 内由
 * ctx.effect / slot 生命周期持有；样式随组件挂载渲染并在卸载时移除。
 */
window.__ModuleLoader__.load({
  id: 'forgeloop-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'forgeloop-board'
    const BOARD_PATH = '/api/forgeloop/board'
    const TERMINAL = { accepted: true, rejected: true, cancelled: true }

    const zh = {
      'view.label': '天工',
      'page.title': '天工',
      'page.subtitle': '{project} · 更新于 {time}',
      'page.refresh': '刷新',
      'page.loading': '正在读取记录…',
      'page.retry': '重试',
      'page.empty': '这个项目还没有需求记录。',
      'page.footer': '只读视图：页面只展示记录，不提供批准、推进或验收入口。',
      'error.transport': '当前页面没有连接服务，无法读取看板。',
      'error.request': '读取看板失败。',
      'filter.all': '全部',
      'filter.active': '进行中',
      'filter.accepted': '已验收',
      'column.requirements': '需求',
      'column.tasks': '任务',
      'column.issues': '问题',
      'summary.requirements': '需求 {count}',
      'summary.active': '进行中 {count}',
      'summary.tasks': '任务 {count}',
      'summary.delivered': '已交付 {count}',
      'summary.issues': '问题 {count}',
      'summary.blocking': '阻断 {count}',
      'status.draft': '草稿',
      'status.awaiting_clarification': '待澄清',
      'status.blocked': '阻塞',
      'status.plan_proposed': '待批准',
      'status.approved': '已批准',
      'status.executing': '执行中',
      'status.accepted': '已验收',
      'status.rejected': '已驳回',
      'status.cancelled': '已取消',
      'status.unknown': '未知状态',
      'task.delivered': '已交付',
      'task.pending': '待执行',
      'task.failed': '失败',
      'task.blocked': '阻塞',
      'task.awaiting_user': '待决定',
      'issue.clarification': '待澄清',
      'issue.blocked': '阻塞',
      'issue.failure_round': '失败轮次',
      'issue.request': '请求',
      'issue.approval': '待批准',
      'issue.severity.blocking': '阻断',
      'issue.severity.attention': '需关注',
      'requirement.version': '需求 v{version}',
      'requirement.plan': '任务包 v{plan}',
      'requirement.noPlan': '未规划',
      'requirement.progress': '{delivered}/{total} 已交付',
      'requirement.approved': '已批准',
      'requirement.approvalMissing': '未批准',
      'requirement.approvalStale': '批准过期',
      'requirement.failureRounds': '失败轮次 {count}（剩余 {remaining}）',
      'requirement.expand': '展开详情',
      'requirement.collapse': '收起详情',
      'task.meta': '{reqId} · 任务包 v{plan}',
      'task.goal': '{taskId} · {goal}',
      'issue.meta': '{reqId} · {kind}',
      'empty.requirements': '没有需求记录',
      'empty.tasks': '还没有任务包',
      'empty.issues': '没有待处理问题',
      'detail.loading': '正在读取需求详情…',
      'detail.error': '读取需求详情失败。',
      'detail.goal': '分析目标',
      'detail.noAnalysis': '尚未分析',
      'detail.clarifications': '待澄清',
      'detail.acceptance': '验收标准',
      'detail.tasks': '任务状态',
      'detail.approval': '批准',
      'detail.approvedBy': '{by} 于 {at} 批准任务包 v{plan}',
      'detail.notApproved': '任务包未批准或批准已过期；不能推进',
      'detail.failures': '失败轮次',
      'detail.requests': '待处理请求',
      'detail.noRequests': '没有待处理请求',
    }

    const en = {
      'view.label': 'Forge',
      'page.title': 'Forge',
      'page.subtitle': '{project} · updated {time}',
      'page.refresh': 'Refresh',
      'page.loading': 'Reading records…',
      'page.retry': 'Retry',
      'page.empty': 'No requirements yet.',
      'page.footer': 'Read-only view: the page only shows records and offers no approve, advance or accept entry.',
      'error.transport': 'This page has no connection service, so the board cannot be read.',
      'error.request': 'Reading the board failed.',
      'filter.all': 'All',
      'filter.active': 'Active',
      'filter.accepted': 'Accepted',
      'column.requirements': 'Requirements',
      'column.tasks': 'Tasks',
      'column.issues': 'Issues',
      'summary.requirements': 'Requirements {count}',
      'summary.active': 'Active {count}',
      'summary.tasks': 'Tasks {count}',
      'summary.delivered': 'Delivered {count}',
      'summary.issues': 'Issues {count}',
      'summary.blocking': 'Blocking {count}',
      'status.draft': 'Draft',
      'status.awaiting_clarification': 'Awaiting answers',
      'status.blocked': 'Blocked',
      'status.plan_proposed': 'Awaiting approval',
      'status.approved': 'Approved',
      'status.executing': 'Executing',
      'status.accepted': 'Accepted',
      'status.rejected': 'Rejected',
      'status.cancelled': 'Cancelled',
      'status.unknown': 'Unknown status',
      'task.delivered': 'Delivered',
      'task.pending': 'Pending',
      'task.failed': 'Failed',
      'task.blocked': 'Blocked',
      'task.awaiting_user': 'Awaiting decision',
      'issue.clarification': 'Clarification',
      'issue.blocked': 'Blocked',
      'issue.failure_round': 'Failure round',
      'issue.request': 'Request',
      'issue.approval': 'Approval',
      'issue.severity.blocking': 'Blocking',
      'issue.severity.attention': 'Attention',
      'requirement.version': 'Requirement v{version}',
      'requirement.plan': 'Plan v{plan}',
      'requirement.noPlan': 'No plan',
      'requirement.progress': '{delivered}/{total} delivered',
      'requirement.approved': 'Approved',
      'requirement.approvalMissing': 'Not approved',
      'requirement.approvalStale': 'Approval stale',
      'requirement.failureRounds': '{count} failure rounds ({remaining} left)',
      'requirement.expand': 'Show details',
      'requirement.collapse': 'Hide details',
      'task.meta': '{reqId} · plan v{plan}',
      'task.goal': '{taskId} · {goal}',
      'issue.meta': '{reqId} · {kind}',
      'empty.requirements': 'No requirements',
      'empty.tasks': 'No task plan yet',
      'empty.issues': 'No open issues',
      'detail.loading': 'Reading requirement details…',
      'detail.error': 'Reading requirement details failed.',
      'detail.goal': 'Goal',
      'detail.noAnalysis': 'Not analyzed yet',
      'detail.clarifications': 'Clarifications',
      'detail.acceptance': 'Acceptance criteria',
      'detail.tasks': 'Task status',
      'detail.approval': 'Approval',
      'detail.approvedBy': '{by} approved plan v{plan} at {at}',
      'detail.notApproved': 'The plan is not approved (or the approval is stale); it cannot advance',
      'detail.failures': 'Failure rounds',
      'detail.requests': 'Pending requests',
      'detail.noRequests': 'No pending requests',
    }

    const REQUIREMENT_TONES = {
      draft: 'idle',
      awaiting_clarification: 'warn',
      blocked: 'error',
      plan_proposed: 'brand',
      approved: 'brand',
      executing: 'brand',
      accepted: 'success',
      rejected: 'idle',
      cancelled: 'idle',
    }

    const TASK_TONES = {
      delivered: 'success',
      pending: 'idle',
      failed: 'error',
      blocked: 'error',
      awaiting_user: 'warn',
    }

    const ISSUE_TONES = { blocking: 'error', attention: 'warn' }

    function statusLabel(t, status) {
      const key = `status.${status}`
      const label = t(key)
      return label === key ? t('status.unknown') : label
    }

    function formatTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString()
    }

    function Chip(props) {
      return h('span', { className: 'flb-chip', 'data-tone': props.tone || 'idle' }, props.children)
    }

    /**
     * 读取看板与需求详情：只走本插件注册的认证 Fetch 路由。
     * 宿主连接层负责 Host/Origin 检查与浏览器凭据准入；页面不直接访问记录库。
     */
    function createReader(t) {
      return async function read(endpoint, body, signal) {
        const response = await fetch(BOARD_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, ...(body || {}) }),
          credentials: 'same-origin',
          ...(signal ? { signal } : {}),
        })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (!response.ok) {
          const message = payload && payload.error && payload.error.message
          throw new Error(message || `${t('error.request')}（HTTP ${response.status}）`)
        }
        if (!payload || payload.ok !== true) {
          const message = payload && payload.error && payload.error.message
          throw new Error(message || t('error.request'))
        }
        return payload.value
      }
    }

    function RequirementCard(props) {
      const t = props.t
      const requirement = props.requirement
      const open = props.open
      const progress = requirement.progress || { total: 0, delivered: 0 }
      const ratio = progress.total > 0 ? Math.round((progress.delivered / progress.total) * 100) : 0
      const approvalKey =
        requirement.approval === 'approved'
          ? 'requirement.approved'
          : requirement.approval === 'stale'
            ? 'requirement.approvalStale'
            : 'requirement.approvalMissing'

      const head = h(
        'button',
        {
          type: 'button',
          className: 'flb-card-head flb-card-toggle',
          'aria-expanded': open,
          title: open ? t('requirement.collapse') : t('requirement.expand'),
          onClick: () => props.onToggle(requirement.reqId),
        },
        h(Chip, { tone: REQUIREMENT_TONES[requirement.status] || 'idle' }, statusLabel(t, requirement.status)),
        h('span', { className: 'flb-card-meta' }, t('requirement.version', { version: requirement.version })),
        requirement.planVersion === null
          ? h('span', { className: 'flb-card-meta' }, t('requirement.noPlan'))
          : h(
              'span',
              { className: 'flb-card-meta' },
              t('requirement.plan', { plan: requirement.planVersion }),
              ' · ',
              t(approvalKey),
            ),
        h('span', { className: 'flb-chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
      )

      return h(
        'article',
        { className: 'flb-card', 'data-open': open, key: requirement.reqId },
        head,
        h('div', { className: 'flb-card-title', title: requirement.title }, requirement.title),
        h(
          'div',
          { className: 'flb-card-meta' },
          h('span', null, requirement.reqId),
          requirement.failureRounds > 0
            ? h(
                'span',
                null,
                t('requirement.failureRounds', {
                  count: requirement.failureRounds,
                  remaining: requirement.remainingRounds,
                }),
              )
            : null,
        ),
        progress.total > 0
          ? h(
              'div',
              { className: 'flb-progress', title: t('requirement.progress', progress) },
              h('span', { style: { width: `${ratio}%` } }),
            )
          : null,
        progress.total > 0
          ? h('div', { className: 'flb-card-meta' }, t('requirement.progress', progress))
          : null,
        open ? h(RequirementDetail, props) : null,
      )
    }

    function DetailSection(title, children) {
      return h(
        'section',
        { className: 'flb-detail-section' },
        h('div', { className: 'flb-detail-title' }, title),
        ...children,
      )
    }

    function RequirementDetail(props) {
      const t = props.t
      const detail = props.detail

      if (detail.phase === 'loading') {
        return h('div', { className: 'flb-detail' }, h('div', { className: 'flb-empty' }, t('detail.loading')))
      }
      if (detail.phase === 'error') {
        return h(
          'div',
          { className: 'flb-detail' },
          h('div', { className: 'flb-error-inline', role: 'alert' }, detail.error || t('detail.error')),
        )
      }
      if (detail.phase !== 'ready' || !detail.data) {
        return h('div', { className: 'flb-detail' }, h('div', { className: 'flb-empty' }, t('detail.loading')))
      }

      const data = detail.data
      const analysis = data.analysis || null
      const tasks = props.tasks
      const runs = new Map((data.runs || []).map((run) => [run.taskId, run]))
      const approval = data.approval || null
      const failures = data.failureRoundDetails || []
      const requests = data.pendingRequests || []

      const sections = []

      if (analysis) {
        sections.push(
          DetailSection(t('detail.goal'), [h('div', { className: 'flb-detail-text', key: 'goal' }, analysis.goal)]),
        )
        if (analysis.clarifications && analysis.clarifications.length > 0) {
          sections.push(
            DetailSection(
              t('detail.clarifications'),
              analysis.clarifications.map((item) => h('div', { className: 'flb-detail-item', key: item }, item)),
            ),
          )
        }
        if (analysis.acceptanceCriteria && analysis.acceptanceCriteria.length > 0) {
          sections.push(
            DetailSection(
              t('detail.acceptance'),
              analysis.acceptanceCriteria.map((item) => h('div', { className: 'flb-detail-item', key: item }, item)),
            ),
          )
        }
      } else {
        sections.push(
          DetailSection(t('detail.goal'), [h('div', { className: 'flb-detail-muted' }, t('detail.noAnalysis'))]),
        )
      }

      if (tasks.length > 0) {
        sections.push(
          DetailSection(
            t('detail.tasks'),
            tasks.map((task) => {
              const run = runs.get(task.taskId)
              return h(
                'div',
                { className: 'flb-detail-row', key: task.taskId },
                h(Chip, { tone: TASK_TONES[task.state] || 'idle' }, t(`task.${task.state}`)),
                h('span', { className: 'flb-detail-code' }, task.taskId),
                h('span', null, task.goal),
                run && run.reason ? h('span', { className: 'flb-detail-muted' }, run.reason) : null,
              )
            }),
          ),
        )
      }

      sections.push(
        DetailSection(t('detail.approval'), [
          approval
            ? h(
                'div',
                { className: 'flb-detail-text', key: 'approved' },
                t('detail.approvedBy', {
                  by: approval.approvedBy,
                  plan: approval.planVersion,
                  at: formatTime(approval.approvedAt),
                }),
              )
            : h('div', { className: 'flb-detail-muted', key: 'missing' }, t('detail.notApproved')),
        ]),
      )

      if (failures.length > 0) {
        sections.push(
          DetailSection(
            t('detail.failures'),
            failures.map((round) =>
              h(
                'div',
                { className: 'flb-detail-row', key: round.roundId },
                h('span', { className: 'flb-detail-muted' }, formatTime(round.occurredAt)),
                h('span', null, round.summary),
              ),
            ),
          ),
        )
      }

      sections.push(
        DetailSection(
          t('detail.requests'),
          requests.length === 0
            ? [h('div', { className: 'flb-detail-muted', key: 'none' }, t('detail.noRequests'))]
            : requests.map((request) =>
                h(
                  'div',
                  { className: 'flb-detail-row', key: request.requestId },
                  h('span', { className: 'flb-detail-code' }, request.action),
                  h('span', null, request.state),
                  request.detail ? h('span', { className: 'flb-detail-muted' }, request.detail) : null,
                ),
              ),
        ),
      )

      return h('div', { className: 'flb-detail' }, ...sections)
    }

    function TaskCard(props) {
      const t = props.t
      const task = props.task
      return h(
        'article',
        { className: 'flb-card', key: `${task.reqId}:${task.planVersion}:${task.taskId}` },
        h(
          'button',
          {
            type: 'button',
            className: 'flb-card-head flb-card-toggle',
            title: t('requirement.expand'),
            onClick: () => props.onOpen(task.reqId),
          },
          h(Chip, { tone: TASK_TONES[task.state] || 'idle' }, t(`task.${task.state}`)),
          h('span', { className: 'flb-card-meta' }, t('task.meta', { reqId: task.reqId, plan: task.planVersion })),
        ),
        h('div', { className: 'flb-card-title', title: task.goal }, t('task.goal', { taskId: task.taskId, goal: task.goal })),
        task.dependsOn && task.dependsOn.length > 0
          ? h('div', { className: 'flb-card-meta' }, `依赖 ${task.dependsOn.join('、')}`)
          : null,
      )
    }

    function IssueCard(props) {
      const t = props.t
      const issue = props.issue
      return h(
        'article',
        { className: 'flb-card', key: issue.issueId, 'data-severity': issue.severity },
        h(
          'button',
          {
            type: 'button',
            className: 'flb-card-head flb-card-toggle',
            title: t('requirement.expand'),
            onClick: () => props.onOpen(issue.reqId),
          },
          h(Chip, { tone: ISSUE_TONES[issue.severity] || 'warn' }, t(`issue.severity.${issue.severity}`)),
          h(Chip, { tone: 'idle' }, t(`issue.${issue.kind}`)),
          h('span', { className: 'flb-card-meta' }, issue.reqId),
        ),
        h('div', { className: 'flb-card-title', title: issue.title }, issue.title),
        issue.detail ? h('div', { className: 'flb-card-meta' }, issue.detail) : null,
      )
    }

    function Column(title, count, children, emptyText) {
      return h(
        'section',
        { className: 'flb-col' },
        h('div', { className: 'flb-col-head' }, h('span', null, title), h('span', { className: 'flb-count' }, count)),
        count === 0 ? h('div', { className: 'flb-empty' }, emptyText) : null,
        ...children,
      )
    }

    const BOARD_CSS = `
.flb-root{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px}
.flb-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.flb-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.flb-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.flb-refresh{box-sizing:border-box;height:24px;padding:0 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.flb-refresh:hover{background:var(--dsw-alias-bg-layer-2)}
.flb-refresh:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.flb-refresh:disabled{cursor:default;color:var(--dsw-alias-label-secondary)}
.flb-head .flb-refresh{margin-left:auto}
.flb-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 24px}
.flb-summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:12px}
.flb-pill{border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.flb-pill[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.flb-filters{display:flex;gap:4px;margin-left:auto}
.flb-filter{border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.flb-filter[aria-pressed=true]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.flb-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;align-items:start}
.flb-col{min-width:0;display:flex;flex-direction:column;gap:8px}
.flb-col-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:0 2px}
.flb-count{font-weight:400;color:var(--dsw-alias-label-secondary)}
.flb-card{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1)}
.flb-card[data-open=true]{border-color:var(--dsw-alias-brand-primary)}
.flb-card[data-severity=blocking]{border-color:var(--dsw-alias-state-error-primary)}
.flb-card-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.flb-card-toggle{width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:4px}
.flb-card-toggle:hover{background:var(--dsw-alias-bg-layer-2)}
.flb-card-toggle:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.flb-chevron{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px}
.flb-card-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;overflow-wrap:anywhere}
.flb-card-meta{display:flex;flex-wrap:wrap;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.flb-chip{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.flb-chip[data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.flb-chip[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.flb-chip[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
.flb-chip[data-tone=brand]{color:var(--dsw-alias-brand-primary)}
.flb-progress{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.flb-progress>span{display:block;height:100%;background:var(--dsw-alias-state-success-primary)}
.flb-empty{padding:8px 10px;border:.5px dashed var(--dsw-alias-border-l1);border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.flb-error{margin-bottom:12px;padding:8px 10px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.flb-error-inline{padding:6px 8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px}
.flb-detail{margin-top:6px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:10px}
.flb-detail-section{display:flex;flex-direction:column;gap:4px}
.flb-detail-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
.flb-detail-text{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.flb-detail-item{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);padding-left:10px;position:relative;overflow-wrap:anywhere}
.flb-detail-item:before{content:'·';position:absolute;left:2px;color:var(--dsw-alias-label-secondary)}
.flb-detail-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.flb-detail-muted{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.flb-detail-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}
.flb-footer{margin-top:16px;font-size:11px;color:var(--dsw-alias-label-secondary)}
`

    /** 注册页面；组件只在会话视图槽展开时渲染。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'forgeloop: dictionaries')
      const t = ctx.locale.bind(NS)
      const read = createReader(t)

      function BoardView() {
        const [state, setState] = React.useState({ phase: 'loading', board: null, error: '' })
        const [filter, setFilter] = React.useState('all')
        const [openReq, setOpenReq] = React.useState('')
        const [detail, setDetail] = React.useState({ phase: 'idle', reqId: '', data: null, error: '' })
        const inflight = React.useRef(null)
        const detailInflight = React.useRef(null)

        const load = React.useCallback(() => {
          if (inflight.current) inflight.current.abort()
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          inflight.current = controller
          setState((previous) => ({
            phase: previous.board ? 'refreshing' : 'loading',
            board: previous.board,
            error: '',
          }))
          read('board', null, controller ? controller.signal : undefined)
            .then((board) => {
              if (controller && controller.signal.aborted) return
              setState({ phase: 'ready', board, error: '' })
            })
            .catch((error) => {
              if (controller && controller.signal.aborted) return
              setState((previous) => ({
                phase: previous.board ? 'ready' : 'error',
                board: previous.board,
                error: (error && error.message) || String(error),
              }))
            })
        }, [])

        React.useEffect(() => {
          load()
          const timer = setInterval(load, 15000)
          return () => {
            clearInterval(timer)
            if (inflight.current) inflight.current.abort()
          }
        }, [load])

        React.useEffect(() => {
          if (!openReq) {
            setDetail({ phase: 'idle', reqId: '', data: null, error: '' })
            return undefined
          }
          if (detailInflight.current) detailInflight.current.abort()
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          detailInflight.current = controller
          setDetail({ phase: 'loading', reqId: openReq, data: null, error: '' })
          read('detail', { reqId: openReq }, controller ? controller.signal : undefined)
            .then((data) => {
              if (controller && controller.signal.aborted) return
              setDetail({ phase: 'ready', reqId: openReq, data, error: '' })
            })
            .catch((error) => {
              if (controller && controller.signal.aborted) return
              setDetail({ phase: 'error', reqId: openReq, data: null, error: (error && error.message) || String(error) })
            })
          return () => {
            if (controller) controller.abort()
          }
        }, [openReq])

        const openRequirement = React.useCallback((reqId) => {
          setFilter('all')
          setOpenReq((previous) => (previous === reqId ? '' : reqId))
        }, [])

        const board = state.board
        const requirements = board ? board.requirements : []
        const allTasks = board ? board.tasks : []
        const allIssues = board ? board.issues : []
        const visible = requirements.filter((requirement) => {
          if (filter === 'active') return !TERMINAL[requirement.status]
          if (filter === 'accepted') return requirement.status === 'accepted'
          return true
        })
        const visibleIds = new Set(visible.map((requirement) => requirement.reqId))
        const tasks = allTasks.filter((task) => visibleIds.has(task.reqId))
        const issues = allIssues.filter((issue) => visibleIds.has(issue.reqId))
        const busy = state.phase === 'loading' || state.phase === 'refreshing'

        return h(
          'section',
          { className: 'flb-root', 'data-dsh-plugin': 'forgeloop', 'aria-label': t('page.title') },
          h('style', null, BOARD_CSS),
          h(
            'header',
            { className: 'flb-head' },
            h('span', { className: 'flb-title' }, t('page.title')),
            board
              ? h(
                  'span',
                  { className: 'flb-sub', 'aria-live': 'polite' },
                  t('page.subtitle', { project: board.project, time: formatTime(board.generatedAt) }),
                )
              : null,
            h('button', { type: 'button', className: 'flb-refresh', onClick: load, disabled: busy }, t('page.refresh')),
          ),
          h(
            'div',
            { className: 'flb-body' },
            state.error
              ? h(
                  'div',
                  { className: 'flb-error', role: 'alert' },
                  h('span', null, state.error),
                  h('button', { type: 'button', className: 'flb-refresh', onClick: load }, t('page.retry')),
                )
              : null,
            !board && state.phase === 'loading' ? h('div', { className: 'flb-empty' }, t('page.loading')) : null,
            !board && state.phase === 'error'
              ? null
              : board && board.summary.requirements === 0
                ? h('div', { className: 'flb-empty' }, t('page.empty'))
                : null,
            board
              ? h(
                  'div',
                  { className: 'flb-summary' },
                  h('span', { className: 'flb-pill' }, t('summary.requirements', { count: board.summary.requirements })),
                  h('span', { className: 'flb-pill' }, t('summary.active', { count: board.summary.active })),
                  h('span', { className: 'flb-pill' }, t('summary.tasks', { count: board.summary.tasks })),
                  h('span', { className: 'flb-pill' }, t('summary.delivered', { count: board.summary.delivered })),
                  h(
                    'span',
                    { className: 'flb-pill', 'data-tone': board.summary.blocking > 0 ? 'error' : undefined },
                    t('summary.issues', { count: board.summary.issues }),
                  ),
                  h(
                    'span',
                    { className: 'flb-pill', 'data-tone': board.summary.blocking > 0 ? 'error' : undefined },
                    t('summary.blocking', { count: board.summary.blocking }),
                  ),
                  h(
                    'div',
                    { className: 'flb-filters' },
                    ['all', 'active', 'accepted'].map((key) =>
                      h(
                        'button',
                        {
                          type: 'button',
                          key,
                          className: 'flb-filter',
                          'aria-pressed': filter === key,
                          onClick: () => setFilter(key),
                        },
                        t(`filter.${key}`),
                      ),
                    ),
                  ),
                )
              : null,
            board
              ? h(
                  'div',
                  { className: 'flb-columns' },
                  Column(
                    t('column.requirements'),
                    visible.length,
                    visible.map((requirement) =>
                      h(RequirementCard, {
                        t,
                        key: requirement.reqId,
                        requirement,
                        open: openReq === requirement.reqId,
                        detail:
                          detail.reqId === requirement.reqId
                            ? detail
                            : { phase: 'loading', data: null, error: '' },
                        tasks: allTasks.filter((task) => task.reqId === requirement.reqId),
                        onToggle: openRequirement,
                      }),
                    ),
                    t('empty.requirements'),
                  ),
                  Column(
                    t('column.tasks'),
                    tasks.length,
                    tasks.map((task) => h(TaskCard, { t, key: `${task.reqId}:${task.planVersion}:${task.taskId}`, task, onOpen: openRequirement })),
                    t('empty.tasks'),
                  ),
                  Column(
                    t('column.issues'),
                    issues.length,
                    issues.map((issue) => h(IssueCard, { t, key: issue.issueId, issue, onOpen: openRequirement })),
                    t('empty.issues'),
                  ),
                )
              : null,
            board ? h('div', { className: 'flb-footer' }, t('page.footer')) : null,
          ),
        )
      }

      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'forgeloop',
            order: 20,
            locale: NS,
            label: () => t('view.label'),
          },
          BoardView,
        ),
      )
    }

    return {
      name: 'forgeloop-board',
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
