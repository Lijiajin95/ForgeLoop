# forgeloop-dsh

ForgeLoop 的 TypeScript 原生 DSH 插件：把需求受理、产品澄清、系统准入、研发实现与自验、独立验证与
业务验收、受控提交、证据与持久推进放进 DSH 宿主进程。运行期不依赖 Python 或独立 HTTP 服务。
身份只有产品、研发、验证、运维四个 Agent；主控是确定性协调者，不是第五个 Agent。
本文描述当前实现；最新产品、技术和验证规则统一见仓库中的 `docs/product.md`，不表示新方案已实现。

## 安装

```sh
dsh plugin --profile <name> add /path/to/packages/forgeloop
dsh --profile <name> --dump-config   # 应出现 "# == forgeloop-dsh" 层
```

随后在该 profile 的 `cordis.patch.yml` 里覆盖 `forgeloop` 行的 `recordsRoot`、`project`、
`projectPath`、`agent.provider/model`、可选的 `autonomy` 与 `ops` 目录。记录根布局：
`<recordsRoot>/projects/<project>/records.sqlite`。`autonomy` 默认对 `dsh-session:` 可信来源启用系统准入，
`allowCodeCommit=true`，`commitCheckCommand=[]`；发布/部署仍需独立授权。

## 入口

### ForgeLoop 业务会话

插件装载后注册 `forgeloop` agent preset（显示名“ForgeLoop 业务会话”）。在 DSH Web 新建会话时
选择该 preset，然后直接在普通输入框输入业务目标或问题：

- 插件在 `agent/pre-step` 接管该会话的人类输入，**不进入普通模型聊天**；输入先受理为需求（版本 1）；
- 产品 Agent 分析业务目标、场景、验收标准与真正的待澄清项；有待澄清时追加澄清请求，回答形成
  新需求版本并重新分析，不新建第二条需求；
- 分析无待澄清项时，主控按真实来源、所有者、有效授权、需求版本与分析版本做**系统准入**，记录
  `requirement_admissions`；不写 `by=owner`／`approved=true`。准入通过后需要进入 `specified`，
  协调器自动排入 `advance`，不需要人工点“批准任务包”或“推进任务”；
- 研发 Agent 在需求级工作区读取代码，一次完成技术方案、任务拆解、实现、正式自验和现场修复；
  任务包是工作记录，不是批准门禁；计划文件清单是预期，不是硬白名单；
- 验证 Agent 从产品需求说明生成验证基线，在独立候选工作区执行自动化测试；运行时重跑命令并核对
  候选完整性、场景覆盖与证据原文。验证通过后同一验证会话继续业务验收；
- 验证阻断时，具体缺陷、复现条件、预期/实际与证据回到**同一研发会话和工作区**定向修复，产生新候选
  并重新验证；不归档全部交付、不删除旧候选、不清零失败轮次、不重新生成任务包；
- 验证与业务验收通过后，主控在真实项目干净且基线一致时应用候选、运行 `commitCheckCommand`、
  只提交本需求改动并记录提交 SHA；不 push、不打 tag、不递增版本、不混合其他在途改动；
- 聊天区显示 intake／analysis／clarification／plan／error 等节点；需求状态使用
  `specified/developing/verifying/committed`，旧记录的 `plan_proposed/approved` 仍可回看；
- 天工页保留停止、取消、追加授权、构建候选包、发布/部署与运维处置入口；历史任务包卡片仍显示旧批准、
  实现前评审与验收记录，但不再是普通需求的常规路径；
- 构建安装包仍只从已通过独立验证的工作区生成并记录验证绑定；安装由外部受控机制完成，正式部署仍需
  所有者明确授权，发布授权缺失不阻塞已完成研发、验证与本地提交；
- 每轮结束后的会话末尾按 **需要澄清 | 不需要澄清** 展示本会话已拆解需求；待澄清回答仍在业务会话输入。

如果宿主没有 `agentPresets` 服务（例如 headless profile），preset 不会注册，输入接管也不会生效。
preset 只接管 `agentPreset=forgeloop` 且非子 Agent 的会话；普通会话保持不变。

### 模型工具

