---
status: accepted
date: 2026-10-19
---

# Agent Runtime 抽象：PI 与 DSH 同属可插拔执行器，运行状态热切换

## 背景

首版把 PI 写死为唯一执行器：`adapter/pi_rpc.py` 的 `PIProcess` 是长期 JSONL RPC 会话，`graph/nodes.py` 直接构造它，`graph/planning.py`（分析／规划）另建一个同样的会话，任务配置快照里的 `pi_command` 是唯一命令来源。架构文档 §7 如实记录：`adapter` 没有 Protocol／ABC 端口，「在进程内替换执行器」要改调用点。

2026-10-19 所有者要求新增对接 DSH，并明确「DSH 和 PI 同属于 Agent Runtime，支持 Agent Runtime 热切换」。DSH 的官方一次性契约（`dsh --profile headless --json`）与 PI 差异明显：

- 一个进程只回答一个任务，没有交互命令通道；提示词从 stdin 读入，进程自行退出；
- stdout 是 JSONL 事件流，终态原因是 `status(phase=turn_end).reason.kind`，退出码 0 只对应 `completed`；
- 没有 PI 的 `abort` 命令与 `get_last_assistant_text` 请求，失败可能表现为运行器 `error` 事件（没有 `final`）。

因此这不是「换一条命令」，而是要在协议、结果语义与选择方式上建立一层共同契约。

## 决策

1. **建立 Agent Runtime 共同契约**（`adapter/agent_runtime.py`）：事件、调用结果、启动选项与会话文件命名。`PIProcess` 与 `DSHProcess` 各自讲自己的协议，都归一到同一结果字段：`settled`／`aborted`／`model_error`／`error` 与运行时身份。PI 的既有类型名保留为别名，既有测试与调用点不需要另起一套。
2. **DSH 的 fail-closed 归类**：只有 `turn_end.kind=completed`（并有 `final`）与 `aborted` 记为 `settled`；`error` 记 `model_error`；`blocked`／`max-tokens`／`interrupted`／`forked`、运行器 `error` 事件、缺 `final`、非 JSON 行与超时全部按「未取得结果」上报，交业务节点中断。**不**因为没有结构化文本就把会话当成成功。
3. **选择规则是领域规则**（`domain/agent_runtime.py`）：优先级为进程环境覆盖（`FORGELOOP_AGENT_RUNTIME`／`FORGELOOP_DSH_COMMAND`）> 运行状态记录 > 内建默认（PI）。PI 没有内建启动命令，缺命令 fail-closed；DSH 的默认命令就是官方 headless 契约。任务配置快照里的 `pi_command` 只对 PI 生效，运行状态里的 PI 命令用于没有任务快照的规划阶段——PI 任务保持提交时的可复现命令，切回 PI 不会悄悄换命令。
4. **热切换是运行状态，不是方案变更**：`forgeloop runtime set` 把当前运行时、命令、更新人、时间与理由写入 `records.sqlite` 的 `agent_runtime_state`，并追加 `agent_runtime_switches` 审计；`by`／`reason` 空白或运行时／命令非法一律拒绝且零副作用。`graph.agent_execution` 在**每次动作启动前**重新读取状态并解析运行时，因此切换对下一个动作生效、不需要重启推进进程；**正在运行的会话不被打断**，避免半途换执行器留下不可归因的候选。切换不改写任务方案、批准、任务配置快照，也不使批准失效。
5. **运行时身份进入证据**：会话请求日志、`dev-reports.jsonl`、`reviews.jsonl` 都记录本次运行时名字与命令来源；`runtime show --json` 是稳定对外文档，进入 `contracts/cli-contract.json`。
6. **中断原因改为中性的 `agent_dev_unsettled:`／`agent_review_unsettled:`**；`records.checkpoints` 继续识别旧检查点里的 `pi_dev_unsettled:`／`pi_review_unsettled:`，旧现场的就地续跑不受影响，不追溯改写旧记录。

## 后果

- PI 路径行为保持不变：默认运行时是 PI，任务配置、审核与现场文件命名都不变；新增的只是「谁执行」这一维。
- DSH 路径与 PI 共用同一业务图、批准门、失败轮次、工时与验收规则；`adapter` 层内部新增 `agent_runtime → pi_rpc`／`dsh_headless` 两条同层依赖，无跨层新边，架构契约快照同步更新。
- 切换是**操作事实**而非配置漂移：记录里能回答「这一动作为什么用了这个执行器」；代价是 `records.sqlite` 多两张表（总计 30 张），且运行状态不随项目代码版本分发——与提交策略「本机配置不入库」同一种取舍。
- **DSH 的会话恢复未实现**：`--session-id` 续跑、容器内 DSH（镜像需自带 `dsh`）都未接入／未验证；跨运行时的会话不可互换，切换发生在动作边界而不是会话中间。
- 运行时抽象仍是 `if` 分支而非插件注册表：新增第三个执行器要同时改 `domain.agent_runtime` 的运行时表、`graph.agent_execution` 的分支与架构文档。这是刻意保留的简单性，等真实第三个执行器出现再抽象。

## 备选方案

- **只加一个 `dsh_command` 开关，不建共同契约**：业务节点要各自判断协议差异（settled 语义、文本提取、失败形态），规则会散在 `nodes`／`planning` 两处并逐渐漂移。否决。
- **用 `Protocol`／ABC 做可注册插件体系**：当前只有两个实现、替换点只有一处，抽象成本大于收益，也与首版「保留 Seam 是配置与函数参数」的取舍冲突。否决，等第三个执行器。
- **把运行时选择写进任务方案或批准**：切换就要重新批准，与「热切换」目标相反；且运行时是执行环境事实，不是研发范围或验收标准的变更。否决。
- **用专门配置文件（TOML／JSON）保存运行状态**：与既有权威记录介质并行、无审计与并发语义；记录层已有事务与 fail-closed 校验模式。否决。
- **切换时中断正在运行的会话并重跑**：会产生半途换执行器的候选与重复副作用，违背「结果不明确不得盲目重放」。否决。
