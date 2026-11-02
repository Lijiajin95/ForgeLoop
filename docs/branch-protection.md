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

## 已落实：GitHub 仓库设置（2026-11-02，个人开发档位 1）

`main` 已通过 REST API 配置分支保护，实际值如下（`gh api` 可查）：

| 配置 | 值 | 说明 |
| --- | --- | --- |
| Required status checks | `quality`、`security` | 来自 `quality.yml` 的两个 job |
| Require branches to be up to date | 开启（`strict: true`） | PR 合并前必须先同步 `main` |
| Allow force pushes | 关闭 | 禁止强推覆盖历史 |
| Allow deletions | 关闭 | 禁止删除 `main` |
| Required pull request reviews | 关闭 | 个人账号无法自我 approve，避免锁死 |
| Enforce admins | 关闭 | 保留个人紧急处置能力 |

配置命令（等价，可重放）：

```bash
cat > /tmp/protection.json <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["quality", "security"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
gh api --method PUT repos/Lijiajin95/ForgeLoop/branches/main/protection --input /tmp/protection.json
```

限制与注意：

- **必需检查只作用于 PR 合并**。当前没有开启 “Require a pull request”，所以直接
  `git push origin main` 仍被允许，不会因 CI 失败被拦；要强制走 PR 需再加一条规则。
- 检查项在 `main` 上首次运行前可能显示 “Expected”；不影响直接 push，但会阻塞 PR 合并。
- `enforce_admins: false` 表示管理员仍可绕过（例如强制推送），个人项目保留该能力。
- 该配置是仓库设置，不在 Git 版本库内；换仓库或重建仓库需要重新应用。

## 未落实：更严格的分支策略

以下项**尚未开启**，个人开发默认不做；需要时再逐项加：

1. `main` 要求 PR（Required approvals = 0，避免自我 approve 锁死）；
2. Require review from Code Owners（单人仓库无意义）；
3. Require signed commits；
4. 禁止管理员绕过（`enforce_admins: true`）；
5. Tag 保护：仅 release workflow 可创建/移动 `v*` tag；
6. 全部分支禁删除（保护多机在途分支）；
7. 分支保护不区分机器：同一账号的每台机器权限相同，审计靠独立 SSH key，不靠规则。

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
