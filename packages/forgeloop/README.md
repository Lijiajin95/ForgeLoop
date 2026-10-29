# forgeloop-dsh

ForgeLoop 的 TypeScript 原生 DSH 插件：把需求受理、分析/规划、验证 Agent 的实现前评审与独立验证、
独立审查、正式测试、交付证据与持久推进放进 DSH 宿主进程。运行期不依赖 Python 或独立 HTTP 服务。
本文描述当前实现；最新产品、技术和验证规则统一见仓库中的 `docs/product.md`，不表示新方案已实现。

## 安装

```sh
dsh plugin --profile <name> add /path/to/packages/forgeloop
dsh --profile <name> --dump-config   # 应出现 "# == forgeloop-dsh" 层
```

随后在该 profile 的 `cordis.patch.yml` 里覆盖 `forgeloop` 行的 `recordsRoot`、`project`、
`projectPath`、`agent.provider/model` 与可选的 `ops` 目录。记录根布局：
`<recordsRoot>/projects/<project>/records.sqlite`。

## 入口

### ForgeLoop 业务会话

插件装载后注册 `forgeloop` agent preset（显示名“ForgeLoop 业务会话”）。在 DSH Web 新建会话时
选择该 preset，然后直接在普通输入框输入业务目标或问题：

- 插件在 `agent/pre-step` 接管该会话的人类输入，**不进入普通模型聊天**；
- 输入先受理为需求（版本 1），再由需求 Agent 分析为目标、业务场景、验收标准与待澄清项；
  分析时读取当前活动需求与任务（状态、创建／更新时间、任务包批准与任务状态）作为只读背景，
  Agent 本身仍不开放工具；需求 Agent 不拆研发任务；
- 有待澄清项时追加 `plugin:forgeloop/clarification-request`；下一条人类输入作为澄清回答，追加需求版本
  并重新分析，不会新建第二条需求；
- 聊天区显示 `plugin:forgeloop/intake`、`plugin:forgeloop/analysis`、`plugin:forgeloop/clarification-request`、
  `plugin:forgeloop/clarification-answer` 或 `plugin:forgeloop/error` 自定义节点；
- 分析无待澄清项时由研发 Agent 依据分析全文（目标、业务场景、验收标准）拆解任务并生成技术方案与任务包，
  追加 `plugin:forgeloop/plan`；
  任务包展示技术方案、实施步骤、风险、任务、文件与依赖，需求进入 `plan_proposed` 等待批准；
- 任务包记录后由验证 Agent 做**实现前评审**：只读需求、分析与任务包，输出结论、阻断项与验证计划。
  运行时逐项核对验证计划是否覆盖分析中的业务场景与验收标准，缺项即使评审自报通过也按阻断记录。
  评审通过才允许批准；评审阻断时把阻断原因交回规划 Agent 重新生成（最多 3 次），未评审/未通过时
  任务包卡片只提供“重新生成任务包”，不能批准；
- 任务包卡片提供“批准任务包”“推进任务”“独立验证”“验收交付”“停止需求”；推进只排队，协调器在隔离
  工作副本中逐任务执行，页面显示批准状态、评审结论、已交付数量与验证状态；
- 全部任务交付后，协调器把各任务候选 diff 应用到独立工作副本，由验证 Agent 在 `verification/` 下
  编写验证测试与命令清单，输出逐场景报告；运行时随后**重新执行**命令、只按退出码、日志与必过场景
  覆盖判定。验证通过才提供“验收交付”，且验收绑定固定候选与验证报告摘要；
- 天工页可交互：需求卡提供“批准任务包”“重新生成任务包”“推进任务”“独立验证”“重新规划”“请求停止”
  “取消需求”，不提供验收；取消是保留记录的终态，停止请求会撤销待执行请求但结果仍需核对；
- “重新规划”只复制当前已批准任务包，为失败的非验证任务补充允许文件（默认提示
  `contracts/architecture.json`），生成新的待批准版本；不自动批准、不新建任务。存在 unknown 请求时
  先确认已核对工作副本、Git 与证据，确认后关闭 unknown 再重新规划；验证任务不能补充文件；
- 失败任务卡展示失败原因与确定性解决方案；任务详情给出正式测试日志尾部、失败轮次与审查阻断项，
  并提供“重试任务”。“重试任务”只重排一次推进，保留失败轮次、证据与批准，不越过已批准文件边界；
  若存在结果未知的请求，第一次点击只提示核对，第二次“核对并重试”才关闭 unknown 并排队；
- 支持 `verification: true` 且 `files: []` 的验证任务：只运行已批准正式测试，不产生候选 diff，交付空 diff
  与验证说明；普通任务仍必须有实际文件改动；
- 每轮结束后的会话末尾按 **需要澄清 | 不需要澄清** 展示本会话已拆解需求；
- 当前只受理文本；验收仍在任务包卡片，追加授权与重新规划入口尚未实现；待澄清回答仍在业务会话输入；

如果宿主没有 `agentPresets` 服务（例如 headless profile），preset 不会注册，输入接管也不会生效。
preset 只接管 `agentPreset=forgeloop` 且非子 Agent 的会话；普通会话保持不变。

### 模型工具

模型工具：`forgeloop_status`、`forgeloop_show_requirement`、`forgeloop_show_plan`、
`forgeloop_evidence`、`forgeloop_requests`、`forgeloop_impact`、`forgeloop_ops`、`forgeloop_submit_requirement`。
工具不能批准、验收、推进或停止；新方案的客户决定入口尚未实现。

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
- 处置后运行恢复检查，只按退出码判定恢复；超时或宿主中断标为结果未知，需核对，不自动重放。
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
- 状态区分：等待输入（检测到 `ask_user_question`）、结果未知（unknown 请求）、停止请求；
  心跳/最后活动不是推进证明，停止请求不等于已经停稳，超过 60 秒未更新会标记可能停滞；
- 动作：需求级批准、重新生成任务包、推进、独立验证、重新规划、请求停止、取消由服务端 `actions` 判定；
  失败任务可重试，页面只展示，服务端继续校验批准、额度、任务顺序、在途请求与 unknown 二次确认；
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
