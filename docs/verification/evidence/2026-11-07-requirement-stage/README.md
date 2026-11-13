# 需求阶段真实模型复验（2026-11-07）

真实 DSH + DeepSeek 复验，使用隔离 `DSH_HOME`、自定义 profile 与本地安装的当前分支插件；
不读写正式记录与 profile。模型路由：`command-goat/deepseek/deepseek-v4.1-flash`
（由 `model-patch.yml` 覆盖 `agent-default-model`；密钥只从进程环境读取，未落盘）。

驱动方式：`harness/` 是在真实 DSH 进程内加载的一次性验证插件，直接调用当前分支构建出的
`ForgeLoopRuntime`（`submit` / `analyzeRequirement` / `answerClarifications` / `requirementDetail`），
因此每次分析都是真实产品 Agent + DeepSeek 调用，不是 fixture。原始输出保留为同目录 JSON。

## 场景 A：连续部分回答

输入：`scenario-a-script.json`；输出：`scenario-a-partial-answers.json`。

- v1 分析提出 3 个待澄清问题（`Q1-1`–`Q1-3`）；
- 只回答 `Q1-1` 后：回答仅 1 条（`Q1-1`，`answerSeq=1`），`Q1-2`/`Q1-3` 仍开放；
- v2 分析新增追问 `Q2-1`，旧未答问题继续保留并阻断准入；
- 再回答其余问题后，`Q1-1`/`Q1-2`/`Q2-1` 均已记录（各 `answerSeq=1`），仍有 1 个问题未答，
  状态保持 `awaiting_clarification`。模型没有把未答问题静默丢弃。

## 场景 B：历史承诺冲突

输出：`scenario-b-conflict.json`（首次分析）与 `scenario-b-conflict-after-answer.json`（回答后）。

- 已有需求原文：“只有店长可以批量取消订单，店员不能批量取消。”
- 新需求原文：“所有店员都可以在订单列表批量取消订单。”
- 新需求分析识别出 1 处冲突，引用已有需求 ID，给出 3 个取舍与待决定事项；因同时存在澄清问题，
  需求停在 `awaiting_clarification`（准入未通过）。
- 回答“旧承诺废止”后，模型不再报告冲突，需求通过准入并进入 `specified`。
  **发现**：系统把“回答里宣布旧承诺废止”当作冲突已解决，但旧需求本身并未被修订或标记退役；
  建议后续要求冲突关闭必须绑定旧需求的新版本或明确的退役记录，否则可能留下两条互相矛盾的已准入需求。

## 场景 C：缺陷 + 新能力混合输入

输出：`scenario-c-mixed.json`。

- 缺陷“看板刷新后筛选条件丢失”：`input_kind=problem`，不做业务要点拆解，无待澄清，直接通过准入；
- 新能力“导出 CSV”：`input_kind=requirement`，走结构化要点与澄清，产生 2 个待澄清问题。
- 两次输入在同一项目内被正确分诊，互不混用分析路径。

## 未完成

- 场景 A 的“全部答完并完成准入”在 web 宿主复跑时第三次真实分析超时被终止，未取得完成态；
  部分回答与未答保持开放的核心行为已由上面的输出证明。
- 本复验通过运行时 API 驱动分析，不经过 Web 会话输入接管；输入接管与逐题指令的确定性行为由
  `tests/clarification-per-question.test.ts` 覆盖，未纳入本次真实模型样本。
