# 交付记录：TypeScript 原生 DSH 插件（2026-10-22）

本记录说明本轮转向的计划范围、实际改动、验证证据、未完成事项与恢复步骤。事实以源码、记录库
与原始日志为准；未执行或未验证的事项逐条标注，不把“已退役”写成“已迁移”。
本文保留当批事实，后续安装状态与检查结果见[状态记录](../status.md)；历史手动安装／恢复步骤
不作为现行操作指引，实际操作按[安装说明](../deployment.md)。新需求以[统一方案](../product.md)为准。

## 1. 范围与计划

所有者当日决定：ForgeLoop 全量转为 TypeScript 实现的 DSH 原生插件，DSH 为唯一常驻宿主，
不保留 Python 业务核心或跨语言桥接；首版完成一条真实自迭代闭环。依据与边界见
当时的 `docs/dsh-plugin-10h-goal-prompt.md`（已移出工作树，原文可从 Git 历史回查）与
[ADR 0008](../adr/0008-typescript-native-dsh-plugin.md)。

执行时间：2026-10-22T22:36 +08:00 开始；会话中途中断约 8 小时，2026-10-23T08:46 收口。
实际动手约 2 小时 10 分，墙钟超过十小时。本文不把“到时”当成功理由，缺项按 §9 列出。

计划文件清单（实际以 `git status` 为准）：

- 新增 `packages/forgeloop/`（插件源码、测试、README、cordis.patch.yml）、`scripts/ts/`
  （契约、提交策略、宿主验证）、`docs/adr/0008-*`、本记录与新的 docs 索引；
- 改写 `README.md`、`AGENTS.md`、`CONTRIBUTING.md`、`CONTEXT.md`、`Makefile`、
  `docs/{architecture,deployment,engineering-reliability,dogfood-execution-plan,product-requirements,pending-requirements,roadmap,status}.md`、
  `contracts/{architecture,cli-contract}.json`、`.githooks/`、`.gitignore`、根 `package.json`；
- 迁移 `src/`、`tests/`、`frontend/`、`pyproject.toml`、`uv.lock`、Python 脚本与旧配置到
  `legacy/`；旧 docs 移到 `docs/history/`。

## 2. 基线与在途工作

- HEAD：`6233a6e9762fa65d61565eef78765cc72d3e290b`；工作树 58 项其他执行方在途改动。
- 基线快照：`.cache/forgeloop/dsh-migration/baseline/`（git-state、worktree.patch、
  diffstat、records.sqlite 副本），未覆盖、回退或清理原改动，未创建产品 commit。
- 执行副本按 Git 跟踪清单＋未忽略新文件复制，包含未提交实现；产品仓库不产生额外提交。

## 3. 能力处置

| 旧能力 | 处置 |
| --- | --- |
| 自建网页、会话壳、工具轨迹 | 退役；由 DSH 原生会话/命令/工具卡片承担 |
| `forgeloop serve` / `web` / 热升级启动器 | 退役；活动产品不再启动独立服务 |
| 需求/版本、分析、任务包、批准、失败轮次、授权、工时、动作身份 | 迁移：TypeScript 领域＋SQLite，表结构兼容旧库 |
| 持久请求、停止、重启核对 | 迁移：`service_requests`＋`actions`＋协调器；新增单消费者锁 |
| PI / DSH headless 执行 | 由宿主内 DSH Agent 承担（分析/规划/审查无工具；实现有工具） |
| 独立审查、正式测试、交付证据 | 迁移：独立会话＋固定 diff；程序运行 argv 并保存日志 |
| 邮件、发布、部署、容器隔离 | 不迁移；不在首版范围，如实标记 |
| Python 工程工具（ruff/pyright/pytest/契约脚本/提交策略） | 退役；改接 tsc/vitest/`scripts/ts/`，不降低规则含义 |

## 4. 版本与产物

| 角色 | 产物目录 | SHA-256 | 安装 |
| --- | --- | --- | --- |
| V0 | `.cache/forgeloop/artifacts/v0/`（tarball） | `789965d6cf136058926f62499eccab62bda5af6498b27c6eda59f800af7ba418` | 隔离 profile `forgeloop`（DSH_HOME `.cache/forgeloop/dsh-home`），安装目录形态 |
| 修复基线 | `.cache/forgeloop/artifacts/v0.1.1/`（tarball） | `a2b62e781783b57f8ffc932888778a2f0566fa3bafef7bb2f2765463f0e38807` | 隔离 profile；含单消费者锁与依赖产物交接 |
| V1 | `.cache/forgeloop/artifacts/v1/`（tarball） | `415b85fd6467bd80e9f722b5ca1dff32465ea048cb01b5fe12502c1e980ee124` | 隔离 profile `installed-copy`；当时的运行版本 |