模型工具：`forgeloop_status`、`forgeloop_show_requirement`、`forgeloop_show_plan`、
`forgeloop_evidence`、`forgeloop_requests`、`forgeloop_impact`、`forgeloop_ops`、`forgeloop_submit_requirement`。
工具不能批准、验收、推进或停止；普通需求由系统准入自动推进，发布/部署与真正的业务例外仍需客户明确授权。

### 运维 Agent

在 profile 配置中登记资源、只读检查与处置动作后，协调器按 `ops.intervalSeconds` 巡检：

```yaml
ops:
  enabled: true
  intervalSeconds: 300
  resources:
    - { id: web, kind: app, label: 天工页面 }
  checks:
    - id: web-health
      resourceId: web
      command: ["node", "-e", "process.exit(0)"]
      severity: major
  actions:
    - id: restart-web
      resourceId: web
      command: ["node", "scripts/restart-web.mjs", "{mode}"]
      params: [{ name: mode, values: [graceful, force] }]
      auto: true
```

- 检查失败按签名归并为运维事件；模型只做无工具诊断，提出目录内动作；参数只能取枚举值。
- `auto: true` 的动作可在目录授权内自动执行；其他动作停在天工「运维」视图等待所有者批准。
- 处置后运行恢复检查，只按退出码判定恢复；动作超时或中止记失败、事件按未解决收口；
  宿主中断的动作记 `interrupted`，事件同样按未解决收口，并由运维 Agent 分析根因上报，不自动重放。
- 未恢复或诊断要求永久修复时创建关联修复需求并排队分析；恢复与修复分别收口。
- 只读工具 `forgeloop_ops` 可查事件、诊断、处置与统计。完整边界与限制见
  [运维 Agent](../../docs/ops-agent.md)。

Web 工作台：DSH Web 会话区「天工」页（与「对话」「轨迹」并列），提供 **层级工作台 / 全部任务 /
需要处理** 入口。左侧需求树按需求 → 任务 → 关联问题展开；中间是当前需求的目标、状态、版本、
交付进度、待处理事项和任务/依赖切换；右侧是需求、任务或问题详情，分为概览、前后序、Agent 执行过程、
测试与审查、变更记录，支持面包屑、选中高亮、完整详情和窄屏逐级进入。任务卡与详情顶部均可直接打开
该任务的执行过程。顶部搜索覆盖
需求身份/状态/原文与版本、分析结论、任务目标/文件/验收标准、运行原因、失败轮次、请求与问题文字，
最多显示 50 条，不读取 Agent 日志文件。

- 需求详情：原文与版本历史、分析、最新任务包（技术方案、任务、文件、依赖）、交付进度、
  交付物摘要、验收记录、批准、实现前评审结论与验证计划、独立验证结论/场景/摘要、失败轮次与待处理请求；
- 任务详情：目标/依赖/允许文件/验收标准/实际状态、失败原因与确定性建议、失败轮次、正式测试日志
  （末尾 4000 字符、字节数、路径与截断标记）、独立审查结论、交付产物摘要与证据路径/会话；
- Agent 执行过程：从真实 `dev.jsonl` 读取公开消息、工具输入/输出、阶段事件，显示需求/任务包/任务/
  尝试/会话身份和开发、审查、正式测试、交付阶段；支持分页、暂停自动刷新、新活动提示和历史失败轮次
  （无独立记录时明确缺失）；不展示隐藏推理；
- 状态区分：等待输入（检测到 `ask_user_question`）、停止请求；没有“结果未知”状态，
  中断动作以 `interrupted` 尝试与根因报告呈现；
  心跳/最后活动不是推进证明，停止请求不等于已经停稳，超过 60 秒未更新会标记可能停滞；
- 动作：需求级批准、重新生成任务包、推进、独立验证、重新规划、请求停止、取消由服务端 `actions` 判定；
  失败任务可重试，页面只展示，服务端继续校验批准、额度、任务顺序与在途请求；
  没有通过实现前评审时不提供批准，没有与当前候选一致的通过验证时不提供验收；验收不在本页。

数据经宿主认证路由 `/api/forgeloop/board` 取得，页面不另存业务状态，也不直接写记录。
没有浏览器连接服务的 profile（headless）不会注册该路由。

输入框工具行没有工作流选择器，普通消息按 DSH 对话处理。

## 验证

```sh
npm run check --workspace forgeloop-dsh
```

## 本地候选包

```sh
npm run candidate --workspace forgeloop-dsh
```
