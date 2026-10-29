/**
 * ForgeLoop Web 客户端：在会话区「对话 / 轨迹」旁增加「需求」页。
 *
 * 看板从本插件 Host 半的认证路由 `/api/forgeloop/board` 读取状态，并展示需求、任务与
 * 待处理问题；需求卡支持批准/推进/取消，失败任务卡展示原因与解决方案并支持重试。
 *
 * 信任边界：页面不提供验收入口；批准、推进、重试、取消、停止都由宿主路由校验规则并以
 * 配置的 owner 记录决定，模型工具不能调用这些路径。
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
      'page.footer': '可交互看板：支持批准、推进、重试和取消需求；验收请回到任务包会话完成。',
      'action.approve': '批准任务包',
      'action.advance': '推进任务',
      'action.plan': '重新生成任务包',
      'action.planHelp': '实现前评审缺失或阻断时重新生成任务包；新任务包仍需评审与批准。',
      'action.verify': '独立验证',
      'action.verifyHelp': '对全部已交付任务的固定候选执行验证计划，通过后才能验收。',
      'action.cancel': '取消需求',
      'action.busy': '处理中…',
      'action.approved': '任务包已批准',
      'action.advanced': '已受理推进请求',
      'action.planned': '已受理重新生成任务包请求',
      'action.verified': '已受理独立验证请求',
      'action.rework': '重新研发',
      'action.reworkHelp': '独立验证阻断后，归档旧候选并把同一任务包重新交给研发；旧证据与失败轮次保留。',
      'action.reworked': '已归档旧候选并排队重新研发',
      'action.reworkRecoveryConfirm': '该需求有结果未知的请求。已核对工作副本、Git 与证据后，确认关闭 unknown 并重新研发？',
      'action.build': '构建安装包',
      'action.buildHelp': '只从已通过验证的候选工作区构建安装包；验收后才能构建。',
      'action.built': '候选包已构建',
      'action.deploy': '核对上线',
      'action.deployHelp': '安装后核对安装文件、运行版本、需求模块与业务记录。',
      'action.deployPrompt': '输入目标 DSH profile 名称（例如 web）：',
      'action.deployed': '上线核对通过',
      'action.cancelled': '需求已取消',
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
      'task.running': '执行中',
      'task.lastActivity': '最后活动 {time}',
      'task.detail': '任务执行详情',
      'task.open': '查看执行过程',
      'task.activity': 'Agent 执行过程',
      'task.noActivity': '暂无活动记录',
      'task.files': '文件',
      'task.acceptance': '验收标准',
      'task.testCommand': '测试命令',
      'task.testLog': '正式测试日志',
      'task.close': '关闭',
      'task.runningTask': '正在执行：{taskId} · {goal} · 最后活动 {time}',
      'task.failed': '失败',
      'task.blocked': '阻塞',
      'task.awaiting_user': '待决定',
      'task.failureReason': '失败原因',
      'task.solution': '解决方案',
      'task.retry': '重试任务',
      'task.retryConfirm': '核对并重试',
      'task.retrying': '排队中…',
      'task.retryQueued': '已受理重试请求，等待宿主执行。',
      'task.retryHelp': '重试只重排一次推进：保留失败轮次、证据与批准，不清零。',
      'task.retryRecoveryHint': '存在未收口的未知请求；先核对工作副本与证据，再点“核对并重试”。',
      'task.failureRounds': '失败轮次',
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
      'requirement.planReviewMissing': '未评审',
      'requirement.planReviewPassed': '评审通过',
      'requirement.planReviewBlocked': '评审阻断',
      'requirement.verificationMissing': '未验证',
      'requirement.verificationPassed': '验证通过',
      'requirement.verificationBlocked': '验证阻断',
      'requirement.verificationStale': '验证过期',
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
      'node.intake.title': '已进入 ForgeLoop 流程',
      'node.intake.text': '原始输入',
      'node.intake.req': '需求 {reqId}',
      'node.intake.status': '已受理，等待需求 Agent 分析',
      'node.analysis.title': '需求 Agent 分析结果',
      'node.analysis.version': '分析 v{analysisVersion} · 需求 v{requirementVersion}',
      'node.analysis.goal': '目标',
      'node.analysis.scenarios': '业务场景',
      'node.analysis.acceptance': '验收标准',
      'node.analysis.clarifications': '待澄清',
      'node.error.title': 'ForgeLoop 受理失败',
      'node.error.req': '需求 {reqId}',
      'node.clarification.title': '需求等待澄清',
      'node.clarification.questions': '需要回答',
      'node.answer.title': '已提交澄清回答',
      'node.answer.version': '需求 v{version}',
      'tail.title': '本会话需求',
      'tail.needs': '需要澄清',
      'tail.clear': '不需要澄清',
      'tail.empty': '暂无需求',
      'tail.goal': '目标',
      'tail.version': '需求 v{version}',
      'tail.progress': '已交付 {delivered}/{total}',
      'tail.approved': '已批准',
      'node.plan.title': '研发 Agent 任务包',
      'node.plan.version': '任务包 v{planVersion} · 需求 v{requirementVersion}',
      'node.plan.solution': '技术方案',
      'node.plan.approach': '实施方案',
      'node.plan.risks': '风险',
      'node.plan.tasks': '任务包',
      'node.plan.files': '文件',
      'node.plan.depends': '依赖',
      'node.plan.verification': '验证任务',
      'node.plan.approve': '批准任务包',
      'node.plan.advance': '推进任务',
      'node.plan.approved': '任务包已批准',
      'node.plan.advanceAccepted': '已受理推进请求',
      'node.plan.progress': '已交付 {delivered}/{total}',
      'node.plan.busy': '处理中…',
      'node.plan.accept': '验收交付',
      'node.plan.stop': '停止需求',
      'node.plan.accepted': '已验收',
      'node.plan.stopped': '已请求停止',
      'node.plan.candidate': '候选产物 SHA-256',
      'node.plan.candidateHint': '已构建候选包，验收必须绑定该产物摘要',
      'node.plan.review': '实现前评审',
      'node.plan.reviewMissing': '尚未取得实现前评审结论；不能批准，需重新生成任务包。',
      'node.plan.reviewBlocked': '评审阻断',
      'node.plan.reviewPassed': '评审通过；可以批准。',
      'node.plan.regenerate': '重新生成任务包',
      'node.plan.planRequested': '已受理重新生成任务包请求',
      'node.plan.verificationState': '独立验证',
      'node.plan.verificationMissing': '全部任务已交付，但尚未独立验证。',
      'node.plan.verificationBlocked': '验证阻断',
      'node.plan.verificationStale': '验证结论不绑定当前候选，需重新验证。',
      'node.plan.verificationPassed': '验证通过；可以验收。',
      'node.plan.verify': '独立验证',
      'node.plan.verifyQueued': '已受理独立验证请求',
    }

    const en = {
      'view.label': 'Forge',
      'page.title': 'Forge',
      'page.subtitle': '{project} · updated {time}',
      'page.refresh': 'Refresh',
      'page.loading': 'Reading records…',
      'page.retry': 'Retry',
      'page.empty': 'No requirements yet.',
      'page.footer': 'Interactive board: approve, advance, retry and cancel requirements; complete acceptance in the task-package conversation.',
      'action.approve': 'Approve task package',
      'action.advance': 'Advance tasks',
      'action.plan': 'Regenerate task package',
      'action.planHelp': 'Regenerate the task package when the pre-implementation review is missing or blocking; the new package still needs review and approval.',
      'action.verify': 'Independent verification',
      'action.verifyHelp': 'Run the verification plan against the fixed candidate after every task is delivered; acceptance requires a passing result.',
      'action.cancel': 'Cancel requirement',
      'action.busy': 'Working…',
      'action.approved': 'Task package approved',
      'action.advanced': 'Advance request accepted',
      'action.planned': 'Regeneration request accepted',
      'action.verified': 'Verification request accepted',
      'action.rework': 'Rework candidate',
      'action.reworkHelp': 'After a blocked verification, archive the old candidate and hand the same task package back to development; evidence and failure rounds are kept.',
      'action.reworked': 'Old candidate archived; rework queued',
      'action.reworkRecoveryConfirm': 'This requirement has an unknown-outcome request. After verifying the workspace, Git and evidence, close it and rework?',
      'action.build': 'Build installable candidate',
      'action.buildHelp': 'Build only from the verified candidate workspace; acceptance is required first.',
      'action.built': 'Candidate package built',
      'action.deploy': 'Check deployment',
      'action.deployHelp': 'After installation, check installed files, running version, requirement modules and business records.',
      'action.deployPrompt': 'Target DSH profile name (for example web):',
      'action.deployed': 'Deployment checks passed',
      'action.cancelled': 'Requirement cancelled',
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
      'task.running': 'Running',
      'task.lastActivity': 'Last activity {time}',
      'task.detail': 'Task execution detail',
      'task.open': 'View execution',
      'task.activity': 'Agent execution',
      'task.noActivity': 'No activity yet',
      'task.files': 'Files',
      'task.acceptance': 'Acceptance',
      'task.testCommand': 'Test command',
      'task.testLog': 'Formal test log',
      'task.close': 'Close',
      'task.runningTask': 'Running: {taskId} · {goal} · last activity {time}',
      'task.failed': 'Failed',
      'task.blocked': 'Blocked',
      'task.awaiting_user': 'Awaiting decision',
      'task.failureReason': 'Failure reason',
      'task.solution': 'Solution',
      'task.retry': 'Retry task',
      'task.retryConfirm': 'Acknowledge and retry',
      'task.retrying': 'Queuing…',
      'task.retryQueued': 'Retry request accepted; waiting for the host.',
      'task.retryHelp': 'A retry queues one more advance; failure rounds, evidence and approval are kept.',
      'task.retryRecoveryHint': 'An unknown-outcome request exists; verify the workspace and evidence, then click “Acknowledge and retry”.',
      'task.failureRounds': 'Failure rounds',
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
      'requirement.planReviewMissing': 'Not reviewed',
      'requirement.planReviewPassed': 'Review passed',
      'requirement.planReviewBlocked': 'Review blocked',
      'requirement.verificationMissing': 'Not verified',
      'requirement.verificationPassed': 'Verified',
      'requirement.verificationBlocked': 'Verification blocked',
      'requirement.verificationStale': 'Verification stale',
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
      'node.intake.title': 'Entered the ForgeLoop flow',
      'node.intake.text': 'Original input',
      'node.intake.req': 'Requirement {reqId}',
      'node.intake.status': 'Accepted; the requirement agent is analyzing it',
      'node.analysis.title': 'Requirement agent analysis',
      'node.analysis.version': 'Analysis v{analysisVersion} · requirement v{requirementVersion}',
      'node.analysis.goal': 'Goal',
      'node.analysis.scenarios': 'Scenarios',
      'node.analysis.acceptance': 'Acceptance criteria',
      'node.analysis.clarifications': 'Clarifications',
      'node.error.title': 'ForgeLoop intake failed',
      'node.error.req': 'Requirement {reqId}',
      'node.clarification.title': 'Requirement awaiting clarification',
      'node.clarification.questions': 'Questions to answer',
      'node.answer.title': 'Clarification answer submitted',
      'node.answer.version': 'Requirement v{version}',
      'tail.title': 'Requirements in this session',
      'tail.needs': 'Needs clarification',
      'tail.clear': 'No clarification needed',
      'tail.empty': 'No requirements yet',
      'tail.goal': 'Goal',
      'tail.version': 'Requirement v{version}',
      'tail.progress': 'Delivered {delivered}/{total}',
      'tail.approved': 'Approved',
      'node.plan.title': 'Dev Agent task package',
      'node.plan.version': 'Plan v{planVersion} · Requirement v{requirementVersion}',
      'node.plan.solution': 'Technical solution',
      'node.plan.approach': 'Approach',
      'node.plan.risks': 'Risks',
      'node.plan.tasks': 'Task package',
      'node.plan.files': 'Files',
      'node.plan.depends': 'Depends on',
      'node.plan.verification': 'Verification task',
      'node.plan.approve': 'Approve task package',
      'node.plan.advance': 'Advance tasks',
      'node.plan.approved': 'Task package approved',
      'node.plan.advanceAccepted': 'Advance request accepted',
      'node.plan.progress': 'Delivered {delivered}/{total}',
      'node.plan.busy': 'Working…',
      'node.plan.accept': 'Accept delivery',
      'node.plan.stop': 'Stop requirement',
      'node.plan.accepted': 'Accepted',
      'node.plan.stopped': 'Stop requested',
      'node.plan.candidate': 'Candidate artifact SHA-256',
      'node.plan.candidateHint': 'A candidate package exists; acceptance must bind its artifact digest',
      'node.plan.review': 'Pre-implementation review',
      'node.plan.reviewMissing': 'No pre-implementation review yet; approval is blocked and the package must be regenerated.',
      'node.plan.reviewBlocked': 'Review blocked',
      'node.plan.reviewPassed': 'Review passed; approval is allowed.',
      'node.plan.regenerate': 'Regenerate task package',
      'node.plan.planRequested': 'Regeneration request accepted',
      'node.plan.verificationState': 'Independent verification',
      'node.plan.verificationMissing': 'Every task is delivered but no independent verification exists yet.',
      'node.plan.verificationBlocked': 'Verification blocked',
      'node.plan.verificationStale': 'The verification result is not bound to the current candidate; verify again.',
      'node.plan.verificationPassed': 'Verification passed; acceptance is allowed.',
      'node.plan.verify': 'Independent verification',
      'node.plan.verifyQueued': 'Verification request accepted',
    }

    const workbenchZh = {
      'nav.overview': '总览',
      'nav.requirements': '需求',
      'nav.tasks': '任务',
      'nav.issues': '问题',
      'nav.ops': '运维',
      'nav.label': '工作台视图',
      'search.placeholder': '搜索需求、任务、问题…',
      'search.label': '搜索工作台',
      'search.clear': '清除搜索',
      'search.results': '搜索“{query}”：匹配 {count} 条需求{truncated}',
      'search.truncated': '，仅显示前 {limit} 条',
      'search.noResults': '没有匹配“{query}”的记录',
      'page.refreshing': '刷新中…',
      'page.source': '事实来自 SQLite 与登记证据',
      'requirement.runningTask': '正在执行：{taskId} · {goal} · 最后活动 {time}',
      'requirement.failedTasks': '失败任务 {count}',
      'requirement.clarifications': '待澄清 {count}',
      'requirement.stopRequested': '停止请求',
      'requirement.unknownCount': '未知请求 {count}',
      'task.awaiting_input': '等待输入',
      'task.waitingCard': '等待输入：{taskId} · {goal} · 最后活动 {time}',
      'task.goalTitle': '目标',
      'task.dependsOn': '依赖',
      'task.verification': '验证任务',
      'task.resultUnknown': '结果未知',
      'task.openDetail': '查看执行',
      'task.openRequirement': '查看需求',
      'task.heartbeatStale': '心跳超过 60 秒，可能已停滞；需核对现场',
      'task.heartbeatNote': '最后活动/心跳只证明观测时间，不是任务正常推进或已完成的证明。',
      'task.waitingInputBanner': '最近活动显示 Agent 可能在等待人工输入（ask_user_question）；需要人工回答，不能把心跳当作推进。',
      'task.unknownBanner': '该需求存在结果未知的请求：先核对工作副本、Git 与证据；未核对前不能盲目重试或认定副作用未发生。',
      'task.stopBanner': '已记录停止请求；请求停止不等于已经停稳，仍可能有未收口动作。',
      'task.activityMeta': '仅显示最近 {shown} 条，共 {total} 条活动记录。',
      'task.testLogMeta': '路径：{path} · {bytes} 字节',
      'task.testLogTruncated': '日志已截断：仅显示末尾 4000 字符；完整内容见上方路径。',
      'task.review': '独立审查',
      'task.reviewVerdict': '结论',
      'task.reviewSummary': '摘要',
      'task.reviewFindings': '发现',
      'task.reviewBlocking': '阻断项',
      'task.reviewNone': '尚无独立审查结论（可能未执行、失败或证据未落盘）。',
      'task.reviewNote': '这是最近一次落盘的审查记录；不一定是当前失败的直接原因，请结合失败原因与日志判断。',
      'task.evidence': '证据身份',
      'task.artifact': '交付产物',
      'task.artifactMissing': '尚无交付产物；任务可能未交付或证据未落盘。',
      'task.evidenceMissing': '尚无证据路径记录。',
      'task.retryNotAllowed': '当前不能重试：{reason}',
      'hint.paths': '证据路径与会话',
      'detail.original': '原始需求',
      'detail.currentVersion': '当前版本 v{version}',
      'detail.history': '查看版本历史（{count} 个旧版本）',
      'detail.versionMeta': 'v{version} · {time} · {by}',
      'detail.analysis': '分析结果',
      'detail.scenarios': '业务场景',
      'detail.technicalSolution': '技术方案',
      'detail.approach': '实施步骤',
      'detail.risks': '风险',
      'detail.plan': '任务包 v{plan}',
      'detail.planTasks': '任务包',
      'detail.noPlanDetail': '尚无任务包，或任务包正文不可读。',
      'detail.openTask': '查看执行',
      'detail.dependsOn': '依赖',
      'detail.files': '允许文件',
      'detail.delivery': '交付进度与验收依据',
      'detail.progressNote': '已交付 {delivered}/{total} · 失败 {failed} · 执行中 {running} · 等待输入 {awaitingInput}',
      'detail.artifacts': '交付物与证据身份',
      'detail.noArtifacts': '尚无交付产物。',
      'detail.artifactTask': '任务 {taskId}',
      'detail.candidate': '候选摘要',
      'detail.testEvidence': '测试证据',
      'detail.reviewEvidence': '审查证据',
      'detail.authorization': '授权来源',
      'detail.recordedAt': '记录时间',
      'detail.baseline': '基线',
      'detail.acceptanceRecord': '验收记录',
      'detail.acceptedMeta': '{by} · {time} · {source}',
      'detail.notAccepted': '未验收；验收仍在任务包会话完成。',
      'detail.candidatePackage': '候选包',
      'detail.planReview': '实现前评审',
      'detail.noPlanReview': '尚未取得实现前评审结论；不能批准。',
      'detail.verification': '独立验证',
      'detail.noVerification': '尚未完成独立验证；不能验收。',
      'detail.verificationFresh': '结论绑定当前候选',
      'detail.verificationStale': '结论不绑定当前候选，需重新验证',
      'detail.verdict.pass': '通过',
      'detail.verdict.block': '阻断',
      'detail.blocking': '阻断原因',
      'detail.scenarios': '验证场景',
      'detail.unknownRequest': '结果未知，需核对',
      'detail.clarificationHint': '回答请在 ForgeLoop 业务会话输入；本页不提供回答入口。',
      'action.replan': '重新规划',
      'action.replanHelp': '复制当前任务包、补充文件并生成待批准的新版本；不会自动批准。',
      'action.replanPrompt': '输入要补充到失败任务的文件路径（逗号或换行分隔）：',
      'action.replanRecoveryConfirm': '该需求有结果未知的请求。已核对工作副本、Git 与证据后，确认关闭 unknown 并重新规划？',
      'action.replanned': '已生成任务包 v{plan}，任务 {task} 补充 {files}；等待批准。',
      'action.replannedRecovered': '已关闭 {count} 条 unknown。',
      'wb.release': '发布与运行',
      'wb.businessReview': '业务终审',
      'wb.candidate': '候选包',
      'wb.deployment': '部署核对',
      'action.stop': '请求停止',
      'action.stopHelp': '请求停止会撤销待执行请求；完成前不能认定已经停稳。',
      'action.stopConfirm': '确认请求停止该需求？停止请求会撤销待执行请求，结果仍需核对。',
      'action.stopReason': '从天工工作台请求停止',
      'action.cancelReason': '从天工工作台取消',
      'action.stopped': '已请求停止；结果需核对',
      'issue.openTask': '查看任务',
      'issue.openRequirement': '查看需求',
      'issue.taskMeta': '任务 {taskId}',
      'overview.stat.requirements': '需求',
      'overview.stat.active': '进行中',
      'overview.stat.tasks': '任务',
      'overview.stat.delivered': '已交付',
      'overview.stat.issues': '问题',
      'overview.stat.blocking': '阻断',
      'overview.runningTitle': '当前执行与等待输入',
      'overview.runningEmpty': '当前没有执行中或等待输入的任务。',
      'overview.attentionTitle': '需要处理',
      'overview.attentionEmpty': '当前没有待处理问题。',
      'overview.attentionMore': '查看全部 {count} 个问题',
      'overview.nextTitle': '下一步可以做什么',
      'overview.featuresTitle': '工作台能力与边界',
      'overview.feature.nav': '统一导航：总览 / 需求 / 任务 / 问题',
      'overview.feature.search': '搜索需求、分析、任务、失败与请求说明',
      'overview.feature.detail': '需求原文/版本、任务包、交付进度与验收依据',
      'overview.feature.debug': '执行状态、心跳、日志、审查结论与证据身份',
      'overview.feature.actions': '批准、推进、重试、请求停止与取消；验收仍在任务包会话',
      'overview.boundaryHeartbeat': '心跳/最后活动不是推进证明；超过 60 秒未更新时标记可能停滞。',
      'overview.boundarySource': '事实来自 SQLite 与已登记证据；页面不另存业务状态。',
      'overview.boundaryStop': '停止请求不等于已经停稳；unknown 结果需先核对现场。',
      'overview.boundaryAccept': '天工页不提供验收；验收仍在任务包会话完成。',
      'overview.boundaryClarification': '待澄清回答仍在 ForgeLoop 业务会话输入；本页只读展示问题。',
      'overview.boundaryGrant': '追加授权与重新规划尚无页面入口；额度用尽时重试会被明确拒绝。',
      'overview.searchScope': '搜索范围：需求身份/状态/原文与版本、分析结论、任务目标/文件/验收标准、运行原因、失败轮次、请求说明与问题文字；最多显示 50 条。',
      'overview.next.approvals': '{count} 个任务包待批准',
      'overview.next.failures': '{count} 个失败任务待查看证据/重试',
      'overview.next.unknown': '{count} 条结果未知请求待核对',
      'overview.next.clarifications': '{count} 条待澄清问题',
      'overview.next.running': '{count} 个任务在执行或等待输入',
      'overview.next.none': '当前没有阻断项；可以继续跟踪任务或提交新需求。',
      'overview.next.submit': '还没有需求记录；在 ForgeLoop 业务会话输入第一条需求。',
      'common.yes': '是',
      'common.no': '否',
      'filter.task.all': '全部',
      'filter.task.running': '执行中',
      'filter.task.awaiting_input': '等待输入',
      'filter.task.failed': '失败',
      'filter.task.blocked': '阻塞',
      'filter.task.awaiting_user': '待决定',
      'filter.task.delivered': '已交付',
      'filter.task.pending': '待执行',
      'filter.issue.all': '全部',
      'filter.issue.blocking': '阻断',
      'filter.issue.attention': '需关注',
      'filter.requirement.all': '全部',
      'filter.requirement.active': '进行中',
      'filter.requirement.attention': '需处理',
      'filter.requirement.draft': '草稿',
      'task.failureAction': '下一步',
      'task.noTestLog': '尚未记录正式测试日志。',
      'wb.tree': '需求树',
      'wb.treeToggle': '收起/展开需求树',
      'wb.hierarchy': '层级工作台',
      'wb.allTasks': '全部任务',
      'wb.attention': '需要处理',
      'wb.requirement': '需求',
      'wb.task': '任务',
      'wb.issue': '问题',
      'wb.back': '返回列表',
      'wb.backWorkbench': '返回工作台',
      'wb.full': '展开详情',
      'wb.close': '关闭',
      'wb.overview': '概览',
      'wb.relations': '前后序',
      'wb.activity': 'Agent 执行过程',
      'wb.tests': '测试与审查',
      'wb.changes': '变更记录',
      'wb.taskList': '任务列表',
      'wb.dependencies': '依赖关系',
      'wb.noSelection': '选择一个需求、任务或问题',
      'wb.noMatch': '没有匹配记录',
      'wb.clear': '清除搜索与筛选',
      'wb.progress': '{delivered}/{total} 个任务已交付',
      'wb.plan': '任务包 v{plan}',
      'wb.planLabel': '任务包',
      'wb.version': '需求 v{version}',
      'wb.attempt': '执行尝试',
      'wb.session': '会话',
      'wb.started': '开始时间',
      'wb.lastActivity': '最后活动',
      'wb.noExecution': '没有可展示的 Agent 执行记录。',
      'wb.noExecutionHint': '任务尚未开始执行，或该次执行记录未保留。',
      'wb.steps': '折叠步骤 {count} 个',
      'wb.loadMore': '加载更多',
      'wb.newEvents': '有新活动到达',
      'wb.pause': '暂停自动刷新',
      'wb.resume': '恢复自动刷新',
      'wb.auto': '自动刷新',
      'wb.predecessors': '前置任务',
      'wb.successors': '后继任务',
      'wb.wait': '等待 {tasks} 交付',
      'wb.dependencyReady': '依赖条件已满足',
      'wb.noPredecessors': '无前置任务',
      'wb.noSuccessors': '无后继任务',
      'wb.openExecution': '查看 Agent 执行过程',
      'wb.related': '关联对象',
      'wb.copy': '复制路径',
      'wb.copied': '已复制',
      'wb.copyFailed': '复制不可用，请手动选择路径',
      'wb.truncated': '已截断，仅展示可取得范围',
      'wb.testCommand': '实际命令',
      'wb.exitCode': '退出码',
      'wb.duration': '耗时',
      'wb.path': '路径',
      'wb.size': '大小',
      'wb.taskInput': '任务输入',
      'wb.publicMessage': '公开消息',
      'wb.tool': '工具调用',
      'wb.toolInput': '输入',
      'wb.toolOutput': '输出',
      'wb.toolPending': '待返回',
      'wb.toolFailed': '失败',
      'wb.toolCompleted': '完成',
      'wb.phase': '阶段事件',
      'wb.attemptUnavailable': '该历史尝试只保留摘要，没有独立执行记录',
      'wb.history': '历史尝试',
      'wb.sessionUnavailable': '未记录会话身份',
      'wb.noAttempt': '没有可切换的执行尝试',
      'wb.more': '更多',
      'wb.selected': '已选中',
      'wb.taskCount': '{count} 个任务',
      'wb.issueCount': '{count} 个问题',
      'wb.reqCount': '{count} 个需求',
      'wb.workbench': '层级工作台',
      'wb.execution': '执行记录',
      'wb.taskGoal': '任务目标',
      'wb.acceptance': '验收标准',
      'wb.files': '允许文件',
      'wb.dependsOn': '前置任务',
      'wb.artifact': '交付产物',
      'wb.failureRounds': '失败轮次',
      'wb.versionHistory': '版本历史',
      'wb.approval': '批准',
      'wb.planReview': '实现前评审',
      'wb.verification': '独立验证',
      'wb.approved': '批准有效',
      'wb.stale': '旧批准已过期',
      'wb.missing': '未记录',
      'wb.stopRequested': '停止请求待核对',
      'wb.resultUnknown': '结果未知，需核对',
      'wb.waitingInput': '等待回答',
      'wb.failed': '失败',
      'wb.blocked': '阻塞',
      'wb.running': '执行中',
      'wb.pendingState': '待执行',
      'wb.deliveredState': '已交付',
      'wb.awaitingUser': '待决定',
      'wb.awaitingInput': '等待回答',
      'wb.executionTotal': '共 {count} 条公开事件',
      'wb.attemptNote': '只展示公开文本、工具调用与结果；隐藏推理不展示。',
      'wb.loading': '加载中…',
      'wb.error': '读取失败',
      'wb.breadcrumb': '路径',
      'wb.noActions': '当前没有可用的客户动作',
      'wb.openTask': '打开任务',
      'wb.openRequirement': '打开需求',
      'wb.openIssue': '打开问题',
      'wb.noIssues': '当前没有待处理事项',
      'wb.planPending': '等待批准',
      'ops.title': '运维事件',
      'ops.subtitle': '登记资源、只读诊断、授权处置与恢复复核',
      'ops.all': '全部',
      'ops.active': '处理中',
      'ops.total': '事件',
      'ops.human': '人工介入',
      'ops.recovered': '已恢复',
      'ops.unresolved': '未解决',
      'ops.unknown': '结果未知',
      'ops.awaiting': '待决定',
      'ops.fix': '修复需求',
      'ops.noEvents': '没有匹配的运维事件。',
      'ops.empty': '当前项目还没有运维事件。',
      'ops.emptyHint': '启用 ops 并登记检查后，失败的巡检会在这里形成事件。',
      'ops.loading': '正在读取运维事件…',
      'ops.error': '运维事件读取失败',
      'ops.severity.critical': '严重',
      'ops.severity.major': '重要',
      'ops.severity.minor': '一般',
      'ops.state.open': '已发现',
      'ops.state.diagnosed': '已诊断',
      'ops.state.awaiting_decision': '待决定',
      'ops.state.recovering': '处置中',
      'ops.state.recovered': '已恢复',
      'ops.state.unresolved': '未解决',
      'ops.state.unknown': '结果未知',
      'ops.state.closed': '已关闭',
      'ops.impact': '业务影响',
      'ops.noImpact': '尚无诊断结论',
      'ops.facts': '事实',
      'ops.hypotheses': '推断',
      'ops.proposed': '建议处置',
      'ops.noAction': '没有可执行的登记动作；需要人工处理或生成修复需求。',
      'ops.attempts': '处置记录',
      'ops.noAttempts': '尚未执行处置动作',
      'ops.observations': '证据与观测',
      'ops.evidence': '证据',
      'ops.action': '动作',
      'ops.exit': '退出码',
      'ops.resource': '资源',
      'ops.check': '检查',
      'ops.opened': '首次发现',
      'ops.updated': '最近更新',
      'ops.recoveredAt': '恢复时间',
      'ops.lastObservation': '最近观测',
      'ops.humanNote': '人工介入',
      'ops.approve': '批准处置',
      'ops.decline': '拒绝处置',
      'ops.confirmUnknown': '核对并确认',
      'ops.close': '关闭事件',
      'ops.requestFix': '生成修复需求',
      'ops.approveConfirm': '批准后由协调器执行登记动作，页面不会立即执行。确认批准？',
      'ops.declineConfirm': '拒绝后事件保留为未解决，不执行动作。确认拒绝？',
      'ops.unknownConfirm': '只在已经核对外部副作用后确认。确认结果未知已核对？',
      'ops.closeConfirm': '关闭会保留证据并结束事件，不会撤销已发生的动作。确认关闭？',
      'ops.done': '已受理；等待协调器处理',
      'ops.fixCreated': '已关联修复需求 {req}',
      'ops.fixPending': '修复需求处理中',
      'wb.stopHelp': '停止请求会撤销待执行请求；完成前不能认定已经停稳。',
    }

    const workbenchEn = {
      'nav.overview': 'Overview',
      'nav.requirements': 'Requirements',
      'nav.tasks': 'Tasks',
      'nav.issues': 'Issues',
      'nav.ops': 'Ops',
      'nav.label': 'Workbench views',
      'search.placeholder': 'Search requirements, tasks, issues…',
      'search.label': 'Search workbench',
      'search.clear': 'Clear search',
      'search.results': 'Search “{query}”: {count} matching requirements{truncated}',
      'search.truncated': ', showing first {limit}',
      'search.noResults': 'No records match “{query}”',
      'page.refreshing': 'Refreshing…',
      'page.source': 'facts from SQLite and registered evidence',
      'requirement.runningTask': 'Running: {taskId} · {goal} · last activity {time}',
      'requirement.failedTasks': '{count} failed tasks',
      'requirement.clarifications': '{count} clarifications',
      'requirement.stopRequested': 'Stop requested',
      'requirement.unknownCount': '{count} unknown requests',
      'task.awaiting_input': 'Waiting input',
      'task.waitingCard': 'Waiting for input: {taskId} · {goal} · last activity {time}',
      'task.goalTitle': 'Goal',
      'task.dependsOn': 'Depends on',
      'task.verification': 'Verification task',
      'task.resultUnknown': 'Result unknown',
      'task.openDetail': 'View execution',
      'task.openRequirement': 'View requirement',
      'task.heartbeatStale': 'Heartbeat older than 60s; may be stalled, verify on site',
      'task.heartbeatNote': 'Last activity/heartbeat only proves observation time, not progress or completion.',
      'task.waitingInputBanner': 'Recent activity indicates the Agent may be waiting for input (ask_user_question); a heartbeat is not progress.',
      'task.unknownBanner': 'This requirement has an unknown-outcome request: verify the workspace, Git and evidence before retrying or assuming no side effects.',
      'task.stopBanner': 'A stop request is recorded; a stop request is not proof that work has actually stopped.',
      'task.activityMeta': 'Showing the latest {shown} of {total} activity records.',
      'task.testLogMeta': 'Path: {path} · {bytes} bytes',
      'task.testLogTruncated': 'Log truncated: only the last 4000 characters are shown; open the path above for the full log.',
      'task.review': 'Independent review',
      'task.reviewVerdict': 'Verdict',
      'task.reviewSummary': 'Summary',
      'task.reviewFindings': 'Findings',
      'task.reviewBlocking': 'Blocking',
      'task.reviewNone': 'No independent review conclusion (not run, failed, or evidence not on disk).',
      'task.reviewNote': 'This is the latest review persisted on disk; it may not be the direct cause of the current failure.',
      'task.evidence': 'Evidence identity',
      'task.artifact': 'Delivery artifact',
      'task.artifactMissing': 'No delivery artifact yet; the task may be undelivered or evidence not on disk.',
      'task.evidenceMissing': 'No evidence paths recorded.',
      'task.retryNotAllowed': 'Retry not available: {reason}',
      'hint.paths': 'Evidence paths and sessions',
      'detail.original': 'Original requirement',
      'detail.currentVersion': 'Current version v{version}',
      'detail.history': 'Version history ({count} older versions)',
      'detail.versionMeta': 'v{version} · {time} · {by}',
      'detail.analysis': 'Analysis',
      'detail.scenarios': 'Scenarios',
      'detail.technicalSolution': 'Technical solution',
      'detail.approach': 'Approach',
      'detail.risks': 'Risks',
      'detail.plan': 'Task package v{plan}',
      'detail.planTasks': 'Task package',
      'detail.noPlanDetail': 'No task package, or the plan body is unreadable.',
      'detail.openTask': 'View execution',
      'detail.dependsOn': 'Depends on',
      'detail.files': 'Allowed files',
      'detail.delivery': 'Delivery progress and acceptance basis',
      'detail.progressNote': 'Delivered {delivered}/{total} · failed {failed} · running {running} · waiting input {awaitingInput}',
      'detail.artifacts': 'Artifacts and evidence identity',
      'detail.noArtifacts': 'No delivery artifacts yet.',
      'detail.artifactTask': 'Task {taskId}',
      'detail.candidate': 'Candidate digest',
      'detail.testEvidence': 'Test evidence',
      'detail.reviewEvidence': 'Review evidence',
      'detail.authorization': 'Authorization',
      'detail.recordedAt': 'Recorded at',
      'detail.baseline': 'Baseline',
      'detail.acceptanceRecord': 'Acceptance record',
      'detail.acceptedMeta': '{by} · {time} · {source}',
      'detail.notAccepted': 'Not accepted; acceptance still happens in the task-package conversation.',
      'detail.candidatePackage': 'Candidate package',
      'detail.planReview': 'Pre-implementation review',
      'detail.noPlanReview': 'No pre-implementation review yet; approval is blocked.',
      'detail.verification': 'Independent verification',
      'detail.noVerification': 'Independent verification has not completed; acceptance is blocked.',
      'detail.verificationFresh': 'Result bound to the current candidate',
      'detail.verificationStale': 'Result is not bound to the current candidate; verify again',
      'detail.verdict.pass': 'pass',
      'detail.verdict.block': 'block',
      'detail.blocking': 'Blocking reasons',
      'detail.scenarios': 'Verification scenarios',
      'detail.unknownRequest': 'Unknown outcome; verify',
      'detail.clarificationHint': 'Answer in the ForgeLoop business conversation; this page has no answer entry.',
      'action.replan': 'Re-plan',
      'action.replanHelp': 'Copy the current task package, add files and create a new version awaiting approval; it is not auto-approved.',
      'action.replanPrompt': 'Files to add to the failed task (comma or newline separated):',
      'action.replanRecoveryConfirm': 'This requirement has an unknown request. After verifying the workspace, Git and evidence, close it and re-plan?',
      'action.replanned': 'Created task package v{plan}; task {task} now allows {files}; awaiting approval.',
      'action.replannedRecovered': 'Closed {count} unknown request(s).',
      'wb.release': 'Release and runtime',
      'wb.businessReview': 'Business review',
      'wb.candidate': 'Candidate package',
      'wb.deployment': 'Deployment check',
      'action.stop': 'Request stop',
      'action.stopHelp': 'A stop request dismisses pending requests; it does not prove the task has stopped.',
      'action.stopConfirm': 'Request stop for this requirement? Pending requests are dismissed and the result still needs verification.',
      'action.stopReason': 'Stop requested from the Forge workbench',
      'action.cancelReason': 'Cancelled from the Forge workbench',
      'action.stopped': 'Stop requested; verify the result',
      'issue.openTask': 'View task',
      'issue.openRequirement': 'View requirement',
      'issue.taskMeta': 'Task {taskId}',
      'overview.stat.requirements': 'Requirements',
      'overview.stat.active': 'Active',
      'overview.stat.tasks': 'Tasks',
      'overview.stat.delivered': 'Delivered',
      'overview.stat.issues': 'Issues',
      'overview.stat.blocking': 'Blocking',
      'overview.runningTitle': 'Running and waiting for input',
      'overview.runningEmpty': 'No running or waiting-for-input tasks.',
      'overview.attentionTitle': 'Needs attention',
      'overview.attentionEmpty': 'No pending issues.',
      'overview.attentionMore': 'View all {count} issues',
      'overview.nextTitle': 'What can I do next',
      'overview.featuresTitle': 'Workbench capabilities and boundaries',
      'overview.feature.nav': 'Unified navigation: overview / requirements / tasks / issues',
      'overview.feature.search': 'Search requirements, analysis, tasks, failures and request text',
      'overview.feature.detail': 'Requirement text/versions, task package, delivery progress and acceptance basis',
      'overview.feature.debug': 'Execution state, heartbeat, logs, review conclusions and evidence identity',
      'overview.feature.actions': 'Approve, advance, retry, request stop and cancel; acceptance stays in the task-package conversation',
      'overview.boundaryHeartbeat': 'Heartbeat/last activity is not proof of progress; stale heartbeats are marked as possibly stalled.',
      'overview.boundarySource': 'Facts come from SQLite and registered evidence; the page keeps no separate business state.',
      'overview.boundaryStop': 'A stop request is not proof of a stopped task; unknown results need on-site verification.',
      'overview.boundaryAccept': 'The Forge page does not provide acceptance; acceptance stays in the task-package conversation.',
      'overview.boundaryClarification': 'Clarification answers still go through the ForgeLoop business conversation; this page only lists the questions.',
      'overview.boundaryGrant': 'Extra grants and re-planning have no page entry yet; retry is explicitly rejected when the budget is exhausted.',
      'overview.searchScope': 'Search scope: requirement id/status/text/versions, analysis, task goals/files/acceptance, run reasons, failure rounds, request text and issue text; at most 50 results.',
      'overview.next.approvals': '{count} task packages waiting for approval',
      'overview.next.failures': '{count} failed tasks to inspect/retry',
      'overview.next.unknown': '{count} unknown-outcome requests to verify',
      'overview.next.clarifications': '{count} clarifications to answer',
      'overview.next.running': '{count} tasks running or waiting for input',
      'overview.next.none': 'No blocking items; continue tracking tasks or submit a new requirement.',
      'overview.next.submit': 'No requirements yet; submit the first one in a ForgeLoop business conversation.',
      'common.yes': 'Yes',
      'common.no': 'No',
      'filter.task.all': 'All',
      'filter.task.running': 'Running',
      'filter.task.awaiting_input': 'Waiting input',
      'filter.task.failed': 'Failed',
      'filter.task.blocked': 'Blocked',
      'filter.task.awaiting_user': 'Awaiting decision',
      'filter.task.delivered': 'Delivered',
      'filter.task.pending': 'Pending',
      'filter.issue.all': 'All',
      'filter.issue.blocking': 'Blocking',
      'filter.issue.attention': 'Attention',
      'filter.requirement.all': 'All',
      'filter.requirement.active': 'Active',
      'filter.requirement.attention': 'Attention',
      'filter.requirement.draft': 'Draft',
      'task.failureAction': 'Next step',
      'task.noTestLog': 'No formal test log recorded yet.',
      'wb.tree': 'Requirement tree',
      'wb.treeToggle': 'Toggle requirement tree',
      'wb.hierarchy': 'Hierarchy',
      'wb.allTasks': 'All tasks',
      'wb.attention': 'Needs attention',
      'wb.requirement': 'Requirement',
      'wb.task': 'Task',
      'wb.issue': 'Issue',
      'wb.back': 'Back to list',
      'wb.backWorkbench': 'Back to workbench',
      'wb.full': 'Expand details',
      'wb.close': 'Close',
      'wb.overview': 'Overview',
      'wb.relations': 'Dependencies',
      'wb.activity': 'Agent execution',
      'wb.tests': 'Tests & review',
      'wb.changes': 'Changes',
      'wb.taskList': 'Task list',
      'wb.dependencies': 'Dependencies',
      'wb.noSelection': 'Select a requirement, task or issue',
      'wb.noMatch': 'No matching records',
      'wb.clear': 'Clear search and filters',
      'wb.progress': '{delivered}/{total} tasks delivered',
      'wb.plan': 'Task package v{plan}',
      'wb.planLabel': 'Task package',
      'wb.version': 'Requirement v{version}',
      'wb.attempt': 'Attempt',
      'wb.session': 'Session',
      'wb.started': 'Started',
      'wb.lastActivity': 'Last activity',
      'wb.noExecution': 'No Agent execution record to show.',
      'wb.noExecutionHint': 'The task has not started, or this attempt record was not retained.',
      'wb.steps': '{count} collapsed steps',
      'wb.loadMore': 'Load more',
      'wb.newEvents': 'New activity arrived',
      'wb.pause': 'Pause auto-refresh',
      'wb.resume': 'Resume auto-refresh',
      'wb.auto': 'Auto refresh',
      'wb.predecessors': 'Predecessors',
      'wb.successors': 'Successors',
      'wb.wait': 'Waiting for {tasks}',
      'wb.dependencyReady': 'Dependency condition met',
      'wb.noPredecessors': 'No predecessors',
      'wb.noSuccessors': 'No successors',
      'wb.openExecution': 'View Agent execution',
      'wb.related': 'Related objects',
      'wb.copy': 'Copy path',
      'wb.copied': 'Copied',
      'wb.copyFailed': 'Copy unavailable; select the path manually',
      'wb.truncated': 'Truncated; showing available range',
      'wb.testCommand': 'Actual command',
      'wb.exitCode': 'Exit code',
      'wb.duration': 'Duration',
      'wb.path': 'Path',
      'wb.size': 'Size',
      'wb.taskInput': 'Task input',
      'wb.publicMessage': 'Public message',
      'wb.tool': 'Tool call',
      'wb.toolInput': 'Input',
      'wb.toolOutput': 'Output',
      'wb.toolPending': 'Pending',
      'wb.toolFailed': 'Failed',
      'wb.toolCompleted': 'Completed',
      'wb.phase': 'Phase event',
      'wb.attemptUnavailable': 'This historical attempt only has a summary; no separate execution record was retained',
      'wb.history': 'Historical attempts',
      'wb.sessionUnavailable': 'No session identity recorded',
      'wb.noAttempt': 'No attempt to switch',
      'wb.more': 'More',
      'wb.selected': 'Selected',
      'wb.taskCount': '{count} tasks',
      'wb.issueCount': '{count} issues',
      'wb.reqCount': '{count} requirements',
      'wb.workbench': 'Hierarchy workbench',
      'wb.execution': 'Execution record',
      'wb.taskGoal': 'Task goal',
      'wb.acceptance': 'Acceptance',
      'wb.files': 'Allowed files',
      'wb.dependsOn': 'Predecessors',
      'wb.artifact': 'Delivery artifact',
      'wb.failureRounds': 'Failure rounds',
      'wb.versionHistory': 'Version history',
      'wb.approval': 'Approval',
      'wb.planReview': 'Pre-implementation review',
      'wb.verification': 'Independent verification',
      'wb.approved': 'Approval valid',
      'wb.stale': 'Previous approval is stale',
      'wb.missing': 'Not recorded',
      'wb.stopRequested': 'Stop requested; verify',
      'wb.resultUnknown': 'Unknown result; verify',
      'wb.waitingInput': 'Waiting for answer',
      'wb.failed': 'Failed',
      'wb.blocked': 'Blocked',
      'wb.running': 'Running',
      'wb.pendingState': 'Pending',
      'wb.deliveredState': 'Delivered',
      'wb.awaitingUser': 'Awaiting decision',
      'wb.awaitingInput': 'Waiting for answer',
      'wb.executionTotal': '{count} public events',
      'wb.attemptNote': 'Only public text, tool calls and results are shown; hidden reasoning is excluded.',
      'wb.loading': 'Loading…',
      'wb.error': 'Read failed',
      'wb.breadcrumb': 'Path',
      'wb.noActions': 'No customer action is available',
      'wb.openTask': 'Open task',
      'wb.openRequirement': 'Open requirement',
      'wb.openIssue': 'Open issue',
      'wb.noIssues': 'No pending items',
      'wb.planPending': 'Awaiting approval',
      'ops.title': 'Operations events',
      'ops.subtitle': 'Registered resources, read-only diagnosis, authorized recovery and verification',
      'ops.all': 'All',
      'ops.active': 'In progress',
      'ops.total': 'Events',
      'ops.human': 'Human involved',
      'ops.recovered': 'Recovered',
      'ops.unresolved': 'Unresolved',
      'ops.unknown': 'Result unknown',
      'ops.awaiting': 'Awaiting decision',
      'ops.fix': 'Fix requirement',
      'ops.noEvents': 'No matching operations events.',
      'ops.empty': 'No operations events in this project yet.',
      'ops.emptyHint': 'Enable ops and register checks; failing checks will open events here.',
      'ops.loading': 'Reading operations events…',
      'ops.error': 'Could not read operations events',
      'ops.severity.critical': 'Critical',
      'ops.severity.major': 'Major',
      'ops.severity.minor': 'Minor',
      'ops.state.open': 'Detected',
      'ops.state.diagnosed': 'Diagnosed',
      'ops.state.awaiting_decision': 'Awaiting decision',
      'ops.state.recovering': 'Recovering',
      'ops.state.recovered': 'Recovered',
      'ops.state.unresolved': 'Unresolved',
      'ops.state.unknown': 'Result unknown',
      'ops.state.closed': 'Closed',
      'ops.impact': 'Business impact',
      'ops.noImpact': 'No diagnosis yet',
      'ops.facts': 'Facts',
      'ops.hypotheses': 'Hypotheses',
      'ops.proposed': 'Proposed action',
      'ops.noAction': 'No registered action is available; handle it manually or file a fix requirement.',
      'ops.attempts': 'Recovery attempts',
      'ops.noAttempts': 'No recovery action executed',
      'ops.observations': 'Evidence and observations',
      'ops.evidence': 'Evidence',
      'ops.action': 'Action',
      'ops.exit': 'Exit code',
      'ops.resource': 'Resource',
      'ops.check': 'Check',
      'ops.opened': 'First seen',
      'ops.updated': 'Updated',
      'ops.recoveredAt': 'Recovered at',
      'ops.lastObservation': 'Latest observation',
      'ops.humanNote': 'Human involvement',
      'ops.approve': 'Approve action',
      'ops.decline': 'Decline action',
      'ops.confirmUnknown': 'Confirm reconciliation',
      'ops.close': 'Close event',
      'ops.requestFix': 'File fix requirement',
      'ops.approveConfirm': 'The coordinator will execute the registered action; the page will not run it directly. Approve?',
      'ops.declineConfirm': 'The event stays unresolved and no action runs. Decline?',
      'ops.unknownConfirm': 'Only confirm after checking external side effects. Confirm the unknown result has been reconciled?',
      'ops.closeConfirm': 'Closing keeps the evidence and ends the event; it does not undo actions already taken. Close?',
      'ops.done': 'Accepted; waiting for the coordinator',
      'ops.fixCreated': 'Linked fix requirement {req}',
      'ops.fixPending': 'Fix requirement in progress',
      'wb.stopHelp': 'A stop request dismisses pending requests; it does not prove the task has stopped.',
    }

    Object.assign(zh, workbenchZh)
    Object.assign(en, workbenchEn)

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
      running: 'warn',
      awaiting_input: 'warn',
      failed: 'error',
      blocked: 'error',
      awaiting_user: 'warn',
    }

    const ISSUE_TONES = { blocking: 'error', attention: 'warn' }

    const FLOW_CSS = `
.flb-flow{margin:8px 0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.flb-flow[data-kind=error]{border-color:var(--dsw-alias-state-error-primary)}
.flb-flow-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:6px}
.flb-flow-title{font-size:12px;font-weight:600}
.flb-flow-meta{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.flb-flow-label{margin-top:6px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
.flb-flow-text{overflow-wrap:anywhere}
.flb-flow-note{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.flb-flow-list{margin:2px 0 0;padding-left:18px}
.flb-flow-list li{margin:1px 0}
.flb-flow-section{margin-top:6px}
.flb-flow-item{padding:4px 0;border-top:.5px solid var(--dsw-alias-border-l1)}
.flb-flow-item:first-of-type{border-top:none;padding-top:0}
.flb-flow-item-title{font-weight:600;overflow-wrap:anywhere}
.flb-flow-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}
.flb-flow-action{padding:3px 10px;border:.5px solid var(--dsw-alias-state-business-primary);border-radius:6px;background:transparent;color:var(--dsw-alias-state-business-primary);font-size:12px;cursor:pointer}
.flb-flow-action:disabled{opacity:.5;cursor:default}
.flb-flow-action-message{font-size:11px;color:var(--dsw-alias-label-secondary)}
.flb-flow-input{width:100%;box-sizing:border-box;margin-top:3px;padding:4px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:11px ui-monospace,SFMono-Regular,Menlo,monospace}
.flb-flow-muted{color:var(--dsw-alias-label-secondary)}
`

    function flowNodeDefinition(kind, eventType) {
      return {
        kind,
        target: 'chat',
        match(event) {
          if (!event || event.type !== eventType) return null
          const data = event.data || {}
          const id = data.eventId || data.reqId || data.seq || 'unknown'
          return { id: String(id), role: 'start' }
        },
        start(_context, match) {
          return match.event.data || {}
        },
        update(_context, match) {
          return match.event.data || {}
        },
        buildViewNode(context) {
          if (!context.start) return null
          return {
            key: context.key,
            kind,
            id: context.id,
            target: 'chat',
            anchorSeq: context.start.event.seq,
            location: context.start.location,
            visibility: 'visible',
            data: context.state || {},
          }
        },
      }
    }

    function listItems(t, title, items, key) {
      if (!Array.isArray(items) || items.length === 0) return null
      return h(
        'div',
        { key },
        h('div', { className: 'flb-flow-label' }, title),
        h('ul', { className: 'flb-flow-list' }, items.map((item, index) => h('li', { key: `${key}-${index}` }, String(item)))),
      )
    }

    function IntakeNodeView(props) {
      const t = props.t
      const data = (props.node && props.node.data) || {}
      return h(
        'article',
        { className: 'flb-flow', 'data-kind': 'intake' },
        h('style', null, FLOW_CSS),
        h(
          'div',
          { className: 'flb-flow-head' },
          h('span', { className: 'flb-flow-title' }, t('node.intake.title')),
          data.reqId ? h('span', { className: 'flb-flow-meta' }, t('node.intake.req', { reqId: data.reqId })) : null,
        ),
        h('div', { className: 'flb-flow-label' }, t('node.intake.text')),
        h('div', { className: 'flb-flow-text' }, data.text || ''),
        h('div', { className: 'flb-flow-note' }, t('node.intake.status')),
      )
    }

    function AnalysisNodeView(props) {
      const t = props.t
      const data = (props.node && props.node.data) || {}
      return h(
        'article',
        { className: 'flb-flow', 'data-kind': 'analysis' },
        h('style', null, FLOW_CSS),
        h(
          'div',
          { className: 'flb-flow-head' },
          h('span', { className: 'flb-flow-title' }, t('node.analysis.title')),
          data.reqId ? h('span', { className: 'flb-flow-meta' }, t('node.intake.req', { reqId: data.reqId })) : null,
          data.analysisVersion
            ? h(
                'span',
                { className: 'flb-flow-meta' },
                t('node.analysis.version', {
                  analysisVersion: data.analysisVersion,
                  requirementVersion: data.requirementVersion,
                }),
              )
            : null,
        ),
        h('div', { className: 'flb-flow-label' }, t('node.analysis.goal')),
        h('div', { className: 'flb-flow-text' }, data.goal || ''),
        listItems(t, t('node.analysis.scenarios'), data.scenarios, 'scenarios'),
        listItems(t, t('node.analysis.acceptance'), data.acceptanceCriteria, 'acceptance'),
        listItems(t, t('node.analysis.clarifications'), data.clarifications, 'clarifications'),
      )
    }

    function ErrorNodeView(props) {
      const t = props.t
      const data = (props.node && props.node.data) || {}
      return h(
        'article',
        { className: 'flb-flow', 'data-kind': 'error' },
        h('style', null, FLOW_CSS),
        h(
          'div',
          { className: 'flb-flow-head' },
          h('span', { className: 'flb-flow-title' }, t('node.error.title')),
          data.reqId ? h('span', { className: 'flb-flow-meta' }, t('node.error.req', { reqId: data.reqId })) : null,
        ),
        h('div', { className: 'flb-flow-text' }, data.message || ''),
      )
    }

    function ClarificationNodeView(props) {
      const t = props.t
      const data = (props.node && props.node.data) || {}
      return h(
        'article',
        { className: 'flb-flow', 'data-kind': 'clarification' },
        h('style', null, FLOW_CSS),
        h(
          'div',
          { className: 'flb-flow-head' },
          h('span', { className: 'flb-flow-title' }, t('node.clarification.title')),
          data.reqId ? h('span', { className: 'flb-flow-meta' }, t('node.intake.req', { reqId: data.reqId })) : null,
        ),
        listItems(t, t('node.clarification.questions'), data.questions, 'questions'),
      )
    }

    function AnswerNodeView(props) {
      const t = props.t
      const data = (props.node && props.node.data) || {}
      return h(
        'article',
        { className: 'flb-flow', 'data-kind': 'answer' },
        h('style', null, FLOW_CSS),
        h(
          'div',
          { className: 'flb-flow-head' },
          h('span', { className: 'flb-flow-title' }, t('node.answer.title')),
          data.reqId ? h('span', { className: 'flb-flow-meta' }, t('node.intake.req', { reqId: data.reqId })) : null,
          data.requirementVersion
            ? h('span', { className: 'flb-flow-meta' }, t('node.answer.version', { version: data.requirementVersion }))
            : null,
        ),
        h('div', { className: 'flb-flow-text' }, data.answer || ''),
      )
    }

    function PlanNodeView(props) {
      const t = props.t
      const data = (props.node && props.node.data) || {}
      const solution = data.technicalSolution || null
      const tasks = Array.isArray(data.tasks) ? data.tasks : []
      const [detail, setDetail] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [artifactSha, setArtifactSha] = React.useState('')

      const readDetail = React.useCallback(
        (alive) => {
          const reader = createReader(t)
          return reader('detail', { reqId: data.reqId })
            .then((value) => {
              if (alive()) setDetail(value)
              return value
            })
            .catch((error) => {
              if (alive()) setMessage((error && error.message) || '')
              throw error
            })
        },
        [data.reqId],
      )

      React.useEffect(() => {
        let active = true
        readDetail(() => active).catch(() => undefined)
        return () => {
          active = false
        }
      }, [readDetail])

      React.useEffect(() => {
        if (!artifactSha && detail && detail.candidate && detail.candidate.sha256) {
          setArtifactSha(detail.candidate.sha256)
        }
      }, [detail, artifactSha])

      const approved = Boolean(detail && detail.approval)
      const delivered = detail && Array.isArray(detail.delivered) ? detail.delivered.length : 0
      const accepted = Boolean(detail && detail.status === 'accepted')
      const allDelivered = tasks.length > 0 && delivered >= tasks.length
      const running = detail && (detail.status === 'executing' || detail.status === 'approved') && !accepted
      const review = detail && detail.planReview ? detail.planReview : null
      const verification = detail && detail.verification ? detail.verification : null
      const verificationPassed = Boolean(verification && verification.verdict === 'pass' && verification.fresh)

      React.useEffect(() => {
        if (!running) return undefined
        let active = true
        const timer = setInterval(() => {
          readDetail(() => active).catch(() => undefined)
        }, 3000)
        return () => {
          active = false
          clearInterval(timer)
        }
      }, [running, readDetail])

      const act = (endpoint) => {
        if (busy) return
        setBusy(endpoint)
        setMessage('')
        const reader = createReader(t)
        reader(endpoint, {
          reqId: data.reqId,
          planVersion: data.planVersion,
          sessionId: props.sessionId,
          ...(endpoint === 'accept' && artifactSha ? { artifactSha256: artifactSha } : {}),
          ...(endpoint === 'stop' ? { reason: '从任务包卡片停止' } : {}),
        })
          .then((value) => {
            setMessage(
              endpoint === 'approve'
                ? t('node.plan.approved')
                : endpoint === 'accept'
                  ? t('node.plan.accepted')
                  : endpoint === 'plan'
                    ? t('node.plan.planRequested')
                    : endpoint === 'verify'
                      ? t('node.plan.verifyQueued')
                      : endpoint === 'stop'
                        ? t('node.plan.stopped')
                        : t('node.plan.advanceAccepted', { requestId: value && value.requestId ? value.requestId : '' }),
            )
            return readDetail(() => true)
          })
          .catch((error) => setMessage((error && error.message) || String(error)))
          .finally(() => setBusy(''))
      }

      return h(
        'article',
        { className: 'flb-flow', 'data-kind': 'plan' },
        h('style', null, FLOW_CSS),
        h(
          'div',
          { className: 'flb-flow-head' },
          h('span', { className: 'flb-flow-title' }, t('node.plan.title')),
          data.reqId ? h('span', { className: 'flb-flow-meta' }, t('node.intake.req', { reqId: data.reqId })) : null,
          h(
            'span',
            { className: 'flb-flow-meta' },
            t('node.plan.version', {
              planVersion: data.planVersion || 0,
              requirementVersion: data.requirementVersion || 0,
            }),
          ),
        ),
        solution
          ? h(
              'div',
              { className: 'flb-flow-section' },
              h('div', { className: 'flb-flow-label' }, t('node.plan.solution')),
              h('div', { className: 'flb-flow-text' }, solution.summary || ''),
              listItems(t, t('node.plan.approach'), solution.approach, 'approach'),
              listItems(t, t('node.plan.risks'), solution.risks, 'risks'),
            )
          : null,
        tasks.length > 0
          ? h(
              'div',
              { className: 'flb-flow-section' },
              h('div', { className: 'flb-flow-label' }, t('node.plan.tasks')),
              h(
                'div',
                { className: 'flb-flow-list' },
                tasks.map((task, index) =>
                  h(
                    'div',
                    { className: 'flb-flow-item', key: `${task.taskId}:${index}` },
                    h(
                      'div',
                      { className: 'flb-flow-item-title' },
                      `${task.taskId} · ${task.goal}`,
                      task.verification ? ` · ${t('node.plan.verification')}` : '',
                    ),
                    Array.isArray(task.files) && task.files.length
                      ? h('div', { className: 'flb-flow-meta' }, `${t('node.plan.files')}: ${task.files.join(', ')}`)
                      : null,
                    Array.isArray(task.dependsOn) && task.dependsOn.length
                      ? h('div', { className: 'flb-flow-meta' }, `${t('node.plan.depends')}: ${task.dependsOn.join(', ')}`)
                      : null,
                  ),
                ),
              ),
            )
          : null,
        detail
          ? h(
              'div',
              { className: 'flb-flow-section' },
              h('div', { className: 'flb-flow-label' }, t('node.plan.review')),
              review
                ? h(
                    'div',
                    { className: 'flb-flow-text' },
                    `${t(`detail.verdict.${review.verdict}`)} · ${review.summary || '—'}`,
                  )
                : h('div', { className: 'flb-flow-meta' }, t('node.plan.reviewMissing')),
              review && Array.isArray(review.blocking) && review.blocking.length > 0
                ? listItems(t, t('detail.blocking'), review.blocking, 'review-blocking')
                : null,
              h('div', { className: 'flb-flow-label' }, t('node.plan.verificationState')),
              verification
                ? h(
                    'div',
                    { className: 'flb-flow-text' },
                    [
                      t(`detail.verdict.${verification.verdict}`),
                      verification.fresh ? t('detail.verificationFresh') : t('detail.verificationStale'),
                      verification.summary || '—',
                    ].join(' · '),
                  )
                : h('div', { className: 'flb-flow-meta' }, t('node.plan.verificationMissing')),
              verification && Array.isArray(verification.blocking) && verification.blocking.length > 0
                ? listItems(t, t('detail.blocking'), verification.blocking, 'verification-blocking')
                : null,
              verification && Array.isArray(verification.scenarios) && verification.scenarios.length > 0
                ? h(
                    'div',
                    { className: 'flb-flow-meta' },
                    `${t('detail.scenarios')}: ${verification.scenarios
                      .map((scenario) => `${scenario.scenario}（${scenario.status}）`)
                      .join('；')}`,
                  )
                : null,
            )
          : null,
        detail && detail.candidate
          ? h(
              'div',
              { className: 'flb-flow-section' },
              h('label', { className: 'flb-flow-label' }, t('node.plan.candidate')),
              h('div', { className: 'flb-flow-meta' }, t('node.plan.candidateHint')),
              h('input', {
                className: 'flb-flow-input',
                type: 'text',
                value: artifactSha,
                spellCheck: false,
                onChange: (event) => setArtifactSha(event.target.value.trim()),
              }),
            )
          : null,
        h(
          'div',
          { className: 'flb-flow-actions' },
          detail
            ? h('span', { className: 'flb-flow-meta' }, t('node.plan.progress', { delivered, total: tasks.length }))
            : null,
          detail && !approved && detail.status === 'plan_proposed'
            ? review && review.verdict === 'pass'
              ? h(
                  'button',
                  { type: 'button', className: 'flb-flow-action', disabled: Boolean(busy), onClick: () => act('approve') },
                  busy === 'approve' ? t('node.plan.busy') : t('node.plan.approve'),
                )
              : h(
                  'button',
                  { type: 'button', className: 'flb-flow-action', disabled: Boolean(busy), onClick: () => act('plan') },
                  busy === 'plan' ? t('node.plan.busy') : t('node.plan.regenerate'),
                )
            : null,
          approved && !allDelivered && !accepted && detail.status !== 'blocked'
            ? h(
                'button',
                { type: 'button', className: 'flb-flow-action', disabled: Boolean(busy), onClick: () => act('advance') },
                busy === 'advance' ? t('node.plan.busy') : t('node.plan.advance'),
              )
            : null,
          approved && allDelivered && !accepted && detail.status !== 'blocked' && !verificationPassed
            ? h(
                'button',
                { type: 'button', className: 'flb-flow-action', disabled: Boolean(busy), onClick: () => act('verify') },
                busy === 'verify' ? t('node.plan.busy') : t('node.plan.verify'),
              )
            : null,
          approved && allDelivered && !accepted && detail.status !== 'blocked' && verificationPassed
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'flb-flow-action',
                  disabled: Boolean(busy) || Boolean(detail.candidate && !artifactSha),
                  onClick: () => act('accept'),
                },
                busy === 'accept' ? t('node.plan.busy') : t('node.plan.accept'),
              )
            : null,
          approved && !accepted
            ? h(
                'button',
                { type: 'button', className: 'flb-flow-action', disabled: Boolean(busy), onClick: () => act('stop') },
                busy === 'stop' ? t('node.plan.busy') : t('node.plan.stop'),
              )
            : null,
          message ? h('span', { className: 'flb-flow-action-message' }, message) : null,
        ),
      )
    }

    const FLOW_NODES = [
      {
        definition: flowNodeDefinition('forgeloop-intake', 'plugin:forgeloop/intake'),
        key: 'forgeloop-intake',
        component: IntakeNodeView,
      },
      {
        definition: flowNodeDefinition('forgeloop-analysis', 'plugin:forgeloop/analysis'),
        key: 'forgeloop-analysis',
        component: AnalysisNodeView,
      },
      {
        definition: flowNodeDefinition('forgeloop-error', 'plugin:forgeloop/error'),
        key: 'forgeloop-error',
        component: ErrorNodeView,
      },
      {
        definition: flowNodeDefinition('forgeloop-clarification', 'plugin:forgeloop/clarification-request'),
        key: 'forgeloop-clarification',
        component: ClarificationNodeView,
      },
      {
        definition: flowNodeDefinition('forgeloop-answer', 'plugin:forgeloop/clarification-answer'),
        key: 'forgeloop-answer',
        component: AnswerNodeView,
      },
      {
        definition: flowNodeDefinition('forgeloop-plan', 'plugin:forgeloop/plan'),
        key: 'forgeloop-plan',
        component: PlanNodeView,
      },
    ]

    function statusLabel(t, status) {
      const key = `status.${status}`
      const label = t(key)
      return label === key ? t('status.unknown') : label
    }

    /** 评审与验证是批/验收的硬门禁；没有结论时显示“未评审/未验证”，不冒充通过。 */
    function planReviewChip(t, review) {
      if (!review) return h(Chip, { tone: 'warn' }, t('requirement.planReviewMissing'))
      return h(
        Chip,
        { tone: review.verdict === 'pass' ? 'success' : 'error' },
        t(review.verdict === 'pass' ? 'requirement.planReviewPassed' : 'requirement.planReviewBlocked'),
      )
    }

    function verificationChip(t, verification) {
      if (!verification) return h(Chip, { tone: 'warn' }, t('requirement.verificationMissing'))
      if (verification.verdict !== 'pass') {
        return h(Chip, { tone: 'error' }, t('requirement.verificationBlocked'))
      }
      return h(
        Chip,
        { tone: verification.fresh ? 'success' : 'warn' },
        t(verification.fresh ? 'requirement.verificationPassed' : 'requirement.verificationStale'),
      )
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
          const error = new Error(message || `${t('error.request')}（HTTP ${response.status}）`)
          error.code = payload && payload.error && payload.error.code
          throw error
        }
        if (!payload || payload.ok !== true) {
          const message = payload && payload.error && payload.error.message
          const error = new Error(message || t('error.request'))
          error.code = payload && payload.error && payload.error.code
          throw error
        }
        return payload.value
      }
    }

    const TAIL_CSS = `
.flb-tail{margin:12px 0 4px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.flb-tail-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
.flb-tail-title{font-size:12px;font-weight:600}
.flb-tail-count{font-size:11px;color:var(--dsw-alias-label-secondary)}
.flb-tail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (max-width:640px){.flb-tail-grid{grid-template-columns:minmax(0,1fr)}}
.flb-tail-col{min-width:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px}
.flb-tail-col[data-kind=needs]{border-color:var(--dsw-alias-state-warning-primary)}
.flb-tail-col-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:6px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
.flb-tail-card{padding:6px 0;border-top:.5px solid var(--dsw-alias-border-l1)}
.flb-tail-card:first-of-type{border-top:none;padding-top:0}
.flb-tail-card-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.flb-tail-card-title{font-weight:600;overflow-wrap:anywhere}
.flb-tail-card-meta{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.flb-tail-card-goal{margin-top:2px;color:var(--dsw-alias-label-primary)}
.flb-tail-questions{margin:2px 0 0;padding-left:18px;color:var(--dsw-alias-label-secondary)}
.flb-tail-empty{padding:2px 0;color:var(--dsw-alias-label-secondary)}
`

    function RequirementsTail(props) {
      const t = props.t
      const preset = typeof props.useProjection === 'function' ? props.useProjection('agentPreset') : undefined
      const [state, setState] = React.useState({ phase: 'idle', data: null })
      React.useEffect(() => {
        if (preset !== 'forgeloop' || !props.sessionId) return undefined
        let alive = true
        const reader = createReader(t)
        const tick = () => {
          reader('session', { sessionId: props.sessionId }, undefined)
            .then((value) => {
              if (alive) setState({ phase: 'ready', data: value })
            })
            .catch(() => {
              if (alive) setState({ phase: 'error', data: null })
            })
        }
        tick()
        const timer = setInterval(tick, 4000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [preset, props.sessionId, props.seq])
      if (preset !== 'forgeloop') return null
      const requirements = (state.data && state.data.requirements) || []
      if (requirements.length === 0) return null
      const needs = requirements.filter((item) => Array.isArray(item.clarifications) && item.clarifications.length > 0)
      const clear = requirements.filter((item) => !Array.isArray(item.clarifications) || item.clarifications.length === 0)

      const card = (item, index) =>
        h(
          'article',
          { className: 'flb-tail-card', key: `${item.reqId}:${index}` },
          h(
            'div',
            { className: 'flb-tail-card-head' },
            h('span', { className: 'flb-tail-card-title' }, item.title || item.reqId),
            h('span', { className: 'flb-tail-card-meta' }, item.reqId),
            h('span', { className: 'flb-tail-card-meta' }, t('tail.version', { version: item.version })),
            h('span', { className: 'flb-tail-card-meta' }, item.status === 'accepted' ? statusLabel(t, item.status) : item.approved ? t('tail.approved') : statusLabel(t, item.status)),
            item.taskCount
              ? h('span', { className: 'flb-tail-card-meta' }, t('tail.progress', { delivered: item.delivered || 0, total: item.taskCount }))
              : null,
          ),
          item.goal ? h('div', { className: 'flb-tail-card-goal' }, item.goal) : null,
          Array.isArray(item.clarifications) && item.clarifications.length > 0
            ? h(
                'ul',
                { className: 'flb-tail-questions' },
                item.clarifications.map((question, questionIndex) =>
                  h('li', { key: `${item.reqId}-q-${questionIndex}` }, String(question)),
                ),
              )
            : null,
        )

      const column = (kind, title, items) =>
        h(
          'section',
          { className: 'flb-tail-col', 'data-kind': kind },
          h(
            'div',
            { className: 'flb-tail-col-head' },
            h('span', null, title),
            h('span', { className: 'flb-tail-count' }, String(items.length)),
          ),
          items.length === 0 ? h('div', { className: 'flb-tail-empty' }, t('tail.empty')) : items.map(card),
        )

      return h(
        'section',
        { className: 'flb-tail' },
        h('style', null, TAIL_CSS),
        h(
          'div',
          { className: 'flb-tail-head' },
          h('span', { className: 'flb-tail-title' }, t('tail.title')),
          h('span', { className: 'flb-tail-count' }, String(requirements.length)),
        ),
        h(
          'div',
          { className: 'flb-tail-grid' },
          column('needs', t('tail.needs'), needs),
          column('clear', t('tail.clear'), clear),
        ),
      )
    }

    function isFailureState(state) {
      return state === 'failed' || state === 'blocked' || state === 'awaiting_user'
    }

    function shortSha(value) {
      if (!value) return '—'
      return value.length > 16 ? `${value.slice(0, 16)}…` : value
    }

    function formatMoment(value) {
      if (!value) return '—'
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
    }

    function heartbeatStale(lastActivity) {
      if (!lastActivity) return false
      const at = Date.parse(lastActivity)
      return Number.isFinite(at) && Date.now() - at > 60_000
    }

    function Banner(props) {
      return h(
        'div',
        { className: 'flb-banner', 'data-tone': props.tone || 'info', role: props.role || 'status' },
        props.children,
      )
    }

    function Muted(props) {
      return h('div', { className: 'flb-muted' }, props.children)
    }

    function Section(props) {
      return h(
        'section',
        { className: 'flb-section' },
        h('div', { className: 'flb-section-title' }, props.title),
        ...(Array.isArray(props.children) ? props.children : [props.children]),
      )
    }

    function BulletList(props) {
      const items = Array.isArray(props.items) ? props.items : []
      if (items.length === 0) return h('div', { className: 'flb-muted' }, props.empty || '—')
      return h(
        'ul',
        { className: 'flb-bullets' },
        items.map((item, index) => h('li', { key: index }, String(item))),
      )
    }

    function Kv(props) {
      return h(
        'div',
        { className: 'flb-kv' },
        h('span', { className: 'flb-kv-label' }, props.label),
        h('span', { className: 'flb-kv-value' }, props.children === undefined ? '—' : props.children),
      )
    }

    function ActionButtons(props) {
      const t = props.t
      const actions = Array.isArray(props.actions) ? props.actions : []
      const labels = {
        plan: t('action.plan'),
        approve: t('action.approve'),
        advance: t('action.advance'),
        verify: t('action.verify'),
        rework: t('action.rework'),
        build: t('action.build'),
        deploy: t('action.deploy'),
        replan: t('action.replan'),
        stop: t('action.stop'),
        cancel: t('action.cancel'),
      }
      const titles = {
        plan: t('action.planHelp'),
        verify: t('action.verifyHelp'),
        rework: t('action.reworkHelp'),
        build: t('action.buildHelp'),
        deploy: t('action.deployHelp'),
        replan: t('action.replanHelp'),
        stop: t('action.stopHelp'),
      }
      return h(
        'div',
        { className: 'flb-card-actions' },
        actions.map((action) =>
          h(
            'button',
            {
              type: 'button',
              key: action,
              className: 'flb-card-action',
              'data-tone': action === 'cancel' || action === 'stop' ? 'danger' : undefined,
              disabled: props.busy,
              title: titles[action],
              onClick: (event) => {
                event.stopPropagation()
                props.onAction(action)
              },
            },
            props.busy === action ? t('action.busy') : labels[action] || action,
          ),
        ),
      )
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
            : requirement.approvalMissing
      const runningTask = (props.tasks || []).find(
        (task) => task.state === 'running' || task.state === 'awaiting_input',
      )
      const failedTasks = (props.tasks || []).filter((task) => isFailureState(task.state))
      const actions = Array.isArray(requirement.actions) ? requirement.actions : []
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
        requirement.planVersion === null
          ? null
          : planReviewChip(t, requirement.planReview),
        requirement.verification
          ? verificationChip(t, requirement.verification)
          : progress.total > 0 && progress.delivered === progress.total
            ? verificationChip(t, null)
            : null,
        requirement.stopRequested ? h(Chip, { tone: 'warn' }, t('requirement.stopRequested')) : null,
        requirement.unknownRequests > 0
          ? h(Chip, { tone: 'error' }, t('requirement.unknownCount', { count: requirement.unknownRequests }))
          : null,
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
          h('span', null, formatMoment(requirement.updatedAt)),
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
          requirement.clarifications > 0
            ? h('span', null, t('requirement.clarifications', { count: requirement.clarifications }))
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
          ? h(
              'div',
              { className: 'flb-card-meta' },
              t('requirement.progress', progress),
              failedTasks.length > 0 ? ` · ${t('requirement.failedTasks', { count: failedTasks.length })}` : '',
            )
          : null,
        runningTask
          ? h(
              'div',
              { className: 'flb-card-running' },
              runningTask.state === 'awaiting_input'
                ? t('task.waitingCard', {
                    taskId: runningTask.taskId,
                    goal: runningTask.goal,
                    time: runningTask.lastActivity ? formatTime(runningTask.lastActivity) : '—',
                  })
                : t('task.runningTask', {
                    taskId: runningTask.taskId,
                    goal: runningTask.goal,
                    time: runningTask.lastActivity ? formatTime(runningTask.lastActivity) : '—',
                  }),
            )
          : null,
        actions.length > 0
          ? h(ActionButtons, {
              t,
              actions,
              busy: props.busy,
              onAction: (endpoint) => props.onAction(requirement, endpoint),
            })
          : null,
        props.actionMessage ? h('div', { className: 'flb-card-action-message' }, props.actionMessage) : null,
        open ? h(RequirementDetail, props) : null,
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
      const plan = data.latestPlan || null
      const versions = Array.isArray(data.versions) ? data.versions : []
      const latestText = versions.length > 0 ? versions[versions.length - 1].text : ''
      const planTasks = plan && Array.isArray(plan.tasks) ? plan.tasks : []
      const boardTaskById = new Map((props.tasks || []).map((task) => [task.taskId, task]))
      const artifacts = Array.isArray(data.artifacts) ? data.artifacts : []
      const artifactByTask = new Map(artifacts.map((artifact) => [artifact.taskId, artifact]))
      const failures = Array.isArray(data.failureRoundDetails) ? data.failureRoundDetails : []
      const requests = Array.isArray(data.pendingRequests) ? data.pendingRequests : []
      const progress = data.progress || { total: 0, delivered: 0 }
      const acceptance = data.acceptanceRecord || {}
      const review = data.planReview || null
      const verification = data.verification || null
      const sections = []

      sections.push(
        Section({
          title: t('detail.original'),
          children: [
            h(
              'div',
              { className: 'flb-card-meta', key: 'meta' },
              t('detail.currentVersion', { version: versions.length || 1 }),
              h('span', null, formatMoment(versions[versions.length - 1]?.createdAt)),
            ),
            h('pre', { className: 'flb-text-block', key: 'text' }, latestText || '—'),
            versions.length > 1
              ? h(
                  'details',
                  { className: 'flb-details', key: 'history' },
                  h('summary', null, t('detail.history', { count: versions.length - 1 })),
                  versions.map((version) =>
                    h(
                      'div',
                      { className: 'flb-version', key: version.version },
                      h(
                        'div',
                        { className: 'flb-card-meta' },
                        t('detail.versionMeta', {
                          version: version.version,
                          time: formatMoment(version.createdAt),
                          by: version.revisedBy || '—',
                        }),
                      ),
                      h('pre', { className: 'flb-text-block' }, version.text),
                    ),
                  ),
                )
              : null,
          ],
        }),
      )

      sections.push(
        Section({
          title: t('detail.analysis'),
          children: analysis
            ? [
                h(Kv, { key: 'goal', label: t('detail.goal') }, analysis.goal),
                h('div', { className: 'flb-label', key: 'scenarios' }, t('detail.scenarios')),
                h(BulletList, { key: 'scenario-list', items: analysis.scenarios }),
                h('div', { className: 'flb-label', key: 'acceptance' }, t('detail.acceptance')),
                h(BulletList, { key: 'acceptance-list', items: analysis.acceptanceCriteria }),
                analysis.clarifications.length > 0
                  ? h(
                      'div',
                      { className: 'flb-block-warn', key: 'clarifications' },
                      h('div', { className: 'flb-label' }, t('detail.clarifications')),
                      h(BulletList, { items: analysis.clarifications }),
                      h('div', { className: 'flb-muted' }, t('detail.clarificationHint')),
                    )
                  : null,
              ]
            : [h('div', { className: 'flb-muted', key: 'none' }, t('detail.noAnalysis'))],
        }),
      )

      sections.push(
        Section({
          title: plan ? t('detail.plan', { plan: plan.planVersion }) : t('detail.planTasks'),
          children: plan
            ? [
                plan.technicalSolution
                  ? h(
                      'div',
                      { className: 'flb-subsection', key: 'solution' },
                      h('div', { className: 'flb-label' }, t('detail.technicalSolution')),
                      h('div', { className: 'flb-text' }, plan.technicalSolution.summary),
                      h('div', { className: 'flb-label' }, t('detail.approach')),
                      h(BulletList, { items: plan.technicalSolution.approach }),
                      plan.technicalSolution.risks.length > 0
                        ? h('div', { className: 'flb-label' }, t('detail.risks'))
                        : null,
                      plan.technicalSolution.risks.length > 0
                        ? h(BulletList, { items: plan.technicalSolution.risks })
                        : null,
                    )
                  : null,
                ...planTasks.map((task) => {
                  const boardTask = boardTaskById.get(task.taskId)
                  const state = boardTask ? boardTask.state : artifactByTask.has(task.taskId) ? 'delivered' : 'pending'
                  return h(
                    'div',
                    { className: 'flb-plan-task', key: task.taskId },
                    h(
                      'div',
                      { className: 'flb-plan-task-head' },
                      h(Chip, { tone: TASK_TONES[state] || 'idle' }, t(`task.${state}`)),
                      h('span', { className: 'flb-detail-code' }, task.taskId),
                      task.verification ? h(Chip, { tone: 'idle' }, t('task.verification')) : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'flb-link-button',
                          onClick: (event) => {
                            event.stopPropagation()
                            props.onOpenTask(boardTask || { reqId: data.reqId, planVersion: plan.planVersion, taskId: task.taskId, goal: task.goal })
                          },
                        },
                        t('detail.openTask'),
                      ),
                    ),
                    h('div', { className: 'flb-text' }, task.goal),
                    h(
                      'div',
                      { className: 'flb-card-meta' },
                      `${t('detail.dependsOn')}: ${task.dependsOn.join('、') || '—'} · ${t(
                        'detail.files',
                      )}: ${task.files.join('、') || '—'}`,
                    ),
                    h('div', { className: 'flb-muted' }, `${t('task.acceptance')}: ${task.acceptance}`),
                  )
                }),
              ]
            : [h('div', { className: 'flb-muted', key: 'no-plan' }, t('detail.noPlanDetail'))],
        }),
      )

      const ratio = progress.total > 0 ? Math.round((progress.delivered / progress.total) * 100) : 0
      sections.push(
        Section({
          title: t('detail.verification'),
          children: [
            h('div', { className: 'flb-label', key: 'review-label' }, t('detail.planReview')),
            review
              ? h(
                  'div',
                  { className: 'flb-text', key: 'review-summary' },
                  `${t(`detail.verdict.${review.verdict}`)} · ${review.summary || '—'}`,
                )
              : h('div', { className: 'flb-muted', key: 'no-review' }, t('detail.noPlanReview')),
            review && Array.isArray(review.blocking) && review.blocking.length > 0
              ? h('div', { className: 'flb-label', key: 'review-blocking-label' }, t('detail.blocking'))
              : null,
            review && Array.isArray(review.blocking) && review.blocking.length > 0
              ? h(BulletList, { key: 'review-blocking', items: review.blocking })
              : null,
            h('div', { className: 'flb-label', key: 'verification-label' }, t('detail.verification')),
            verification
              ? h(
                  'div',
                  { className: 'flb-text', key: 'verification-summary' },
                  [
                    t(`detail.verdict.${verification.verdict}`),
                    verification.fresh ? t('detail.verificationFresh') : t('detail.verificationStale'),
                    verification.summary || '—',
                  ].join(' · '),
                )
              : h('div', { className: 'flb-muted', key: 'no-verification' }, t('detail.noVerification')),
            verification && Array.isArray(verification.blocking) && verification.blocking.length > 0
              ? h('div', { className: 'flb-label', key: 'verification-blocking-label' }, t('detail.blocking'))
              : null,
            verification && Array.isArray(verification.blocking) && verification.blocking.length > 0
              ? h(BulletList, { key: 'verification-blocking', items: verification.blocking })
              : null,
            verification && Array.isArray(verification.scenarios) && verification.scenarios.length > 0
              ? h('div', { className: 'flb-label', key: 'scenarios-label' }, t('detail.scenarios'))
              : null,
            verification && Array.isArray(verification.scenarios) && verification.scenarios.length > 0
              ? h(
                  'div',
                  { key: 'scenarios' },
                  verification.scenarios.map((scenario) =>
                    h(
                      'div',
                      { className: 'flb-evidence', key: scenario.scenario },
                      h('div', { className: 'flb-text' }, `${scenario.scenario} · ${scenario.status}`),
                      scenario.evidence ? h('div', { className: 'flb-card-meta' }, scenario.evidence) : null,
                    ),
                  ),
                )
              : null,
          ],
        }),
      )
      sections.push(
        Section({
          title: t('detail.delivery'),
          children: [
            h(
              'div',
              { className: 'flb-progress', key: 'progress' },
              h('span', { style: { width: `${ratio}%` } }),
            ),
            h(
              'div',
              { className: 'flb-card-meta', key: 'progress-meta' },
              t('detail.progressNote', {
                delivered: progress.delivered,
                total: progress.total,
                failed: progress.failed || 0,
                running: progress.running || 0,
                awaitingInput: progress.awaitingInput || 0,
              }),
            ),
            h('div', { className: 'flb-label', key: 'artifacts-label' }, t('detail.artifacts')),
            artifacts.length === 0
              ? h('div', { className: 'flb-muted', key: 'no-artifacts' }, t('detail.noArtifacts'))
              : artifacts.map((artifact) =>
                  h(
                    'div',
                    { className: 'flb-evidence', key: artifact.taskId },
                    h('div', { className: 'flb-text' }, t('detail.artifactTask', { taskId: artifact.taskId })),
                    h(
                      'div',
                      { className: 'flb-card-meta' },
                      `${t('detail.candidate')}: ${shortSha(artifact.candidateSha256)} · ${t(
                        'detail.testEvidence',
                      )}: ${shortSha(artifact.testEvidenceSha256)} · ${t('detail.reviewEvidence')}: ${shortSha(
                        artifact.reviewSha256,
                      )}`,
                    ),
                    h(
                      'div',
                      { className: 'flb-card-meta' },
                      `${t('detail.authorization')}: ${artifact.authorizationSource || '—'} · ${t(
                        'detail.recordedAt',
                      )}: ${formatMoment(artifact.recordedAt)} · ${t('detail.baseline')}: ${shortSha(
                        artifact.baselineCommit,
                      )}`,
                    ),
                  ),
                ),
            h('div', { className: 'flb-label', key: 'acceptance-label' }, t('detail.acceptanceRecord')),
            acceptance.accepted_at
              ? h(
                  'div',
                  { className: 'flb-text', key: 'accepted' },
                  t('detail.acceptedMeta', {
                    by: acceptance.accepted_by || '—',
                    time: formatMoment(acceptance.accepted_at),
                    source: acceptance.acceptance_source || '—',
                  }),
                )
              : h('div', { className: 'flb-muted', key: 'not-accepted' }, t('detail.notAccepted')),
            data.candidate
              ? h(
                  'div',
                  { className: 'flb-evidence', key: 'candidate' },
                  h('div', { className: 'flb-text' }, t('detail.candidatePackage')),
                  h('div', { className: 'flb-card-meta' }, `SHA-256: ${data.candidate.sha256}`),
                  h(
                    'div',
                    { className: 'flb-card-meta' },
                    `${data.candidate.tarball || '—'} · ${formatMoment(data.candidate.builtAt)}`,
                  ),
                )
              : null,
          ],
        }),
      )

      sections.push(
        Section({
          title: t('detail.approval'),
          children: [
            data.approval
              ? h(
                  'div',
                  { className: 'flb-text', key: 'approval' },
                  t('detail.approvedBy', {
                    by: data.approval.approvedBy,
                    at: formatMoment(data.approval.approvedAt),
                    plan: data.approval.planVersion,
                  }),
                )
              : h('div', { className: 'flb-muted', key: 'no-approval' }, t('detail.notApproved')),
          ],
        }),
      )

      if (failures.length > 0) {
        sections.push(
          Section({
            title: t('detail.failures'),
            children: failures.map((round) =>
              h(
                'div',
                { className: 'flb-list-item', key: round.roundId },
                h(
                  'div',
                  { className: 'flb-card-meta' },
                  `${round.stage} · ${formatMoment(round.occurredAt)}${round.taskId ? ` · ${round.taskId}` : ''}`,
                ),
                h('div', { className: 'flb-text' }, round.summary),
                round.taskId
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'flb-link-button',
                        onClick: (event) => {
                          event.stopPropagation()
                          const boardTask = boardTaskById.get(round.taskId)
                          if (boardTask) props.onOpenTask(boardTask)
                        },
                      },
                      t('detail.openTask'),
                    )
                  : null,
              ),
            ),
          }),
        )
      }

      sections.push(
        Section({
          title: t('detail.requests'),
          children:
            requests.length === 0
              ? [h('div', { className: 'flb-muted', key: 'none' }, t('detail.noRequests'))]
              : requests.map((request) =>
                  h(
                    'div',
                    { className: 'flb-list-item', key: request.requestId },
                    h(
                      'div',
                      { className: 'flb-card-meta' },
                      `${request.action} · ${request.state} · ${formatMoment(request.createdAt)}`,
                      request.state === 'unknown' ? h(Chip, { tone: 'error' }, t('detail.unknownRequest')) : null,
                    ),
                    h('div', { className: 'flb-text' }, request.detail || '—'),
                  ),
                ),
        }),
      )

      return h('div', { className: 'flb-detail' }, ...sections)
    }

    function TaskMeta(props) {
      const t = props.t
      const task = props.task
      return h(
        'div',
        { className: 'flb-task-meta' },
        h(Kv, { label: t('task.goalTitle') }, task.goal || '—'),
        h(Kv, { label: t('task.acceptance') }, task.acceptance || '—'),
        h(Kv, { label: t('task.dependsOn') }, task.dependsOn && task.dependsOn.length ? task.dependsOn.join('、') : '—'),
        h(Kv, { label: t('task.files') }, task.files && task.files.length ? task.files.join('、') : '—'),
        h(Kv, { label: t('task.testCommand') }, task.testCommand && task.testCommand.length ? task.testCommand.join(' ') : '—'),
        h(Kv, { label: t('task.verification') }, task.verification ? t('common.yes') : t('common.no')),
      )
    }

    function TaskCard(props) {
      const t = props.t
      const task = props.task
      const failed = isFailureState(task.state)
      const advice = task.failureAdvice && Array.isArray(task.failureAdvice.actions) ? task.failureAdvice : null
      const key = `${task.reqId}:${task.planVersion}:${task.taskId}`
      const retry = props.retry && props.retry.key === key ? props.retry : null
      const stale = heartbeatStale(task.lastActivity) && (task.state === 'running' || task.state === 'awaiting_input')
      return h(
        'article',
        { className: 'flb-card', key },
        h(
          'button',
          {
            type: 'button',
            className: 'flb-card-head flb-card-toggle',
            title: t('task.openDetail'),
            onClick: () => props.onOpen(task),
          },
          h(Chip, { tone: TASK_TONES[task.state] || 'idle' }, t(`task.${task.state}`)),
          task.resultUnknown ? h(Chip, { tone: 'error' }, t('task.resultUnknown')) : null,
          h('span', { className: 'flb-card-meta' }, t('task.meta', { reqId: task.reqId, plan: task.planVersion })),
        ),
        h('div', { className: 'flb-card-title', title: task.goal }, t('task.goal', { taskId: task.taskId, goal: task.goal })),
        task.dependsOn && task.dependsOn.length > 0
          ? h('div', { className: 'flb-card-meta' }, `${t('task.dependsOn')}: ${task.dependsOn.join('、')}`)
          : null,
        task.lastActivity
          ? h(
              'div',
              { className: 'flb-card-meta' },
              t('task.lastActivity', { time: formatTime(task.lastActivity) }),
              stale ? ` · ${t('task.heartbeatStale')}` : '',
            )
          : null,
        failed && task.failureReason ? h('div', { className: 'flb-card-failure' }, task.failureReason) : null,
        failed && advice && advice.actions.length > 0
          ? h('div', { className: 'flb-card-advice' }, `${t('task.solution')}：${advice.actions[0]}`)
          : null,
        h(
          'div',
          { className: 'flb-card-actions' },
          h(
            'button',
            { type: 'button', className: 'flb-link-button', onClick: () => props.onOpenRequirement(task.reqId) },
            t('task.openRequirement'),
          ),
          failed && props.canRetry
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'flb-card-action',
                  disabled: Boolean(retry && retry.busy),
                  title: t('task.retryHelp'),
                  onClick: (event) => {
                    event.stopPropagation()
                    props.onRetry(task)
                  },
                },
                retry && retry.busy
                  ? t('task.retrying')
                  : retry && retry.confirm
                    ? t('task.retryConfirm')
                    : t('task.retry'),
              )
            : null,
        ),
        retry && retry.message ? h('div', { className: 'flb-card-action-message' }, retry.message) : null,
      )
    }

    function TaskDetailPanel(props) {
      const t = props.t
      const state = props.state
      const close = (event) => {
        event.stopPropagation()
        props.onClose()
      }
      return h(
        'div',
        { className: 'flb-task-overlay', role: 'presentation', onClick: props.onClose },
        h(
          'aside',
          { className: 'flb-task-panel', role: 'dialog', 'aria-label': t('task.detail'), key: props.task ? `${props.task.reqId}:${props.task.planVersion}:${props.task.taskId}` : 'task', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'flb-task-head' },
            h(
              'div',
              null,
              h('div', { className: 'flb-task-title' }, t('task.detail')),
              props.task
                ? h('div', { className: 'flb-card-meta' }, `${props.task.taskId} · ${props.task.reqId} · v${props.task.planVersion}`)
                : null,
            ),
            h('button', { type: 'button', className: 'flb-task-close', onClick: close }, t('task.close')),
          ),
          state.phase === 'loading'
            ? h('div', { className: 'flb-empty' }, t('page.loading'))
            : state.phase === 'error'
              ? h('div', { className: 'flb-error-inline', role: 'alert' }, state.error || t('page.retry'))
              : state.data
                ? h(TaskDetailBody, {
                    t,
                    data: state.data,
                    task: props.task,
                    retry: props.retry,
                    onRetry: props.onRetry,
                    onOpenRequirement: props.onOpenRequirement,
                  })
                : null,
        ),
      )
    }

    function TaskDetailBody(props) {
      const t = props.t
      const data = props.data
      const task = data.task || {}
      const run = data.run || null
      const activity = Array.isArray(data.activity) ? data.activity : []
      const advice = data.advice || null
      const rounds = Array.isArray(data.failureRounds) ? data.failureRounds : []
      const failed = run && isFailureState(run.state)
      const retry = props.retry || null
      const stale =
        run &&
        (run.state === 'running' || data.waitingForInput) &&
        heartbeatStale(run.updatedAt)
      const review = data.review || null
      const artifact = data.artifact || null
      const evidence = data.evidence || null
      const sections = []

      sections.push(
        h(
          'div',
          { className: 'flb-task-section', key: 'status' },
          h(
            'div',
            { className: 'flb-card-meta' },
            h(Chip, { tone: TASK_TONES[data.waitingForInput ? 'awaiting_input' : run ? run.state : 'pending'] || 'idle' }, t(data.waitingForInput ? 'task.awaiting_input' : `task.${run ? run.state : 'pending'}`)),
            data.resultUnknown ? h(Chip, { tone: 'error' }, t('task.resultUnknown')) : null,
            h('span', null, t('task.lastActivity', { time: run && run.updatedAt ? formatTime(run.updatedAt) : '—' })),
          ),
          data.waitingForInput
            ? h(Banner, { tone: 'warn' }, t('task.waitingInputBanner'))
            : null,
          data.resultUnknown ? h(Banner, { tone: 'error' }, t('task.unknownBanner')) : null,
          data.requirement && data.requirement.stopRequested
            ? h(Banner, { tone: 'warn' }, t('task.stopBanner'))
            : null,
          stale ? h(Banner, { tone: 'warn' }, t('task.heartbeatStale')) : null,
          h('div', { className: 'flb-muted' }, t('task.heartbeatNote')),
        ),
      )

      sections.push(h(TaskMeta, { key: 'meta', t, task }))

      if (failed && run.reason) {
        sections.push(
          Section({
            title: t('task.failureReason'),
            children: [h('div', { className: 'flb-text', key: 'reason' }, run.reason)],
          }),
        )
      }
      if (advice) {
        sections.push(
          Section({
            title: t('task.solution'),
            children: [
              h('div', { className: 'flb-text', key: 'cause' }, advice.cause || ''),
              h(
                'ol',
                { className: 'flb-task-advice', key: 'actions' },
                (advice.actions || []).map((action, index) => h('li', { key: index }, action)),
              ),
              Array.isArray(advice.scope) && advice.scope.length > 0
                ? h('div', { className: 'flb-muted', key: 'scope' }, `${t('task.files')}: ${advice.scope.join('、')}`)
                : null,
            ],
          }),
        )
      }
      if (rounds.length > 0) {
        sections.push(
          Section({
            title: t('task.failureRounds'),
            children: rounds.map((round) =>
              h(
                'div',
                { className: 'flb-list-item', key: round.roundId },
                h('div', { className: 'flb-card-meta' }, `${round.stage} · ${formatMoment(round.occurredAt)}`),
                h('div', { className: 'flb-text' }, round.summary || ''),
              ),
            ),
          }),
        )
      }

      if (data.testLogTail) {
        sections.push(
          Section({
            title: t('task.testLog'),
            children: [
              h('div', { className: 'flb-muted', key: 'meta' }, t('task.testLogMeta', {
                path: data.testLogPath || '—',
                bytes: data.testLogBytes || 0,
              })),
              data.testLogTruncated
                ? h('div', { className: 'flb-muted', key: 'truncated' }, t('task.testLogTruncated'))
                : null,
              h('pre', { className: 'flb-task-log', key: 'log' }, data.testLogTail),
            ],
          }),
        )
      }

      sections.push(
        Section({
          title: t('task.review'),
          children: review
            ? [
                h(Kv, { key: 'verdict', label: t('task.reviewVerdict') }, review.verdict || '—'),
                h(Kv, { key: 'summary', label: t('task.reviewSummary') }, review.summary || '—'),
                h('div', { className: 'flb-label', key: 'findings-label' }, t('task.reviewFindings')),
                h(BulletList, { key: 'findings', items: review.findings || [] }),
                h('div', { className: 'flb-label', key: 'blocking-label' }, t('task.reviewBlocking')),
                h(BulletList, { key: 'blocking', items: review.blocking || [] }),
                h('div', { className: 'flb-muted', key: 'note' }, t('task.reviewNote')),
              ]
            : [h('div', { className: 'flb-muted', key: 'none' }, t('task.reviewNone'))],
        }),
      )

      sections.push(
        Section({
          title: t('task.evidence'),
          children: [
            artifact
              ? h(
                  'div',
                  { className: 'flb-evidence', key: 'artifact' },
                  h('div', { className: 'flb-label' }, t('task.artifact')),
                  h('div', { className: 'flb-card-meta' }, `${t('detail.candidate')}: ${artifact.candidateSha256}`),
                  h('div', { className: 'flb-card-meta' }, `${t('detail.testEvidence')}: ${artifact.testEvidenceSha256}`),
                  h('div', { className: 'flb-card-meta' }, `${t('detail.reviewEvidence')}: ${artifact.reviewSha256}`),
                  h('div', { className: 'flb-card-meta' }, `${t('detail.authorization')}: ${artifact.authorizationSource || '—'}`),
                  h('div', { className: 'flb-card-meta' }, `${t('detail.baseline')}: ${artifact.baselineCommit}`),
                  h('div', { className: 'flb-card-meta' }, `${t('detail.recordedAt')}: ${formatMoment(artifact.recordedAt)}`),
                )
              : h('div', { className: 'flb-muted', key: 'no-artifact' }, t('task.artifactMissing')),
            evidence
              ? h(
                  'div',
                  { className: 'flb-evidence', key: 'evidence' },
                  h('div', { className: 'flb-label' }, t('hint.paths')),
                  h('div', { className: 'flb-card-meta' }, `workspace: ${evidence.workspacePath || '—'}`),
                  h('div', { className: 'flb-card-meta' }, `candidate: ${evidence.candidatePath || '—'}`),
                  h('div', { className: 'flb-card-meta' }, `test log: ${evidence.testLogPath || '—'}`),
                  h('div', { className: 'flb-card-meta' }, `review: ${evidence.reviewPath || '—'}`),
                  h('div', { className: 'flb-card-meta' }, `sessions: ${evidence.devSession || '—'} / ${evidence.reviewSession || '—'}`),
                )
              : h('div', { className: 'flb-muted', key: 'no-evidence' }, t('task.evidenceMissing')),
          ],
        }),
      )

      sections.push(
        Section({
          title: t('task.activity'),
          children: [
            data.activityTruncated
              ? h('div', { className: 'flb-muted', key: 'meta' }, t('task.activityMeta', { shown: activity.length, total: data.activityTotal || activity.length }))
              : null,
            activity.length === 0
              ? h('div', { className: 'flb-muted', key: 'none' }, t('task.noActivity'))
              : h(
                  'div',
                  { className: 'flb-task-activity', key: 'list' },
                  activity.map((item, index) =>
                    h(
                      'div',
                      { className: 'flb-task-activity-item', key: `${item.type}:${index}` },
                      h('div', { className: 'flb-task-activity-time' }, `${item.at ? formatMoment(item.at) : ''} · ${item.type}`),
                      h('div', null, item.summary || ''),
                    ),
                  ),
                ),
          ],
        }),
      )

      sections.push(
        h(
          'div',
          { className: 'flb-task-actions', key: 'actions' },
          data.retry && data.retry.allowed && props.onRetry && props.task
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'flb-card-action',
                  disabled: Boolean(retry && retry.busy),
                  title: t('task.retryHelp'),
                  onClick: () => props.onRetry(props.task),
                },
                retry && retry.busy
                  ? t('task.retrying')
                  : retry && retry.confirm
                    ? t('task.retryConfirm')
                    : t('task.retry'),
              )
            : null,
          data.retry && !data.retry.allowed && data.retry.reason
            ? h('span', { className: 'flb-muted' }, t('task.retryNotAllowed', { reason: data.retry.reason }))
            : null,
          data.retry && data.retry.requiresRecovery
            ? h('span', { className: 'flb-muted' }, t('task.retryRecoveryHint'))
            : null,
          props.onOpenRequirement && props.task
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'flb-link-button',
                  onClick: () => props.onOpenRequirement(props.task.reqId),
                },
                t('task.openRequirement'),
              )
            : null,
          retry && retry.message ? h('span', { className: 'flb-muted' }, retry.message) : null,
        ),
      )

      return h('div', null, ...sections)
    }

    function IssueCard(props) {
      const t = props.t
      const issue = props.issue
      const target = () => props.onOpen(issue)
      return h(
        'article',
        { className: 'flb-card', key: issue.issueId, 'data-severity': issue.severity },
        h(
          'button',
          {
            type: 'button',
            className: 'flb-card-head flb-card-toggle',
            title: issue.taskId ? t('issue.openTask') : t('issue.openRequirement'),
            onClick: target,
          },
          h(Chip, { tone: ISSUE_TONES[issue.severity] || 'warn' }, t(`issue.severity.${issue.severity}`)),
          h(Chip, { tone: 'idle' }, t(`issue.${issue.kind}`)),
          h('span', { className: 'flb-card-meta' }, issue.reqId),
          issue.taskId ? h('span', { className: 'flb-card-meta' }, t('issue.taskMeta', { taskId: issue.taskId })) : null,
        ),
        h('div', { className: 'flb-card-title', title: issue.title }, issue.title),
        issue.detail ? h('div', { className: 'flb-card-meta' }, issue.detail) : null,
        h(
          'div',
          { className: 'flb-card-actions' },
          h('button', { type: 'button', className: 'flb-link-button', onClick: target }, issue.taskId ? t('issue.openTask') : t('issue.openRequirement')),
        ),
      )
    }

    function Overview(props) {
      const t = props.t
      const { board, tasks, issues } = props
      const requirements = board.requirements || []
      const running = tasks.filter((task) => task.state === 'running' || task.state === 'awaiting_input')
      const attention = issues.slice(0, 4)
      const counts = {
        approvals: issues.filter((issue) => issue.kind === 'approval').length,
        failures: issues.filter((issue) => issue.kind === 'failure_round').length,
        unknown: issues.filter((issue) => issue.kind === 'request').length,
        clarifications: issues.filter((issue) => issue.kind === 'clarification').length,
        running: running.length,
      }
      const next = []
      if (counts.approvals > 0) next.push({ key: 'approvals', text: t('overview.next.approvals', { count: counts.approvals }), view: 'requirements' })
      if (counts.failures > 0) next.push({ key: 'failures', text: t('overview.next.failures', { count: counts.failures }), view: 'tasks' })
      if (counts.unknown > 0) next.push({ key: 'unknown', text: t('overview.next.unknown', { count: counts.unknown }), view: 'issues' })
      if (counts.clarifications > 0) next.push({ key: 'clarifications', text: t('overview.next.clarifications', { count: counts.clarifications }), view: 'requirements' })
      if (counts.running > 0) next.push({ key: 'running', text: t('overview.next.running', { count: counts.running }), view: 'tasks' })
      if (next.length === 0) {
        next.push({
          key: 'none',
          text: requirements.length === 0 ? t('overview.next.submit') : t('overview.next.none'),
          view: requirements.length === 0 ? 'requirements' : 'tasks',
        })
      }

      return h(
        'div',
        { className: 'flb-overview' },
        h(
          'div',
          { className: 'flb-stat-grid' },
          h('div', { className: 'flb-stat' }, h('span', { className: 'flb-stat-value' }, String(board.summary.requirements)), h('span', { className: 'flb-stat-label' }, t('overview.stat.requirements'))),
          h('div', { className: 'flb-stat' }, h('span', { className: 'flb-stat-value' }, String(board.summary.active)), h('span', { className: 'flb-stat-label' }, t('overview.stat.active'))),
          h('div', { className: 'flb-stat' }, h('span', { className: 'flb-stat-value' }, String(board.summary.tasks)), h('span', { className: 'flb-stat-label' }, t('overview.stat.tasks'))),
          h('div', { className: 'flb-stat' }, h('span', { className: 'flb-stat-value' }, String(board.summary.delivered)), h('span', { className: 'flb-stat-label' }, t('overview.stat.delivered'))),
          h('div', { className: 'flb-stat' }, h('span', { className: 'flb-stat-value' }, String(board.summary.issues)), h('span', { className: 'flb-stat-label' }, t('overview.stat.issues'))),
          h('div', { className: 'flb-stat', 'data-tone': board.summary.blocking > 0 ? 'error' : undefined }, h('span', { className: 'flb-stat-value' }, String(board.summary.blocking)), h('span', { className: 'flb-stat-label' }, t('overview.stat.blocking'))),
        ),
        h(
          'div',
          { className: 'flb-overview-grid' },
          h(
            'section',
            { className: 'flb-panel' },
            h('div', { className: 'flb-panel-title' }, t('overview.runningTitle')),
            running.length === 0
              ? h('div', { className: 'flb-muted' }, t('overview.runningEmpty'))
              : running.map((task) =>
                  h(
                    'div',
                    { className: 'flb-list-item', key: `${task.reqId}:${task.taskId}` },
                    h(
                      'div',
                      { className: 'flb-list-head' },
                      h(Chip, { tone: TASK_TONES[task.state] || 'idle' }, t(`task.${task.state}`)),
                      h('span', { className: 'flb-detail-code' }, task.taskId),
                      h('span', { className: 'flb-card-meta' }, task.reqId),
                    ),
                    h('div', { className: 'flb-text' }, task.goal),
                    h(
                      'div',
                      { className: 'flb-card-meta' },
                      t('task.lastActivity', { time: task.lastActivity ? formatTime(task.lastActivity) : '—' }),
                      heartbeatStale(task.lastActivity) ? ` · ${t('task.heartbeatStale')}` : '',
                    ),
                    h('button', { type: 'button', className: 'flb-link-button', onClick: () => props.onOpenTask(task) }, t('task.openDetail')),
                  ),
                ),
            h('div', { className: 'flb-muted' }, t('overview.boundaryHeartbeat')),
          ),
          h(
            'section',
            { className: 'flb-panel' },
            h('div', { className: 'flb-panel-title' }, t('overview.attentionTitle')),
            attention.length === 0
              ? h('div', { className: 'flb-muted' }, t('overview.attentionEmpty'))
              : attention.map((issue) =>
                  h(
                    'div',
                    { className: 'flb-list-item', key: issue.issueId },
                    h(
                      'div',
                      { className: 'flb-list-head' },
                      h(Chip, { tone: ISSUE_TONES[issue.severity] || 'warn' }, t(`issue.severity.${issue.severity}`)),
                      h(Chip, { tone: 'idle' }, t(`issue.${issue.kind}`)),
                      h('span', { className: 'flb-card-meta' }, issue.reqId),
                    ),
                    h('div', { className: 'flb-text' }, issue.title),
                    issue.detail ? h('div', { className: 'flb-muted' }, issue.detail) : null,
                    h(
                      'button',
                      { type: 'button', className: 'flb-link-button', onClick: () => props.onOpenIssue(issue) },
                      issue.taskId ? t('issue.openTask') : t('issue.openRequirement'),
                    ),
                  ),
                ),
            issues.length > attention.length
              ? h(
                  'button',
                  { type: 'button', className: 'flb-link-button', onClick: () => props.onNavigate('issues') },
                  t('overview.attentionMore', { count: issues.length }),
                )
              : null,
          ),
          h(
            'section',
            { className: 'flb-panel' },
            h('div', { className: 'flb-panel-title' }, t('overview.nextTitle')),
            next.map((item) =>
              h(
                'button',
                {
                  type: 'button',
                  className: 'flb-next-item',
                  key: item.key,
                  onClick: () => props.onNavigate(item.view),
                },
                item.text,
              ),
            ),
          ),
          h(
            'section',
            { className: 'flb-panel' },
            h('div', { className: 'flb-panel-title' }, t('overview.featuresTitle')),
            h(BulletList, {
              items: [
                t('overview.feature.nav'),
                t('overview.feature.search'),
                t('overview.feature.detail'),
                t('overview.feature.debug'),
                t('overview.feature.actions'),
              ],
            }),
            h('div', { className: 'flb-muted' }, t('overview.boundarySource')),
            h('div', { className: 'flb-muted' }, t('overview.boundaryStop')),
            h('div', { className: 'flb-muted' }, t('overview.boundaryAccept')),
            h('div', { className: 'flb-muted' }, t('overview.boundaryClarification')),
            h('div', { className: 'flb-muted' }, t('overview.boundaryGrant')),
            h('div', { className: 'flb-muted' }, t('overview.searchScope')),
          ),
        ),
      )
    }

    const BOARD_CSS = `
.flb-root{box-sizing:border-box;min-height:100%;display:flex;flex-direction:column;overflow:visible;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px}
.flb-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.flb-head-main{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}
.flb-title{font-size:15px;font-weight:600}
.flb-sub{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.flb-head-tools{display:flex;align-items:center;gap:8px;margin-left:auto}
.flb-search{position:relative;display:flex;align-items:center;min-width:220px;max-width:360px;flex:1}
.flb-search input{box-sizing:border-box;width:100%;height:28px;padding:0 26px 0 26px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.flb-search input:focus{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.flb-search-icon{position:absolute;left:8px;color:var(--dsw-alias-label-secondary);font-size:14px;pointer-events:none}
.flb-search-clear{position:absolute;right:4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;cursor:pointer;padding:2px 5px;line-height:16px}
.flb-refresh{box-sizing:border-box;height:28px;padding:0 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.flb-refresh:hover{background:var(--dsw-alias-bg-layer-2)}
.flb-refresh:disabled{opacity:.6;cursor:default}
.flb-tabs{display:flex;align-items:stretch;gap:2px;width:100%;overflow-x:auto;margin-top:2px}
.flb-tab{display:inline-flex;align-items:center;gap:6px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:7px 10px;cursor:pointer;white-space:nowrap}
.flb-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.flb-tab[aria-selected=true]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.flb-tab-count{font-size:10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:0 6px;line-height:15px}
.flb-search-meta{width:100%;padding:6px 0 8px;font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;flex-wrap:wrap;align-items:baseline}
.flb-body{box-sizing:border-box;flex:1;min-height:0;overflow:visible;padding:12px 16px 0}
.flb-toolbar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:10px}
.flb-filter{border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 9px;font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.flb-filter[aria-pressed=true]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.flb-col-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;align-items:start}
.flb-card{box-sizing:border-box;display:flex;flex-direction:column;gap:5px;padding:9px 11px;border:.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.flb-card[data-open=true]{border-color:var(--dsw-alias-brand-primary);grid-column:1/-1}
.flb-card[data-severity=blocking]{border-color:var(--dsw-alias-state-error-primary)}
.flb-card-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.flb-card-toggle{width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:4px}
.flb-card-toggle:hover{background:var(--dsw-alias-bg-layer-2)}
.flb-card-toggle:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.flb-chevron{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px}
.flb-card-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;overflow-wrap:anywhere}
.flb-card-meta{display:flex;flex-wrap:wrap;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.flb-card-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:4px}
.flb-card-action{padding:2px 8px;border:.5px solid var(--dsw-alias-state-business-primary);border-radius:5px;background:transparent;color:var(--dsw-alias-state-business-primary);font-size:11px;cursor:pointer}
.flb-card-action[data-tone=danger]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.flb-card-action:disabled{opacity:.5;cursor:default}
.flb-card-action-message{margin-top:3px;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.flb-card-running{margin-top:3px;font-size:11px;color:var(--dsw-alias-state-warning-primary);overflow-wrap:anywhere}
.flb-card-failure{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.flb-card-advice{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.flb-link-button{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11px;cursor:pointer;padding:2px 0;text-align:left}
.flb-link-button:hover{text-decoration:underline}
.flb-muted{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.flb-empty{padding:10px 12px;border:.5px dashed var(--dsw-alias-border-l1);border-radius:7px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.flb-empty-large{display:flex;flex-direction:column;gap:8px;align-items:flex-start;padding:22px;margin-top:12px}
.flb-error{margin-bottom:12px;padding:8px 10px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.flb-error-inline{padding:6px 8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px}
.flb-overview{display:flex;flex-direction:column;gap:12px}
.flb-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:8px}
.flb-stat{display:flex;flex-direction:column;gap:2px;padding:9px 11px;border:.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1)}
.flb-stat[data-tone=error]{border-color:var(--dsw-alias-state-error-primary)}
.flb-stat-value{font-size:19px;font-weight:600;line-height:24px}
.flb-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.flb-overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-items:start}
.flb-panel{border:.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);padding:10px;min-width:0}
.flb-panel-title{font-size:12px;font-weight:600;margin-bottom:7px}
.flb-list-item{padding:7px 0;border-top:.5px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:4px}
.flb-list-item:first-of-type{border-top:0;padding-top:0}
.flb-list-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.flb-next-item{display:block;width:100%;text-align:left;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:17px;padding:7px 9px;margin-top:6px;cursor:pointer}
.flb-next-item:hover{border-color:var(--dsw-alias-brand-primary)}
.flb-chip{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.flb-chip[data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.flb-chip[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.flb-chip[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
.flb-chip[data-tone=brand]{color:var(--dsw-alias-brand-primary)}
.flb-progress{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.flb-progress>span{display:block;height:100%;background:var(--dsw-alias-state-success-primary)}
.flb-detail{margin-top:8px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:12px}
.flb-section{display:flex;flex-direction:column;gap:5px;min-width:0}
.flb-section-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
.flb-subsection{display:flex;flex-direction:column;gap:4px;padding:7px 0;border-top:.5px dashed var(--dsw-alias-border-l1)}
.flb-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-top:4px}
.flb-text{font-size:12px;line-height:18px;overflow-wrap:anywhere}
.flb-text-block{margin:0;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:17px;background:var(--dsw-alias-bg-layer-2);padding:7px 8px;border-radius:5px}
.flb-bullets{margin:0;padding-left:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.flb-bullets li{margin:1px 0}
.flb-kv{display:grid;grid-template-columns:88px minmax(0,1fr);gap:7px;font-size:12px;line-height:18px}
.flb-kv-label{color:var(--dsw-alias-label-secondary)}
.flb-kv-value{overflow-wrap:anywhere}
.flb-evidence{border-left:2px solid var(--dsw-alias-border-l2);padding:2px 0 2px 8px;display:flex;flex-direction:column;gap:2px}
.flb-version{border-top:.5px dashed var(--dsw-alias-border-l1);padding-top:6px;margin-top:6px}
.flb-details{margin-top:5px}
.flb-details summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-brand-primary);padding:3px 0}
.flb-plan-task{border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;padding:7px 8px;margin-top:6px;display:flex;flex-direction:column;gap:3px}
.flb-plan-task-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.flb-block-warn{border-left:2px solid var(--dsw-alias-state-warning-primary);padding-left:8px}
.flb-banner{padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.flb-banner[data-tone=warn]{border-color:var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary)}
.flb-banner[data-tone=error]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.flb-task-meta{display:flex;flex-direction:column;gap:4px}
.flb-task-overlay{position:fixed;top:0;right:0;bottom:160px;left:0;z-index:200;background:rgba(0,0,0,.28);display:flex;justify-content:flex-end}
.flb-task-panel{width:min(820px,94vw);height:100%;overflow:auto;background:var(--dsw-alias-bg-layer-1);border-left:.5px solid var(--dsw-alias-border-l2);padding:14px;box-sizing:border-box}
.flb-task-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);padding-bottom:8px;z-index:1}
.flb-task-title{font-size:14px;font-weight:600}
.flb-task-close{border:.5px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);padding:2px 8px;cursor:pointer}
.flb-task-section{margin-top:12px;display:flex;flex-direction:column;gap:5px}
.flb-task-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
.flb-task-text{font-size:12px;line-height:18px;overflow-wrap:anywhere}
.flb-task-advice{margin:0;padding-left:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.flb-task-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1)}
.flb-task-activity{display:flex;flex-direction:column;gap:5px}
.flb-task-activity-item{border-left:2px solid var(--dsw-alias-border-l2);padding:2px 0 2px 8px;font-size:11px;line-height:16px}
.flb-task-activity-time{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}
.flb-task-log{margin:0;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--dsw-alias-bg-layer-2);padding:6px;border-radius:4px}
.flb-footer{margin-top:16px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.flb-bottom-spacer{height:150px;flex:none}
.flb-workbench[data-full=true]{grid-template-columns:minmax(0,1fr)}
.flb-workbench[data-full=true] .flb-tree-pane,.flb-workbench[data-full=true] .flb-main-pane{display:none}
.flb-workbench[data-full=true] .flb-side{grid-column:1/-1;max-height:none}
.flb-workbench[data-tree-open=false]{grid-template-columns:minmax(0,1fr) minmax(340px,440px)}
.flb-workbench[data-tree-open=false] .flb-tree-pane{display:none}
.flb-workbench{display:grid;grid-template-columns:250px minmax(0,1fr) minmax(340px,440px);gap:10px;align-items:start;margin-top:10px;min-width:0}
.flb-tree-pane,.flb-main-pane,.flb-side{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0;max-height:calc(100vh - 420px);overflow:auto}
.flb-tree-pane{padding:8px}
.flb-main-pane{padding:12px}
.flb-side{padding:10px}
.flb-wb-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.flb-wb-title{font-size:12px;font-weight:600}
.flb-wb-sub{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.flb-wb-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0}
.flb-wb-spacer{flex:1}
.flb-tree-group{border-top:.5px solid var(--dsw-alias-border-l1);padding:5px 0}
.flb-tree-group:first-of-type{border-top:0}
.flb-tree-node{box-sizing:border-box;width:100%;display:flex;align-items:flex-start;gap:5px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:16px;text-align:left;padding:5px 6px;cursor:pointer;min-width:0}
.flb-tree-node:hover{background:var(--dsw-alias-bg-layer-2)}
.flb-tree-node[aria-current=true]{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.flb-tree-node .flb-tree-text{min-width:0;overflow-wrap:anywhere}
.flb-tree-child{margin-left:13px;width:calc(100% - 13px)}
.flb-tree-grandchild{margin-left:26px;width:calc(100% - 26px)}
.flb-tree-kind{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}
.flb-tree-count{font-size:10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:0 5px;line-height:14px;margin-left:auto}
.flb-tree-empty{padding:10px 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.flb-hier-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap}
.flb-hier-title{font-size:15px;font-weight:600;line-height:22px;overflow-wrap:anywhere;margin:2px 0}
.flb-hier-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.flb-hier-progress{margin:8px 0 3px}
.flb-hier-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px}
.flb-hier-tabs{display:flex;gap:4px;overflow-x:auto;border-bottom:.5px solid var(--dsw-alias-border-l1);margin:8px 0 9px}
.flb-hier-tab{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:5px 7px;cursor:pointer;white-space:nowrap}
.flb-hier-tab[aria-selected=true]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.flb-hier-card{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);padding:8px 9px;margin-top:7px;min-width:0}
.flb-hier-card[data-selected=true]{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.flb-hier-card-head{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.flb-hier-card-title{border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:17px;text-align:left;padding:2px 0;cursor:pointer;overflow-wrap:anywhere}
.flb-hier-card-title:hover{color:var(--dsw-alias-brand-primary)}
.flb-hier-card-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.flb-hier-card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:5px}
.flb-hier-issue{margin-top:5px;display:flex;align-items:flex-start;gap:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.flb-side-head{display:flex;align-items:flex-start;justify-content:space-between;gap:6px;position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-1);padding-bottom:6px}
.flb-side-close{border:.5px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:2px 6px;cursor:pointer}
.flb-side-tabs{display:flex;gap:2px;overflow-x:auto;border-bottom:.5px solid var(--dsw-alias-border-l1);margin-bottom:7px}
.flb-side-tab{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:5px;cursor:pointer;white-space:nowrap}
.flb-side-tab[aria-selected=true]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.flb-breadcrumb{display:flex;align-items:center;gap:3px;flex-wrap:wrap;font-size:10px;color:var(--dsw-alias-label-secondary);margin-bottom:3px}
.flb-breadcrumb button{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:10px;padding:0;cursor:pointer;overflow-wrap:anywhere}
.flb-relations{display:flex;flex-direction:column;gap:5px}
.flb-rel-node{display:block;width:100%;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;padding:6px 7px;cursor:pointer;min-width:0}
.flb-rel-node[data-current=true]{border-color:var(--dsw-alias-brand-primary)}
.flb-rel-node:hover{border-color:var(--dsw-alias-brand-primary)}
.flb-rel-edge{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:4px;align-items:stretch;margin:3px 0}
.flb-rel-arrow{align-self:center;color:var(--dsw-alias-label-secondary);font-size:14px}
.flb-rel-label{font-size:10px;color:var(--dsw-alias-label-secondary);margin:6px 0 2px}
.flb-exec{display:flex;flex-direction:column;gap:7px}
.flb-exec-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.flb-exec-identity{display:flex;flex-direction:column;gap:2px;font-size:10px;line-height:15px}
.flb-exec-identity .flb-kv{font-size:10px;line-height:15px}
.flb-exec-identity .flb-kv-value{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.flb-exec-attempt{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 0}
.flb-exec-attempt select{box-sizing:border-box;max-width:100%;height:26px;border:.5px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:0 5px}
.flb-exec-stages{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}
.flb-exec-stage{border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px;background:var(--dsw-alias-bg-base);min-width:0}
.flb-exec-stage-title{font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.03em}
.flb-exec-stage-text{font-size:11px;line-height:16px;margin-top:2px;overflow-wrap:anywhere}
.flb-exec-timeline{display:flex;flex-direction:column;gap:5px;max-height:520px;overflow:auto;padding-right:2px}
.flb-exec-event{border-left:2px solid var(--dsw-alias-border-l2);padding:4px 0 4px 7px;min-width:0}
.flb-exec-event[data-kind=tool]{border-left-color:var(--dsw-alias-brand-primary)}
.flb-exec-event[data-kind=phase]{border-left-style:dashed}
.flb-exec-event-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px;flex-wrap:wrap}
.flb-exec-event-title{font-size:11px;font-weight:600}
.flb-exec-event-time{font-size:10px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.flb-exec-event-text{margin:3px 0 0;font-size:11px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}
.flb-exec-event details{margin-top:3px}
.flb-exec-event summary{cursor:pointer;font-size:10px;color:var(--dsw-alias-brand-primary);padding:2px 0}
.flb-exec-pre{margin:3px 0 0;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:15px;background:var(--dsw-alias-bg-layer-2);padding:5px;border-radius:4px}
.flb-exec-tool-status{font-size:10px;color:var(--dsw-alias-label-secondary)}
.flb-exec-tool-status[data-error=true]{color:var(--dsw-alias-state-error-primary)}
.flb-exec-notice{padding:5px 7px;border:.5px solid var(--dsw-alias-state-warning-primary);border-radius:5px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-state-warning-primary)}
.flb-exec-empty{padding:8px;border:.5px dashed var(--dsw-alias-border-l1);border-radius:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.flb-exec-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.flb-copy{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:10px;cursor:pointer;padding:1px 0}
.flb-copy:hover{text-decoration:underline}
.flb-side-empty{padding:14px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.flb-mobile-back{display:none}
.flb-hidden{display:none!important}
@media (max-width:1180px){.flb-workbench{grid-template-columns:220px minmax(0,1fr)}.flb-side{grid-column:1/-1;max-height:none}.flb-workbench[data-tree-open=false]{grid-template-columns:minmax(0,1fr) minmax(340px,440px)}}
@media (max-width:820px){
  .flb-workbench,.flb-workbench[data-tree-open=false]{display:block}
  .flb-tree-pane,.flb-main-pane,.flb-side{max-height:none;margin-bottom:8px}
  .flb-side{display:none}
  .flb-workbench[data-mobile-detail=true] .flb-tree-pane,.flb-workbench[data-mobile-detail=true] .flb-main-pane{display:none}
  .flb-workbench[data-mobile-detail=true] .flb-side{display:block}
  .flb-mobile-back{display:inline-block}
  .flb-rel-edge{grid-template-columns:minmax(0,1fr)}
  .flb-rel-arrow{display:none}
  .flb-exec-stages{grid-template-columns:minmax(0,1fr)}
  .flb-exec-timeline{max-height:none}
  .flb-head-tools{width:100%}
  .flb-search{flex:1 1 140px;min-width:0}
  .flb-head-tools label.flb-muted{flex:none;white-space:nowrap;font-size:10px}
  .flb-workbench[data-tree-open=false] .flb-tree-pane{display:none}
  .flb-side{scroll-margin-top:270px}
}
@media (max-width:900px){.flb-overview-grid{grid-template-columns:minmax(0,1fr)}}
@media (max-width:760px){
  .flb-head{padding:10px 12px 0}
  .flb-head-main{width:100%}
  .flb-head-tools{width:100%;margin-left:0}
  .flb-search{max-width:none}
  .flb-body{box-sizing:border-box;padding:10px 12px 0}
  .flb-col-grid{grid-template-columns:minmax(0,1fr)}
  .flb-task-panel{width:100%;padding:12px}
  .flb-stat-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .flb-kv{grid-template-columns:78px minmax(0,1fr)}
}
@media (max-width:480px){.flb-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
`

    const OPS_CSS = `
.flb-ops-head{padding:2px 0 8px}
.flb-ops-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px;margin:6px 0 12px}
.flb-ops-stat{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}
.flb-ops-stat-value{font-size:18px;font-weight:600;line-height:22px}
.flb-ops-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.flb-ops-grid{display:grid;grid-template-columns:minmax(260px,360px) minmax(0,1fr);gap:12px;align-items:start}
.flb-ops-list{display:flex;flex-direction:column;gap:8px;max-height:70vh;overflow:auto;padding-right:2px}
.flb-ops-card{display:block;width:100%;text-align:left;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;font:inherit;color:inherit}
.flb-ops-card[data-selected=true]{border-color:var(--dsw-alias-state-info-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-info-primary) inset}
.flb-ops-card-head{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px}
.flb-ops-card-title{font-weight:600;margin-bottom:2px;overflow-wrap:anywhere}
.flb-ops-card-impact{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.flb-ops-card-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.flb-ops-detail-pane{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.flb-ops-detail-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px}
.flb-ops-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.flb-ops-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:6px;overflow-wrap:anywhere}
.flb-ops-evidence{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.flb-ops-obs{border-top:.5px solid var(--dsw-alias-border-l1);padding:6px 0;font-size:12px}
.flb-ops-obs:first-of-type{border-top:none}
@media (max-width:820px){.flb-ops-grid{grid-template-columns:minmax(0,1fr)}.flb-ops-list{max-height:40vh}}
`
    /** 注册页面；组件只在会话视图槽展开时渲染。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'forgeloop: dictionaries')
      const t = ctx.locale.bind(NS)
      const read = createReader(t)

    function LegacyBoardView(props) {
      const [state, setState] = React.useState({ phase: 'loading', board: null, error: '' })
      const [view, setView] = React.useState('overview')
      const [query, setQuery] = React.useState('')
      const [appliedQuery, setAppliedQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [taskFilter, setTaskFilter] = React.useState('all')
      const [issueFilter, setIssueFilter] = React.useState('all')
      const [openReq, setOpenReq] = React.useState('')
      const [detail, setDetail] = React.useState({ phase: 'idle', reqId: '', data: null, error: '' })
      const [action, setAction] = React.useState({ reqId: '', busy: '', message: '' })
      const [detailNonce, setDetailNonce] = React.useState(0)
      const [taskOpen, setTaskOpen] = React.useState(null)
      const [taskNonce, setTaskNonce] = React.useState(0)
      const [taskDetail, setTaskDetail] = React.useState({ phase: 'idle', data: null, error: '' })
      const [retry, setRetry] = React.useState({ key: '', busy: false, message: '', confirm: false })
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
        read(
          'board',
          { query: appliedQuery, limit: 50 },
          controller ? controller.signal : undefined,
        )
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
      }, [appliedQuery])

      React.useEffect(() => {
        const timer = setTimeout(() => setAppliedQuery(query.trim()), 300)
        return () => clearTimeout(timer)
      }, [query])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, 15000)
        return () => {
          clearInterval(timer)
          if (inflight.current) inflight.current.abort()
        }
      }, [load])

      const runAction = React.useCallback(
        (requirement, endpoint) => {
          if (action.busy) return
          if (endpoint === 'stop') {
            const confirmed =
              typeof window === 'undefined' || typeof window.confirm !== 'function'
                ? true
                : window.confirm(t('action.stopConfirm'))
            if (!confirmed) return
          }
          if (endpoint === 'replan') {
            const raw =
              typeof window === 'undefined' || typeof window.prompt !== 'function'
                ? ''
                : window.prompt(t('action.replanPrompt'), 'contracts/architecture.json')
            if (raw === null) return
            const files = raw
              .split(/[\n,]/)
              .map((file) => file.trim())
              .filter(Boolean)
            if (files.length === 0) return
            let confirmRecovery = false
            if (requirement.unknownRequests > 0) {
              const confirmed =
                typeof window === 'undefined' || typeof window.confirm !== 'function'
                  ? false
                  : window.confirm(t('action.replanRecoveryConfirm'))
              if (!confirmed) return
              confirmRecovery = true
            }
            setAction({ reqId: requirement.reqId, busy: endpoint, message: '' })
            read('replan', {
              reqId: requirement.reqId,
              planVersion: requirement.planVersion,
              files,
              sessionId: props.sessionId,
              confirmRecovery,
            })
              .then((value) => {
                const recovered = value && value.recovered > 0
                  ? ` ${t('action.replannedRecovered', { count: value.recovered })}`
                  : ''
                setAction({
                  reqId: requirement.reqId,
                  busy: '',
                  message: t('action.replanned', {
                    plan: value && value.planVersion,
                    task: value && value.taskId,
                    files: value && Array.isArray(value.files) ? value.files.join(', ') : files.join(', '),
                  }) + recovered,
                })
                load()
                setDetailNonce((current) => current + 1)
              })
              .catch((error) => {
                setAction({
                  reqId: requirement.reqId,
                  busy: '',
                  message: (error && error.message) || String(error),
                })
              })
            return
          }
          const extra = {}
          if (endpoint === 'rework') {
            extra.planVersion = requirement.planVersion
            if (requirement.unknownRequests > 0) {
              const confirmed =
                typeof window === 'undefined' || typeof window.confirm !== 'function'
                  ? false
                  : window.confirm(t('action.reworkRecoveryConfirm'))
              if (!confirmed) return
              extra.confirmRecovery = true
            }
          }
          if (endpoint === 'build') extra.planVersion = requirement.planVersion
          if (endpoint === 'deploy') {
            const raw =
              typeof window === 'undefined' || typeof window.prompt !== 'function'
                ? ''
                : window.prompt(t('action.deployPrompt'), 'web')
            if (raw === null) return
            const targetProfile = String(raw).trim()
            if (!targetProfile) return
            extra.targetProfile = targetProfile
          }
          setAction({ reqId: requirement.reqId, busy: endpoint, message: '' })
          read(endpoint === 'stop' ? 'stop' : endpoint, {
            reqId: requirement.reqId,
            sessionId: props.sessionId,
            ...(endpoint === 'approve' ? { planVersion: requirement.planVersion } : {}),
            ...(endpoint === 'cancel' ? { reason: t('action.cancelReason') } : {}),
            ...(endpoint === 'stop' ? { reason: t('action.stopReason') } : {}),
            ...extra,
          })
            .then(() => {
              const key =
                endpoint === 'approve'
                  ? 'approved'
                  : endpoint === 'advance'
                    ? 'advanced'
                    : endpoint === 'plan'
                      ? 'planned'
                      : endpoint === 'verify'
                        ? 'verified'
                        : endpoint === 'rework'
                          ? 'reworked'
                          : endpoint === 'build'
                            ? 'built'
                            : endpoint === 'deploy'
                              ? 'deployed'
                              : endpoint === 'stop'
                                ? 'stopped'
                                : 'cancelled'
              setAction({ reqId: requirement.reqId, busy: '', message: t(`action.${key}`) })
              load()
              setDetailNonce((value) => value + 1)
            })
            .catch((error) => {
              setAction({
                reqId: requirement.reqId,
                busy: '',
                message: (error && error.message) || String(error),
              })
            })
        },
        [action.busy, load, props.sessionId, read, t],
      )

      const retryTask = React.useCallback(
        (task) => {
          const key = `${task.reqId}:${task.planVersion}:${task.taskId}`
          if (retry.busy && retry.key === key) return
          const confirmRecovery = retry.confirm && retry.key === key
          setRetry({ key, busy: true, message: '', confirm: confirmRecovery })
          read('retry', {
            reqId: task.reqId,
            planVersion: task.planVersion,
            taskId: task.taskId,
            sessionId: props.sessionId,
            confirmRecovery,
          })
            .then(() => {
              setRetry({ key, busy: false, message: t('task.retryQueued'), confirm: false })
              load()
              setDetailNonce((value) => value + 1)
              setTaskNonce((value) => value + 1)
            })
            .catch((error) => {
              const code = error && error.code
              setRetry({
                key,
                busy: false,
                message: (error && error.message) || String(error),
                confirm: code === 'recovery_required',
              })
            })
        },
        [retry, load, props.sessionId, read, t],
      )

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
            if (controller) controller.abort()
            setDetail((previous) => ({
              phase: 'error',
              reqId: openReq,
              data: previous.data,
              error: (error && error.message) || String(error),
            }))
          })
        return () => {
          if (controller) controller.abort()
        }
      }, [openReq, detailNonce, read])

      const openTask = React.useCallback((task) => {
        setTaskOpen(task)
        setView('tasks')
      }, [])

      const openRequirement = React.useCallback((reqId) => {
        setTaskOpen(null)
        setView('requirements')
        setFilter('all')
        setOpenReq(reqId)
      }, [])

      const openIssue = React.useCallback(
        (issue) => {
          if (issue.taskId) {
            const task = (state.board ? state.board.tasks : []).find(
              (candidate) => candidate.reqId === issue.reqId && candidate.taskId === issue.taskId,
            )
            if (task) {
              openTask(task)
              return
            }
          }
          openRequirement(issue.reqId)
        },
        [openRequirement, openTask, state.board],
      )

      React.useEffect(() => {
        if (!taskOpen) {
          setTaskDetail({ phase: 'idle', data: null, error: '' })
          return undefined
        }
        let active = true
        let controller = typeof AbortController === 'function' ? new AbortController() : null
        const loadTask = () => {
          read(
            'task',
            { reqId: taskOpen.reqId, planVersion: taskOpen.planVersion, taskId: taskOpen.taskId },
            controller ? controller.signal : undefined,
          )
            .then((data) => {
              if (active) setTaskDetail({ phase: 'ready', data, error: '' })
            })
            .catch((error) => {
              if (active) setTaskDetail({ phase: 'error', data: null, error: (error && error.message) || String(error) })
            })
        }
        loadTask()
        const timer = setInterval(loadTask, 2000)
        return () => {
          active = false
          clearInterval(timer)
          if (controller) controller.abort()
        }
      }, [taskOpen, taskNonce])

      const board = state.board
      const requirements = board ? board.requirements : []
      const allTasks = board ? board.tasks : []
      const allIssues = board ? board.issues : []
      const requirementById = new Map(requirements.map((requirement) => [requirement.reqId, requirement]))

      const visible = requirements.filter((requirement) => {
        if (filter === 'active') return !TERMINAL[requirement.status]
        if (filter === 'accepted') return requirement.status === 'accepted'
        return true
      })
      const tasks = allTasks
        .sort((left, right) => {
          const order = {
            awaiting_input: 0,
            running: 1,
            failed: 2,
            blocked: 3,
            awaiting_user: 4,
            pending: 5,
            delivered: 6,
          }
          const byState = (order[left.state] ?? 9) - (order[right.state] ?? 9)
          if (byState !== 0) return byState
          return `${left.reqId}:${left.taskId}`.localeCompare(`${right.reqId}:${right.taskId}`)
        })
      const filteredTasks =
        taskFilter === 'all' ? tasks : tasks.filter((task) => task.state === taskFilter)
      const issues = allIssues
      const filteredIssues =
        issueFilter === 'all' ? issues : issues.filter((issue) => issue.severity === issueFilter)
      const busy = state.phase === 'loading' || state.phase === 'refreshing'
      const queryActive = Boolean(board && board.query)
      const noResults = Boolean(board && queryActive && board.requirements.length === 0)
      const canRetryTask = (task) => {
        const requirement = requirementById.get(task.reqId)
        return Boolean(
          requirement &&
            !TERMINAL[requirement.status] &&
            requirement.approval === 'approved' &&
            requirement.remainingRounds > 0 &&
            isFailureState(task.state),
        )
      }
      const counts = {
        requirements: requirements.length,
        tasks: tasks.length,
        issues: issues.length,
      }

      const tabs = [
        { key: 'overview', label: t('nav.overview'), count: board ? board.summary.active : 0 },
        { key: 'requirements', label: t('nav.requirements'), count: counts.requirements },
        { key: 'tasks', label: t('nav.tasks'), count: counts.tasks },
        { key: 'issues', label: t('nav.issues'), count: counts.issues },
      ]

      return h(
        'section',
        { className: 'flb-root', 'data-dsh-plugin': 'forgeloop', 'aria-label': t('page.title') },
        h('style', null, BOARD_CSS),
        h(
          'header',
          { className: 'flb-head' },
          h(
            'div',
            { className: 'flb-head-main' },
            h('span', { className: 'flb-title' }, t('page.title')),
            board
              ? h(
                  'span',
                  { className: 'flb-sub', 'aria-live': 'polite' },
                  t('page.subtitle', { project: board.project, time: formatTime(board.generatedAt) }),
                  ` · ${t('page.source')}`,
                )
              : null,
          ),
          h(
            'div',
            { className: 'flb-head-tools' },
            h(
              'label',
              { className: 'flb-search' },
              h('span', { className: 'flb-search-icon', 'aria-hidden': 'true' }, '⌕'),
              h('input', {
                type: 'search',
                value: query,
                placeholder: t('search.placeholder'),
                'aria-label': t('search.label'),
                title: t('overview.searchScope'),
                onChange: (event) => setQuery(event.target.value),
              }),
              query
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'flb-search-clear',
                      onClick: () => setQuery(''),
                      title: t('search.clear'),
                    },
                    '×',
                  )
                : null,
            ),
            h(
              'button',
              { type: 'button', className: 'flb-refresh', onClick: load, disabled: busy },
              busy ? t('page.refreshing') : t('page.refresh'),
            ),
          ),
          h(
            'nav',
            { className: 'flb-tabs', role: 'tablist', 'aria-label': t('nav.label') },
            tabs.map((tab) =>
              h(
                'button',
                {
                  type: 'button',
                  key: tab.key,
                  role: 'tab',
                  className: 'flb-tab',
                  'aria-selected': view === tab.key,
                  onClick: () => setView(tab.key),
                },
                tab.label,
                h('span', { className: 'flb-tab-count' }, String(tab.count)),
              ),
            ),
          ),
          board && queryActive
            ? h(
                'div',
                { className: 'flb-search-meta' },
                t('search.results', {
                  query: board.query,
                  count: board.summary.requirements,
                  truncated: board.truncated ? t('search.truncated', { limit: board.limit }) : '',
                }),
                h('span', { className: 'flb-muted' }, t('overview.searchScope')),
              )
            : null,
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
          board && noResults
            ? h(
                'div',
                { className: 'flb-empty flb-empty-large' },
                h('div', null, t('search.noResults', { query: board.query })),
                h('div', { className: 'flb-muted' }, t('overview.searchScope')),
                h(
                  'button',
                  { type: 'button', className: 'flb-refresh', onClick: () => setQuery('') },
                  t('search.clear'),
                ),
              )
            : null,
          board && !noResults && board.summary.requirements === 0 && !queryActive
            ? h(
                'div',
                { className: 'flb-empty flb-empty-large' },
                h('div', null, t('page.empty')),
                h('div', { className: 'flb-muted' }, t('overview.next.submit')),
                h(BulletList, {
                  items: [
                    t('overview.feature.nav'),
                    t('overview.feature.search'),
                    t('overview.feature.detail'),
                    t('overview.feature.debug'),
                    t('overview.feature.actions'),
                  ],
                }),
                h('div', { className: 'flb-muted' }, t('overview.boundarySource')),
                h('div', { className: 'flb-muted' }, t('overview.boundaryHeartbeat')),
                h('div', { className: 'flb-muted' }, t('overview.boundaryStop')),
                h('div', { className: 'flb-muted' }, t('overview.boundaryAccept')),
                h('div', { className: 'flb-muted' }, t('overview.boundaryClarification')),
                h('div', { className: 'flb-muted' }, t('overview.boundaryGrant')),
              )
            : null,
          board && !noResults && board.summary.requirements > 0
            ? view === 'overview'
              ? h(Overview, {
                  t,
                  board,
                  tasks: allTasks,
                  issues: allIssues,
                  onOpenTask: openTask,
                  onOpenIssue: openIssue,
                  onNavigate: setView,
                })
              : view === 'requirements'
                ? h(
                    'div',
                    null,
                    h(
                      'div',
                      { className: 'flb-toolbar' },
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
                      h('span', { className: 'flb-muted' }, t('overview.searchScope')),
                    ),
                    visible.length === 0
                      ? h('div', { className: 'flb-empty' }, t('empty.requirements'))
                      : h(
                          'div',
                          { className: 'flb-col-grid' },
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
                              onToggle: (reqId) => setOpenReq((previous) => (previous === reqId ? '' : reqId)),
                              onAction: runAction,
                              onOpenTask: openTask,
                              busy: action.reqId === requirement.reqId ? action.busy : '',
                              actionMessage: action.reqId === requirement.reqId ? action.message : '',
                            }),
                          ),
                        ),
                  )
                : view === 'tasks'
                  ? h(
                      'div',
                      null,
                      h(
                        'div',
                        { className: 'flb-toolbar' },
                        ['all', 'running', 'awaiting_input', 'failed', 'blocked', 'awaiting_user', 'delivered', 'pending'].map(
                          (key) =>
                            h(
                              'button',
                              {
                                type: 'button',
                                key,
                                className: 'flb-filter',
                                'aria-pressed': taskFilter === key,
                                onClick: () => setTaskFilter(key),
                              },
                              t(`filter.task.${key}`),
                            ),
                        ),
                      ),
                      filteredTasks.length === 0
                        ? h('div', { className: 'flb-empty' }, t('empty.tasks'))
                        : h(
                            'div',
                            { className: 'flb-col-grid' },
                            filteredTasks.map((task) =>
                              h(TaskCard, {
                                t,
                                key: `${task.reqId}:${task.planVersion}:${task.taskId}`,
                                task,
                                onOpen: openTask,
                                onOpenRequirement: openRequirement,
                                canRetry: canRetryTask(task),
                                retry,
                                onRetry: retryTask,
                              }),
                            ),
                          ),
                    )
                  : h(
                      'div',
                      null,
                      h(
                        'div',
                        { className: 'flb-toolbar' },
                        ['all', 'blocking', 'attention'].map((key) =>
                          h(
                            'button',
                            {
                              type: 'button',
                              key,
                              className: 'flb-filter',
                              'aria-pressed': issueFilter === key,
                              onClick: () => setIssueFilter(key),
                            },
                            t(`filter.issue.${key}`),
                          ),
                        ),
                      ),
                      filteredIssues.length === 0
                        ? h('div', { className: 'flb-empty' }, t('empty.issues'))
                        : h(
                            'div',
                            { className: 'flb-col-grid' },
                            filteredIssues.map((issue) =>
                              h(IssueCard, { t, key: issue.issueId, issue, onOpen: openIssue }),
                            ),
                          ),
                    )
            : null,
        ),
          taskOpen
            ? h(TaskDetailPanel, {
                t,
                task: taskOpen,
                state: taskDetail,
                retry:
                  retry.key === `${taskOpen.reqId}:${taskOpen.planVersion}:${taskOpen.taskId}` ? retry : null,
                onRetry: retryTask,
                onOpenRequirement: openRequirement,
                onClose: () => setTaskOpen(null),
              })
            : null,
        board
          ? h(
              'div',
              { className: 'flb-footer' },
              t('page.footer'),
              ' ',
              t('overview.boundarySource'),
            )
          : null,
        h('div', { className: 'flb-bottom-spacer', 'aria-hidden': 'true' }),
      )
    }

    function wbStateLabel(t, state) {
      const key = {
        running: 'task.running',
        failed: 'task.failed',
        blocked: 'task.blocked',
        awaiting_input: 'task.awaiting_input',
        awaiting_user: 'task.awaiting_user',
        delivered: 'task.delivered',
        pending: 'task.pending',
      }[state]
      return key ? t(key) : statusLabel(t, state)
    }

    function wbStateTone(state) {
      return TASK_TONES[state] || 'idle'
    }

    function wbIssueFor(issues, task) {
      return issues.find((issue) => issue.reqId === task.reqId && issue.taskId === task.taskId)
    }

    function wbTasksOf(tasks, requirement) {
      return tasks.filter(
        (task) => task.reqId === requirement.reqId && task.planVersion === requirement.planVersion,
      )
    }

    function wbPredecessors(tasks, task) {
      return task.dependsOn
        .map((taskId) => tasks.find((candidate) => candidate.taskId === taskId))
        .filter(Boolean)
    }

    function wbSuccessors(tasks, task) {
      return tasks.filter((candidate) => candidate.dependsOn.includes(task.taskId))
    }

    function wbCopy(text, t, notify) {
      if (!text) return
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(
          () => notify(t('wb.copied')),
          () => notify(t('wb.copyFailed') + ': ' + text),
        )
      } else {
        notify(t('wb.copyFailed') + ': ' + text)
      }
    }

    function WorkbenchTree(props) {
      const t = props.t
      const selected = props.selected
      const requirements = props.requirements
      const tasks = props.tasks
      const issues = props.issues
      return h(
        'aside',
        { className: 'flb-tree-pane', 'aria-label': t('wb.tree') },
        h(
          'div',
          { className: 'flb-wb-head' },
          h('span', { className: 'flb-wb-title' }, t('wb.tree')),
          h('span', { className: 'flb-wb-sub' }, t('wb.reqCount', { count: requirements.length })),
        ),
        requirements.length === 0
          ? h('div', { className: 'flb-tree-empty' }, t('wb.noMatch'))
          : requirements.map((requirement) => {
              const reqTasks = wbTasksOf(tasks, requirement)
              const reqIssues = issues.filter((issue) => issue.reqId === requirement.reqId)
              const open = props.expanded === requirement.reqId
              const selectedReq =
                selected.reqId === requirement.reqId && !selected.taskId && !selected.issueId
              return h(
                'div',
                { className: 'flb-tree-group', key: requirement.reqId },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'flb-tree-node',
                    'aria-current': selectedReq ? 'true' : undefined,
                    onClick: () => props.onOpenRequirement(requirement.reqId),
                  },
                  h('span', { className: 'flb-tree-kind' }, open ? '▾' : '▸'),
                  h(
                    'span',
                    { className: 'flb-tree-text' },
                    h('span', { className: 'flb-tree-kind' }, requirement.reqId),
                    h('br'),
                    requirement.title,
                  ),
                  reqIssues.length > 0 ? h('span', { className: 'flb-tree-count' }, String(reqIssues.length)) : null,
                ),
                open
                  ? h(
                      'div',
                      null,
                      reqTasks.map((task) => {
                        const taskIssue = wbIssueFor(issues, task)
                        const selectedTask = selected.taskId === task.taskId
                        return h(
                          'div',
                          { key: task.taskId },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'flb-tree-node flb-tree-child',
                              'aria-current': selectedTask ? 'true' : undefined,
                              onClick: () => props.onOpenTask(requirement.reqId, task.taskId, 'overview'),
                            },
                            h(Chip, { tone: wbStateTone(task.state) }, wbStateLabel(t, task.state)),
                            h('span', { className: 'flb-tree-text' }, task.taskId + ' · ' + task.goal),
                          ),
                          taskIssue
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'flb-tree-node flb-tree-grandchild',
                                  'aria-current': selected.issueId === taskIssue.issueId ? 'true' : undefined,
                                  onClick: () => props.onOpenIssue(taskIssue),
                                },
                                h('span', { className: 'flb-tree-kind' }, '↳'),
                                h('span', { className: 'flb-tree-text' }, taskIssue.title),
                              )
                            : null,
                        )
                      }),
                      reqIssues
                        .filter((issue) => !issue.taskId)
                        .map((issue) =>
                          h(
                            'button',
                            {
                              type: 'button',
                              key: issue.issueId,
                              className: 'flb-tree-node flb-tree-child',
                              'aria-current': selected.issueId === issue.issueId ? 'true' : undefined,
                              onClick: () => props.onOpenIssue(issue),
                            },
                            h(Chip, { tone: ISSUE_TONES[issue.severity] || 'warn' }, t(`issue.severity.${issue.severity}`)),
                            h('span', { className: 'flb-tree-text' }, issue.title),
                          ),
                        ),
                    )
                  : null,
              )
            }),
      )
    }

    function TaskRow(props) {
      const t = props.t
      const task = props.task
      const tasks = props.tasks
      const issue = props.issue
      const predecessors = wbPredecessors(tasks, task)
      const successors = wbSuccessors(tasks, task)
      return h(
        'article',
        { className: 'flb-hier-card', 'data-selected': props.selected ? 'true' : undefined },
        h(
          'div',
          { className: 'flb-hier-card-head' },
          h('span', { className: 'flb-tree-kind' }, task.taskId),
          h(Chip, { tone: wbStateTone(task.state) }, wbStateLabel(t, task.state)),
          task.resultUnknown ? h(Chip, { tone: 'warn' }, t('wb.resultUnknown')) : null,
          h(
            'button',
            {
              type: 'button',
              className: 'flb-hier-card-title',
              onClick: () => props.onOpenTask(task.reqId, task.taskId, 'overview'),
            },
            task.goal,
          ),
        ),
        h('div', { className: 'flb-hier-card-meta' }, task.lastActivity ? t('wb.lastActivity') + ': ' + formatMoment(task.lastActivity) : t('wb.pendingState')),
        h(
          'div',
          { className: 'flb-hier-card-meta' },
          h('span', null, t('wb.predecessors') + ':'),
          predecessors.length > 0
            ? predecessors.map((predecessor) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: predecessor.taskId,
                    className: 'flb-link-button',
                    onClick: () => props.onOpenTask(task.reqId, predecessor.taskId, 'relations'),
                  },
                  predecessor.taskId + ' · ' + wbStateLabel(t, predecessor.state),
                ),
              )
            : h('span', null, t('wb.noPredecessors')),
          successors.length > 0 ? h('span', null, t('wb.successors') + ': ' + successors.map((next) => next.taskId).join('、')) : null,
        ),
        task.failureReason
          ? h('div', { className: 'flb-card-failure' }, task.failureReason)
          : null,
        issue
          ? h(
              'button',
              {
                type: 'button',
                className: 'flb-hier-issue',
                onClick: () => props.onOpenIssue(issue),
              },
              '⚠ ' + issue.title,
            )
          : null,
        h(
          'div',
          { className: 'flb-hier-card-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'flb-card-action',
              onClick: () => props.onOpenTask(task.reqId, task.taskId, 'activity'),
            },
            t('wb.openExecution'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'flb-link-button',
              onClick: () => props.onOpenTask(task.reqId, task.taskId, 'overview'),
            },
            t('wb.openTask'),
          ),
        ),
      )
    }

    function RelationsPanel(props) {
      const t = props.t
      const requirement = props.requirement
      const tasks = props.tasks
      const current = props.current || null
      const node = (task, isCurrent = false) =>
        h(
          'button',
          {
            type: 'button',
            className: 'flb-rel-node',
            'data-current': isCurrent ? 'true' : undefined,
            onClick: () => props.onOpenTask(requirement.reqId, task.taskId, 'relations'),
          },
          h(
            'span',
            { className: 'flb-hier-card-head' },
            h('span', { className: 'flb-tree-kind' }, task.taskId),
            h(Chip, { tone: wbStateTone(task.state) }, wbStateLabel(t, task.state)),
          ),
          h('div', { className: 'flb-task-text' }, task.goal),
          h(
            'div',
            { className: 'flb-wb-sub' },
            wbPredecessors(tasks, task).length === 0
              ? t('wb.noPredecessors')
              : wbPredecessors(tasks, task).some((predecessor) => predecessor.state !== 'delivered')
                ? t('wb.wait', {
                    tasks: wbPredecessors(tasks, task)
                      .filter((predecessor) => predecessor.state !== 'delivered')
                      .map((predecessor) => predecessor.taskId)
                      .join('、'),
                  })
                : t('wb.dependencyReady'),
          ),
        )
      if (current) {
        const before = wbPredecessors(tasks, current)
        const after = wbSuccessors(tasks, current)
        return h(
          'div',
          { className: 'flb-relations' },
          h('div', { className: 'flb-rel-label' }, t('wb.predecessors')),
          before.length > 0
            ? before.map((task) => h('div', { className: 'flb-rel-edge', key: task.taskId }, node(task), h('span', { className: 'flb-rel-arrow' }, '→'), node(current, true)))
            : h('div', { className: 'flb-wb-sub' }, t('wb.noPredecessors')),
          h('div', { className: 'flb-rel-label' }, t('wb.successors')),
          after.length > 0
            ? after.map((task) => h('div', { className: 'flb-rel-edge', key: task.taskId }, node(current, true), h('span', { className: 'flb-rel-arrow' }, '→'), node(task)))
            : h('div', { className: 'flb-wb-sub' }, t('wb.noSuccessors')),
        )
      }
      const edges = []
      for (const task of tasks) {
        for (const predecessorId of task.dependsOn) {
          const predecessor = tasks.find((candidate) => candidate.taskId === predecessorId)
          if (predecessor) edges.push({ predecessor, task })
        }
      }
      return h(
        'div',
        { className: 'flb-relations' },
        h(
          'div',
          { className: 'flb-wb-sub' },
          t('wb.dependencies') + ' · ' + tasks.length + ' / ' + edges.length,
        ),
        edges.length > 0
          ? edges.map(({ predecessor, task }) =>
              h(
                'div',
                { className: 'flb-rel-edge', key: predecessor.taskId + ':' + task.taskId },
                node(predecessor),
                h('span', { className: 'flb-rel-arrow' }, '→'),
                node(task),
              ),
            )
          : h('div', { className: 'flb-wb-sub' }, t('wb.noPredecessors')),
        tasks
          .filter((task) => task.dependsOn.length === 0 && wbSuccessors(tasks, task).length === 0)
          .map((task) => h('div', { key: task.taskId }, node(task))),
      )
    }

    function CenterPane(props) {
      const t = props.t
      const requirement = props.requirement
      if (!requirement) {
        return h('main', { className: 'flb-main-pane' }, h('div', { className: 'flb-side-empty' }, t('wb.noSelection')))
      }
      const tasks = props.tasks
      const issues = props.issues
      const completed = tasks.filter((task) => task.state === 'delivered').length
      const ratio = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0
      return h(
        'main',
        { className: 'flb-main-pane' },
        h(
          'div',
          { className: 'flb-wb-head' },
          h('span', { className: 'flb-tree-kind' }, requirement.reqId),
          h(Chip, { tone: REQUIREMENT_TONES[requirement.status] || 'idle' }, statusLabel(t, requirement.status)),
          requirement.approval === 'approved'
            ? h(Chip, { tone: 'success' }, t('wb.approved'))
            : requirement.approval === 'stale'
              ? h(Chip, { tone: 'warn' }, t('wb.stale'))
              : h(Chip, { tone: 'warn' }, t('requirement.approvalMissing')),
          requirement.planVersion ? planReviewChip(t, requirement.planReview) : null,
          requirement.verification
            ? verificationChip(t, requirement.verification)
            : tasks.length > 0 && completed === tasks.length
              ? verificationChip(t, null)
              : null,
        ),
        h('h2', { className: 'flb-hier-title' }, requirement.title),
        h(
          'div',
          { className: 'flb-hier-meta' },
          h('span', null, t('wb.version', { version: requirement.version })),
          requirement.planVersion ? h('span', null, t('wb.plan', { plan: requirement.planVersion })) : null,
          h('span', null, t('wb.taskCount', { count: tasks.length })),
          h('span', null, t('wb.issueCount', { count: issues.length })),
        ),
        h(
          'div',
          { className: 'flb-hier-progress' },
          h('div', { className: 'flb-progress' }, h('span', { style: { width: ratio + '%' } })),
          h('div', { className: 'flb-wb-sub' }, t('wb.progress', { delivered: completed, total: tasks.length })),
        ),
        props.actionMessage
          ? h('div', { className: 'flb-card-action-message', role: 'status' }, props.actionMessage)
          : null,
        h(ActionButtons, {
          t,
          actions: requirement.actions,
          busy: props.busy,
          onAction: (action) => props.onAction(requirement, action),
        }),
        issues.length > 0
          ? h(
              'div',
              { className: 'flb-banner', 'data-tone': 'warn', style: { marginTop: '7px' } },
              h('div', { className: 'flb-label' }, t('wb.attention')),
              issues.slice(0, 4).map((issue) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: issue.issueId,
                    className: 'flb-link-button',
                    onClick: () => props.onOpenIssue(issue),
                  },
                  issue.title,
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'flb-hier-tabs', role: 'tablist' },
          [['list', t('wb.taskList')], ['relations', t('wb.dependencies')]].map(([key, label]) =>
            h(
              'button',
              {
                type: 'button',
                key,
                className: 'flb-hier-tab',
                role: 'tab',
                'aria-selected': props.workMode === key,
                onClick: () => props.onWorkMode(key),
              },
              label,
            ),
          ),
        ),
        props.workMode === 'relations'
          ? h(RelationsPanel, { t, requirement, tasks, onOpenTask: props.onOpenTask })
          : tasks.length > 0
            ? tasks.map((task) =>
                h(TaskRow, {
                  t,
                  key: task.taskId,
                  task,
                  tasks,
                  issue: wbIssueFor(issues, task),
                  selected: props.selectedTaskId === task.taskId,
                  onOpenTask: props.onOpenTask,
                  onOpenIssue: props.onOpenIssue,
                }),
              )
            : h('div', { className: 'flb-side-empty' }, t('wb.noExecutionHint')),
      )
    }

    function TaskOverview(props) {
      const t = props.t
      const task = props.task
      const detail = props.detail
      if (detail.phase === 'loading' || detail.phase === 'idle') {
        return h('div', { className: 'flb-side-empty' }, t('wb.loading'))
      }
      if (detail.phase === 'error') {
        return h('div', { className: 'flb-error-inline', role: 'alert' }, detail.error || t('wb.error'))
      }
      const data = detail.data || {}
      const run = data.run || null
      const advice = data.advice || null
      const retry = data.retry || null
      const stale =
        run && (run.state === 'running' || data.waitingForInput) && heartbeatStale(run.updatedAt)
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'flb-hier-card-head' },
          h('span', { className: 'flb-tree-kind' }, task.taskId),
          h(Chip, { tone: wbStateTone(task.state) }, wbStateLabel(t, task.state)),
          task.resultUnknown ? h(Chip, { tone: 'warn' }, t('wb.resultUnknown')) : null,
          stale ? h(Chip, { tone: 'warn' }, t('task.heartbeatStale')) : null,
        ),
        data.waitingForInput
          ? h('div', { className: 'flb-banner', 'data-tone': 'warn', style: { marginTop: '6px' } }, t('task.waitingInputBanner'))
          : null,
        task.resultUnknown
          ? h('div', { className: 'flb-banner', 'data-tone': 'error', style: { marginTop: '6px' } }, t('task.unknownBanner'))
          : null,
        data.requirement && data.requirement.stopRequested
          ? h('div', { className: 'flb-banner', 'data-tone': 'warn', style: { marginTop: '6px' } }, t('task.stopBanner'))
          : null,
        h(
          'div',
          { className: 'flb-section', style: { marginTop: '8px' } },
          h('div', { className: 'flb-label' }, t('wb.taskGoal')),
          h('div', { className: 'flb-task-text' }, task.goal),
          h(Kv, { label: t('wb.acceptance') }, task.acceptance || '—'),
          h(Kv, { label: t('task.testCommand') }, (task.testCommand || []).join(' ')),
          h(Kv, { label: t('wb.files') }, (task.files || []).length ? (task.files || []).join('、') : '—'),
          h(Kv, { label: t('wb.dependsOn') }, (task.dependsOn || []).length ? (task.dependsOn || []).join('、') : t('wb.noPredecessors')),
          task.verification ? h(Kv, { label: t('task.verification') }, t('common.yes')) : null,
        ),
        run
          ? h(
              'div',
              { className: 'flb-section' },
              h('div', { className: 'flb-label' }, t('task.lastActivity')),
              h('div', { className: 'flb-task-text' }, run.reason || wbStateLabel(t, run.state)),
              h('div', { className: 'flb-wb-sub' }, formatMoment(run.updatedAt)),
            )
          : null,
        advice
          ? h(
              'div',
              { className: 'flb-section' },
              h('div', { className: 'flb-label' }, t('task.failureReason')),
              h('div', { className: 'flb-task-text' }, advice.cause || '—'),
              h('div', { className: 'flb-label' }, t('task.failureAction')),
              h(BulletList, { items: advice.actions || [] }),
            )
          : null,
        h(
          'div',
          { className: 'flb-hier-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'flb-card-action',
              onClick: () => props.onOpenExecution(task, 'activity'),
            },
            t('wb.openExecution'),
          ),
          retry && retry.allowed
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'flb-card-action',
                  disabled: Boolean(props.retry && props.retry.busy),
                  onClick: () => props.onRetry(task),
                },
                props.retry && props.retry.busy
                  ? t('task.retrying')
                  : props.retry && props.retry.confirm
                    ? t('task.retryConfirm')
                    : t('task.retry'),
              )
            : retry && retry.reason
              ? h('span', { className: 'flb-muted' }, t('task.retryNotAllowed', { reason: retry.reason }))
              : null,
          h(
            'button',
            {
              type: 'button',
              className: 'flb-link-button',
              onClick: () => props.onOpenRequirement(task.reqId),
            },
            t('wb.openRequirement'),
          ),
        ),
        props.retry && props.retry.message
          ? h('div', { className: 'flb-card-action-message' }, props.retry.message)
          : null,
      )
    }

    function IssueOverview(props) {
      const t = props.t
      const issue = props.issue
      if (!issue) return h('div', { className: 'flb-side-empty' }, t('wb.noSelection'))
      const task = props.task
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'flb-hier-card-head' },
          h(Chip, { tone: ISSUE_TONES[issue.severity] || 'warn' }, t(`issue.severity.${issue.severity}`)),
          h(Chip, { tone: 'idle' }, t(`issue.${issue.kind}`)),
          h('span', { className: 'flb-tree-kind' }, issue.issueId),
        ),
        h('div', { className: 'flb-hier-title' }, issue.title),
        h('div', { className: 'flb-task-text' }, issue.detail || '—'),
        h(
          'div',
          { className: 'flb-section', style: { marginTop: '8px' } },
          h('div', { className: 'flb-label' }, t('wb.related')),
          task
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'flb-link-button',
                  onClick: () => props.onOpenTask(issue.reqId, task.taskId, 'overview'),
                },
                t('wb.openTask') + ' ' + task.taskId,
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'flb-link-button',
                  onClick: () => props.onOpenRequirement(issue.reqId),
                },
                t('wb.openRequirement') + ' ' + issue.reqId,
              ),
        ),
        task
          ? h(
              'div',
              { className: 'flb-hier-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'flb-card-action',
                  onClick: () => props.onOpenTask(issue.reqId, task.taskId, 'activity'),
                },
                t('wb.openExecution'),
              ),
            )
          : null,
        h(
          'div',
          { className: 'flb-wb-sub', style: { marginTop: '8px' } },
          t('wb.attemptNote'),
        ),
      )
    }

    function TestsPanel(props) {
      const t = props.t
      const detail = props.detail
      const [message, setMessage] = React.useState('')
      if (!detail || detail.phase === 'loading' || detail.phase === 'idle') {
        return h('div', { className: 'flb-side-empty' }, t('wb.loading'))
      }
      if (detail.phase === 'error') {
        return h('div', { className: 'flb-error-inline', role: 'alert' }, detail.error || t('wb.error'))
      }
      const data = detail.data || {}
      const review = data.review
      const evidence = data.evidence
      const artifact = data.artifact
      return h(
        'div',
        { className: 'flb-section' },
        h(
          'div',
          { className: 'flb-hier-card-head' },
          h('span', { className: 'flb-label' }, t('wb.tests')),
          data.testLogTail ? h(Chip, { tone: 'brand' }, t('task.testLog')) : null,
        ),
        data.testLogPath
          ? h(Kv, { label: t('wb.path') }, data.testLogPath)
          : null,
        h(Kv, { label: t('task.testCommand') }, (data.task && data.task.testCommand ? data.task.testCommand : []).join(' ')),
        data.testLogBytes !== undefined ? h(Kv, { label: t('wb.size') }, String(data.testLogBytes) + ' B') : null,
        data.testExitCode !== undefined && data.testExitCode !== null
          ? h(Kv, { label: t('wb.exitCode') }, String(data.testExitCode))
          : null,
        data.testDurationMs !== undefined && data.testDurationMs !== null
          ? h(Kv, { label: t('wb.duration') }, String(data.testDurationMs) + ' ms')
          : null,
        data.testStartedAt ? h(Kv, { label: t('wb.started') }, formatMoment(data.testStartedAt)) : null,
        message ? h('div', { className: 'flb-card-action-message' }, message) : null,
        data.testLogPath
          ? h(
              'button',
              {
                type: 'button',
                className: 'flb-copy',
                onClick: () => wbCopy(data.testLogPath, t, setMessage),
              },
              t('wb.copy') + ' · ' + t('task.testLog'),
            )
          : null,
        data.testLogTail
          ? h(
              'details',
              { className: 'flb-details', open: false },
              h('summary', null, t('task.testLog')),
              data.testLogTruncated ? h('div', { className: 'flb-wb-sub' }, t('task.testLogTruncated')) : null,
              h('pre', { className: 'flb-exec-pre' }, data.testLogTail),
            )
          : h('div', { className: 'flb-wb-sub' }, t('task.noTestLog')),
        h(
          'div',
          { className: 'flb-section', style: { marginTop: '10px' } },
          h('div', { className: 'flb-label' }, t('task.review')),
          review
            ? h(
                'div',
                null,
                h(Kv, { label: t('task.reviewVerdict') }, review.verdict || '—'),
                h(Kv, { label: t('task.reviewSummary') }, review.summary || '—'),
                h('div', { className: 'flb-label' }, t('task.reviewFindings')),
                h(BulletList, { items: review.findings || [] }),
                h('div', { className: 'flb-label' }, t('task.reviewBlocking')),
                h(BulletList, { items: review.blocking || [] }),
                h('div', { className: 'flb-wb-sub' }, t('task.reviewNote')),
              )
            : h('div', { className: 'flb-wb-sub' }, t('task.reviewNone')),
        ),
        h(
          'div',
          { className: 'flb-section', style: { marginTop: '10px' } },
          h('div', { className: 'flb-label' }, t('task.evidence')),
          artifact
            ? h(
                'div',
                { className: 'flb-evidence' },
                h('div', { className: 'flb-card-meta' }, 'candidate: ' + artifact.candidateSha256),
                h('div', { className: 'flb-card-meta' }, 'test: ' + artifact.testEvidenceSha256),
                h('div', { className: 'flb-card-meta' }, 'review: ' + artifact.reviewSha256),
                h('div', { className: 'flb-card-meta' }, 'authorization: ' + (artifact.authorizationSource || '—')),
                h('div', { className: 'flb-card-meta' }, 'baseline: ' + (artifact.baselineCommit || '—')),
                h('div', { className: 'flb-card-meta' }, t('detail.recordedAt') + ': ' + formatMoment(artifact.recordedAt)),
              )
            : h('div', { className: 'flb-wb-sub' }, t('task.artifactMissing')),
          evidence
            ? h(
                'div',
                { className: 'flb-evidence', style: { marginTop: '6px' } },
                h('div', { className: 'flb-card-meta' }, 'workspace: ' + (evidence.workspacePath || '—')),
                h('div', { className: 'flb-card-meta' }, 'candidate: ' + (evidence.candidatePath || '—')),
                h('div', { className: 'flb-card-meta' }, 'test log: ' + (evidence.testLogPath || '—')),
                h('div', { className: 'flb-card-meta' }, 'review: ' + (evidence.reviewPath || '—')),
                h('div', { className: 'flb-card-meta' }, 'sessions: ' + (evidence.devSession || '—') + ' / ' + (evidence.reviewSession || '—')),
              )
            : h('div', { className: 'flb-wb-sub' }, t('task.evidenceMissing')),
        ),
      )
    }

    function ExecutionProcess(props) {
      const t = props.t
      const read = props.read
      const task = props.task
      const [state, setState] = React.useState({ phase: 'idle', data: null, error: '' })
      const [attemptId, setAttemptId] = React.useState('')
      const [paused, setPaused] = React.useState(false)
      const [incoming, setIncoming] = React.useState(null)
      const [message, setMessage] = React.useState('')
      const inflight = React.useRef(false)
      const dataRef = React.useRef(null)
      const scrollRef = React.useRef(null)
      const scrollTop = React.useRef(0)

      React.useEffect(() => {
        dataRef.current = state.data
      }, [state.data])

      const load = React.useCallback(
        (offset, limit, replace) => {
          if (!task || inflight.current) return
          inflight.current = true
          if (replace) setState((previous) => ({ phase: previous.data ? 'refreshing' : 'loading', data: previous.data, error: '' }))
          read('execution', {
            reqId: task.reqId,
            planVersion: task.planVersion,
            taskId: task.taskId,
            offset,
            limit,
          })
            .then((data) => {
              inflight.current = false
              if (replace) {
                if (scrollRef.current) scrollTop.current = scrollRef.current.scrollTop
                setState({ phase: 'ready', data, error: '' })
                setAttemptId(data.attempts && data.attempts[0] ? data.attempts[0].attemptId : '')
              } else {
                setState((previous) => ({
                  phase: 'ready',
                  data: previous.data
                    ? {
                        ...previous.data,
                        events: [...(previous.data.events || []), ...(data.events || [])],
                        offset: 0,
                        limit: (previous.data.limit || 0) + (data.limit || 0),
                        truncated: data.truncated,
                        total: data.total,
                      }
                    : data,
                  error: '',
                }))
              }
            })
            .catch((error) => {
              inflight.current = false
              setState((previous) => ({ phase: 'error', data: previous.data, error: error.message || String(error) }))
            })
        },
        [read, task && task.reqId, task && task.taskId, task && task.planVersion],
      )

      React.useEffect(() => {
        if (!task) return
        setState({ phase: 'loading', data: null, error: '' })
        setAttemptId('')
        setIncoming(null)
        setPaused(false)
        load(0, 100, true)
      }, [task && task.reqId, task && task.taskId, task && task.planVersion])

      React.useEffect(() => {
        const data = state.data
        if (!data || !data.attempts || !data.attempts[0] || paused || !props.active) return
        if (attemptId && data.attempts[0].attemptId !== attemptId) return
        if (!data.attempts[0].available) return
        const timer = setInterval(() => {
          if (inflight.current) return
          const current = dataRef.current
          if (!current) return
          read('execution', {
            reqId: task.reqId,
            planVersion: task.planVersion,
            taskId: task.taskId,
            offset: 0,
            limit: Math.max(100, (current.events || []).length),
          })
            .then((next) => {
              if (next.total > current.total) setIncoming(next)
              else {
                setState((previous) => previous.data ? { phase: 'ready', data: { ...previous.data, stages: next.stages, run: next.run, lastActivity: next.lastActivity }, error: '' } : previous)
              }
            })
            .catch(() => {})
        }, 4000)
        return () => clearInterval(timer)
      }, [paused, state.data && state.data.total, attemptId, props.active, task && task.taskId])

      const data = state.data
      if (state.phase === 'loading' && !data) return h('div', { className: 'flb-side-empty' }, t('wb.loading'))
      if (state.phase === 'error' && !data) return h('div', { className: 'flb-error-inline', role: 'alert' }, state.error)
      if (!data) return h('div', { className: 'flb-side-empty' }, t('wb.noExecution'))
      const attempts = data.attempts || []
      const currentAttempt = attempts[0] || null
      const historical = attemptId && currentAttempt && currentAttempt.attemptId !== attemptId
        ? attempts.find((attempt) => attempt.attemptId === attemptId)
        : null
      const showEvents = !historical && currentAttempt && currentAttempt.available
      const events = data.events || []
      const stages = data.stages || []
      const test = data.test || {}
      const session = data.session || {}
      return h(
        'div',
        { className: 'flb-exec' },
        h(
          'div',
          { className: 'flb-exec-toolbar' },
          h('span', { className: 'flb-wb-title' }, t('wb.execution')),
          h('span', { className: 'flb-wb-sub' }, t('wb.executionTotal', { count: data.total || 0 })),
          h('div', { className: 'flb-wb-spacer' }),
          h(
            'button',
            { type: 'button', className: 'flb-filter', onClick: () => setPaused((value) => !value) },
            paused ? t('wb.resume') : t('wb.pause'),
          ),
          h(
            'button',
            { type: 'button', className: 'flb-filter', onClick: () => load(0, 100, true) },
            t('page.refresh'),
          ),
        ),
        incoming
          ? h(
              'div',
              { className: 'flb-exec-notice' },
              t('wb.newEvents') + ' · ' + t('wb.executionTotal', { count: incoming.total }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'flb-link-button',
                  onClick: () => {
                    setState({ phase: 'ready', data: incoming, error: '' })
                    setIncoming(null)
                    requestAnimationFrame(() => {
                      if (scrollRef.current) scrollRef.current.scrollTop = scrollTop.current
                    })
                  },
                },
                t('page.refresh'),
              ),
            )
          : null,
        h(
          'div',
          { className: 'flb-exec-identity' },
          h(Kv, { label: t('wb.requirement') }, data.reqId + ' · v' + (data.requirement ? data.requirement.version : '?')),
          h(Kv, { label: t('wb.planLabel') }, t('wb.plan', { plan: data.planVersion })),
          h(Kv, { label: t('wb.task') }, task.taskId + ' / v' + task.planVersion),
          h(Kv, { label: t('wb.attempt') }, attemptId || t('wb.missing')),
          h(Kv, { label: t('wb.session') }, session.dev || t('wb.sessionUnavailable')),
          h(Kv, { label: t('wb.started') }, formatMoment(data.startedAt)),
          h(Kv, { label: t('wb.lastActivity') }, formatMoment(data.lastActivity)),
        ),
        h(
          'div',
          { className: 'flb-exec-attempt' },
          h('span', { className: 'flb-wb-sub' }, t('wb.attempt')),
          h(
            'select',
            {
              value: attemptId,
              'aria-label': t('wb.attempt'),
              onChange: (event) => setAttemptId(event.target.value),
            },
            attempts.map((attempt) =>
              h(
                'option',
                { key: attempt.attemptId, value: attempt.attemptId },
                attempt.label + (attempt.available ? '' : ' · ' + t('wb.missing')),
              ),
            ),
          ),
          session.dev
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'flb-copy',
                  onClick: () => wbCopy(session.dev, t, setMessage),
                },
                t('wb.copy'),
              )
            : null,
          h('span', { className: 'flb-wb-sub' }, t('wb.attemptNote')),
        ),
        message ? h('div', { className: 'flb-card-action-message' }, message) : null,
        h(
          'div',
          { className: 'flb-exec-stages' },
          stages.map((stage) =>
            h(
              'div',
              { className: 'flb-exec-stage', key: stage.id },
              h('div', { className: 'flb-exec-stage-title' }, stage.label),
              h(
                'div',
                { className: 'flb-exec-stage-text' },
                stage.id === 'dev'
                  ? (stage.state || '—') + (stage.total ? ' · ' + t('wb.executionTotal', { count: stage.total }) : '')
                  : stage.id === 'review'
                    ? (stage.available ? (stage.verdict || '—') : t('wb.missing')) + (stage.sessionId ? ' · ' + stage.sessionId : '')
                    : stage.id === 'formal_test'
                      ? stage.available
                        ? t('wb.exitCode') + ': ' + (stage.exitCode === null ? '—' : stage.exitCode) + (stage.durationMs !== null ? ' · ' + stage.durationMs + 'ms' : '')
                        : t('wb.missing')
                      : stage.delivered
                        ? t('wb.deliveredState') + ' · ' + formatMoment(stage.recordedAt)
                        : t('wb.missing'),
              ),
            ),
          ),
        ),
        historical
          ? h('div', { className: 'flb-exec-empty' }, t('wb.attemptUnavailable'))
          : showEvents
            ? h(
                'div',
                { className: 'flb-exec-timeline', ref: scrollRef, onScroll: (event) => { scrollTop.current = event.currentTarget.scrollTop } },
                h('div', { className: 'flb-wb-sub' }, t('wb.steps', { count: data.stepCount || 0 })),
                events.map((event) =>
                  h(
                    'div',
                    { className: 'flb-exec-event', key: event.id, 'data-kind': event.kind },
                    h(
                      'div',
                      { className: 'flb-exec-event-head' },
                      h(
                        'span',
                        { className: 'flb-exec-event-title' },
                        event.kind === 'tool'
                          ? t('wb.tool') + ' · ' + event.tool.name
                          : event.kind === 'phase'
                            ? event.title
                            : event.role === 'user'
                              ? t('wb.taskInput')
                              : t('wb.publicMessage'),
                      ),
                      h('time', { className: 'flb-exec-event-time' }, formatMoment(event.at)),
                    ),
                    event.kind === 'tool' && event.tool
                      ? h(
                          'div',
                          null,
                          h(
                            'div',
                            { className: 'flb-exec-tool-status', 'data-error': event.tool.isError ? 'true' : undefined },
                            event.tool.status === 'completed'
                              ? t('wb.toolCompleted')
                              : event.tool.status === 'failed'
                                ? t('wb.toolFailed')
                                : t('wb.toolPending'),
                          ),
                          h(
                            'details',
                            null,
                            h('summary', null, t('wb.toolInput')),
                            h('pre', { className: 'flb-exec-pre' }, event.tool.input || '—'),
                          ),
                          h(
                            'details',
                            null,
                            h('summary', null, t('wb.toolOutput')),
                            h('pre', { className: 'flb-exec-pre' }, event.tool.output || '—'),
                          ),
                          event.tool.outputTruncated ? h('div', { className: 'flb-wb-sub' }, t('wb.truncated')) : null,
                        )
                      : event.text
                        ? event.role === 'user' || event.text.length > 500
                          ? h(
                              'details',
                              null,
                              h('summary', null, event.text.slice(0, 80)),
                              h('pre', { className: 'flb-exec-event-text' }, event.text),
                              event.textTruncated ? h('div', { className: 'flb-wb-sub' }, t('wb.truncated')) : null,
                            )
                          : h('pre', { className: 'flb-exec-event-text' }, event.text)
                        : null,
                  ),
                ),
                data.truncated
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'flb-card-action',
                        onClick: () => load(events.length, 100, false),
                      },
                      t('wb.loadMore') + ' · ' + t('wb.executionTotal', { count: data.total }),
                    )
                  : null,
              )
            : h(
                'div',
                { className: 'flb-exec-empty' },
                t('wb.noExecution') + ' ' + (currentAttempt && currentAttempt.reason ? currentAttempt.reason : ''),
              ),
        h(
          'div',
          { className: 'flb-hier-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'flb-link-button',
              onClick: () => wbCopy(data.reviewPath || '', t, setMessage),
            },
            t('wb.copy') + ' · ' + t('task.review'),
          ),
          test.path
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'flb-link-button',
                  onClick: () => wbCopy(test.path, t, setMessage),
                },
                t('wb.copy') + ' · ' + t('task.testLog'),
              )
            : null,
          h('span', { className: 'flb-wb-sub' }, t('task.reviewNote')),
        ),
      )
    }

    function RequirementActivity(props) {
      const t = props.t
      return h(
        'div',
        { className: 'flb-section' },
        props.tasks.length === 0
          ? h('div', { className: 'flb-side-empty' }, t('wb.noExecution'))
          : props.tasks.map((task) =>
              h(
                'div',
                { className: 'flb-list-item', key: task.taskId },
                h(
                  'div',
                  { className: 'flb-hier-card-head' },
                  h('span', { className: 'flb-tree-kind' }, task.taskId),
                  h(Chip, { tone: wbStateTone(task.state) }, wbStateLabel(t, task.state)),
                  h('span', { className: 'flb-wb-sub' }, formatMoment(task.lastActivity)),
                ),
                h('div', { className: 'flb-task-text' }, task.goal),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'flb-link-button',
                    onClick: () => props.onOpenTask(task.reqId, task.taskId, 'activity'),
                  },
                  t('wb.openExecution'),
                ),
              ),
            ),
      )
    }

    function VersionPanel(props) {
      const t = props.t
      const requirement = props.requirement
      const detail = props.reqDetail
      const task = props.task
      return h(
        'div',
        { className: 'flb-section' },
        requirement
          ? h(
              'div',
              null,
              h('div', { className: 'flb-label' }, t('wb.versionHistory')),
              detail && detail.data && Array.isArray(detail.data.versions)
                ? detail.data.versions.map((version) =>
                    h(
                      'div',
                      { className: 'flb-subsection', key: version.version },
                      h('div', { className: 'flb-label' }, 'v' + version.version + ' · ' + formatMoment(version.createdAt)),
                      h('div', { className: 'flb-task-text' }, version.text),
                    ),
                  )
                : h('div', { className: 'flb-wb-sub' }, t('wb.loading')),
              h(Kv, { label: t('wb.approval') }, requirement.approval === 'approved' ? t('wb.approved') : requirement.approval === 'stale' ? t('wb.stale') : t('requirement.approvalMissing')),
              h(
                Kv,
                { label: t('wb.planReview') },
                requirement.planReview
                  ? `${t(`detail.verdict.${requirement.planReview.verdict}`)} · ${requirement.planReview.summary || '—'}`
                  : t('requirement.planReviewMissing'),
              ),
              h(
                Kv,
                { label: t('wb.verification') },
                requirement.verification
                  ? [
                      t(`detail.verdict.${requirement.verification.verdict}`),
                      requirement.verification.fresh
                        ? t('detail.verificationFresh')
                        : t('detail.verificationStale'),
                      requirement.verification.summary || '—',
                    ].join(' · ')
                  : t('requirement.verificationMissing'),
              ),
              h(
                Kv,
                { label: t('wb.businessReview') },
                requirement.businessReview
                  ? [
                      t(`detail.verdict.${requirement.businessReview.verdict}`),
                      requirement.businessReview.fresh ? t('detail.verificationFresh') : t('detail.verificationStale'),
                      requirement.businessReview.summary || '—',
                    ].join(' · ')
                  : t('wb.missing'),
              ),
              h(
                Kv,
                { label: t('wb.candidate') },
                requirement.candidate
                  ? [
                      'v' + requirement.candidate.packageVersion,
                      String(requirement.candidate.artifactSha256 || '').slice(0, 16) + '…',
                      formatMoment(requirement.candidate.builtAt),
                    ].join(' · ')
                  : t('wb.missing'),
              ),
              h(
                Kv,
                { label: t('wb.deployment') },
                requirement.deployment
                  ? [
                      requirement.deployment.state,
                      requirement.deployment.targetProfile,
                      'v' + requirement.deployment.runtimeVersion,
                      ...[].concat(requirement.deployment.failedChecks || []).slice(0, 2),
                    ].join(' · ')
                  : t('wb.missing'),
              ),
            )
          : null,
        task && props.taskDetail && props.taskDetail.data
          ? h(
              'div',
              { className: 'flb-section' },
              h('div', { className: 'flb-label' }, t('wb.failureRounds')),
              props.taskDetail.data.failureRounds.length === 0
                ? h('div', { className: 'flb-wb-sub' }, t('wb.missing'))
                : props.taskDetail.data.failureRounds.map((round) =>
                    h(
                      'div',
                      { className: 'flb-list-item', key: round.roundId },
                      h('div', { className: 'flb-wb-sub' }, round.stage + ' · ' + formatMoment(round.occurredAt)),
                      h('div', { className: 'flb-task-text' }, round.summary),
                    ),
                  ),
            )
          : null,
        props.issue
          ? h('div', { className: 'flb-wb-sub' }, t('wb.attemptNote'))
          : null,
      )
    }

    function RequirementTests(props) {
      const t = props.t
      const detail = props.reqDetail
      if (!detail || detail.phase !== 'ready' || !detail.data) {
        return h('div', { className: 'flb-side-empty' }, t('wb.loading'))
      }
      const data = detail.data
      const artifacts = Array.isArray(data.artifacts) ? data.artifacts : []
      return h(
        'div',
        { className: 'flb-section' },
        h('div', { className: 'flb-label' }, t('task.evidence')),
        artifacts.length === 0
          ? h('div', { className: 'flb-wb-sub' }, t('detail.noArtifacts'))
          : artifacts.map((artifact) =>
              h(
                'div',
                { className: 'flb-evidence', key: artifact.taskId },
                h('div', { className: 'flb-label' }, artifact.taskId),
                h('div', { className: 'flb-card-meta' }, 'candidate: ' + artifact.candidateSha256),
                h('div', { className: 'flb-card-meta' }, 'test: ' + artifact.testEvidenceSha256),
                h('div', { className: 'flb-card-meta' }, 'review: ' + artifact.reviewSha256),
                h('div', { className: 'flb-card-meta' }, t('detail.recordedAt') + ': ' + formatMoment(artifact.recordedAt)),
              ),
            ),
        h(
          'div',
          { className: 'flb-section', style: { marginTop: '10px' } },
          h('div', { className: 'flb-label' }, t('detail.acceptanceRecord')),
          data.acceptanceRecord
            ? h('div', { className: 'flb-task-text' }, data.acceptanceRecord.accepted_by ? t('detail.acceptedMeta', { by: data.acceptanceRecord.accepted_by, time: formatMoment(data.acceptanceRecord.accepted_at), source: data.acceptanceRecord.acceptance_source || '—' }) : t('detail.notAccepted'))
            : h('div', { className: 'flb-wb-sub' }, t('detail.notAccepted')),
        ),
      )
    }

    function DetailPane(props) {
      const t = props.t
      const selection = props.selection
      const requirement = props.requirement
      const selectionKind = selection.kind || 'requirement'
      const task = selectionKind === 'task' ? props.task : null
      const issueTask = selectionKind === 'issue' ? props.task : null
      const issue = selectionKind === 'issue' ? props.issue : null
      if (!requirement) {
        return h('aside', { className: 'flb-side' }, h('div', { className: 'flb-side-empty' }, t('wb.noSelection')))
      }
      const kind = selectionKind
      const tabs = [
        ['overview', t('wb.overview')],
        ['relations', t('wb.relations')],
        ['activity', t('wb.activity')],
        ['tests', t('wb.tests')],
        ['changes', t('wb.changes')],
      ]
      const title = task ? task.goal : issue ? issue.title : requirement.title
      const state = task ? task.state : issue ? issue.kind : requirement.status
      const executionTask = task || issueTask
      const stateChip = task
        ? h(Chip, { tone: wbStateTone(task.state) }, wbStateLabel(t, task.state))
        : issue
          ? h(Chip, { tone: ISSUE_TONES[issue.severity] || 'warn' }, t(`issue.severity.${issue.severity}`))
          : h(Chip, { tone: REQUIREMENT_TONES[requirement.status] || 'idle' }, statusLabel(t, requirement.status))
      return h(
        'aside',
        { className: 'flb-side', 'aria-label': t(`wb.${kind}`) },
        h(
          'div',
          { className: 'flb-side-head' },
          h(
            'div',
            { className: 'flb-breadcrumb' },
            h(
              'button',
              { type: 'button', onClick: () => props.onOpenRequirement(requirement.reqId) },
              requirement.reqId,
            ),
            task ? h('span', null, '›') : null,
            task
              ? h('button', { type: 'button', onClick: () => props.onOpenTask(task.reqId, task.taskId, 'overview') }, task.taskId)
              : null,
            issue ? h('span', null, '› ' + issue.issueId) : null,
          ),
          h(
            'div',
            { className: 'flb-hier-actions' },
            h(
              'button',
              { type: 'button', className: 'flb-side-close flb-mobile-back', onClick: props.onBack },
              t('wb.back'),
            ),
            h(
              'button',
              { type: 'button', className: 'flb-side-close', onClick: props.onToggleFull },
              props.fullDetail ? t('wb.backWorkbench') : t('wb.full'),
            ),
          ),
        ),
        h('div', { className: 'flb-hier-card-head' }, h('span', { className: 'flb-tree-kind' }, t(`wb.${kind}`)), stateChip, h('span', { className: 'flb-tree-kind' }, kind === 'requirement' ? requirement.reqId : task ? task.taskId : issue.issueId)),
        h('h2', { className: 'flb-hier-title' }, title),
        props.actionMessage ? h('div', { className: 'flb-card-action-message', role: 'status' }, props.actionMessage) : null,
        kind === 'requirement'
          ? h(ActionButtons, {
              t,
              actions: requirement.actions,
              busy: props.busy,
              onAction: (action) => props.onAction(requirement, action),
            })
          : kind === 'task'
            ? h(
                'div',
                { className: 'flb-hier-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'flb-card-action',
                    onClick: () => props.onOpenTask(task.reqId, task.taskId, 'activity'),
                  },
                  t('wb.openExecution'),
                ),
                props.taskDetail && props.taskDetail.data && props.taskDetail.data.retry && props.taskDetail.data.retry.allowed
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'flb-card-action',
                        disabled: Boolean(props.retry && props.retry.busy),
                        onClick: () => props.onRetry(task),
                      },
                      props.retry && props.retry.confirm ? t('task.retryConfirm') : t('task.retry'),
                    )
                  : null,
              )
            : h(
                'div',
                { className: 'flb-hier-actions' },
                h(
                  'button',
                  { type: 'button', className: 'flb-card-action', onClick: () => props.onOpenRequirement(issue.reqId) },
                  t('wb.openRequirement'),
                ),
                issueTask
                  ? h(
                      'button',
                      { type: 'button', className: 'flb-card-action', onClick: () => props.onOpenTask(issueTask.reqId, issueTask.taskId, 'activity') },
                      t('wb.openExecution'),
                    )
                  : null,
              ),
        h(
          'div',
          { className: 'flb-side-tabs', role: 'tablist' },
          tabs.map(([key, label]) =>
            h(
              'button',
              {
                type: 'button',
                key,
                role: 'tab',
                className: 'flb-side-tab',
                'aria-selected': props.tab === key,
                onClick: () => props.onTab(key),
              },
              label,
            ),
          ),
        ),
        h(
          'div',
          { className: 'flb-side-body' },
          h(
            'div',
            { className: props.tab === 'activity' ? 'flb-exec-slot' : 'flb-hidden' },
            executionTask
              ? h(ExecutionProcess, {
                  t,
                  read: props.read,
                  task: executionTask,
                  active: props.tab === 'activity',
                })
              : null,
          ),
          props.tab === 'activity'
            ? executionTask
              ? null
              : h(RequirementActivity, { t, tasks: props.tasks, onOpenTask: props.onOpenTask })
            :
          props.tab === 'overview'
            ? kind === 'requirement'
              ? h(RequirementDetail, { t, detail: props.reqDetail, tasks: props.tasks })
              : kind === 'task'
                ? h(TaskOverview, {
                    t,
                    task,
                    detail: props.taskDetail,
                    retry: props.retry,
                    onRetry: props.onRetry,
                    onOpenExecution: props.onOpenTask,
                    onOpenRequirement: props.onOpenRequirement,
                  })
                : h(IssueOverview, {
                    t,
                    issue,
                    task: issueTask,
                    onOpenTask: props.onOpenTask,
                    onOpenRequirement: props.onOpenRequirement,
                  })
            : props.tab === 'relations'
              ? h(RelationsPanel, {
                  t,
                  requirement,
                  tasks: props.tasks,
                  current: task || issueTask || null,
                  onOpenTask: props.onOpenTask,
                })
              : props.tab === 'activity'
                ? task
                  ? h(ExecutionProcess, {
                      t,
                      read: props.read,
                      task,
                      active: props.active,
                    })
                  : kind === 'issue' && issueTask
                    ? h(ExecutionProcess, { t, read: props.read, task: issueTask, active: props.active })
                    : h(RequirementActivity, { t, tasks: props.tasks, onOpenTask: props.onOpenTask })
                : props.tab === 'tests'
                  ? task
                    ? h(TestsPanel, { t, detail: props.taskDetail })
                    : kind === 'issue' && issueTask
                      ? h(TestsPanel, { t, detail: props.taskDetail })
                      : h(RequirementTests, { t, reqDetail: props.reqDetail })
                  : h(VersionPanel, {
                      t,
                      requirement,
                      reqDetail: props.reqDetail,
                      task,
                      taskDetail: props.taskDetail,
                      issue,
                    }),
        ),
      )
    }

    function AllTasksPane(props) {
      const t = props.t
      return h(
        'main',
        { className: 'flb-main-pane' },
        h('h2', { className: 'flb-hier-title' }, t('wb.allTasks')),
        h('div', { className: 'flb-wb-sub' }, t('overview.searchScope')),
        props.requirements.length === 0
          ? h('div', { className: 'flb-side-empty' }, t('wb.noMatch'))
          : props.requirements.map((requirement) => {
              const tasks = wbTasksOf(props.tasks, requirement)
              return h(
                'section',
                { key: requirement.reqId, style: { marginTop: '10px' } },
                h(
                  'div',
                  { className: 'flb-wb-head' },
                  h('span', { className: 'flb-tree-kind' }, requirement.reqId),
                  h(
                    'button',
                    { type: 'button', className: 'flb-link-button', onClick: () => props.onOpenRequirement(requirement.reqId) },
                    requirement.title,
                  ),
                ),
                tasks.length > 0
                  ? tasks.map((task) =>
                      h(TaskRow, {
                        t,
                        key: task.taskId,
                        task,
                        tasks,
                        issue: wbIssueFor(props.issues, task),
                        selected: props.selectedTaskId === task.taskId,
                        onOpenTask: props.onOpenTask,
                        onOpenIssue: props.onOpenIssue,
                      }),
                    )
                  : h('div', { className: 'flb-wb-sub' }, t('wb.noExecutionHint')),
              )
            }),
      )
    }

    function IssuesPane(props) {
      const t = props.t
      return h(
        'main',
        { className: 'flb-main-pane' },
        h('h2', { className: 'flb-hier-title' }, t('wb.attention')),
        h('div', { className: 'flb-wb-sub' }, t('overview.searchScope')),
        props.items.length === 0
          ? h('div', { className: 'flb-side-empty' }, t('wb.noIssues'))
          : props.items.map((item) =>
              h(
                'article',
                { className: 'flb-hier-card', key: item.key },
                h(
                  'div',
                  { className: 'flb-hier-card-head' },
                  h('span', { className: 'flb-tree-kind' }, item.reqId + (item.taskId ? ' › ' + item.taskId : '')),
                  h(Chip, { tone: item.tone || 'warn' }, item.kindLabel),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'flb-hier-card-title',
                    onClick: () => props.onOpen(item),
                  },
                  item.title,
                ),
                item.detail ? h('div', { className: 'flb-wb-sub' }, item.detail) : null,
                h(
                  'div',
                  { className: 'flb-hier-card-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'flb-card-action',
                      onClick: () => props.onOpen(item),
                    },
                    item.taskId ? t('wb.openTask') : t('wb.openRequirement'),
                  ),
                ),
              ),
            ),
      )
    }

    const OPS_STATE_TONE = {
      open: 'warn',
      diagnosed: 'warn',
      awaiting_decision: 'warn',
      recovering: 'warn',
      recovered: 'success',
      unresolved: 'error',
      unknown: 'error',
      closed: 'idle',
    }
    const OPS_SEVERITY_TONE = { critical: 'error', major: 'warn', minor: 'idle' }

    /** 运维视图：只读事实 + 所有者动作（批准/拒绝/核对未知/关闭/生成修复需求）。 */
    function OpsPane(props) {
      const t = props.t
      const data = props.data
      if (!data) {
        return h(
          'main',
          { className: 'flb-main-pane' },
          h('div', { className: props.error ? 'flb-error' : 'flb-empty' }, props.error || t('ops.loading')),
        )
      }
      const summary = data.summary || {}
      const stats = summary.stats || {}
      const events = data.events || []
      const active = events.filter((event) => !['recovered', 'closed'].includes(event.state))
      const visible = props.filter === 'active' ? active : events
      const selected = events.find((event) => event.eventId === props.selectedId) || visible[0] || events[0] || null
      const detail = props.detail && props.detail.eventId === (selected && selected.eventId) ? props.detail : null
      const stateLabel = (state) => {
        const key = 'ops.state.' + state
        const value = t(key)
        return value === key ? state : value
      }
      const stat = (label, value) =>
        h(
          'div',
          { className: 'flb-ops-stat', key: label },
          h('div', { className: 'flb-ops-stat-value' }, String(value)),
          h('div', { className: 'flb-ops-stat-label' }, label),
        )
      const busy = props.busy && props.busy.eventId === (selected && selected.eventId) ? props.busy.message : ''
      const actionButton = (event, label, endpoint, extra) =>
        h(
          'button',
          {
            type: 'button',
            className: 'flb-card-action',
            key: endpoint + label,
            disabled: Boolean(props.busy && props.busy.eventId),
            onClick: () => props.onAction(event, endpoint, extra || {}),
          },
          label,
        )
      const actionRow = (event) => {
        const items = []
        if (event.state === 'awaiting_decision') {
          items.push(actionButton(event, t('ops.approve'), 'ops-decide', { decision: 'approve' }))
          items.push(actionButton(event, t('ops.decline'), 'ops-decide', { decision: 'decline' }))
        }
        if (event.state === 'unknown') {
          items.push(actionButton(event, t('ops.confirmUnknown'), 'ops-confirm-unknown', {}))
        }
        if (event.state !== 'closed') {
          items.push(actionButton(event, t('ops.close'), 'ops-close', {}))
        }
        if (
          !event.fixRequirementId &&
          detail &&
          detail.data &&
          detail.data.diagnosis &&
          ['recovered', 'unresolved'].includes(event.state)
        ) {
          items.push(actionButton(event, t('ops.requestFix'), 'ops-request-fix', {}))
        }
        return items.length === 0 ? null : h('div', { className: 'flb-ops-actions' }, items)
      }
      const detailBody = (event) => {
        if (!detail) return h('div', { className: 'flb-empty' }, t('ops.loading'))
        if (detail.error) return h('div', { className: 'flb-error' }, detail.error)
        const value = detail.data || {}
        const diagnosis = value.diagnosis || event.diagnosis || null
        const attempts = value.attempts || []
        const observations = value.observations || []
        const resource = value.resource || {}
        const proposed = diagnosis && diagnosis.proposedAction
        return h(
          'section',
          { className: 'flb-ops-detail-pane' },
          h(
            'div',
            { className: 'flb-ops-detail-head' },
            h(Chip, { tone: OPS_SEVERITY_TONE[event.severity] || 'idle' }, t('ops.severity.' + event.severity)),
            h(Chip, { tone: OPS_STATE_TONE[event.state] || 'idle' }, stateLabel(event.state)),
            h('strong', null, event.title),
          ),
          h(Kv, { label: t('ops.resource') }, resource.label || event.resourceLabel),
          h(Kv, { label: t('ops.check') }, event.checkId),
          h(Kv, { label: t('ops.opened') }, formatMoment(event.openedAt)),
          h(Kv, { label: t('ops.updated') }, formatMoment(event.updatedAt)),
          event.recoveredAt ? h(Kv, { label: t('ops.recoveredAt') }, formatMoment(event.recoveredAt)) : null,
          event.fixRequirementId ? h(Kv, { label: t('ops.fix') }, event.fixRequirementId) : null,
          h(Section, { title: t('ops.impact') }, h('div', null, event.impact || t('ops.noImpact'))),
          diagnosis
            ? h(
                Section,
                { title: t('ops.proposed') },
                h(
                  'div',
                  null,
                  proposed ? proposed.actionId + ' ' + JSON.stringify(proposed.params || {}) : t('ops.noAction'),
                ),
                h('div', { className: 'flb-muted' }, diagnosis.summary || ''),
              )
            : null,
          diagnosis && diagnosis.facts && diagnosis.facts.length > 0
            ? h(Section, { title: t('ops.facts') }, h(BulletList, { items: diagnosis.facts, empty: '—' }))
            : null,
          diagnosis && diagnosis.hypotheses && diagnosis.hypotheses.length > 0
            ? h(
                Section,
                { title: t('ops.hypotheses') },
                h(BulletList, {
                  items: diagnosis.hypotheses.map((item) => `${item.statement}（${item.confidence}）`),
                  empty: '—',
                }),
              )
            : null,
          h(
            Section,
            { title: t('ops.attempts') },
            attempts.length === 0
              ? h('div', { className: 'flb-muted' }, t('ops.noAttempts'))
              : attempts.map((attempt) =>
                  h(
                    'div',
                    { className: 'flb-ops-obs', key: attempt.actionId },
                    h(
                      'div',
                      null,
                      `${attempt.actionDefId} · ${attempt.state}${
                        attempt.exitCode === null ? '' : ' · ' + t('ops.exit') + ' ' + attempt.exitCode
                      }`,
                    ),
                    h('div', { className: 'flb-ops-evidence' }, attempt.authorizationSource),
                    attempt.detail ? h('div', { className: 'flb-ops-note' }, attempt.detail) : null,
                    attempt.evidencePath ? h('div', { className: 'flb-ops-evidence' }, attempt.evidencePath) : null,
                  ),
                ),
          ),
          h(
            Section,
            { title: t('ops.observations') },
            observations.length === 0
              ? h('div', { className: 'flb-muted' }, '—')
              : observations.map((item) =>
                  h(
                    'div',
                    { className: 'flb-ops-obs', key: String(item.seq) },
                    h('div', null, `${formatMoment(item.at)} · ${item.kind}`),
                    h('div', null, item.summary),
                    item.evidencePath ? h('div', { className: 'flb-ops-evidence' }, item.evidencePath) : null,
                  ),
                ),
          ),
          actionRow(event),
          busy ? h('div', { className: 'flb-ops-note' }, busy) : null,
          event.humanInvolved ? h('div', { className: 'flb-ops-note' }, `${t('ops.humanNote')}：${value.event ? value.event.humanReason : ''}`) : null,
        )
      }
      return h(
        'main',
        { className: 'flb-main-pane' },
        h(
          'div',
          { className: 'flb-ops-head' },
          h('h2', { className: 'flb-hier-title' }, t('ops.title')),
          h('div', { className: 'flb-wb-sub' }, t('ops.subtitle')),
          h(
            'div',
            { className: 'flb-toolbar' },
            ['all', 'active'].map((key) =>
              h(
                'button',
                {
                  type: 'button',
                  key,
                  className: 'flb-filter',
                  'aria-pressed': props.filter === key,
                  onClick: () => props.onFilter(key),
                },
                t('ops.' + key),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'flb-ops-stats' },
          stat(t('ops.total'), stats.total || 0),
          stat(t('ops.active'), stats.active || 0),
          stat(t('ops.awaiting'), stats.awaitingDecision || 0),
          stat(t('ops.recovered'), stats.recovered || 0),
          stat(t('ops.unresolved'), stats.unresolved || 0),
          stat(t('ops.unknown'), stats.unknown || 0),
          stat(t('ops.human'), stats.humanInvolved || 0),
        ),
        events.length === 0
          ? h(
              'div',
              { className: 'flb-empty flb-empty-large' },
              h('div', null, t('ops.empty')),
              h('div', { className: 'flb-muted' }, t('ops.emptyHint')),
            )
          : visible.length === 0
            ? h('div', { className: 'flb-empty' }, t('ops.noEvents'))
            : h(
                'div',
                { className: 'flb-ops-grid' },
                h(
                  'div',
                  { className: 'flb-ops-list' },
                  visible.map((event) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        key: event.eventId,
                        className: 'flb-ops-card',
                        'data-selected': String(selected && selected.eventId === event.eventId),
                        onClick: () => props.onSelect(event.eventId),
                      },
                      h(
                        'div',
                        { className: 'flb-ops-card-head' },
                        h(Chip, { tone: OPS_SEVERITY_TONE[event.severity] || 'idle' }, t('ops.severity.' + event.severity)),
                        h(Chip, { tone: OPS_STATE_TONE[event.state] || 'idle' }, stateLabel(event.state)),
                      ),
                      h('div', { className: 'flb-ops-card-title' }, event.title),
                      h('div', { className: 'flb-ops-card-impact' }, event.impact || event.lastObservation || ''),
                      h('div', { className: 'flb-ops-card-meta' }, `${event.resourceLabel} · ${formatMoment(event.updatedAt)}`),
                    ),
                  ),
                ),
                selected ? detailBody(selected) : h('div', { className: 'flb-empty' }, t('ops.empty')),
              ),
      )
    }

    function BoardView(props) {
      const [state, setState] = React.useState({ phase: 'loading', board: null, error: '' })
      const [query, setQuery] = React.useState('')
      const [appliedQuery, setAppliedQuery] = React.useState('')
      const [view, setView] = React.useState('hierarchy')
      const [filter, setFilter] = React.useState('all')
      const [workMode, setWorkMode] = React.useState('list')
      const [treeOpen, setTreeOpen] = React.useState(true)
      const [expanded, setExpanded] = React.useState('')
      const [selection, setSelection] = React.useState({ kind: 'requirement', reqId: '', taskId: '', issueId: '' })
      const [tab, setTab] = React.useState('overview')
      const [mobileDetail, setMobileDetail] = React.useState(false)
      const [fullDetail, setFullDetail] = React.useState(false)
      const [auto, setAuto] = React.useState(true)
      const [action, setAction] = React.useState({ busy: '', message: '' })
      const [retry, setRetry] = React.useState({ key: '', busy: false, message: '', confirm: false })
      const [reqDetail, setReqDetail] = React.useState({ phase: 'idle', reqId: '', data: null, error: '' })
      const [taskDetail, setTaskDetail] = React.useState({ phase: 'idle', key: '', data: null, error: '' })
      const [detailNonce, setDetailNonce] = React.useState(0)
      const [taskNonce, setTaskNonce] = React.useState(0)
      const [ops, setOps] = React.useState({ phase: 'idle', data: null, error: '' })
      const [opsSelected, setOpsSelected] = React.useState('')
      const [opsDetail, setOpsDetail] = React.useState({ phase: 'idle', eventId: '', data: null, error: '' })
      const [opsFilter, setOpsFilter] = React.useState('active')
      const [opsBusy, setOpsBusy] = React.useState({ eventId: '', message: '' })
      const [opsNonce, setOpsNonce] = React.useState(0)
      const inflight = React.useRef(null)
      const reqInflight = React.useRef(null)
      const taskInflight = React.useRef(null)

      const load = React.useCallback(() => {
        if (inflight.current) inflight.current.abort()
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        inflight.current = controller
        setState((previous) => ({
          phase: previous.board ? 'refreshing' : 'loading',
          board: previous.board,
          error: '',
        }))
        read('board', { query: appliedQuery, limit: 100 }, controller ? controller.signal : undefined)
          .then((board) => {
            if (controller && controller.signal.aborted) return
            setState({ phase: 'ready', board, error: '' })
          })
          .catch((error) => {
            if (controller && controller.signal.aborted) return
            setState((previous) => ({ phase: 'error', board: previous.board, error: error.message || String(error) }))
          })
      }, [appliedQuery])

      React.useEffect(() => {
        const timer = setTimeout(() => setAppliedQuery(query.trim()), 300)
        return () => clearTimeout(timer)
      }, [query])

      React.useEffect(() => {
        load()
      }, [load])

      React.useEffect(() => {
        if (!auto) return
        const timer = setInterval(load, 15000)
        return () => clearInterval(timer)
      }, [auto, load])

      const board = state.board
      const requirements = board ? board.requirements || [] : []
      const allTasks = board ? board.tasks || [] : []
      const allIssues = board ? board.issues || [] : []
      const visible = requirements.filter((requirement) => {
        if (filter === 'active') return !TERMINAL[requirement.status] && requirement.status !== 'draft'
        if (filter === 'attention') {
          return ['plan_proposed', 'blocked', 'executing'].includes(requirement.status) || allIssues.some((issue) => issue.reqId === requirement.reqId)
        }
        if (filter === 'draft') return requirement.status === 'draft'
        return true
      })
      const requirementIssues = (reqId) => allIssues.filter((issue) => issue.reqId === reqId)
      const selectedRequirement = requirements.find((requirement) => requirement.reqId === selection.reqId) || null
      const selectedTasks = selectedRequirement ? wbTasksOf(allTasks, selectedRequirement) : []
      const selectedTask = selection.taskId ? allTasks.find((task) => task.taskId === selection.taskId && task.reqId === selection.reqId) || null : null
      const selectedIssue = selection.issueId ? allIssues.find((issue) => issue.issueId === selection.issueId) || null : null
      const activeTask = selectedTask || (selectedIssue && selectedIssue.taskId ? allTasks.find((task) => task.taskId === selectedIssue.taskId && task.reqId === selectedIssue.reqId) || null : null)
      const activeRequirement = selectedRequirement || (activeTask ? requirements.find((requirement) => requirement.reqId === activeTask.reqId) || null : null)

      React.useEffect(() => {
        if (selection.reqId || requirements.length === 0) return
        setSelection({ kind: 'requirement', reqId: requirements[0].reqId, taskId: '', issueId: '' })
        setExpanded(requirements[0].reqId)
      }, [selection.reqId, requirements.length])

      React.useEffect(() => {
        if (!activeRequirement) return
        if (reqDetail.reqId === activeRequirement.reqId && reqDetail.phase === 'ready') return
        if (reqInflight.current) reqInflight.current.abort()
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        reqInflight.current = controller
        setReqDetail({ phase: 'loading', reqId: activeRequirement.reqId, data: null, error: '' })
        read('detail', { reqId: activeRequirement.reqId }, controller ? controller.signal : undefined)
          .then((data) => setReqDetail({ phase: 'ready', reqId: activeRequirement.reqId, data, error: '' }))
          .catch((error) => {
            if (controller && controller.signal.aborted) return
            setReqDetail({ phase: 'error', reqId: activeRequirement.reqId, data: null, error: error.message || String(error) })
          })
      }, [activeRequirement && activeRequirement.reqId, detailNonce])

      React.useEffect(() => {
        const task = activeTask
        if (!task) {
          setTaskDetail({ phase: 'idle', key: '', data: null, error: '' })
          return
        }
        const key = task.reqId + ':' + task.planVersion + ':' + task.taskId
        if (taskDetail.key === key && taskDetail.phase === 'ready') return
        if (taskInflight.current) taskInflight.current.abort()
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        taskInflight.current = controller
        setTaskDetail({ phase: 'loading', key, data: null, error: '' })
        read('task', { reqId: task.reqId, taskId: task.taskId, planVersion: task.planVersion }, controller ? controller.signal : undefined)
          .then((data) => setTaskDetail({ phase: 'ready', key, data, error: '' }))
          .catch((error) => {
            if (controller && controller.signal.aborted) return
            setTaskDetail({ phase: 'error', key, data: null, error: error.message || String(error) })
          })
      }, [activeTask && activeTask.reqId, activeTask && activeTask.taskId, activeTask && activeTask.planVersion, taskNonce])

      React.useEffect(() => {
        if (view !== 'ops') return undefined
        let alive = true
        const loadOps = () => {
          read('ops', {}, undefined)
            .then((value) => {
              if (!alive) return
              setOps({ phase: 'ready', data: value, error: '' })
              setOpsSelected((current) => current || (value.events && value.events[0] ? value.events[0].eventId : ''))
            })
            .catch((error) => {
              if (!alive) return
              setOps((previous) => ({ phase: 'error', data: previous.data, error: error.message || String(error) }))
            })
        }
        loadOps()
        const timer = auto ? setInterval(loadOps, 15000) : null
        return () => {
          alive = false
          if (timer) clearInterval(timer)
        }
      }, [view, auto, opsNonce])

      React.useEffect(() => {
        if (view !== 'ops' || !opsSelected) return undefined
        let alive = true
        setOpsDetail({ phase: 'loading', eventId: opsSelected, data: null, error: '' })
        read('ops-detail', { eventId: opsSelected }, undefined)
          .then((value) => {
            if (alive) setOpsDetail({ phase: 'ready', eventId: opsSelected, data: value, error: '' })
          })
          .catch((error) => {
            if (alive) setOpsDetail({ phase: 'error', eventId: opsSelected, data: null, error: error.message || String(error) })
          })
        return () => {
          alive = false
        }
      }, [view, opsSelected, opsNonce])

      const openRequirement = (reqId) => {
        setSelection({ kind: 'requirement', reqId, taskId: '', issueId: '' })
        setExpanded(reqId)
        setTab('overview')
        const narrow = typeof window !== 'undefined' && window.innerWidth <= 820
        setMobileDetail(!narrow)
        if (narrow) { setTreeOpen(false); scrollWorkbench() }
        setFullDetail(false)
      }
      const openTask = (reqId, taskId, nextTab) => {
        setSelection({ kind: 'task', reqId, taskId, issueId: '' })
        setExpanded(reqId)
        setTab(nextTab || 'overview')
        setMobileDetail(true)
        setFullDetail(false)
        if (typeof window !== 'undefined' && window.innerWidth <= 820) scrollWorkbench()
      }
      const openIssue = (issue) => {
        setSelection({ kind: 'issue', reqId: issue.reqId, taskId: issue.taskId || '', issueId: issue.issueId })
        setExpanded(issue.reqId)
        setTab('overview')
        setMobileDetail(true)
        setFullDetail(false)
        if (typeof window !== 'undefined' && window.innerWidth <= 820) scrollWorkbench()
      }

      const scrollWorkbench = () => {
        if (typeof document === 'undefined') return
        requestAnimationFrame(() => {
          const node =
            document.querySelector('.flb-workbench[data-mobile-detail="true"] .flb-side') ||
            document.querySelector('.flb-workbench')
          if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
        })
      }

      const runAction = (requirement, endpoint) => {
        if (action.busy) return
        if (endpoint === 'stop') {
          const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function' ? true : window.confirm(t('action.stopConfirm'))
          if (!confirmed) return
        }
        if (endpoint === 'replan') {
          const raw = typeof window === 'undefined' || typeof window.prompt !== 'function' ? '' : window.prompt(t('action.replanPrompt'), 'contracts/architecture.json')
          if (raw === null) return
          const files = raw.split(/[\n,]/).map((file) => file.trim()).filter(Boolean)
          if (files.length === 0) return
          let confirmRecovery = false
          if (requirement.unknownRequests > 0) {
            const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function' ? false : window.confirm(t('action.replanRecoveryConfirm'))
            if (!confirmed) return
            confirmRecovery = true
          }
          setAction({ busy: 'replan', message: '' })
          read('replan', { reqId: requirement.reqId, planVersion: requirement.planVersion, files, sessionId: props.sessionId, confirmRecovery })
            .then((value) => {
              setAction({ busy: '', message: t('action.replanned', { plan: value.planVersion, task: value.taskId, files: value.files.join(', ') }) })
              load()
              setDetailNonce((value) => value + 1)
            })
            .catch((error) => setAction({ busy: '', message: error.message || String(error) }))
          return
        }
        setAction({ busy: endpoint, message: '' })
        read(endpoint, {
          reqId: requirement.reqId,
          sessionId: props.sessionId,
          ...(endpoint === 'approve' ? { planVersion: requirement.planVersion } : {}),
          ...(endpoint === 'cancel' ? { reason: t('action.cancelReason') } : {}),
          ...(endpoint === 'stop' ? { reason: t('action.stopReason') } : {}),
        })
          .then(() => {
            const key = endpoint === 'approve' ? 'approved' : endpoint === 'advance' ? 'advanced' : endpoint === 'plan' ? 'planned' : endpoint === 'verify' ? 'verified' : endpoint === 'stop' ? 'stopped' : 'cancelled'
            setAction({ busy: '', message: t(`action.${key}`) })
            load()
            setDetailNonce((value) => value + 1)
          })
          .catch((error) => setAction({ busy: '', message: error.message || String(error) }))
      }

      const runOpsAction = (event, endpoint, extra) => {
        if (opsBusy.eventId) return
        const confirmKey =
          endpoint === 'ops-decide'
            ? extra.decision === 'approve'
              ? 'ops.approveConfirm'
              : 'ops.declineConfirm'
            : endpoint === 'ops-close'
              ? 'ops.closeConfirm'
              : endpoint === 'ops-confirm-unknown'
                ? 'ops.unknownConfirm'
                : ''
        if (confirmKey) {
          const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function' ? false : window.confirm(t(confirmKey))
          if (!confirmed) return
        }
        setOpsBusy({ eventId: event.eventId, message: '' })
        const body = { eventId: event.eventId, sessionId: props.sessionId, ...extra }
        if (endpoint === 'ops-close' && event.state === 'unknown') body.confirmRecovery = true
        read(endpoint, body)
          .then(() => {
            setOpsBusy({ eventId: event.eventId, message: t('ops.done') })
            setOpsNonce((value) => value + 1)
          })
          .catch((error) => setOpsBusy({ eventId: event.eventId, message: error.message || String(error) }))
      }

      const retryTask = (task) => {
        const key = task.reqId + ':' + task.planVersion + ':' + task.taskId
        if (retry.busy && retry.key === key) return
        const confirmRecovery = retry.confirm && retry.key === key
        setRetry({ key, busy: true, message: '', confirm: confirmRecovery })
        read('retry', { reqId: task.reqId, planVersion: task.planVersion, taskId: task.taskId, sessionId: props.sessionId, confirmRecovery })
          .then(() => {
            setRetry({ key, busy: false, message: t('task.retryQueued'), confirm: false })
            load()
            setDetailNonce((value) => value + 1)
            setTaskNonce((value) => value + 1)
          })
          .catch((error) => {
            setRetry({ key, busy: false, message: error.message || String(error), confirm: error.code === 'recovery_required' })
          })
      }

      const attention = (() => {
        const items = []
        const seen = new Set()
        for (const requirement of requirements) {
          if (requirement.status === 'plan_proposed') {
            items.push({ key: 'approve:' + requirement.reqId, reqId: requirement.reqId, taskId: '', kind: 'approval', kindLabel: statusLabel(t, 'plan_proposed'), title: requirement.title, detail: t('wb.planPending'), tone: 'warn', issue: null })
          }
          const reqIssues = requirementIssues(requirement.reqId).filter((issue) => ['blocking', 'attention'].includes(issue.severity))
          for (const issue of reqIssues) {
            const key = issue.taskId ? requirement.reqId + ':task:' + issue.taskId : requirement.reqId + ':req:' + issue.issueId
            if (seen.has(key)) continue
            seen.add(key)
            items.push({ key: 'issue:' + issue.issueId, reqId: requirement.reqId, taskId: issue.taskId || '', kind: 'issue', kindLabel: t(`issue.${issue.kind}`), title: issue.title, detail: issue.detail || '', tone: ISSUE_TONES[issue.severity] || 'warn', issue })
          }
        }
        return items
      })()

      const allViews = [
        ['hierarchy', t('wb.hierarchy')],
        ['tasks', t('wb.allTasks')],
        ['issues', t('wb.attention')],
        ['ops', t('nav.ops')],
      ]
      const body = () => {
        if (!board) {
          return state.error ? h('div', { className: 'flb-error', role: 'alert' }, state.error) : h('div', { className: 'flb-empty' }, t('wb.loading'))
        }
        if (view === 'ops') {
          return h(OpsPane, {
            t,
            data: ops.data,
            error: ops.error,
            detail: opsDetail,
            selectedId: opsSelected,
            filter: opsFilter,
            busy: opsBusy,
            onSelect: setOpsSelected,
            onFilter: setOpsFilter,
            onAction: runOpsAction,
          })
        }
        if (requirements.length === 0) {
          if (board.query) {
            return h(
              'div',
              { className: 'flb-empty flb-empty-large' },
              h('div', null, t('wb.noMatch')),
              h('div', { className: 'flb-muted' }, t('search.noResults', { query: board.query })),
              h('button', { type: 'button', className: 'flb-card-action', onClick: () => setQuery('') }, t('search.clear')),
            )
          }
          return h('div', { className: 'flb-empty flb-empty-large' }, h('div', null, t('page.empty')), h('div', { className: 'flb-muted' }, t('overview.next.submit')))
        }
        if (visible.length === 0 && view !== 'issues') {
          return h('div', { className: 'flb-empty flb-empty-large' }, h('div', null, t('wb.noMatch')), h('button', { type: 'button', className: 'flb-card-action', onClick: () => { setQuery(''); setFilter('all') } }, t('wb.clear')))
        }
        return h(
          'div',
          { className: 'flb-workbench', 'data-mobile-detail': String(mobileDetail), 'data-full': String(fullDetail), 'data-tree-open': String(treeOpen) },
          treeOpen ? h(WorkbenchTree, {
            t,
            requirements: visible,
            tasks: allTasks,
            issues: allIssues,
            selected: selection,
            expanded,
            onOpenRequirement: openRequirement,
            onOpenTask: openTask,
            onOpenIssue: openIssue,
          }) : null,
          fullDetail
            ? null
            : view === 'hierarchy'
              ? h(CenterPane, {
                  t,
                  requirement: activeRequirement || visible[0] || null,
                  tasks: activeRequirement ? wbTasksOf(allTasks, activeRequirement) : [],
                  issues: activeRequirement ? requirementIssues(activeRequirement.reqId) : [],
                  workMode,
                  onWorkMode: setWorkMode,
                  selectedTaskId: selection.taskId,
                  busy: action.busy,
                  actionMessage: action.message,
                  onAction: runAction,
                  onOpenTask: openTask,
                  onOpenIssue: openIssue,
                })
              : view === 'tasks'
                ? h(AllTasksPane, {
                    t,
                    requirements: visible,
                    tasks: allTasks,
                    issues: allIssues,
                    selectedTaskId: selection.taskId,
                    onOpenRequirement: openRequirement,
                    onOpenTask: openTask,
                    onOpenIssue: openIssue,
                  })
                : h(IssuesPane, {
                    t,
                    items: attention.filter((item) => visible.some((requirement) => requirement.reqId === item.reqId)),
                    onOpen: (item) => item.issue ? openIssue(item.issue) : openRequirement(item.reqId),
                  }),
          h(DetailPane, {
            t,
            read,
            selection: {
              ...selection,
              kind: selectedTask ? 'task' : selectedIssue ? 'issue' : 'requirement',
              reqId: (activeRequirement || selectedRequirement || visible[0] || {}).reqId || selection.reqId,
            },
            requirement: activeRequirement || visible[0] || null,
            task: selectedTask || (selectedIssue && selectedIssue.taskId ? allTasks.find((task) => task.taskId === selectedIssue.taskId && task.reqId === selectedIssue.reqId) || null : null),
            issue: selectedIssue,
            tasks: activeRequirement ? wbTasksOf(allTasks, activeRequirement) : [],
            reqDetail,
            taskDetail,
            tab,
            fullDetail,
            active: tab === 'activity',
            busy: action.busy,
            actionMessage: action.message,
            retry,
            onOpenRequirement: openRequirement,
            onOpenTask: openTask,
            onOpenIssue: openIssue,
            onTab: setTab,
            onAction: runAction,
            onRetry: retryTask,
            onBack: () => { setMobileDetail(false); setFullDetail(false) },
            onToggleFull: () => setFullDetail((value) => !value),
          }),
        )
      }

      return h(
        'section',
        { className: 'flb-root' },
        h('style', null, BOARD_CSS),
        h('style', null, OPS_CSS),
        h(
          'header',
          { className: 'flb-head' },
          h(
            'div',
            { className: 'flb-head-main' },
            h('span', { className: 'flb-title' }, t('view.label')),
            h('span', { className: 'flb-sub' }, board ? t('page.subtitle', { project: board.project, time: formatMoment(board.generatedAt) }) : t('page.loading')),
            h('span', { className: 'flb-sub' }, t('page.source')),
          ),
          h(
            'div',
            { className: 'flb-head-tools' },
            h(
              'label',
              { className: 'flb-search' },
              h('span', { className: 'flb-search-icon' }, '⌕'),
              h('input', {
                type: 'search',
                value: query,
                placeholder: t('search.placeholder'),
                'aria-label': t('search.label'),
                onChange: (event) => setQuery(event.target.value),
              }),
              query ? h('button', { type: 'button', className: 'flb-search-clear', onClick: () => setQuery(''), 'aria-label': t('search.clear') }, '×') : null,
            ),
            h('button', { type: 'button', className: 'flb-refresh', onClick: load, disabled: state.phase === 'loading' || state.phase === 'refreshing' }, state.phase === 'refreshing' ? t('page.refreshing') : t('page.refresh')),
            h('label', { className: 'flb-muted' }, h('input', { type: 'checkbox', checked: auto, onChange: (event) => setAuto(event.target.checked) }), ' ' + t('wb.auto')),
          ),
          h(
            'nav',
            { className: 'flb-tabs', role: 'tablist', 'aria-label': t('nav.label') },
            allViews.map(([key, label]) =>
              h(
                'button',
                {
                  type: 'button',
                  key,
                  role: 'tab',
                  className: 'flb-tab',
                  'aria-selected': view === key,
                  onClick: () => { setView(key); setMobileDetail(false); setFullDetail(false) },
                },
                label,
                h(
                  'span',
                  { className: 'flb-tab-count' },
                  key === 'tasks'
                    ? allTasks.length
                    : key === 'issues'
                      ? attention.length
                      : key === 'ops'
                        ? (ops.data && ops.data.summary && ops.data.summary.stats ? ops.data.summary.stats.active : 0)
                        : requirements.length,
                ),
              ),
            ),
            h('button', { type: 'button', className: 'flb-tab', onClick: () => setTreeOpen((value) => !value), title: t('wb.treeToggle') }, t('wb.tree')),
          ),
          h(
            'div',
            { className: 'flb-search-meta' },
            query ? h('span', null, t('search.results', { query, count: requirements.length, truncated: board && board.truncated ? t('search.truncated', { limit: board.limit || 50 }) : '' })) : null,
            view === 'hierarchy'
              ? h(
                  'div',
                  { className: 'flb-toolbar' },
                  ['all', 'active', 'attention', 'draft'].map((key) =>
                    h('button', { type: 'button', key, className: 'flb-filter', 'aria-pressed': filter === key, onClick: () => setFilter(key) }, t(`filter.requirement.${key}`)),
                  ),
                )
              : null,
            h('span', null, t('overview.searchScope')),
          ),
        ),
        h(
          'div',
          { className: 'flb-body' },
          state.error && board ? h('div', { className: 'flb-error', role: 'alert' }, state.error, h('button', { type: 'button', className: 'flb-card-action', onClick: load }, t('page.retry'))) : null,
          body(),
          h('div', { className: 'flb-footer' }, t('page.footer'), ' ', t('overview.boundarySource')),
          h('div', { className: 'flb-bottom-spacer', 'aria-hidden': 'true' }),
        ),
      )
    }


      if (ctx.uiConversation && ctx.uiConversation.events && typeof ctx.uiConversation.events.register === 'function') {
        for (const node of FLOW_NODES) {
          ctx.effect(() => ctx.uiConversation.events.register(node.definition), `forgeloop: ${node.key}`)
          ctx.slots.inject('conversation.chat.node', () =>
            ctx.slots.register(
              { name: 'conversation.chat.node', key: node.key, locale: NS },
              node.component,
            ),
          )
        }
      }

      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          { name: 'conversation.chat.turnTail', id: 'forgeloop-requirements', order: 80, locale: NS },
          RequirementsTail,
        ),
      )

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
      inject: ['slots', 'locale', 'uiConversation'],
      apply,
    }
  },
})
