# 分支保护与发布门禁

本文记录**已经能由仓库内代码强制执行**的门禁，以及仍需在 GitHub 仓库设置中手工
配置、当前**未落实**的项。按 [AGENTS.md](../AGENTS.md) 的规则，只有声明、没有机制的
限制一律标为“未落实”。

## 已落实：仓库内可执行门禁

| 门禁 | 触发 | 命令 | 失败即阻断 |
| --- | --- | --- | --- |
| 快速质量 | PR / push 到 `main` | `.github/workflows/quality.yml` → `make check-fast` | 是 |
| 格式 | PR / push | `make format`（Prettier 检查） | 是 |
| 全量质量 | 每日定时 + 手动 | `.github/workflows/nightly.yml` → `make check` + `make coverage` + `make mutation` | 是（nightly） |
| 发布 | 手动 | `.github/workflows/release.yml` → `make check`、`coverage`、`sbom`、`package` | 是（release） |
| 产权 | 任意改动 | `.github/CODEOWNERS` 指定所有者审阅 | 依赖 GitHub 设置 |
| 契约 | 本地/CI | `make contracts`（分层、依赖、端点、文档链接） | 是 |

真实宿主验收（`make verify-plugin`）需要模型凭据与自托管 runner，当前只在
`release.yml` 中以 `vars.ENABLE_REAL_HOST` 开关控制，**默认不执行**，因此不能算作
PR 的强制门禁。

## 未落实：GitHub 仓库设置

以下设置无法由仓库文件声明，需要在 GitHub 仓库 Settings → Branches 手工配置，
配置完成前不得声称“分支已保护”。

1. `main` 分支保护规则：
   - Require a pull request before merging（至少 1 个 approve）。
   - Require review from Code Owners。
   - Require status checks to pass：勾选 `quality` 工作流的全部 job（快速质量、格式）。
   - Require branches to be up to date before merging。
   - Do not allow bypassing the above settings（包括管理员）。
2. 禁止直接 push 到 `main`；紧急修复也必须走 PR。
3. 开启 “Require signed commits”（若团队使用签名提交）。
4. Tag 保护：仅 release workflow 可创建 `v*` tag。

## E2E 门禁现状（未落实）

当前没有 Playwright/E2E 套件，也没有 `make e2e` 目标；看板与 Web 接缝的验证仍由
`tests/board-route.test.ts`、`tests/architecture-contract.test.ts` 等集成测试覆盖。
在补齐真实浏览器 E2E 之前：

- 不新增“E2E 已通过”的声明；
- 若后续引入 Playwright，新增 `make e2e` 并在 `quality.yml` 中作为独立 job，
  再把该 job 加入 `main` 的必需检查；
- E2E 失败与单元测试失败同等阻断合并。

## 维护

- 门禁命令以 [Makefile](../Makefile)、`.github/workflows/` 与 `contracts/` 为准；
  本文只描述入口与设置，不复制判定参数。
- 修改必需检查列表时同步更新本文与 `docs/status.md`。