版本号只由 git tag 决定；上表按角色记录构建产物与摘要，文件名以构建记录为准。

环境：DSH `0.2.1-rc.2`、Node `v26.11.1`、npm `11.20.0`、TypeScript `5.9.3`；模型路由
`qwen-token-plan-cn / deepseek-v4.1-flash-1017`，凭据由启动环境提供，未写入仓库。

## 5. V0 与 V1 链路证据

### V0（`req-20261022151546-b52121`，失败轮次可见性）

- 入口：DSH `/fl submit`；分析 v1；任务包 v2（3 任务，依赖链）；`/fl approve ... 2`；
  `/fl advance`；3/3 交付；`/fl candidate ...`（版本标签由 git tag 决定）；安装 tarball；`/fl accept ... <sha>`。
- 审查：`pass`（7 条非阻断 findings，含额度公式复用与测试脆弱性）；正式测试 `exit_code: 0`。
- 材料指纹：`e1c7a50b3aba2922…`；需求状态 `accepted`。
- 安装验证：`make verify-plugin --full` → `installed-copy`、真实模型调用 `forgeloop_status`、
  真实 `/fl status` 成功。

### V1（`req-20261022154141-b8907b`，需求修订影响摘要）

- 入口：由已安装的 V0 通过 `/fl submit` 提交；分析 v1；任务包 v1（4 任务：事实引擎 → 推断
  模块 → 命令/工具接线 → 契约文档）；`/fl approve ... 1`；`/fl advance`；4/4 交付；
  `/fl candidate ...`（版本标签由 git tag 决定）；安装 tarball；`/fl accept ... <sha>`。
- 审查：4 个任务均 `pass`；正式测试 `exit_code: 0`（交付时快照 84 项通过；当前主源码补测后 97 项）。
- 材料指纹：`8ac4afa284c13e10…`；需求状态 `accepted`。
- 安装验证：`make verify-plugin --full` → `forgeloop-dsh`（版本以 git tag 为准）、`installed-copy`、真实模型
  调用 `forgeloop_status`/`forgeloop_impact`、真实 `/fl status` 成功。
- 专用用户 profile：`~/.dsh/profiles/forgeloop` 安装同一 tarball，真实模型调用成功；需提供
  `QWEN_TOKEN_PLAN_CN_API_KEY` 或在 Models 页登记；桌面 profile 未改动。
- 新行为：`/fl impact <需求>` 输出 current/pending 事实与过期/待核对项；默认不调用模型；
  `--explain` 的推断与事实分区并标注“不是确定事实”。
- 历史与恢复：V1 下旧需求可读；重装修复基线构建后 `/fl status` 可读、`/fl impact` 为未知子命令；
  再装回 V1。恢复步骤见 §10。

## 6. 无 Python 环境验证

- Python 项目源码、旧 `.venv`、旧测试/前端/脚本已移出活动路径（`legacy/`，且
  `legacy/python/.venv`、`legacy/python/frontend/node_modules` 等生成物已删除）。
- 使用仅含 node/npm/git/sh 等工具的 `PATH`（无 `python`、`python3`）运行：
  `make check` 58 项通过；`node scripts/ts/verify-plugin.ts --full` 通过（真实主机、真实模型、
  真实命令入口）。命令与输出见 §7。
- 安装包内容核对：仅 `lib/**/*.js`、`package.json`、`cordis.patch.yml`、`README.md`；无 `.py`。

