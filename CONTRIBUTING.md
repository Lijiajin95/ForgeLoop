# 贡献与提交规范

产品方向见[统一方案](docs/product.md)。许可方式（代码与文档）由所有者后续决定；未决定前不对外分发。
研发纪律统一遵循 [AGENTS.md](AGENTS.md)，本文件只说明提交与交付操作。

## 提交

- 一个可独立审阅的小改动完成且相关检查通过后，即可创建 commit，不再逐次等待所有者授权。
  代码/行为改动至少运行 `make check`；契约/文档改动运行 `make contracts` 和文档链接检查；
  插件或安装相关改动按影响补充 `make verify-plugin` / `make package`。检查未通过不提交。
- 自动提交（研发 Agent 应用候选后）使用 `autonomy.commitCheckCommand`，当前指向 `make commit-check`
  （跨平台等价 `npm run check:commit`）：静态检查 + 全量行为测试 + `vitest` 逐文件覆盖率门槛
  （lines 90 / functions 95 / branches 85）。覆盖率不达标即拒绝提交，不能只看测试通过或报告已生成。
- 采用小型多次提交（small diff smart）：一次提交只解决一个目标，按实现、测试、契约/文档、安装记录
  等可独立验证的步骤拆分。禁止把无关重构、全仓格式化、生成物或他人在途改动混入同一提交。
- 提交消息遵循 Conventional Commits（`type(scope): summary`），正文记录验证命令与结果。
- 禁止提交失败测试、伪造通过、凭据/秘密、本机配置、缓存、构建产物或未经确认的生成文件；
  不得伪造作者、提交者或提交时间，也不得绕过检查。
- commit 不等于验收、发布或生产授权；`git push`、tag、发布与部署仍需所有者明确要求。

## 交付

提交或交付说明按 [AGENTS.md](AGENTS.md#提交与交付)列出计划范围、实际改动、验证结果、
未完成项和“发现但不碰”；具体工程检查与证据要求以 Makefile、vitest 配置和契约为准。

## 类型断言（`as`）

- 普通业务代码默认禁止 `as`（ESLint `consistent-type-assertions: never`）；优先用类型收窄、
  `satisfies`、显式标注或 `unknown` + 校验。
- `as const` 允许；`as any`、`as unknown as T`、尖括号断言、无理由的 `@ts-ignore` 一律禁止。
- 仅下列接口边界文件允许 `as`，且 `no-explicit-any` / `no-unsafe-*` 仍然生效：
  `domain/json.ts`、`records/{db,repository,ops-store,issues}.ts`、`config.ts`、
  `index.ts`、`tools.ts`、`cli/pack.ts`、`runtime/{agent-runner,formal-test,board-route}.ts`、
  `session/{events,index,preset}.ts`。
- 新增边界例外须说明依据并由审查确认，不得把业务代码挪进边界目录规避规则；
  `scripts/ts/assertion-budget.ts` 会拒绝业务文件出现 `as`。
- 验证：`make assertions` 与 `packages/forgeloop/tests/assertion-policy.test.ts`。

## 提交前检查（pre-commit）

仓库内置 `.githooks/pre-commit`：提交前先运行 worktree 硬约束（主工作树暂存代码文件即拒绝），
再按暂存范围选择检查：

- **含代码路径**（`packages/`、`scripts/`、`contracts/`、`.github/`、`.githooks/`、`Makefile`、
  包清单等，判定见 `scripts/ts/commit-scope.ts`）：运行 `make commit-check`，即静态检查 +
  全量行为测试 + `vitest` 逐文件覆盖率门槛（lines 90 / functions 95 / branches 85）；覆盖率不达标
  即非零退出，提交被阻止。
- **纯文档/状态记录**：只运行 `make check-static`（类型、lint、架构契约、token/断言预算），
  不跑全量覆盖率，避免无意义的等待。
- 两类都要再运行 `make format`，失败即阻止提交。

注意边界：pre-commit 是**本地**约束，`git commit --no-verify` 能绕过；远端 CI 只能约束 push/merge，
不能阻止本地提交。`make commit-check` 生成的 `packages/forgeloop/coverage/coverage-summary.json`
属于生成物，hook 在检查后恢复它，不应进入暂存区。
任务开始用 `make worktree-start TASK=<task>` 创建独立现场；纯文档改动可在主工作树提交。新克隆执行一次安装：

```bash
make hooks      # 等价于 git config core.hooksPath .githooks
# 或 make setup（安装依赖并装 hook）
```

- 不做完整测试、覆盖率与变异测试（这些在 `make check` 与 CI 中）；
- hook 只影响本机克隆，`core.hooksPath` 不随仓库分发；
- 紧急绕过需显式 `git commit --no-verify`，不应成为常态。

## Windows

- Windows 默认没有 GNU make：在仓库根用 `make.cmd <target>`，目标与 Makefile 同名、命令等价，
  例如 `make.cmd check`、`make.cmd check-static`、`make.cmd test`、
  `make.cmd mutation-shard SHARD=runtime-ops-1`。
- 目标参数按 `KEY=VALUE` 传入（`MUTATION=1`、`SHARD=...`、`BRANCH=...`）；`make.cmd help` 列出全部目标，
  未知目标非零退出。
- 脚本经 `scripts/ts/platform.ts` 启动 `npm.cmd` / `dsh.cmd`（Windows 不能直接执行 .cmd），
  并按进程树结束子进程；测试改用 `process.execPath`、`tmpdir()` 与 `node -e`，不依赖 `/tmp`、`sh` 或
  POSIX 信号。
- Makefile 仍是 CI/POSIX 的权威入口；`make.cmd` 只是 Windows 入口，改动目标时两边同步。
