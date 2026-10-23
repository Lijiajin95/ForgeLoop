# ForgeLoop 工程可靠性（TypeScript／DSH 版）

日期：2026-10-22。旧的 Python 可靠性方案与历史失败记录保留在 Git 与 `legacy/`；本文只描述
**当前活动实现**的门槛、执行方式与已知缺口。原则见[研发纪律](development-discipline.md)。

## 1. 门槛分层

| 层级 | 入口 | 当前状态 |
| --- | --- | --- |
| 类型 | `npm run typecheck --workspace forgeloop-dsh` | 已接入，`make check` 执行 |
| 行为测试 | `npm run test --workspace forgeloop-dsh`（vitest） | 已接入；领域不变量、记录、流水线、持久请求 |
| 契约 | `node scripts/ts/contracts.ts`（`make contracts`） | 已接入：模块清单、依赖方向、表、命令/工具、文档关键词、无 Python 引用 |
| 提交策略配置 | `node scripts/ts/commit-policy.ts --validate-config` | 已接入；无生效配置时标注 `policy_absent` 与 NOT enforced |
| 提交消息 | `.githooks/commit-msg` → 同一 TS 工具 | 已接入，始终生效 |
| 真实宿主 | `make verify-plugin` / `node scripts/ts/verify-plugin.ts` | 已接入；需要 DSH 与模型凭据，验证安装形态、组合层、真实工具与命令 |
| 打包 | `npm run candidate --workspace forgeloop-dsh` | 已接入；输出 tarball 与 SHA-256、文件清单 |
| 覆盖率 | `make coverage`（vitest v8） | 已接入：行 78 / 语句 78 / 函数 80 / 分支 70；本机实测 80.28/80.28/82.43/71.23。目标 90/85 未达成，不声称达标 |
| 变异测试 | `make mutation` | **未接入**；目标显式失败（旧 mutmut 工作流已退役） |
| 依赖漏洞扫描 | `make audit`（`npm audit --audit-level=high`） | 已配置；本机受限缓存下未验证，CI 网络环境执行，失败即阻断 |
| 格式化 | `make format` | **未选定格式化器**；目标显式失败 |

## 2. 关键规则与测试对应

| 规则 | 实现位置 | 行为测试 |
| --- | --- | --- |
| 需求版本连续、修订不覆盖 | `domain/requirement.ts` | `tests/requirement.test.ts` |
| 分析畸形 fail-closed | `domain/requirement.ts` | `tests/requirement.test.ts` |
| 任务包依赖/文件/测试命令校验 | `domain/task-plan.ts` | `tests/domain.test.ts`、`tests/language.test.ts` |
| 语言/工程边界（拒绝 Python、旧 CLI、并行包） | `domain/language.ts`、规划阶段 | `tests/language.test.ts` |
| 批准过期、重复消费、材料变化 | `domain/approval.ts`、`domain/delivery.ts` | `tests/domain.test.ts` |
| 失败轮次幂等与额度 | `domain/counting.ts` | `tests/domain.test.ts` |
| 工时限额 | `domain/limits.ts` | `tests/domain.test.ts` |
| 请求去重、原子领取、重启 unknown | `records/repository.ts`、`runtime/coordinator.ts` | `tests/records.test.ts`、`tests/service.test.ts` |
| 越出文件清单阻断、测试失败重试 | `runtime/service.ts` | `tests/service.test.ts` |
| 候选包摘要与验收绑定 | `runtime/service.ts`、`records/repository.ts` | 真实 V0 链路（见状态记录） |

## 3. 提交策略（可选本机强制）

- 仓库只发布模板 `config/commit-policy.template.toml`；生效配置在本机
  `.cache/forgeloop/commit-policy.toml` 或 `~/.config/forgeloop/commit-policy.toml`（二选一）。
- 没有生效配置的机器：命令放行并输出 `policy_absent` / `NOT enforced`，如实标记“未落实”，
  不能声称规则已生效。
- 配置损坏、年历缺失、窗口非法（重叠、授权窄口越界或晚于 10:00）一律拒绝。
- 提交消息头由 `.githooks/commit-msg` 校验 Conventional Commits，与配置无关。
- 禁止 `--no-verify`、禁用 hooks、改时钟或伪造时间绕过；命令通过不代替所有者授权。

## 4. 真实宿主验证的边界

`make verify-plugin` 证明的是：profile 清单包含插件、安装形态是安装目录而非源码链接、
组合层可解析、真实模型能调用插件工具、真实命令注册表能执行 `/fl status`。它**不**证明：

- 关闭客户端后长时间推进、宿主重启后的完整恢复（由协调器单元测试与记录状态覆盖，真实长跑
  未执行）；
- 审查/实现的 OS 级隔离；
- 跨 DSH 版本兼容；
- 安装包在另一台机器或桌面 profile 的行为。

这些边界在[状态记录](status.md)中逐条标注，不用冒烟结果替代真实验收。

## 5. 缺口与后续

1. 提高覆盖率门槛至行/语句 90、分支 85，并补 `agent-runner`、`service`、`workspace` 的
   错误分支（当前 80.28/71.23，不声称达标）；
2. 选定 TypeScript 变异测试工具（如 Stryker），替换已退役的 mutmut 夜间作业；
3. 在可联网环境实际运行 `npm audit` 并记录结果／例外；
4. 选定格式化器并让 `make format` 真正可用；
5. 把真实宿主长跑、重启恢复、停止/取消与大仓测试纳入可重复的集成脚本；
6. DSH 升级时重跑装载与真实链路验证，记录版本矩阵。