## 7. 检查与日志

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `make check` | 通过（97 tests） | `.cache/forgeloop/evidence-20261022/clean-make-check.log` |
| `node scripts/ts/contracts.ts` | 通过 | 模块/依赖/表/命令工具/文档/无 Python 引用 |
| `node scripts/ts/commit-policy.ts --validate-config` | 通过 | 本机生效配置路径 |
| `make verify-plugin --full` | 通过（V0/V1） | `.cache/forgeloop/evidence-20261022/verify-plugin-v1-clean.log` |
| 无 Python PATH 下 `make check` | 通过（97 tests） | 同上，PATH 仅含白名单工具 |
| 无 Python PATH 下 `verify-plugin --full` | 通过 | 真实主流程；日志同上 |
| `make coverage` | 通过（行 80.28%、分支 71.23%） | 阈值 78/70；日志见上 |
| 变异/依赖审计/格式化 | **变异与格式化未接入**；审计已配置但本机未验证 | 失败即失败，不冒充通过 |

## 8. 人工介入与外部补救

- 批准、验收、候选构建、安装与宿主重启由外部执行 Agent 通过命令入口代所有者执行，记录为
  `local-owner`；不计为 ForgeLoop 独立成果，也不冒充所有者本人操作。
- 规划模型曾多次输出目录路径、旧 Python 测试命令或并行包路径，被确定性规则拒绝并重试；
  未手工改写其输出。
- V1 推进期间因第二个 DSH 宿主并发运行，原请求被标为 `unknown`；已停止不一致执行、核对现场
  （无交付产物、无 Git/部署副作用），新增单消费者锁并加入测试后 `/fl recover confirm` 重新
  排队。该事件如实记录，不作为成功路径。
- V1 第三个任务首次被范围检查阻断（依赖产物未进入副本）；修复为上游 artifact 先应用并提交为
  新基线，重新以修复基线构建安装后继续，未放宽文件清单。
- 候选 diff 在源码继续变化后出现上下文不匹配，使用受控 `patch --fuzz` 合并；契约 JSON 的
  格式差异通过恢复原始排版解决。均为机械合并，未重写实现语义。

## 9. 未完成 / 未验证

- 桌面 profile（`~/.dsh/profiles/desktop`）于 2026-10-23 **已手动安装**（`dsh plugin` 拒绝
  Electron 独占 profile，改用 pnpm + 追加 `dsh.profile.bundles`）：安装目录、记录根与
  执行现场已写入 `cordis.patch.yml`；同构副本 `--dump-config` 验证组合层。**重启 DSH Desktop
  后才会加载**，界面与命令未在本会话验证。原 profile 的 `package.json`/`cordis.patch.yml`
  备份在 `.cache/forgeloop/desktop-install/`。
- 真实长跑、断电/强杀逐阶段故障注入、宿主卸载后的完整恢复未执行；已有单元测试与一次真实
  unknown 事件。
- 容器/OS 级审查隔离、多用户、远程访问、邮件/IM、发布/部署未实现。
- DSH 跨版本兼容未验证。
- 覆盖率已接入（80.28% 行 / 71.23% 分支，未达 90/85 目标）；变异测试与格式化器未接入；依赖审计已配置，本机受限缓存下未验证。
- 单消费者锁已实现并有测试，但未在真实并发宿主长跑下重复验证（本次事件暴露需求）。
- 常驻宿主中断开客户端后继续推进未单独验证：协调器有单测与真实命令链路，但验证宿主是无头
  一次性进程；该场景仍列为 N01。
- GitHub Actions 已改接 Node/TypeScript，但未推送、未在 GitHub 执行；本地执行了同一组
  `make` 命令。
- 依赖产物交接已有行为测试与真实 V1 任务验证，但未覆盖多分支依赖/大文件冲突。

## 10. 恢复步骤

```sh
# 回到 V0
dsh plugin --profile forgeloop add /abs/path/.cache/forgeloop/artifacts/v0/<tarball>
# 重启 DSH 宿主；确认安装目录而非 link
ls -la "$DSH_HOME/profiles/forgeloop/node_modules/forgeloop-dsh"
make verify-plugin
```

记录库与证据目录不随版本删除；恢复后运行 `/fl status` 与 `/fl evidence` 核对历史。未知请求
与未收口动作先核对，不自动重放。旧 Python 实现不参与恢复。

## 11. 发现但不碰

- 旧 docs 中的历史数字、Debian 路径与热升级细节按当时事实保留，未逐条改写，统一移入
  `docs/history/`。
- 旧 Python 代码中的既有缺陷未在迁移中顺手修复；只做隔离与兼容读取。
- 本机桌面 profile 的既有配置未改动；插件验证使用隔离 DSH_HOME。
- `reports/`、`records.sqlite`（仓库根，忽略）等本机现场未清理，不属于活动实现。
