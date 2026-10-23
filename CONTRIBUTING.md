# 贡献与提交规范

ForgeLoop 是个人研发工具项目。许可方式（代码与文档）由所有者后续决定；未决定前不对外分发。
贡献遵循本规范与[研发纪律](docs/development-discipline.md)。

## 开发流程

1. 读 [AGENTS.md](AGENTS.md)、[架构说明](docs/architecture.md) 与[状态记录](docs/status.md)，
   核对源码与契约；范围外问题记录为“发现但不碰”。
2. 关键规则先写失败的 TypeScript 行为测试，再实现；运行 `make check`。
3. 架构、持久化、命令/工具表面变化同批更新 `docs/architecture.md` 与 `contracts/`，运行
   `make contracts`；方向性选择写 `docs/adr/`。
4. 真实宿主行为变化运行 `make verify-plugin`（需 DSH 与模型凭据）；安装包变化运行
   `make package` 并记录 tarball SHA-256。
5. 需要提交时由所有者明确授权；提交前运行提交策略检查。

## 提交时间限制

提交时间限制是**可选的本机策略**：仓库只发布配置模板 `config/commit-policy.template.toml`，
**实际生效的配置不入库**，只从本机两个位置二选一读取：

1. `.cache/forgeloop/commit-policy.toml`（仓库内缓存，已被 `.gitignore` 忽略）
2. `~/.config/forgeloop/commit-policy.toml`（用户级，位于仓库之外）

把模板复制到上述任一位置即在本机启用限制；**两处都没有配置文件时不执行提交时间禁止**——
`pre-commit`／`commit-msg` 与 CI 审计都会放行，并在输出里标注 `policy_absent` 与 NOT
enforced：这是“没有规则”，不是“检查通过”。配置存在而损坏、年历目录缺失或旧路径
`commit-policy.local.toml` 未迁移时仍然拒绝（失败关闭）。

窗口、午间可提交时段、授权窄口与授权批次来自**生效配置**，判定由
`scripts/ts/commit-policy.ts` 实现；模板默认值沿用旧口径（09:00–12:00 与 13:30–18:00 禁止、
午间 12:00–13:30 可提交、授权只限 09:00–09:55 窄口）。授权批次逐条登记在
`[[authorized_batches]]` 并写明来源，未登记的日期即使落在窄口内也拒绝。**10:00 是领域硬
上限**：任何配置都不得把授权窗口延伸到 10:00 之后，超出即配置无效。数值以配置与代码为准，
不在本文复制。

## 提交消息

消息头遵循 Conventional Commits（`type(scope): summary`），由 `.githooks/commit-msg` 调用同一
TypeScript 工具校验，与是否启用本机策略无关。禁止 `--no-verify`、禁用 hooks、修改时钟或伪造
作者/提交者时间绕过已启用的策略。

## 本地钩子

```sh
make hooks     # git config core.hooksPath .githooks
```

`pre-commit` 运行提交时间检查与 `npm run typecheck --workspace forgeloop-dsh`；`commit-msg`
校验消息头。钩子只做本地早起拒绝，不是完整保障；CI 与产品运行时的判定各自独立。

## 真实记录

- 不补造批准、失败、测试或验收记录；未知、跳过与未验证如实标记。
- 外部工具完成的改动不计为 ForgeLoop 独立成果；记录实际执行来源与人工介入。
- 提交、推送、发布与部署以所有者明确授权和生效策略为准；命令通过不代替授权。