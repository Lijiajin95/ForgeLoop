# forgeloop-dsh

ForgeLoop 的 TypeScript 原生 DSH 插件：把需求受理、分析/规划、独立审查、正式测试、
交付证据与持久推进放进 DSH 宿主进程。运行期不依赖 Python 或独立 HTTP 服务。
本文描述当前实现；最新产品、技术和验证规则统一见仓库中的 `docs/product.md`，不表示新方案已实现。

## 安装

```sh
dsh plugin --profile <name> add /path/to/packages/forgeloop
dsh --profile <name> --dump-config   # 应出现 "# == forgeloop-dsh" 层
```

随后在该 profile 的 `cordis.patch.yml` 里覆盖 `forgeloop` 行的 `recordsRoot`、`project`、
`projectPath` 与 `agent.provider/model`。记录根布局：
`<recordsRoot>/projects/<project>/records.sqlite`。

## 入口

### ForgeLoop 业务会话

插件装载后注册 `forgeloop` agent preset（显示名“ForgeLoop 业务会话”）。在 DSH Web 新建会话时
选择该 preset，然后直接在普通输入框输入业务目标或问题：

- 插件在 `agent/pre-step` 接管该会话的人类输入，**不进入普通模型聊天**；
- 输入先受理为需求（版本 1），再由需求 Agent 拆解为目标、业务场景、验收标准与待澄清项；
  分析时读取当前活动需求与任务（状态、创建／更新时间、任务包批准与任务状态）作为只读背景，
  Agent 本身仍不开放工具；
- 有待澄清项时追加 `plugin:forgeloop/clarification-request`；下一条人类输入作为澄清回答，追加需求版本
  并重新分析，不会新建第二条需求；
- 聊天区显示 `plugin:forgeloop/intake`、`plugin:forgeloop/analysis`、`plugin:forgeloop/clarification-request`、
  `plugin:forgeloop/clarification-answer` 或 `plugin:forgeloop/error` 自定义节点；
- 分析无待澄清项时自动由研发 Agent 生成技术方案与任务包，追加 `plugin:forgeloop/plan`；
  任务包展示技术方案、实施步骤、风险、任务、文件与依赖，需求进入 `plan_proposed` 等待批准；
- 任务包卡片提供“批准任务包”“推进任务”“验收交付”“停止需求”；推进只排队，协调器在隔离工作副本中
  逐任务执行，页面显示批准状态与已交付数量；
- 天工页可交互：需求卡提供“批准任务包”“推进任务”“重新规划”“请求停止”“取消需求”，不提供验收；
  取消是保留记录的终态，停止请求会撤销待执行请求但结果仍需核对；
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
`forgeloop_evidence`、`forgeloop_requests`、`forgeloop_impact`、`forgeloop_submit_requirement`。
工具不能批准、验收、推进或停止；新方案的客户决定入口尚未实现。

Web 工作台：DSH Web 会话区「天工」页（与「对话」「轨迹」并列），提供 **总览 / 需求 / 任务 / 问题**
四个视图。总览展示统计、当前执行/等待输入、需要处理的问题、下一步建议与能力边界；顶部搜索覆盖
需求身份/状态/原文与版本、分析结论、任务目标/文件/验收标准、运行原因、失败轮次、请求与问题文字，
最多显示 50 条，不读取 Agent 日志文件。

- 需求详情：原文与版本历史、分析、最新任务包（技术方案、任务、文件、依赖）、交付进度、
  交付物摘要、验收记录、批准、失败轮次与待处理请求；
- 任务详情：目标/依赖/允许文件/验收标准/实际状态、失败原因与确定性建议、失败轮次、Agent 活动
  （最近 120 条及总数）、正式测试日志（末尾 4000 字符、字节数、路径与截断标记）、独立审查结论、
  交付产物摘要与证据路径/会话；
- 状态区分：等待输入（检测到 `ask_user_question`）、结果未知（unknown 请求）、停止请求；
  心跳/最后活动不是推进证明，停止请求不等于已经停稳，超过 60 秒未更新会标记可能停滞；
- 动作：需求级批准、推进、重新规划、请求停止、取消由服务端 `actions` 判定；失败任务可重试，
  页面只展示，服务端继续校验批准、额度、任务顺序、在途请求与 unknown 二次确认；重新规划只补文件、
  生成待批准新版本，不自动批准；验收不在本页。

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
